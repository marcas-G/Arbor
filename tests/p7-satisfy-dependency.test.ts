import { Effect, Option } from "effect";
import { describe, expect, it } from "vitest";
import {
  P7_MIGRATIONS,
  runMigrations,
} from "../adapters/persistence-sqlite/src/index.js";
import {
  makeSatisfyDependencyHandler,
  type SatisfyDependencyPayload,
  type SatisfyDependencyResult,
  satisfactionCommandId,
} from "../packages/application/src/commands/satisfy-dependency.js";
import type {
  CommandOutcome,
  CommandResult,
  GatewayEnvelope,
  VerifiedCommandAuthority,
} from "../packages/application/src/index.js";
import {
  ArtifactId,
  type ArtifactRole,
  CommandId,
  DeliverableId,
  type DeliverableKind,
  DependencyId,
  DependencyRevision,
  declareDependency,
  ExecutionId,
  type ExpectedDeliverable,
  type ProducerBinding,
  parse,
  WorkId,
} from "../packages/domain/dist/index.js";
import {
  DeliverableRepository,
  DependencyRepository,
  TransactionPort,
  WorkRepository,
} from "../packages/ports/src/index.js";
import {
  makeP7App,
  p7Project,
  p7RootWorkspace,
  p7SeedProject,
  p7SeedWork,
  p7TestActor,
  p7TestPrincipal,
  runP7,
} from "./support/p7-app.js";

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
const UNKNOWN_DEP = parse(DependencyId)(
  "dep_018f2b3c-4d5e-7abc-8def-0123456789ff",
);
const UNKNOWN_DEL = parse(DeliverableId)(
  "del_018f2b3c-4d5e-7abc-8def-0123456789ff",
);
const CMD = (suffix: string) =>
  parse(CommandId)(`cmd_018f2b3c-4d5e-7abc-8def-${suffix}`);

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

const seed = Effect.gen(function* () {
  yield* runMigrations(P7_MIGRATIONS);
  yield* p7SeedProject;
  const consumer = yield* p7SeedWork(WORK_C, ASSIGN_CMD_C);
  expect(consumer.resolution._tag).toBe("Committed");
  const producer = yield* p7SeedWork(WORK_P, ASSIGN_CMD_P);
  expect(producer.resolution._tag).toBe("Committed");
});

/** One Unsatisfied dependency (revision 0) bound to the consumer Work. */
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

/** One immutable deliverable fact produced by WORK_P at revision 0. */
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

const makeHandler = Effect.gen(function* () {
  const dependencies = yield* DependencyRepository;
  const deliverables = yield* DeliverableRepository;
  const works = yield* WorkRepository;
  return makeSatisfyDependencyHandler({ dependencies, deliverables, works });
});

const context = { _tag: "External", principal: p7TestPrincipal } as const;

const envelopeOf = (
  commandId: CommandId,
  payload: SatisfyDependencyPayload,
): GatewayEnvelope<SatisfyDependencyPayload> => ({
  commandType: "SatisfyDependency",
  commandId,
  projectId: p7Project,
  actor: p7TestActor,
  issuedAt: "t",
  payload,
});

const payloadOf = (
  dependencyId: DependencyId,
  deliverableId: DeliverableId,
  targetDependencyRevision = REV(0),
): SatisfyDependencyPayload => ({
  dependencyId,
  targetDependencyRevision,
  deliverableId,
});

type SatisfyOutcome = CommandResult<CommandOutcome<SatisfyDependencyResult>>;

const expectRejected = (outcome: SatisfyOutcome, tag: string) => {
  expect(outcome.ok).toBe(false);
  if (!outcome.ok) {
    expect(outcome.error._tag).toBe(tag);
  }
};

const storedDependency = (dependencyId: DependencyId) =>
  Effect.gen(function* () {
    const tx = yield* TransactionPort;
    const dependencies = yield* DependencyRepository;
    const found = yield* tx.transact(dependencies.findById(dependencyId));
    expect(Option.isSome(found)).toBe(true);
    return Option.isSome(found) ? found.value : undefined;
  });

describe("p7-satisfy-dependency", () => {
  it("AnyProducer positive: Satisfied + DependencySatisfied event + DependencySatisfied wake signal; the domain transition keeps the revision (from == to)", async () => {
    await runP7(
      Effect.gen(function* () {
        yield* seed;
        const dep = DEP(1);
        yield* seedDependency(
          dep,
          { _tag: "AnyProducer" },
          expectedOf("report", ["summary"]),
        );
        yield* seedDeliverable(DEL(1), "report", ["summary"]);
        const tx = yield* TransactionPort;
        const handler = yield* makeHandler;
        const commandId = CMD("0123456789b1");
        const outcome: SatisfyOutcome = yield* tx.transact(
          handler.execute(
            envelopeOf(commandId, payloadOf(dep, DEL(1))),
            context,
          ),
        );
        expect(outcome.ok).toBe(true);
        if (outcome.ok) {
          // satisfyDependency keeps the revision (P0 domain): the record is
          // bound to satisfiedAtDependencyRevision = the observed revision.
          expect(outcome.value.result).toEqual({
            dependencyId: dep,
            state: "Satisfied",
            dependencyRevision: 0,
            deliverableId: DEL(1),
            satisfiedAtDependencyRevision: 0,
            wakeSignals: [
              {
                workspaceId: p7RootWorkspace,
                reason: { _tag: "DependencySatisfied" },
                detail: { dependencyId: dep, fromRevision: 0, toRevision: 0 },
              },
            ],
          });
          expect(outcome.value.events).toHaveLength(1);
          const event = outcome.value.events[0]!;
          expect(event.eventType).toBe("DependencySatisfied");
          expect(event.eventVersion).toBe(1);
          expect(event.aggregateRef).toBe(dep);
          expect(event.projectId).toBe(p7Project);
          expect(event.causedByCommandId).toBe(commandId);
          expect(event.payload).toEqual({
            dependencyId: dep,
            targetDependencyRevision: 0,
            deliverableId: DEL(1),
            satisfiedAtDependencyRevision: 0,
          });
        }
        const stored = yield* storedDependency(dep);
        expect(stored?.state).toBe("Satisfied");
        expect(stored?.revision).toBe(0);
        expect(stored?.satisfiedByDeliverableId).toBe(DEL(1));
        expect(stored?.satisfiedAtDependencyRevision).toBe(0);
      }),
      makeP7App(),
    );
  });

  it("matcher negative (kind mismatch): DependencyNotSatisfiable, state unchanged", async () => {
    await runP7(
      Effect.gen(function* () {
        yield* seed;
        const dep = DEP(2);
        yield* seedDependency(
          dep,
          { _tag: "AnyProducer" },
          expectedOf("report", ["summary"]),
        );
        yield* seedDeliverable(DEL(2), "diagram", ["summary"]);
        const tx = yield* TransactionPort;
        const handler = yield* makeHandler;
        const outcome: SatisfyOutcome = yield* tx.transact(
          handler.execute(
            envelopeOf(CMD("0123456789b2"), payloadOf(dep, DEL(2))),
            context,
          ),
        );
        expectRejected(outcome, "DependencyNotSatisfiable");
        if (!outcome.ok) {
          expect(outcome.error).toEqual({
            _tag: "DependencyNotSatisfiable",
            dependencyId: dep,
          });
        }
        const stored = yield* storedDependency(dep);
        expect(stored?.state).toBe("Unsatisfied");
        expect(stored?.satisfiedByDeliverableId).toBeUndefined();
      }),
      makeP7App(),
    );
  });

  it("matcher negative (missing required artifact role): DependencyNotSatisfiable, state unchanged", async () => {
    await runP7(
      Effect.gen(function* () {
        yield* seed;
        const dep = DEP(3);
        yield* seedDependency(
          dep,
          { _tag: "AnyProducer" },
          expectedOf("report", ["summary", "appendix"]),
        );
        yield* seedDeliverable(DEL(3), "report", ["summary"]);
        const tx = yield* TransactionPort;
        const handler = yield* makeHandler;
        const outcome: SatisfyOutcome = yield* tx.transact(
          handler.execute(
            envelopeOf(CMD("0123456789b3"), payloadOf(dep, DEL(3))),
            context,
          ),
        );
        expectRejected(outcome, "DependencyNotSatisfiable");
        const stored = yield* storedDependency(dep);
        expect(stored?.state).toBe("Unsatisfied");
      }),
      makeP7App(),
    );
  });

  it("WorkBound producer: matching sourceWorkId satisfies; a different source Work is DependencyNotSatisfiable", async () => {
    await runP7(
      Effect.gen(function* () {
        yield* seed;
        const dep = DEP(4);
        yield* seedDependency(
          dep,
          { _tag: "WorkBound", workId: WORK_P },
          expectedOf("report", ["summary"]),
        );
        yield* seedDeliverable(DEL(4), "report", ["summary"]);
        const tx = yield* TransactionPort;
        const handler = yield* makeHandler;
        const matched: SatisfyOutcome = yield* tx.transact(
          handler.execute(
            envelopeOf(CMD("0123456789b4"), payloadOf(dep, DEL(4))),
            context,
          ),
        );
        expect(matched.ok).toBe(true);

        const dep2 = DEP(5);
        yield* seedDependency(
          dep2,
          { _tag: "WorkBound", workId: WORK_C },
          expectedOf("report", ["summary"]),
        );
        const mismatched: SatisfyOutcome = yield* tx.transact(
          handler.execute(
            envelopeOf(CMD("0123456789b5"), payloadOf(dep2, DEL(4))),
            context,
          ),
        );
        expectRejected(mismatched, "DependencyNotSatisfiable");
        const stored = yield* storedDependency(dep2);
        expect(stored?.state).toBe("Unsatisfied");
      }),
      makeP7App(),
    );
  });

  it("rejection rows: DependencyNotFound / DeliverableNotFound / stale RevisionConflict", async () => {
    await runP7(
      Effect.gen(function* () {
        yield* seed;
        const dep = DEP(6);
        yield* seedDependency(
          dep,
          { _tag: "AnyProducer" },
          expectedOf("report", ["summary"]),
        );
        yield* seedDeliverable(DEL(6), "report", ["summary"]);
        const tx = yield* TransactionPort;
        const handler = yield* makeHandler;

        const unknownDep: SatisfyOutcome = yield* tx.transact(
          handler.execute(
            envelopeOf(CMD("0123456789c1"), payloadOf(UNKNOWN_DEP, DEL(6))),
            context,
          ),
        );
        expectRejected(unknownDep, "DependencyNotFound");
        if (!unknownDep.ok) {
          expect(unknownDep.error).toEqual({
            _tag: "DependencyNotFound",
            dependencyId: UNKNOWN_DEP,
          });
        }

        const unknownDeliverable: SatisfyOutcome = yield* tx.transact(
          handler.execute(
            envelopeOf(CMD("0123456789c2"), payloadOf(dep, UNKNOWN_DEL)),
            context,
          ),
        );
        expectRejected(unknownDeliverable, "DeliverableNotFound");
        if (!unknownDeliverable.ok) {
          expect(unknownDeliverable.error).toEqual({
            _tag: "DeliverableNotFound",
            deliverableId: UNKNOWN_DEL,
          });
        }

        const stale: SatisfyOutcome = yield* tx.transact(
          handler.execute(
            envelopeOf(CMD("0123456789c3"), payloadOf(dep, DEL(6), REV(5))),
            context,
          ),
        );
        expectRejected(stale, "RevisionConflict");
        if (!stale.ok) {
          expect(stale.error).toEqual({
            _tag: "RevisionConflict",
            expected: 5,
            actual: 0,
          });
        }
        const stored = yield* storedDependency(dep);
        expect(stored?.state).toBe("Unsatisfied");
      }),
      makeP7App(),
    );
  });

  it("terminal row: a second SatisfyDependency against a Satisfied dependency is TerminalLifecycleMutation", async () => {
    await runP7(
      Effect.gen(function* () {
        yield* seed;
        const dep = DEP(7);
        yield* seedDependency(
          dep,
          { _tag: "AnyProducer" },
          expectedOf("report", ["summary"]),
        );
        yield* seedDeliverable(DEL(7), "report", ["summary"]);
        const tx = yield* TransactionPort;
        const handler = yield* makeHandler;
        const first: SatisfyOutcome = yield* tx.transact(
          handler.execute(
            envelopeOf(CMD("0123456789c4"), payloadOf(dep, DEL(7))),
            context,
          ),
        );
        expect(first.ok).toBe(true);
        const second: SatisfyOutcome = yield* tx.transact(
          handler.execute(
            envelopeOf(CMD("0123456789c5"), payloadOf(dep, DEL(7))),
            context,
          ),
        );
        expectRejected(second, "TerminalLifecycleMutation");
        if (!second.ok) {
          expect(second.error).toEqual({
            _tag: "TerminalLifecycleMutation",
            entity: "Dependency",
            lifecycle: "Satisfied",
          });
        }
        const stored = yield* storedDependency(dep);
        expect(stored?.state).toBe("Satisfied");
        expect(stored?.satisfiedByDeliverableId).toBe(DEL(7));
      }),
      makeP7App(),
    );
  });

  it("CAS race outcome: two same-expectedRevision executions — the first committer wins, the loser receives the typed rejection", async () => {
    await runP7(
      Effect.gen(function* () {
        yield* seed;
        const dep = DEP(8);
        yield* seedDependency(
          dep,
          { _tag: "AnyProducer" },
          expectedOf("report", ["summary"]),
        );
        yield* seedDeliverable(DEL(8), "report", ["summary"]);
        const tx = yield* TransactionPort;
        const handler = yield* makeHandler;
        // The receipt-level idempotent replay is gateway-owned (deterministic
        // CommandId + receipt); under direct handler execution the second
        // submission is the frozen concurrency loser: already Satisfied →
        // TerminalLifecycleMutation (§4 Concurrency).
        const winner: SatisfyOutcome = yield* tx.transact(
          handler.execute(
            envelopeOf(CMD("0123456789c6"), payloadOf(dep, DEL(8))),
            context,
          ),
        );
        expect(winner.ok).toBe(true);
        const loser: SatisfyOutcome = yield* tx.transact(
          handler.execute(
            envelopeOf(CMD("0123456789c7"), payloadOf(dep, DEL(8))),
            context,
          ),
        );
        expectRejected(loser, "TerminalLifecycleMutation");
        const stored = yield* storedDependency(dep);
        expect(stored?.state).toBe("Satisfied");
        expect(stored?.satisfiedByDeliverableId).toBe(DEL(8));
        // First-writer-wins keeps the satisfaction record immutable — the
        // loser never rewrites satisfiedByDeliverableId.
        expect(stored?.revision).toBe(0);
      }),
      makeP7App(),
    );
  });

  it("authority rule is exact-bound (G6): SatisfyDependencyAuthority tag, source two-valued, (dependencyId, deliverableId) fact binding, optional ConsumerExecution check", () => {
    const consumerExecutionId = parse(ExecutionId)(
      "exe_00000000-0000-7000-8000-000000000001",
    );
    const payload = payloadOf(DEP(1), DEL(1));
    const baseAuthority: VerifiedCommandAuthority = {
      _tag: "SatisfyDependencyAuthority",
      source: {
        _tag: "ConsumerExecution",
        workspaceId: p7RootWorkspace,
        executionId: consumerExecutionId,
      },
      principal: p7TestPrincipal,
      commandId: CMD("0123456789d1"),
      semanticRequestFingerprint: "fp" as never,
      projectId: p7Project,
      targetWorkspaceId: p7RootWorkspace,
      dependencyId: DEP(1),
      deliverableId: DEL(1),
    } as const;
    const coordinatorAuthority = {
      ...baseAuthority,
      source: { _tag: "P7Coordinator" },
    } as const;

    const handlerWithoutCheck = makeSatisfyDependencyHandler({
      dependencies: undefined as never,
      deliverables: undefined as never,
      works: undefined as never,
    });
    // Minimal contract: without the optional check the fact legalizes
    // submission (submission-time projection guarantee, §4).
    expect(
      handlerWithoutCheck.authority.targetMatches(baseAuthority, payload),
    ).toBe(true);
    expect(
      handlerWithoutCheck.authority.targetMatches(
        coordinatorAuthority,
        payload,
      ),
    ).toBe(true);
    // Fact binding: anything else is a mismatch.
    expect(
      handlerWithoutCheck.authority.targetMatches(
        { ...baseAuthority, deliverableId: DEL(2) },
        payload,
      ),
    ).toBe(false);
    expect(
      handlerWithoutCheck.authority.targetMatches(
        { ...baseAuthority, dependencyId: DEP(2) },
        payload,
      ),
    ).toBe(false);
    expect(
      handlerWithoutCheck.authority.targetMatches(
        { ...baseAuthority, _tag: "SteerWorkAuthority" as never },
        payload,
      ),
    ).toBe(false);
    // G6 exact-bound: an out-of-band source value is rejected at the face.
    expect(
      handlerWithoutCheck.authority.targetMatches(
        {
          ...baseAuthority,
          source: { _tag: "HumanPrincipal" } as never,
        },
        payload,
      ),
    ).toBe(false);

    const checkedWorkspaces: string[] = [];
    const handlerWithCheck = makeSatisfyDependencyHandler({
      dependencies: undefined as never,
      deliverables: undefined as never,
      works: undefined as never,
      verifyConsumerExecution: (source, targetWorkspaceId) => {
        checkedWorkspaces.push(source.workspaceId);
        return source.workspaceId === targetWorkspaceId;
      },
    });
    expect(
      handlerWithCheck.authority.targetMatches(baseAuthority, payload),
    ).toBe(true);
    expect(
      handlerWithCheck.authority.targetMatches(
        {
          ...baseAuthority,
          source: {
            _tag: "ConsumerExecution",
            workspaceId: DEL(1) as never,
            executionId: consumerExecutionId,
          },
        },
        payload,
      ),
    ).toBe(false);
    // The coordinator source never consults the execution check.
    expect(checkedWorkspaces).toEqual([p7RootWorkspace, DEL(1)]);

    expect(handlerWithCheck.commandType).toBe("SatisfyDependency");
    expect(handlerWithCheck.schemaVersion).toBe("1");
    expect(handlerWithCheck.stopAdmission).toEqual({
      _tag: "NormalExecutionMutation",
    });
    expect(handlerWithCheck.authority.tag).toBe("SatisfyDependencyAuthority");
    expect(
      handlerWithCheck.authority.targetMatches(
        { ...coordinatorAuthority, source: { _tag: "P7Coordinator" } },
        payload,
      ),
    ).toBe(true);
  });

  it("satisfactionCommandId is deterministic in (deliverableId, dependencyId, revision) and uuid-v7 shaped", () => {
    const first = satisfactionCommandId(DEL(1), DEP(1), REV(0));
    expect(first).toBe(satisfactionCommandId(DEL(1), DEP(1), REV(0)));
    expect(first.startsWith("cmd_")).toBe(true);
    expect(first).not.toBe(satisfactionCommandId(DEL(1), DEP(1), REV(1)));
    expect(first).not.toBe(satisfactionCommandId(DEL(2), DEP(1), REV(0)));
    expect(first).not.toBe(satisfactionCommandId(DEL(1), DEP(2), REV(0)));
    // Same (deliverableId, dependencyId, revision) re-derivation survives
    // branded-id round trips (at-least-once redelivery absorption, DID §5.4).
    const rederived = satisfactionCommandId(
      parse(DeliverableId)(String(DEL(1))),
      parse(DependencyId)(String(DEP(1))),
      REV(0),
    );
    expect(rederived).toBe(first);
  });
});
