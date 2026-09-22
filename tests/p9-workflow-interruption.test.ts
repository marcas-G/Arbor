import { Effect, Layer, Option } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { describe, expect, it } from "vitest";
import { satisfactionCommandId } from "../packages/application/src/commands/satisfy-dependency.js";
import {
  type ConsumerLoopStores,
  completionConsumerLoop,
  dependencyCoordinatorLoop,
  pollOnce,
  verificationConsumerLoop,
} from "../packages/application/src/consumer-loop.js";
import type { CommandGatewayService } from "../packages/application/src/gateway.js";
import {
  CommandGateway,
  semanticRequestFingerprint,
} from "../packages/application/src/index.js";
import { verificationSpawnIds } from "../packages/application/src/verification-consumer.js";
import {
  ensureVerifierSpawned,
  verifierAdmitCommandId,
} from "../packages/application/src/verifier-spawn.js";
import {
  AcceptanceId,
  ArtifactId,
  type ArtifactRole,
  CommandId,
  type CommandSubmissionContext,
  DeliverableId,
  type DeliverableKind,
  DependencyId,
  DependencyRevision,
  declareDependency,
  type EventTypeName,
  type ExecutionId,
  type ExpectedDeliverable,
  type Principal,
  parse,
  startVerification,
  VerificationId,
  type VerificationMission,
  WorkId,
  WorkRevision,
  type WorkspaceId,
} from "../packages/domain/dist/index.js";
import {
  preDispatchCheck,
  runRecovery,
  type SettleExecutionPayload,
  sweepRecovery,
} from "../packages/execution-runtime/src/index.js";
import {
  Clock,
  ConsumerDeadLetterStore,
  ConsumerOffsetStore,
  DeliverableRepository,
  DependencyRepository,
  DomainEventJournal,
  ExecutionRepository,
  ExecutionScheduler,
  LeaseService,
  ProjectionStore,
  TransactionPort,
  VerificationRepository,
  WorkerDispatchPort,
  WorkRepository,
  WorkspaceRepository,
} from "../packages/ports/src/index.js";
import {
  p7Project,
  p7RootWorkspace,
  p7SeedProject,
  p7SeedWork,
  p7TestActor,
  p7TestPrincipal,
} from "./support/p7-app.js";
import {
  makeP9ConsumerApp,
  p9Boot,
  runP9Consumer,
} from "./support/p9-consumer-app.js";
import { labeled } from "./support/p9-harness-api.js";

/** P9-012 — P7/P8 workflow interruption replay (WF1–WF3, 02 §8) +
 * dispatch failure / lost dispatch (DF1–DF2, 02 §9 / 04 §4) + D5.
 * Interruptions are injected at the wired consumer path (P9-010 loops)
 * and at the dispatch port; convergence is asserted as identical
 * canonical state. Every case is labeled crash-injected (GQ5). */

const WORK_1 = parse(WorkId)("wrk_00000000-0000-7000-8000-000000000001");
const WORK_P = parse(WorkId)("wrk_00000000-0000-7000-8000-000000000002");
const ASSIGN_CMD_1 = parse(CommandId)(
  "cmd_018f2b3c-4d5e-7abc-8def-0123456789e1",
);
const ASSIGN_CMD_P = parse(CommandId)(
  "cmd_018f2b3c-4d5e-7abc-8def-0123456789e2",
);

const VER = (n: number) =>
  parse(VerificationId)(`ver_00000000-0000-7000-8000-0000000000${n}`);
const ACC = (n: number) =>
  parse(AcceptanceId)(`acc_00000000-0000-7000-8000-0000000000${n}`);
const WREV = (n: number) => parse(WorkRevision)(n);
const DEP_W1 = parse(DependencyId)("dep_00000000-0000-7000-8000-0000000000a1");
const DEL_W1 = parse(DeliverableId)("del_00000000-0000-7000-8000-0000000000a2");
const ART_W1 = parse(ArtifactId)("art_00000000-0000-7000-8000-0000000000a3");
const REV = (n: number) => parse(DependencyRevision)(n);

const MISSION: VerificationMission = {
  goal: "verify the completed outcome",
  criteria: [
    { criterionId: "c1", requirement: "tests pass", required: true },
    { criterionId: "c2", requirement: "lint clean", required: false },
  ],
  riskRequirements: [],
};

const expectedOf = (
  kind: string,
  roles: ReadonlyArray<string>,
): ExpectedDeliverable =>
  ({
    kind: kind as never as DeliverableKind,
    requiredArtifactRoles: roles as never as ReadonlyArray<ArtifactRole>,
  }) as ExpectedDeliverable;

const seedProjectAndWork = Effect.gen(function* () {
  yield* p9Boot;
  yield* p7SeedProject;
  const receipt = yield* p7SeedWork(WORK_1, ASSIGN_CMD_1);
  expect(receipt.resolution._tag).toBe("Committed");
  const sql = yield* SqlClient;
  yield* sql.unsafe(
    "UPDATE works SET verification_mission = ? WHERE work_id = ?",
    [JSON.stringify(MISSION), WORK_1],
  );
});

const journalEvent = (eventType: string, payload: unknown) =>
  Effect.gen(function* () {
    const tx = yield* TransactionPort;
    const journal = yield* DomainEventJournal;
    yield* tx.transact(
      journal.append([
        {
          projectId: p7Project,
          eventType: eventType as EventTypeName,
          eventVersion: 1,
          occurredAt: "t",
          aggregateRef: p7Project,
          actor: p7TestActor,
          payload,
        },
      ]),
    );
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

const journalHead = Effect.gen(function* () {
  const tx = yield* TransactionPort;
  const journal = yield* DomainEventJournal;
  return yield* tx.transact(journal.lastSequence(p7Project));
});

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

const offsetOf = (consumerId: string) =>
  Effect.gen(function* () {
    const tx = yield* TransactionPort;
    const offsets = yield* ConsumerOffsetStore;
    return yield* tx.transact(offsets.read(consumerId, p7Project));
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

const countRows = (
  table: string,
  where = "1=1",
  params: ReadonlyArray<unknown> = [],
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    const rows = yield* sql.unsafe<{ n: number }>(
      `SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`,
      params,
    );
    return Number(rows[0]?.n ?? 0);
  });

/** One-shot pre-commit interruption at the gateway (WF1/WF3): the first
 * matching submission dies with the transient operational class — the
 * loop aborts the batch (offset stays), redelivery retries. */
const transientOnceGateway = (
  gateway: CommandGatewayService,
  commandType: string,
): { gateway: CommandGatewayService; fired: () => boolean } => {
  let fired = false;
  return {
    fired: () => fired,
    gateway: {
      execute: (envelope, context, authority) =>
        Effect.suspend(() => {
          if (!fired && envelope.commandType === commandType) {
            fired = true;
            return Effect.die({
              _tag: "TransactionOperationalFailure",
              cause: "harness-kill:pre-commit",
            }) as never;
          }
          return gateway.execute(envelope, context, authority);
        }) as never,
    },
  };
};

const makeVerificationDeps = (gateway: CommandGatewayService) =>
  Effect.gen(function* () {
    const tx = yield* TransactionPort;
    const verifications = yield* VerificationRepository;
    const works = yield* WorkRepository;
    const workspaces = yield* WorkspaceRepository;
    return {
      gateway,
      verifications: {
        findOpenByWorkRevision: (workId: WorkId, targetWorkRevision: number) =>
          tx.transact(
            verifications.findOpenByWorkRevision(workId, targetWorkRevision),
          ),
        findById: (verificationId: VerificationId) =>
          tx.transact(verifications.findById(verificationId)),
      },
      works: {
        findById: (workId: WorkId) => tx.transact(works.findById(workId)),
      },
      workspaces: {
        findById: (workspaceId: WorkspaceId) =>
          tx.transact(workspaces.findById(workspaceId)),
      },
    };
  });

const makeCompletionDeps = () =>
  Effect.gen(function* () {
    const gateway = yield* CommandGateway;
    const tx = yield* TransactionPort;
    const works = yield* WorkRepository;
    const verifications = yield* VerificationRepository;
    return {
      gateway,
      verifications: {
        findById: (verificationId: VerificationId) =>
          tx.transact(verifications.findById(verificationId)),
      },
      acceptances: {
        findByWorkRevision: () => Effect.succeed(Option.none()),
      },
      works: {
        findById: (workId: WorkId) => tx.transact(works.findById(workId)),
      },
    };
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
        listUnsatisfiedByProject: (projectId: typeof p7Project) =>
          tx.transact(dependencies.listUnsatisfiedByProject(projectId)),
      },
      deliverables: {
        findById: (deliverableId: DeliverableId) =>
          tx.transact(deliverables.findById(deliverableId)),
        listArtifactRoles: (deliverableId: DeliverableId) =>
          tx.transact(deliverables.listArtifactRoles(deliverableId)),
        deliverablesByProject: (projectId: typeof p7Project) =>
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

const seedDependencyAndDeliverable = Effect.gen(function* () {
  const tx = yield* TransactionPort;
  const dependencies = yield* DependencyRepository;
  const deliverables = yield* DeliverableRepository;
  yield* tx.transact(
    dependencies.insert(
      declareDependency({
        dependencyId: DEP_W1,
        consumerWorkId: WORK_1,
        producerBinding: { _tag: "AnyProducer" },
        revision: REV(0),
        expectedDeliverable: expectedOf("report", ["summary"]),
      }),
      p7Project,
    ),
  );
  yield* tx.transact(
    deliverables.insert(
      {
        deliverableId: DEL_W1,
        sourceWorkId: WORK_P,
        sourceWorkRevision: 0,
        kind: "report",
      },
      [{ role: "summary", artifactId: ART_W1 }],
      p7Project,
    ),
  );
});

/** Raw Active execution fixture (p9-recovery-driver precedent). */
const INSERT_EXECUTION = (executionId: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    yield* sql.unsafe(
      "INSERT INTO sessions (session_id, binding_kind, workspace_id, execution_id, context_epoch, created_at) VALUES (?,?,NULL,?,0,'t')",
      [`ses_${executionId}`, "ExecutionScoped", executionId],
    );
    yield* sql.unsafe(
      "INSERT INTO executions (execution_id, project_id, binding_kind, workspace_id, mission, session_id, admitted_at, stop_requested_at, settlement_kind, settlement_json, settled_at) VALUES (?,?, 'execution_bound', ?, 'm', ?, 't', NULL, NULL, NULL, NULL)",
      [executionId, p7Project, p7RootWorkspace, `ses_${executionId}`],
    );
  });

/** Raw Active MAIN execution fixture: the DF2 reevaluate face keys on
 * binding_kind 'workspace' (P2 `05` §8 single-flight conflict). */
const INSERT_MAIN_EXECUTION = (executionId: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    yield* sql.unsafe(
      "INSERT INTO sessions (session_id, binding_kind, workspace_id, execution_id, context_epoch, created_at) VALUES (?,?,NULL,?,0,'t')",
      [`ses_${executionId}`, "ExecutionScoped", executionId],
    );
    yield* sql.unsafe(
      "INSERT INTO executions (execution_id, project_id, binding_kind, workspace_id, focus_kind, focus_work_id, parent_execution_id, mission, session_id, admitted_at, stop_requested_at, settlement_kind, settlement_json, settled_at) VALUES (?,?, 'workspace', ?, 'coordination', NULL, NULL, NULL, ?, 't', NULL, NULL, NULL, NULL)",
      [executionId, p7Project, p7RootWorkspace, `ses_${executionId}`],
    );
  });

const executionSettlement = (executionId: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    const rows = yield* sql.unsafe<{ settlement_kind: string | null }>(
      "SELECT settlement_kind FROM executions WHERE execution_id = ?",
      [executionId],
    );
    return rows.length === 0 ? "missing" : (rows[0]!.settlement_kind ?? null);
  });

const dispatchRound = (
  executionId: string,
  port: Layer.Layer<WorkerDispatchPort>,
) =>
  Effect.provide(
    Effect.gen(function* () {
      const dispatch = yield* WorkerDispatchPort;
      yield* dispatch.dispatch({
        executionId: executionId as never as ExecutionId,
        workspaceId: p7RootWorkspace,
        workerKind: "Agent",
      });
    }),
    port,
  );

const dyingDispatch = (): Layer.Layer<WorkerDispatchPort> =>
  Layer.succeed(WorkerDispatchPort, {
    dispatch: () => Effect.die(new Error("harness-kill:dispatch")),
  });

const recordingDispatch = (
  sink: Array<string>,
): Layer.Layer<WorkerDispatchPort> =>
  Layer.succeed(WorkerDispatchPort, {
    dispatch: (request) =>
      Effect.sync(() => {
        sink.push(request.executionId as string);
        return { dispatchId: `tkt_${sink.length}`, acceptedAt: "t" };
      }),
  });

const settleCompleted = (executionId: string) =>
  Effect.gen(function* () {
    const gateway = yield* CommandGateway;
    const tx = yield* TransactionPort;
    const leases = yield* LeaseService;
    const lease = yield* tx.transact(
      leases.acquire(executionId as never as ExecutionId, "worker:p9df"),
    );
    const payload: SettleExecutionPayload = {
      executionId: executionId as never as ExecutionId,
      settlement: {
        _tag: "Completed",
        result: { _tag: "CoordinationCompleted" },
      },
      expectedFencingGeneration: lease.generation,
    };
    const commandId = `cmd_settle_p9df_${executionId}` as never as CommandId;
    return yield* gateway.execute(
      {
        commandType: "SettleExecution",
        commandId,
        projectId: p7Project,
        actor: p7TestPrincipal as never,
        issuedAt: "t",
        payload,
      },
      {
        _tag: "ExecutionOrigin",
        principal: p7TestPrincipal as Principal,
        executionId: executionId as never as ExecutionId,
        fencingGeneration: lease.generation,
      } satisfies CommandSubmissionContext,
      {
        _tag: "SettleExecutionAuthority",
        submissionOrigin: "ExecutionOrigin",
        principal: p7TestPrincipal as Principal,
        commandId,
        semanticRequestFingerprint: semanticRequestFingerprint({
          commandType: "SettleExecution",
          projectId: p7Project,
          actor: p7TestPrincipal as never,
          schemaVersion: "1",
          payload,
        }),
        projectId: p7Project,
        commandKind: "SettleExecution",
        executionId: executionId as never as ExecutionId,
        fencingGeneration: lease.generation,
      },
    );
  });

describe("p9-workflow-interruption (WF1–WF3 / DF1–DF2 / D5)", () => {
  it("WF1 [crash-injected]: coordinator consumption interrupted before the SatisfyDependency commit — redelivery converges to the identical canonical state", async () => {
    expect(
      labeled("WF1-coordinator-interruption", "crash-injected").guarantee,
    ).toBe("crash-injected");
    await runP9Consumer(
      Effect.gen(function* () {
        yield* seedProjectAndWork;
        const producer = yield* p7SeedWork(WORK_P, ASSIGN_CMD_P);
        expect(producer.resolution._tag).toBe("Committed");
        yield* seedDependencyAndDeliverable;
        const head = yield* preconsume("wf1");
        yield* journalEvent("DeliverableProduced", {
          deliverableId: DEL_W1,
          sourceWorkId: WORK_P,
          sourceWorkRevision: 0,
          kind: "report",
          artifactRoles: ["summary"],
        });
        const stores = yield* loopStores;
        const gateway = yield* CommandGateway;
        const interrupted = transientOnceGateway(gateway, "SatisfyDependency");
        const failure = yield* pollOnce("wf1", p7Project, 10, {
          ...stores,
          handlers: dependencyCoordinatorLoop(
            p7Project,
            p7TestPrincipal,
            yield* makeCoordinatorDeps((base) => interrupted.gateway),
          ),
        }).pipe(Effect.flip);
        expect(failure._tag).toBe("TransactionOperationalFailure");
        expect(interrupted.fired()).toBe(true);
        // Nothing durable from the interruption: no command, no
        // satisfaction, offset stays.
        const satisfyCommandId = satisfactionCommandId(DEL_W1, DEP_W1, REV(0));
        expect(
          yield* countRows("commands", "command_id = ?", [satisfyCommandId]),
        ).toBe(0);
        expect(yield* countEvents("DependencySatisfied")).toBe(0);
        expect(yield* offsetOf("wf1")).toBe(head);
        // Redelivery (next dispatcher round) converges.
        const result = yield* pollOnce("wf1", p7Project, 10, {
          ...stores,
          handlers: dependencyCoordinatorLoop(
            p7Project,
            p7TestPrincipal,
            yield* makeCoordinatorDeps(),
          ),
        });
        expect(result.records).toContain("SatisfyDependency");
        expect(yield* countEvents("DependencySatisfied")).toBe(1);
        expect(
          yield* countRows(
            "dependencies",
            "dependency_id = ? AND state = 'Satisfied' AND satisfied_by_deliverable_id IS NOT NULL",
            [DEP_W1],
          ),
        ).toBe(1);
        expect(yield* offsetOf("wf1")).toBe(head + 1);
      }),
      makeP9ConsumerApp(),
    );
  });

  it("WF2 [crash-injected]: verifier spawn window closure — replay emits the needSpawn hint, re-spawn uses the same caller-preallocated id, AdmitExecution idempotent, no committed-without-Verifier state", async () => {
    expect(
      labeled("WF2-verifier-spawn-window", "crash-injected").guarantee,
    ).toBe("crash-injected");
    await runP9Consumer(
      Effect.gen(function* () {
        yield* seedProjectAndWork;
        const claimRef = "claim-wf2";
        const head = yield* preconsume("wf2");
        yield* journalEvent("ExecutionSettled", {
          executionId: "exe_00000000-0000-7000-8000-0000000000w2",
          workId: WORK_1,
          workRevision: 0,
          claimRef,
        });
        const stores = yield* loopStores;
        const gateway = yield* CommandGateway;
        const deps = yield* makeVerificationDeps(gateway);
        const first = yield* pollOnce("wf2", p7Project, 10, {
          ...stores,
          handlers: verificationConsumerLoop(p7Project, p7TestPrincipal, deps),
        });
        expect(first.records).toEqual(["StartVerification"]);
        const ids = verificationSpawnIds(WORK_1, 0, claimRef);
        // Crash window fixture: the StartVerification commit landed, the
        // spawn/backfill did not (un-backfilled Open row, no execution).
        const sql = yield* SqlClient;
        yield* sql.unsafe(
          "UPDATE verifications SET verification_execution_ids = '[]' WHERE verification_id = ?",
          [ids.verificationId],
        );
        expect(
          yield* countRows("executions", "execution_id = ?", [
            ids.verifierExecutionId,
          ]),
        ).toBe(0);
        // Replay: redelivery yields the needSpawn hint (no new
        // verification, no journal burn).
        yield* sql.unsafe(
          "UPDATE consumer_offsets SET last_sequence = ? WHERE consumer_id = ?",
          [head, "wf2"],
        );
        const replay = yield* pollOnce("wf2", p7Project, 10, {
          ...stores,
          handlers: verificationConsumerLoop(p7Project, p7TestPrincipal, deps),
        });
        expect(replay.records).toEqual([
          `needSpawn:${ids.verificationId}:${ids.verifierExecutionId}`,
        ]);
        expect(yield* countRows("verifications")).toBe(1);
        // Apply the hint with the SAME caller-preallocated id.
        const tx = yield* TransactionPort;
        const verifications = yield* VerificationRepository;
        const executions = yield* ExecutionRepository;
        const clock = yield* Clock;
        const stored = yield* tx.transact(
          verifications.findById(ids.verificationId),
        );
        expect(Option.isSome(stored)).toBe(true);
        if (Option.isNone(stored)) {
          return;
        }
        const verification = stored.value;
        const spawnDeps = {
          gateway,
          verifications,
          executions,
          tx,
          clock,
          principal: p7TestPrincipal as Principal,
        };
        const args = {
          verification,
          projectId: p7Project,
          ownerWorkspaceId: p7RootWorkspace,
          verifierExecutionId: ids.verifierExecutionId,
          missionDigest: "wf2",
        };
        const spawned = yield* ensureVerifierSpawned(args, spawnDeps);
        expect(spawned._tag).toBe("Spawned");
        expect(spawned._tag === "Spawned" ? spawned.admitted : false).toBe(
          true,
        );
        expect(
          yield* countRows("executions", "execution_id = ?", [
            ids.verifierExecutionId,
          ]),
        ).toBe(1);
        // Idempotent re-entry: Noop, no duplicate execution, backfill
        // present — no permanent committed-without-Verifier state.
        const again = yield* ensureVerifierSpawned(args, spawnDeps);
        expect(again._tag).toBe("Noop");
        expect(
          yield* countRows("executions", "execution_id = ?", [
            ids.verifierExecutionId,
          ]),
        ).toBe(1);
        expect(
          yield* countRows("commands", "command_id = ?", [
            verifierAdmitCommandId(ids.verificationId, ids.verifierExecutionId),
          ]),
        ).toBe(1);
        const backfilled = yield* tx.transact(
          verifications.findById(ids.verificationId),
        );
        expect(
          Option.isSome(backfilled)
            ? backfilled.value.verificationExecutionIds
            : [],
        ).toEqual([ids.verifierExecutionId]);
      }),
      makeP9ConsumerApp(),
    );
  });

  it("WF3a [crash-injected]: consumer A interrupted before the StartVerification commit — replay converges, exactly one Verification", async () => {
    expect(labeled("WF3-consumer-a", "crash-injected").guarantee).toBe(
      "crash-injected",
    );
    await runP9Consumer(
      Effect.gen(function* () {
        yield* seedProjectAndWork;
        const head = yield* preconsume("wf3a");
        yield* journalEvent("ExecutionSettled", {
          executionId: "exe_00000000-0000-7000-8000-0000000000wa",
          workId: WORK_1,
          workRevision: 0,
          claimRef: "claim-wf3a",
        });
        const stores = yield* loopStores;
        const gateway = yield* CommandGateway;
        const interrupted = transientOnceGateway(gateway, "StartVerification");
        const deps = yield* makeVerificationDeps(interrupted.gateway);
        const failure = yield* pollOnce("wf3a", p7Project, 10, {
          ...stores,
          handlers: verificationConsumerLoop(p7Project, p7TestPrincipal, deps),
        }).pipe(Effect.flip);
        expect(failure._tag).toBe("TransactionOperationalFailure");
        expect(interrupted.fired()).toBe(true);
        expect(yield* countRows("verifications")).toBe(0);
        expect(yield* countEvents("VerificationStarted")).toBe(0);
        expect(yield* offsetOf("wf3a")).toBe(head);
        // Replay converges: exactly one verification, one event.
        const clean = yield* makeVerificationDeps(gateway);
        const result = yield* pollOnce("wf3a", p7Project, 10, {
          ...stores,
          handlers: verificationConsumerLoop(p7Project, p7TestPrincipal, clean),
        });
        expect(result.records).toEqual(["StartVerification"]);
        expect(yield* countRows("verifications")).toBe(1);
        expect(yield* countEvents("VerificationStarted")).toBe(1);
        expect(yield* offsetOf("wf3a")).toBe(head + 1);
      }),
      makeP9ConsumerApp(),
    );
  });

  it("WF3b [crash-injected]: consumer B interrupted before the CompleteWork commit — replay converges, exactly one Completion", async () => {
    expect(labeled("WF3-consumer-b", "crash-injected").guarantee).toBe(
      "crash-injected",
    );
    await runP9Consumer(
      Effect.gen(function* () {
        yield* seedProjectAndWork;
        const tx = yield* TransactionPort;
        const verifications = yield* VerificationRepository;
        const sql = yield* SqlClient;
        yield* tx.transact(
          verifications.insert(
            startVerification({
              verificationId: VER(31),
              workId: WORK_1,
              targetWorkRevision: WREV(0),
              missionSnapshot: MISSION,
            }),
            p7Project,
            p7RootWorkspace,
          ),
        );
        yield* tx.transact(
          verifications.concludeIfOpen(VER(31), "Pass", undefined),
        );
        yield* sql.unsafe(
          "INSERT INTO work_acceptances (acceptance_id, project_id, work_id, target_work_revision, verification_id, actor, accepted_at) VALUES (?,?,?,?,?,?,'t')",
          [ACC(31), p7Project, WORK_1, 0, VER(31), p7TestActor],
        );
        yield* sql.unsafe(
          "UPDATE workspaces SET current_work_id = ? WHERE workspace_id = ?",
          [WORK_1, p7RootWorkspace],
        );
        const head = yield* preconsume("wf3b");
        yield* journalEvent("WorkOutcomeAccepted", {
          acceptanceId: ACC(31),
          workId: WORK_1,
          targetWorkRevision: 0,
          verificationId: VER(31),
          actor: p7TestActor,
        });
        const stores = yield* loopStores;
        const gateway = yield* CommandGateway;
        const interrupted = transientOnceGateway(gateway, "CompleteWork");
        const deps = yield* Effect.gen(function* () {
          const base = yield* makeCompletionDeps();
          return { ...base, gateway: interrupted.gateway };
        });
        const failure = yield* pollOnce("wf3b", p7Project, 10, {
          ...stores,
          handlers: completionConsumerLoop(p7Project, p7TestPrincipal, deps),
        }).pipe(Effect.flip);
        expect(failure._tag).toBe("TransactionOperationalFailure");
        expect(interrupted.fired()).toBe(true);
        expect(
          yield* countRows("works", "work_id = ? AND lifecycle = 'Open'", [
            WORK_1,
          ]),
        ).toBe(1);
        expect(yield* countEvents("WorkCompleted")).toBe(0);
        expect(yield* offsetOf("wf3b")).toBe(head);
        // Replay converges: exactly one CompleteWork.
        const clean = yield* makeCompletionDeps();
        const result = yield* pollOnce("wf3b", p7Project, 10, {
          ...stores,
          handlers: completionConsumerLoop(p7Project, p7TestPrincipal, clean),
        });
        expect(result.records).toEqual(["CompleteWork"]);
        expect(
          yield* countRows("works", "work_id = ? AND lifecycle = 'Completed'", [
            WORK_1,
          ]),
        ).toBe(1);
        expect(yield* countEvents("WorkCompleted")).toBe(1);
        expect(
          yield* countRows(
            "workspaces",
            "workspace_id = ? AND current_work_id IS NULL",
            [p7RootWorkspace],
          ),
        ).toBe(1);
      }),
      makeP9ConsumerApp(),
    );
  });

  it("DF1 [crash-injected]: dispatch port call fails — never settles an Execution; stays Active; reevaluation re-dispatch converges", async () => {
    expect(labeled("DF1-dispatch-failure", "crash-injected").guarantee).toBe(
      "crash-injected",
    );
    await runP9Consumer(
      Effect.gen(function* () {
        yield* p9Boot;
        yield* p7SeedProject;
        yield* INSERT_EXECUTION("exe_p9_df1");
        const exit = yield* Effect.exit(
          dispatchRound("exe_p9_df1", dyingDispatch()),
        );
        expect(exit._tag).toBe("Failure");
        // A dispatch failure never settles (P2 `02` §5): no settlement,
        // no lease, no canonical side effects.
        expect(yield* executionSettlement("exe_p9_df1")).toBeNull();
        expect(
          yield* countRows("execution_leases", "execution_id = ?", [
            "exe_p9_df1",
          ]),
        ).toBe(0);
        expect(
          yield* countRows("commands", "command_id LIKE 'cmd_settle_%'"),
        ).toBe(0);
        // The re-dispatch surface stays eligible (no live lease).
        expect(yield* preDispatchCheck("exe_p9_df1" as never)).toBe(true);
        const sink: Array<string> = [];
        yield* dispatchRound("exe_p9_df1", recordingDispatch(sink));
        expect(sink).toEqual(["exe_p9_df1"]);
        const receipt = yield* settleCompleted("exe_p9_df1");
        expect(
          (receipt as { resolution: { _tag: string } }).resolution._tag,
        ).toBe("Committed");
        expect(yield* executionSettlement("exe_p9_df1")).toBe("Completed");
      }),
      makeP9ConsumerApp(),
    );
  });

  it("DF2 [crash-injected]: dispatch accepted then lost — next sweep reevaluation re-drives the workspace; single-flight conflict converges to Noop", async () => {
    expect(labeled("DF2-lost-dispatch", "crash-injected").guarantee).toBe(
      "crash-injected",
    );
    await runP9Consumer(
      Effect.gen(function* () {
        yield* p9Boot;
        yield* p7SeedProject;
        yield* INSERT_MAIN_EXECUTION("exe_p9_df2");
        const sink: Array<string> = [];
        yield* dispatchRound("exe_p9_df2", recordingDispatch(sink));
        expect(sink).toEqual(["exe_p9_df2"]);
        // Lost dispatch: ticket accepted, worker never starts — Active +
        // no live lease + no session progress (the observable surface).
        expect(yield* executionSettlement("exe_p9_df2")).toBeNull();
        expect(
          yield* countRows("execution_leases", "execution_id = ?", [
            "exe_p9_df2",
          ]),
        ).toBe(0);
        expect(
          yield* countRows("session_entries", "session_id = ?", [
            "ses_exe_p9_df2",
          ]),
        ).toBe(0);
        // Bottom line: the next sweep (T2/T3) runs; the reevaluation of
        // the owning workspace sees the Active main execution and
        // converges the single-flight conflict to Noop (P2 `05` §8).
        yield* sweepRecovery(p7TestPrincipal as Principal);
        const scheduler = yield* ExecutionScheduler;
        const decision = yield* scheduler.reevaluate(p7RootWorkspace, {
          _tag: "Recovery",
        });
        expect(decision).toEqual({
          _tag: "Noop",
          reason: "ActiveMainExecution",
        });
        // Re-dispatch within the sweep cadence: eligible, and the
        // workspace continues to settlement on the same execution.
        expect(yield* preDispatchCheck("exe_p9_df2" as never)).toBe(true);
        yield* dispatchRound("exe_p9_df2", recordingDispatch(sink));
        expect(sink).toHaveLength(2);
        const receipt = yield* settleCompleted("exe_p9_df2");
        expect(
          (receipt as { resolution: { _tag: string } }).resolution._tag,
        ).toBe("Committed");
        expect(yield* executionSettlement("exe_p9_df2")).toBe("Completed");
      }),
      makeP9ConsumerApp(),
    );
  });

  it("D5 [crash-injected]: Open verification survives the dirty-restart recovery pass — no auto-conclude, no auto-Unknown", async () => {
    expect(
      labeled("D5-open-verification-preserved", "crash-injected").guarantee,
    ).toBe("crash-injected");
    await runP9Consumer(
      Effect.gen(function* () {
        yield* p9Boot;
        yield* p7SeedProject;
        const seeded = yield* p7SeedWork(WORK_1, ASSIGN_CMD_1);
        expect(seeded.resolution._tag).toBe("Committed");
        const tx = yield* TransactionPort;
        const verifications = yield* VerificationRepository;
        yield* tx.transact(
          verifications.insert(
            startVerification({
              verificationId: VER(51),
              workId: WORK_1,
              targetWorkRevision: WREV(0),
              missionSnapshot: MISSION,
            }),
            p7Project,
            p7RootWorkspace,
          ),
        );
        yield* runRecovery(p7TestPrincipal as Principal);
        const stored = yield* tx.transact(verifications.findById(VER(51)));
        expect(Option.isSome(stored)).toBe(true);
        expect(
          Option.isSome(stored) ? stored.value.state.status : "missing",
        ).toBe("Open");
        expect(yield* countEvents("VerificationConcluded")).toBe(0);
        expect(yield* countEvents("VerificationUnknown")).toBe(0);
      }),
      makeP9ConsumerApp(),
    );
  });
});
