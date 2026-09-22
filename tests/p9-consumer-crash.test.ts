import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Option } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { describe, expect, it } from "vitest";
import {
  type ConsumerLoopStores,
  completionConsumerLoop,
  dependencyCoordinatorLoop,
  pollOnce,
} from "../packages/application/src/consumer-loop.js";
import type { CommandGatewayService } from "../packages/application/src/gateway.js";
import { CommandGateway } from "../packages/application/src/index.js";
import {
  ArtifactId,
  type ArtifactRole,
  CommandId,
  DeliverableId,
  type DeliverableKind,
  DependencyId,
  DependencyRevision,
  declareDependency,
  type EventTypeName,
  type ExpectedDeliverable,
  type ProducerBinding,
  type ProjectId,
  parse,
  WorkId,
} from "../packages/domain/dist/index.js";
import {
  AcceptanceRepository,
  ConsumerDeadLetterStore,
  ConsumerOffsetStore,
  DeliverableRepository,
  DependencyRepository,
  DomainEventJournal,
  ProjectionStore,
  TransactionPort,
  VerificationRepository,
  WorkRepository,
} from "../packages/ports/src/index.js";
import {
  p7Project,
  p7SeedProject,
  p7SeedWork,
  p7TestActor,
  p7TestPrincipal,
} from "./support/p7-app.js";
import {
  commitGate,
  gatedTransactionPort,
  makeP9ConsumerApp,
  p9Boot,
  runP9Consumer,
} from "./support/p9-consumer-app.js";
import { labeled } from "./support/p9-harness-api.js";

/** P9-010 — consumer crash injection matrix CC-1..CC-6 (P9 `02` §7 +
 * `05` §1–§2) over the WIRED path: the P7 coordinator / P8 consumers A-B
 * wrapped by `pollOnce` on the P1 consumer infrastructure. Every case is
 * labeled crash-injected (GQ5). The wired loop reads the WHOLE project
 * journal (seed commands journal their events too), so each case first
 * pre-consumes to the seeded head and asserts against relative offsets. */

const WORK_C = parse(WorkId)("wrk_00000000-0000-7000-8000-000000000001");
const WORK_P = parse(WorkId)("wrk_00000000-0000-7000-8000-000000000002");
const ASSIGN_CMD_C = parse(CommandId)(
  "cmd_018f2b3c-4d5e-7abc-8def-0123456789a1",
);
const ASSIGN_CMD_P = parse(CommandId)(
  "cmd_018f2b3c-4d5e-7abc-8def-0123456789a2",
);

const DEP = (n: number) =>
  parse(DependencyId)(`dep_00000000-0000-7000-8000-00000000000${n}`);
const DEL = (n: number) =>
  parse(DeliverableId)(`del_00000000-0000-7000-8000-00000000000${n}`);
const ART_1 = parse(ArtifactId)("art_00000000-0000-7000-8000-000000000001");
const REV = (n: number) => parse(DependencyRevision)(n);

const expectedOf = (
  kind: string,
  roles: ReadonlyArray<string>,
): ExpectedDeliverable =>
  ({
    kind: kind as never as DeliverableKind,
    requiredArtifactRoles: roles as never as ReadonlyArray<ArtifactRole>,
  }) as ExpectedDeliverable;

const seedBase = Effect.gen(function* () {
  yield* p9Boot;
  yield* p7SeedProject;
  const consumer = yield* p7SeedWork(WORK_C, ASSIGN_CMD_C);
  expect(consumer.resolution._tag).toBe("Committed");
  const producer = yield* p7SeedWork(WORK_P, ASSIGN_CMD_P);
  expect(producer.resolution._tag).toBe("Committed");
});

const seedDependency = (
  dependencyId: DependencyId,
  producerBinding: ProducerBinding,
  expected: ExpectedDeliverable,
) =>
  Effect.gen(function* () {
    const tx = yield* TransactionPort;
    const dependencies = yield* DependencyRepository;
    yield* tx.transact(
      dependencies.insert(
        declareDependency({
          dependencyId,
          consumerWorkId: WORK_C,
          producerBinding,
          revision: REV(0),
          expectedDeliverable: expected,
        }),
        p7Project,
      ),
    );
  });

const seedDeliverable = (
  deliverableId: DeliverableId,
  kind: string,
  roles: ReadonlyArray<string>,
) =>
  Effect.gen(function* () {
    const tx = yield* TransactionPort;
    const deliverables = yield* DeliverableRepository;
    yield* tx.transact(
      deliverables.insert(
        {
          deliverableId,
          sourceWorkId: WORK_P,
          sourceWorkRevision: 0,
          kind,
        },
        roles.map((role) => ({ role, artifactId: ART_1 })),
        p7Project,
      ),
    );
  });

/** Journal one event exactly as the producing side would (P1 face). */
const journalEvent = (eventType: string, payload: unknown, eventVersion = 1) =>
  Effect.gen(function* () {
    const tx = yield* TransactionPort;
    const journal = yield* DomainEventJournal;
    yield* tx.transact(
      journal.append([
        {
          projectId: p7Project,
          eventType: eventType as EventTypeName,
          eventVersion,
          occurredAt: "t",
          aggregateRef: p7Project,
          actor: p7TestActor,
          payload,
        },
      ]),
    );
  });

const producedPayload = (n: number) => ({
  deliverableId: DEL(n),
  sourceWorkId: WORK_P,
  sourceWorkRevision: 0,
  kind: "report",
  artifactRoles: ["summary"],
});

const loopStores: Effect.Effect<
  ConsumerLoopStores,
  never,
  | TransactionPort
  | DomainEventJournal
  | ConsumerOffsetStore
  | ConsumerDeadLetterStore
  | ProjectionStore
> = Effect.gen(function* () {
  const tx = yield* TransactionPort;
  const journal = yield* DomainEventJournal;
  const offsets = yield* ConsumerOffsetStore;
  const deadLetters = yield* ConsumerDeadLetterStore;
  const projection = yield* ProjectionStore;
  return {
    tx: { transact: tx.transact },
    journal: { readAfter: journal.readAfter },
    offsets,
    deadLetters,
    projection,
  };
});

/** Current project journal head (sequence of the last journaled event). */
const journalHead = Effect.gen(function* () {
  const tx = yield* TransactionPort;
  const journal = yield* DomainEventJournal;
  return yield* tx.transact(journal.lastSequence(p7Project));
});

/** Advance the consumer offset to the current seeded head with a no-op
 * handler, so the case's own injections start from a known offset. */
const preconsume = (consumerId: string) =>
  Effect.gen(function* () {
    const stores = yield* loopStores;
    const head = yield* journalHead;
    yield* pollOnce(consumerId, p7Project, 1000, {
      ...stores,
      handlers: () => Effect.succeed([]),
    });
    return head;
  });

/** p7-coordinator test deps shape (repositories + direct-SQL listing). */
const makeCoordinatorDeps = (
  wrapGateway?: (gateway: CommandGatewayService) => CommandGatewayService,
) =>
  Effect.gen(function* () {
    const gateway = yield* CommandGateway;
    const tx = yield* TransactionPort;
    const sql = yield* SqlClient;
    const dependencies = yield* DependencyRepository;
    const deliverables = yield* DeliverableRepository;
    const works = yield* WorkRepository;
    return {
      gateway: wrapGateway === undefined ? gateway : wrapGateway(gateway),
      dependencies: {
        listUnsatisfiedByProject: (projectId: ProjectId) =>
          tx.transact(dependencies.listUnsatisfiedByProject(projectId)),
      },
      deliverables: {
        findById: (deliverableId: DeliverableId) =>
          tx.transact(deliverables.findById(deliverableId)),
        listArtifactRoles: (deliverableId: DeliverableId) =>
          tx.transact(deliverables.listArtifactRoles(deliverableId)),
        deliverablesByProject: (projectId: ProjectId) =>
          tx.transact(
            Effect.gen(function* () {
              const rows = yield* sql.unsafe<{
                readonly deliverable_id: string;
                readonly source_work_id: string;
                readonly source_work_revision: number;
                readonly kind: string;
                readonly role: string | null;
              }>(
                "SELECT d.deliverable_id, d.source_work_id, d.source_work_revision, d.kind, a.role FROM deliverables d LEFT JOIN deliverable_artifacts a ON a.deliverable_id = d.deliverable_id WHERE d.project_id = ? ORDER BY d.deliverable_id, a.role",
                [projectId],
              );
              const snapshots = new Map<
                string,
                {
                  deliverableId: DeliverableId;
                  sourceWorkId: WorkId;
                  sourceWorkRevision: number;
                  kind: string;
                  artifactRoles: string[];
                }
              >();
              for (const row of rows) {
                const current = snapshots.get(row.deliverable_id);
                if (current === undefined) {
                  snapshots.set(row.deliverable_id, {
                    deliverableId: row.deliverable_id as DeliverableId,
                    sourceWorkId: row.source_work_id as WorkId,
                    sourceWorkRevision: row.source_work_revision,
                    kind: row.kind,
                    artifactRoles: row.role === null ? [] : [row.role],
                  });
                } else if (row.role !== null) {
                  current.artifactRoles.push(row.role);
                }
              }
              return [...snapshots.values()];
            }),
          ),
      },
      works: {
        findById: (workId: WorkId) => tx.transact(works.findById(workId)),
      },
    };
  });

/** p8-consumer-B test deps shape. */
const makeCompletionDeps = () =>
  Effect.gen(function* () {
    const gateway = yield* CommandGateway;
    const tx = yield* TransactionPort;
    const works = yield* WorkRepository;
    const verifications = yield* VerificationRepository;
    const acceptances = yield* AcceptanceRepository;
    return {
      gateway,
      verifications: {
        findById: (
          verificationId: import("../packages/domain/dist/index.js").VerificationId,
        ) => tx.transact(verifications.findById(verificationId)),
      },
      acceptances: {
        findByWorkRevision: (workId: WorkId, targetWorkRevision: number) =>
          tx.transact(
            acceptances.findByWorkRevision(workId, targetWorkRevision),
          ),
      },
      works: {
        findById: (workId: WorkId) => tx.transact(works.findById(workId)),
      },
    };
  });

const storedDependency = (dependencyId: DependencyId) =>
  Effect.gen(function* () {
    const tx = yield* TransactionPort;
    const dependencies = yield* DependencyRepository;
    const found = yield* tx.transact(dependencies.findById(dependencyId));
    expect(Option.isSome(found)).toBe(true);
    return Option.isSome(found) ? found.value : undefined;
  });

const offsetOf = (consumerId: string) =>
  Effect.gen(function* () {
    const tx = yield* TransactionPort;
    const offsets = yield* ConsumerOffsetStore;
    return yield* tx.transact(offsets.read(consumerId, p7Project));
  });

const projectionCount = Effect.gen(function* () {
  const sql = yield* SqlClient;
  const rows = yield* sql.unsafe<{ count: number }>(
    "SELECT COUNT(*) AS count FROM projection_state",
  );
  return Number(rows[0]?.count ?? 0);
});

const deadLetterRows = (consumerId: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    return yield* sql.unsafe<{ sequence: number; reason: string }>(
      "SELECT sequence, reason FROM consumer_dead_letters WHERE consumer_id = ? ORDER BY sequence",
      [consumerId],
    );
  });

const countEvents = (eventType: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    const rows = yield* sql.unsafe<{ n: number }>(
      "SELECT COUNT(*) AS n FROM domain_events WHERE event_type = ?",
      [eventType],
    );
    return Number(rows[0]?.n ?? 0);
  });

/** Gateway wrapper: arm the commit gate after the handler's command
 * transaction landed (CC-1 injection point: apply done, advance not yet). */
const armingGateway = (
  gateway: CommandGatewayService,
  gate: { armed: boolean },
): CommandGatewayService => ({
  execute: (envelope, context, authority) =>
    gateway.execute(envelope, context, authority).pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          gate.armed = true;
        }),
      ),
    ) as never,
});

describe("p9-consumer-crash (CC-1..CC-6, 02 §7 / 05 §1–§2)", () => {
  it("CC-1 [crash-injected]: mid-batch abort after apply before advance — apply+advance are ONE transaction, both roll back, re-run re-applies idempotently", async () => {
    expect(labeled("CC-1-mid-batch-commit", "crash-injected").guarantee).toBe(
      "crash-injected",
    );
    const gate = commitGate();
    await runP9Consumer(
      Effect.gen(function* () {
        yield* seedBase;
        yield* seedDependency(
          DEP(1),
          { _tag: "AnyProducer" },
          expectedOf("report", ["summary"]),
        );
        yield* seedDeliverable(DEL(1), "report", ["summary"]);
        const head = yield* preconsume("cc1");
        const baseProjection = yield* projectionCount;
        yield* journalEvent("DeliverableProduced", producedPayload(1));
        const stores = yield* loopStores;
        const arming = yield* makeCoordinatorDeps((gateway) =>
          armingGateway(gateway, gate),
        );
        const failure = yield* pollOnce("cc1", p7Project, 10, {
          ...stores,
          handlers: dependencyCoordinatorLoop(
            p7Project,
            p7TestPrincipal,
            arming,
          ),
        }).pipe(Effect.flip);
        expect(failure._tag).toBe("TransactionOperationalFailure");
        // The offset NEVER advances without the apply: both rolled back.
        expect(yield* offsetOf("cc1")).toBe(head);
        expect(yield* projectionCount).toBe(baseProjection);
        // The handler's command transaction already committed exactly once.
        const stored = yield* storedDependency(DEP(1));
        expect(stored?.state).toBe("Satisfied");
        expect(stored?.satisfiedByDeliverableId).toBe(DEL(1));
        expect(yield* countEvents("DependencySatisfied")).toBe(1);
        // Re-run (crash recovery): redelivery re-submits the deterministic
        // CommandId, the stored receipt absorbs it — no duplicate effect.
        const clean = yield* makeCoordinatorDeps();
        const result = yield* pollOnce("cc1", p7Project, 10, {
          ...stores,
          handlers: dependencyCoordinatorLoop(
            p7Project,
            p7TestPrincipal,
            clean,
          ),
        });
        // The crashed run's committed SatisfyDependency journaled
        // DependencySatisfied — the clean poll re-delivers both events.
        const finalHead = yield* journalHead;
        expect(result.applied).toBe(finalHead - head);
        expect(yield* offsetOf("cc1")).toBe(finalHead);
        expect(yield* projectionCount).toBe(
          baseProjection + (finalHead - head),
        );
        expect(yield* countEvents("DependencySatisfied")).toBe(1);
        const after = yield* storedDependency(DEP(1));
        expect(after?.state).toBe("Satisfied");
        expect(after?.satisfiedByDeliverableId).toBe(DEL(1));
      }),
      makeP9ConsumerApp({ transaction: gatedTransactionPort(gate) }),
    );
  });

  it("CC-2 [crash-injected]: offset row deleted / regressed below the true position — full/stale replay absorbed by deterministic CommandId; dead-letter re-quarantine is a no-op", async () => {
    expect(labeled("CC-2-offset-loss", "crash-injected").guarantee).toBe(
      "crash-injected",
    );
    await runP9Consumer(
      Effect.gen(function* () {
        yield* seedBase;
        yield* seedDependency(
          DEP(2),
          { _tag: "AnyProducer" },
          expectedOf("report", ["summary"]),
        );
        yield* seedDeliverable(DEL(2), "report", ["summary"]);
        const head = yield* preconsume("cc2");
        yield* journalEvent("DeliverableProduced", producedPayload(2));
        yield* journalEvent("WorkspaceCreated", {}, 2);
        const stores = yield* loopStores;
        const deps = yield* makeCoordinatorDeps();
        const first = yield* pollOnce("cc2", p7Project, 10, {
          ...stores,
          handlers: dependencyCoordinatorLoop(p7Project, p7TestPrincipal, deps),
        });
        expect(first.applied).toBe(1);
        expect(first.quarantined).toBe(1);
        // The committed SatisfyDependency journaled DependencySatisfied.
        const afterFirst = yield* journalHead;
        expect(afterFirst).toBe(head + 3);
        // The batch read happened before DependencySatisfied journaled:
        // the offset advanced to the delivered batch end, not the head.
        expect(yield* offsetOf("cc2")).toBe(head + 2);
        const sql = yield* SqlClient;
        // Regress the offset below the true position (stale replay).
        yield* sql.unsafe(
          "UPDATE consumer_offsets SET last_sequence = 0 WHERE consumer_id = ?",
          ["cc2"],
        );
        const replay = yield* pollOnce("cc2", p7Project, 1000, {
          ...stores,
          handlers: dependencyCoordinatorLoop(p7Project, p7TestPrincipal, deps),
        });
        // Full replay from the effective retained floor: every event
        // re-delivered (except the poison), nothing duplicated.
        expect(replay.applied).toBe(afterFirst - 1);
        expect(replay.quarantined).toBe(1);
        expect(yield* countEvents("DependencySatisfied")).toBe(1);
        expect(yield* projectionCount).toBe(afterFirst - 1);
        expect(
          (yield* deadLetterRows("cc2")).map((row) => row.sequence),
        ).toEqual([head + 2]);
        const stored = yield* storedDependency(DEP(2));
        expect(stored?.state).toBe("Satisfied");
        // Delete the offset row entirely (absent → read returns 0).
        yield* sql.unsafe(
          "DELETE FROM consumer_offsets WHERE consumer_id = ?",
          ["cc2"],
        );
        expect(yield* offsetOf("cc2")).toBe(0);
        const replay2 = yield* pollOnce("cc2", p7Project, 1000, {
          ...stores,
          handlers: dependencyCoordinatorLoop(p7Project, p7TestPrincipal, deps),
        });
        expect(replay2.applied).toBe(afterFirst - 1);
        expect(replay2.quarantined).toBe(1);
        expect(yield* countEvents("DependencySatisfied")).toBe(1);
        expect(yield* projectionCount).toBe(afterFirst - 1);
        expect(
          (yield* deadLetterRows("cc2")).map((row) => row.sequence),
        ).toEqual([head + 2]);
      }),
      makeP9ConsumerApp(),
    );
  });

  it("CC-3 [crash-injected]: poison eventVersion above the reader ceiling — quarantine + advance in the SAME transaction, consumer never stalls", async () => {
    expect(labeled("CC-3-version-poison", "crash-injected").guarantee).toBe(
      "crash-injected",
    );
    await runP9Consumer(
      Effect.gen(function* () {
        yield* seedBase;
        const head = yield* preconsume("cc3");
        yield* journalEvent("DeliverableProduced", producedPayload(3));
        yield* journalEvent("WorkspaceCreated", {}, 2);
        yield* journalEvent("WorkspaceCreated", {});
        const stores = yield* loopStores;
        const deps = yield* makeCoordinatorDeps();
        const batch = yield* pollOnce("cc3", p7Project, 10, {
          ...stores,
          handlers: dependencyCoordinatorLoop(p7Project, p7TestPrincipal, deps),
        });
        expect(batch.applied).toBe(2);
        expect(batch.quarantined).toBe(1);
        expect(yield* offsetOf("cc3")).toBe(head + 3);
        const dead = yield* deadLetterRows("cc3");
        expect(dead.map((row) => row.sequence)).toEqual([head + 2]);
        expect(dead[0]!.reason).toContain("unsupported eventVersion 2");
        // No head-of-line block: the batch after the poison one is empty.
        const next = yield* pollOnce("cc3", p7Project, 10, {
          ...stores,
          handlers: dependencyCoordinatorLoop(p7Project, p7TestPrincipal, deps),
        });
        expect(next.applied).toBe(0);
        expect(next.quarantined).toBe(0);
        expect(next.lastSequence).toBe(head + 3);
      }),
      makeP9ConsumerApp(),
    );
  });

  it("CC-4a [crash-injected]: deterministic handler defect — dead-letter + skip + advance; the batch is not interrupted", async () => {
    expect(labeled("CC-4-handler-defect", "crash-injected").guarantee).toBe(
      "crash-injected",
    );
    await runP9Consumer(
      Effect.gen(function* () {
        yield* seedBase;
        const head = yield* preconsume("cc4a");
        yield* journalEvent("DeliverableProduced", producedPayload(4));
        yield* journalEvent("WorkspaceCreated", { poison: true });
        yield* journalEvent("WorkspaceCreated", {});
        const stores = yield* loopStores;
        const result = yield* pollOnce("cc4a", p7Project, 10, {
          ...stores,
          handlers: (events) =>
            (events[0]?.payload as { poison?: boolean } | undefined)?.poison ===
            true
              ? Effect.die(new Error("decode defect: schema mismatch"))
              : Effect.succeed(["ok"]),
        });
        expect(result.applied).toBe(2);
        expect(result.quarantined).toBe(1);
        expect(yield* offsetOf("cc4a")).toBe(head + 3);
        const dead = yield* deadLetterRows("cc4a");
        expect(dead.map((row) => row.sequence)).toEqual([head + 2]);
        expect(dead[0]!.reason).toContain("handler defect");
      }),
      makeP9ConsumerApp(),
    );
  });

  it("CC-4b [crash-injected]: typed DomainError rejection is NOT poison — recorded outcome, no dead-letter, offset advances (wired consumer B)", async () => {
    expect(labeled("CC-4-typed-not-poison", "crash-injected").guarantee).toBe(
      "crash-injected",
    );
    await runP9Consumer(
      Effect.gen(function* () {
        yield* seedBase;
        const head = yield* preconsume("cc4b");
        // Forged WorkOutcomeAccepted with no acceptance row: the
        // CompleteWork handler's typed seven-fold rejection is a recorded
        // outcome, never a poison quarantine.
        yield* journalEvent("WorkOutcomeAccepted", {
          acceptanceId: "acc_forged",
          workId: WORK_C,
          targetWorkRevision: 0,
          verificationId: "ver_00000000-0000-7000-8000-000000000099",
        });
        const stores = yield* loopStores;
        const deps = yield* makeCompletionDeps();
        const result = yield* pollOnce("cc4b", p7Project, 10, {
          ...stores,
          handlers: completionConsumerLoop(p7Project, p7TestPrincipal, deps),
        });
        expect(result.records).toEqual(["skip:VerificationAcceptanceMismatch"]);
        expect(result.quarantined).toBe(0);
        expect(yield* offsetOf("cc4b")).toBe(head + 1);
        expect(yield* deadLetterRows("cc4b")).toEqual([]);
      }),
      makeP9ConsumerApp(),
    );
  });

  it("CC-4c/PB3 [crash-injected]: transient operational failure aborts the batch and retries — never dead-letter, offset stays", async () => {
    expect(labeled("CC-4-transient-abort", "crash-injected").guarantee).toBe(
      "crash-injected",
    );
    await runP9Consumer(
      Effect.gen(function* () {
        yield* seedBase;
        const head = yield* preconsume("cc4c");
        yield* journalEvent("DeliverableProduced", producedPayload(5));
        const stores = yield* loopStores;
        let calls = 0;
        const failure = yield* pollOnce("cc4c", p7Project, 10, {
          ...stores,
          handlers: () => {
            calls += 1;
            return Effect.die({
              _tag: "TransactionOperationalFailure",
              cause: "injected:busy",
            });
          },
        }).pipe(Effect.flip);
        expect(failure._tag).toBe("TransactionOperationalFailure");
        expect(yield* offsetOf("cc4c")).toBe(head);
        expect(yield* deadLetterRows("cc4c")).toEqual([]);
        expect(calls).toBe(1);
        // Retry (bounded, new attempt): converges on the same batch.
        yield* seedDependency(
          DEP(5),
          { _tag: "AnyProducer" },
          expectedOf("report", ["summary"]),
        );
        yield* seedDeliverable(DEL(5), "report", ["summary"]);
        const deps = yield* makeCoordinatorDeps();
        const retry = yield* pollOnce("cc4c", p7Project, 10, {
          ...stores,
          handlers: dependencyCoordinatorLoop(p7Project, p7TestPrincipal, deps),
        });
        expect(retry.applied).toBe(1);
        expect(yield* offsetOf("cc4c")).toBe(head + 1);
      }),
      makeP9ConsumerApp(),
    );
  });

  it("CC-6 [crash-injected]: concurrent double-dispatch of one consumer — overlap is harmless: idempotent re-apply, single canonical effect", async () => {
    expect(labeled("CC-6-double-dispatch", "crash-injected").guarantee).toBe(
      "crash-injected",
    );
    const dir = mkdtempSync(join(tmpdir(), "arbor-p9-cc6-"));
    await runP9Consumer(
      Effect.gen(function* () {
        yield* seedBase;
        yield* seedDependency(
          DEP(6),
          { _tag: "AnyProducer" },
          expectedOf("report", ["summary"]),
        );
        yield* seedDeliverable(DEL(6), "report", ["summary"]);
        yield* preconsume("cc6");
        yield* journalEvent("DeliverableProduced", producedPayload(6));
        const stores = yield* loopStores;
        const depsA = yield* makeCoordinatorDeps();
        const depsB = yield* makeCoordinatorDeps();
        const results = yield* Effect.all(
          [
            pollOnce("cc6", p7Project, 10, {
              ...stores,
              handlers: dependencyCoordinatorLoop(
                p7Project,
                p7TestPrincipal,
                depsA,
              ),
            }),
            pollOnce("cc6", p7Project, 10, {
              ...stores,
              handlers: dependencyCoordinatorLoop(
                p7Project,
                p7TestPrincipal,
                depsB,
              ),
            }),
          ],
          { concurrency: 2 },
        );
        // Both dispatches complete; the overlap is absorbed. A stale
        // overlap may leave the offset transiently behind — one settle
        // poll re-delivers idempotently (the overlap-harmless face).
        expect(results).toHaveLength(2);
        const settle = yield* makeCoordinatorDeps();
        yield* pollOnce("cc6", p7Project, 10, {
          ...stores,
          handlers: dependencyCoordinatorLoop(
            p7Project,
            p7TestPrincipal,
            settle,
          ),
        });
        const finalHead = yield* journalHead;
        expect(yield* offsetOf("cc6")).toBe(finalHead);
        expect(yield* projectionCount).toBe(finalHead);
        expect(yield* countEvents("DependencySatisfied")).toBe(1);
        const stored = yield* storedDependency(DEP(6));
        expect(stored?.state).toBe("Satisfied");
        expect(stored?.satisfiedByDeliverableId).toBe(DEL(6));
      }),
      makeP9ConsumerApp({ filename: join(dir, "cc6.db") }),
    );
  });
});
