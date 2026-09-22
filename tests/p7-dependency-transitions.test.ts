import { Effect, Layer, Option } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { describe, expect, it } from "vitest";
import {
  DomainEventJournalLive,
  IdGeneratorLive,
  P7_MIGRATIONS,
  runMigrations,
} from "../adapters/persistence-sqlite/src/index.js";
import {
  type MarkDependencyUnfulfillableResult,
  makeMarkDependencyUnfulfillableHandler,
  makeReviseDependencyContractHandler,
  makeWithdrawDependencyHandler,
  type ReviseDependencyContractResult,
  type WithdrawDependencyResult,
} from "../packages/application/src/commands/dependency-transitions.js";
import type {
  CommandOutcome,
  CommandResult,
  GatewayEnvelope,
} from "../packages/application/src/index.js";
import {
  CommandId,
  DeliverableId,
  type DeliverableKind,
  DependencyId,
  DependencyRevision,
  declareDependency,
  parse,
  satisfyDependency,
  WorkId,
} from "../packages/domain/dist/index.js";
import {
  DependencyRepository,
  DomainEventJournal,
  type PendingDomainEvent,
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

const WORK_1 = parse(WorkId)("wrk_00000000-0000-7000-8000-000000000001");
const DEL_1 = parse(DeliverableId)("del_00000000-0000-7000-8000-000000000001");

const DEP = (n: number) =>
  parse(DependencyId)(`dep_00000000-0000-7000-8000-00000000000${n}`);
const UNKNOWN_DEP = parse(DependencyId)(
  "dep_018f2b3c-4d5e-7abc-8def-0123456789ff",
);
const CMD = (suffix: string) =>
  parse(CommandId)(`cmd_018f2b3c-4d5e-7abc-8def-${suffix}`);
const ASSIGN_CMD = CMD("0123456789a1");

const KIND = "report" as never as DeliverableKind;
const ROLES = ["summary" as never];
const REV = (n: number) => parse(DependencyRevision)(n);

const seed = Effect.gen(function* () {
  yield* runMigrations(P7_MIGRATIONS);
  yield* p7SeedProject;
  const receipt = yield* p7SeedWork(WORK_1, ASSIGN_CMD);
  expect(receipt.resolution._tag).toBe("Committed");
});

/** Presets one Unsatisfied dependency at revision 0 (DependencyRepository
 * insert + declareDependency domain function, P7-002 pattern). */
const seedDependency = (dependencyId: DependencyId) =>
  Effect.gen(function* () {
    const tx = yield* TransactionPort;
    const dependencies = yield* DependencyRepository;
    yield* tx.transact(
      dependencies.insert(
        declareDependency({
          dependencyId,
          consumerWorkId: WORK_1,
          producerBinding: { _tag: "AnyProducer" },
          revision: REV(0),
          expectedDeliverable: { kind: KIND, requiredArtifactRoles: ROLES },
        }),
        p7Project,
      ),
    );
  });

/** Drives one dependency to Satisfied via the frozen domain transition +
 * repository CAS (terminal-mutation precondition for the rejection rows). */
const satisfySeeded = (dependencyId: DependencyId) =>
  Effect.gen(function* () {
    const tx = yield* TransactionPort;
    const dependencies = yield* DependencyRepository;
    const found = yield* tx.transact(dependencies.findById(dependencyId));
    expect(Option.isSome(found)).toBe(true);
    if (Option.isNone(found)) {
      return;
    }
    const satisfied = satisfyDependency(found.value, {
      deliverableId: DEL_1 as DeliverableId,
      sourceWorkId: WORK_1,
      sourceWorkspaceId: p7RootWorkspace,
      kind: KIND,
      artifactRoles: new Set(ROLES),
    });
    expect(satisfied.ok).toBe(true);
    if (satisfied.ok) {
      yield* tx.transact(
        dependencies.transitionIfUnsatisfiedRevision(
          dependencyId,
          found.value.revision,
          satisfied.value,
        ),
      );
    }
  });

const makeHandlers = Effect.gen(function* () {
  const dependencies = yield* DependencyRepository;
  const works = yield* WorkRepository;
  return {
    withdraw: makeWithdrawDependencyHandler({ dependencies, works }),
    mark: makeMarkDependencyUnfulfillableHandler({ dependencies, works }),
    revise: makeReviseDependencyContractHandler({ dependencies, works }),
  };
});

const context = { _tag: "External", principal: p7TestPrincipal } as const;

const envelopeOf = <P>(
  commandType: string,
  commandId: CommandId,
  payload: P,
): GatewayEnvelope<P> => ({
  commandType,
  commandId,
  projectId: p7Project,
  actor: p7TestActor,
  issuedAt: "t",
  payload,
});

type WithdrawOutcome = CommandResult<CommandOutcome<WithdrawDependencyResult>>;
type MarkOutcome = CommandResult<
  CommandOutcome<MarkDependencyUnfulfillableResult>
>;
type ReviseOutcome = CommandResult<
  CommandOutcome<ReviseDependencyContractResult>
>;

const expectRejected = (
  outcome: WithdrawOutcome | MarkOutcome | ReviseOutcome,
  tag: string,
) => {
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

const withdrawnEventCount = Effect.gen(function* () {
  const sql = yield* SqlClient;
  const rows = yield* sql.unsafe<{ count: number }>(
    "SELECT COUNT(*) AS count FROM domain_events WHERE event_type = 'DependencyWithdrawn'",
  );
  return Number(rows[0]?.count ?? 0);
});

/** Gateway-commit equivalent for direct-execution tests: journals the
 * outcome's events so replay non-double-writing is countable. */
const journalLayer = Layer.provide(DomainEventJournalLive, IdGeneratorLive);
const appendEvents = (events: ReadonlyArray<PendingDomainEvent>) =>
  Effect.gen(function* () {
    const journal = yield* DomainEventJournal;
    yield* journal.append(events);
  }).pipe(Effect.provide(journalLayer));

describe("p7-dependency-transitions", () => {
  it("Withdraw reaches the Withdrawn terminal without a revision bump and emits DependencyWithdrawn", async () => {
    await runP7(
      Effect.gen(function* () {
        yield* seed;
        const dep = DEP(1);
        yield* seedDependency(dep);
        const tx = yield* TransactionPort;
        const handler = yield* makeHandlers;
        const outcome: WithdrawOutcome = yield* tx.transact(
          handler.withdraw.execute(
            envelopeOf("WithdrawDependency", CMD("0123456789b1"), {
              dependencyId: dep,
              targetDependencyRevision: REV(0),
              reason: "consumer no longer needs the result",
            }),
            context,
          ),
        );
        expect(outcome.ok).toBe(true);
        if (outcome.ok) {
          expect(outcome.value.result).toEqual({
            dependencyId: dep,
            state: "Withdrawn",
            dependencyRevision: 0,
          });
          // P10 `06` §2: a human-originated withdrawal pairs the fact
          // with HumanInterventionApplied(GovernanceDecision).
          expect(outcome.value.events).toHaveLength(2);
          const event = outcome.value.events[0]!;
          expect(event.eventType).toBe("DependencyWithdrawn");
          expect(outcome.value.events[1]!.eventType).toBe(
            "HumanInterventionApplied",
          );
          expect(event.eventVersion).toBe(1);
          expect(event.aggregateRef).toBe(dep);
          expect(event.projectId).toBe(p7Project);
          expect(event.causedByCommandId).toBe(CMD("0123456789b1"));
          expect(event.payload).toEqual({
            dependencyId: dep,
            dependencyRevision: 0,
            reason: "consumer no longer needs the result",
          });
        }
        const stored = yield* storedDependency(dep);
        expect(stored?.state).toBe("Withdrawn");
        expect(stored?.revision).toBe(0);
      }),
      makeP7App(),
    );
  });

  it("Mark reaches the Unfulfillable terminal without a revision bump and emits DependencyMarkedUnfulfillable", async () => {
    await runP7(
      Effect.gen(function* () {
        yield* seed;
        const dep = DEP(2);
        yield* seedDependency(dep);
        const tx = yield* TransactionPort;
        const handler = yield* makeHandlers;
        const outcome: MarkOutcome = yield* tx.transact(
          handler.mark.execute(
            envelopeOf("MarkDependencyUnfulfillable", CMD("0123456789b2"), {
              dependencyId: dep,
              targetDependencyRevision: REV(0),
              justification: "producer lost, adjudicated unfulfillable",
            }),
            context,
          ),
        );
        expect(outcome.ok).toBe(true);
        if (outcome.ok) {
          expect(outcome.value.result).toEqual({
            dependencyId: dep,
            state: "Unfulfillable",
            dependencyRevision: 0,
          });
          // The Attention fact rides the event itself (§6); the P10
          // `06` §2 human-origin pairing adds the governance fact.
          expect(outcome.value.events).toHaveLength(2);
          const event = outcome.value.events[0]!;
          expect(event.eventType).toBe("DependencyMarkedUnfulfillable");
          expect(outcome.value.events[1]!.eventType).toBe(
            "HumanInterventionApplied",
          );
          expect(event.aggregateRef).toBe(dep);
          expect(event.payload).toEqual({
            dependencyId: dep,
            dependencyRevision: 0,
            justification: "producer lost, adjudicated unfulfillable",
          });
        }
        const stored = yield* storedDependency(dep);
        expect(stored?.state).toBe("Unfulfillable");
        expect(stored?.revision).toBe(0);
      }),
      makeP7App(),
    );
  });

  it("Revise replaces the contract Unsatisfied→Unsatisfied with revision +1 and emits DependencyContractRevised", async () => {
    await runP7(
      Effect.gen(function* () {
        yield* seed;
        const dep = DEP(3);
        yield* seedDependency(dep);
        const tx = yield* TransactionPort;
        const handler = yield* makeHandlers;
        const outcome: ReviseOutcome = yield* tx.transact(
          handler.revise.execute(
            envelopeOf("ReviseDependencyContract", CMD("0123456789b3"), {
              dependencyId: dep,
              targetDependencyRevision: REV(0),
              newExpectedDeliverable: {
                kind: "report-v2" as never as DeliverableKind,
                requiredArtifactRoles: [
                  "summary" as never,
                  "appendix" as never,
                ],
              },
            }),
            context,
          ),
        );
        expect(outcome.ok).toBe(true);
        if (outcome.ok) {
          expect(outcome.value.result).toEqual({
            dependencyId: dep,
            state: "Unsatisfied",
            fromRevision: 0,
            toRevision: 1,
          });
          expect(outcome.value.events).toHaveLength(1);
          const event = outcome.value.events[0]!;
          expect(event.eventType).toBe("DependencyContractRevised");
          expect(event.aggregateRef).toBe(dep);
          expect(event.payload).toEqual({
            dependencyId: dep,
            fromRevision: 0,
            toRevision: 1,
          });
        }
        const stored = yield* storedDependency(dep);
        expect(stored?.state).toBe("Unsatisfied");
        expect(stored?.revision).toBe(1);
        expect(stored?.expectedDeliverable).toEqual({
          kind: "report-v2",
          requiredArtifactRoles: ["summary", "appendix"],
        });
        expect(stored?.producerBinding).toEqual({ _tag: "AnyProducer" });
      }),
      makeP7App(),
    );
  });

  it("rejects DependencyNotFound for an unknown dependency across all three commands", async () => {
    await runP7(
      Effect.gen(function* () {
        yield* seed;
        const tx = yield* TransactionPort;
        const handler = yield* makeHandlers;
        const withdrawn = yield* tx.transact(
          handler.withdraw.execute(
            envelopeOf("WithdrawDependency", CMD("0123456789c1"), {
              dependencyId: UNKNOWN_DEP,
              targetDependencyRevision: REV(0),
              reason: "x",
            }),
            context,
          ),
        );
        const marked = yield* tx.transact(
          handler.mark.execute(
            envelopeOf("MarkDependencyUnfulfillable", CMD("0123456789c2"), {
              dependencyId: UNKNOWN_DEP,
              targetDependencyRevision: REV(0),
              justification: "x",
            }),
            context,
          ),
        );
        const revised = yield* tx.transact(
          handler.revise.execute(
            envelopeOf("ReviseDependencyContract", CMD("0123456789c3"), {
              dependencyId: UNKNOWN_DEP,
              targetDependencyRevision: REV(0),
            }),
            context,
          ),
        );
        expectRejected(withdrawn, "DependencyNotFound");
        expectRejected(marked, "DependencyNotFound");
        expectRejected(revised, "DependencyNotFound");
        if (!withdrawn.ok) {
          expect(withdrawn.error).toEqual({
            _tag: "DependencyNotFound",
            dependencyId: UNKNOWN_DEP,
          });
        }
      }),
      makeP7App(),
    );
  });

  it("rejects TerminalLifecycleMutation(Dependency) when withdrawing a Satisfied dependency", async () => {
    await runP7(
      Effect.gen(function* () {
        yield* seed;
        const dep = DEP(4);
        yield* seedDependency(dep);
        yield* satisfySeeded(dep);
        const tx = yield* TransactionPort;
        const handler = yield* makeHandlers;
        const outcome: WithdrawOutcome = yield* tx.transact(
          handler.withdraw.execute(
            envelopeOf("WithdrawDependency", CMD("0123456789c4"), {
              dependencyId: dep,
              targetDependencyRevision: REV(0),
              reason: "late withdrawal",
            }),
            context,
          ),
        );
        expectRejected(outcome, "TerminalLifecycleMutation");
        if (!outcome.ok) {
          expect(outcome.error).toEqual({
            _tag: "TerminalLifecycleMutation",
            entity: "Dependency",
            lifecycle: "Satisfied",
          });
        }
        const stored = yield* storedDependency(dep);
        expect(stored?.state).toBe("Satisfied");
      }),
      makeP7App(),
    );
  });

  it("rejects TerminalLifecycleMutation(Dependency) when marking an already Withdrawn dependency", async () => {
    await runP7(
      Effect.gen(function* () {
        yield* seed;
        const dep = DEP(5);
        yield* seedDependency(dep);
        const tx = yield* TransactionPort;
        const handler = yield* makeHandlers;
        const first: WithdrawOutcome = yield* tx.transact(
          handler.withdraw.execute(
            envelopeOf("WithdrawDependency", CMD("0123456789c5"), {
              dependencyId: dep,
              targetDependencyRevision: REV(0),
              reason: "first",
            }),
            context,
          ),
        );
        expect(first.ok).toBe(true);
        const second: MarkOutcome = yield* tx.transact(
          handler.mark.execute(
            envelopeOf("MarkDependencyUnfulfillable", CMD("0123456789c6"), {
              dependencyId: dep,
              targetDependencyRevision: REV(0),
              justification: "second",
            }),
            context,
          ),
        );
        expectRejected(second, "TerminalLifecycleMutation");
        if (!second.ok) {
          expect(second.error).toEqual({
            _tag: "TerminalLifecycleMutation",
            entity: "Dependency",
            lifecycle: "Withdrawn",
          });
        }
      }),
      makeP7App(),
    );
  });

  it("rejects RevisionConflict on a stale targetDependencyRevision", async () => {
    await runP7(
      Effect.gen(function* () {
        yield* seed;
        const dep = DEP(6);
        yield* seedDependency(dep);
        const tx = yield* TransactionPort;
        const handler = yield* makeHandlers;
        const outcome: WithdrawOutcome = yield* tx.transact(
          handler.withdraw.execute(
            envelopeOf("WithdrawDependency", CMD("0123456789c7"), {
              dependencyId: dep,
              targetDependencyRevision: REV(5),
              reason: "stale",
            }),
            context,
          ),
        );
        expectRejected(outcome, "RevisionConflict");
        if (!outcome.ok) {
          expect(outcome.error).toEqual({
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

  it("rejects RevisionConflict when withdrawing against a revision moved by an earlier Revise", async () => {
    await runP7(
      Effect.gen(function* () {
        yield* seed;
        const dep = DEP(7);
        yield* seedDependency(dep);
        const tx = yield* TransactionPort;
        const handler = yield* makeHandlers;
        const revised: ReviseOutcome = yield* tx.transact(
          handler.revise.execute(
            envelopeOf("ReviseDependencyContract", CMD("0123456789c8"), {
              dependencyId: dep,
              targetDependencyRevision: REV(0),
              newExpectedDeliverable: {
                kind: "report-v2" as never as DeliverableKind,
                requiredArtifactRoles: ROLES,
              },
            }),
            context,
          ),
        );
        expect(revised.ok).toBe(true);
        const staleWithdraw: WithdrawOutcome = yield* tx.transact(
          handler.withdraw.execute(
            envelopeOf("WithdrawDependency", CMD("0123456789c9"), {
              dependencyId: dep,
              targetDependencyRevision: REV(0),
              reason: "stale after revise",
            }),
            context,
          ),
        );
        expectRejected(staleWithdraw, "RevisionConflict");
        if (!staleWithdraw.ok) {
          expect(staleWithdraw.error).toEqual({
            _tag: "RevisionConflict",
            expected: 0,
            actual: 1,
          });
        }
        const stored = yield* storedDependency(dep);
        expect(stored?.state).toBe("Unsatisfied");
        expect(stored?.revision).toBe(1);
      }),
      makeP7App(),
    );
  });

  it("never reinterprets satisfaction: Revise after Satisfied is a TerminalLifecycleMutation", async () => {
    await runP7(
      Effect.gen(function* () {
        yield* seed;
        const dep = DEP(8);
        yield* seedDependency(dep);
        yield* satisfySeeded(dep);
        const tx = yield* TransactionPort;
        const handler = yield* makeHandlers;
        const outcome: ReviseOutcome = yield* tx.transact(
          handler.revise.execute(
            envelopeOf("ReviseDependencyContract", CMD("0123456789d1"), {
              dependencyId: dep,
              targetDependencyRevision: REV(0),
              newExpectedDeliverable: {
                kind: "report-v2" as never as DeliverableKind,
                requiredArtifactRoles: ROLES,
              },
            }),
            context,
          ),
        );
        expectRejected(outcome, "TerminalLifecycleMutation");
        if (!outcome.ok) {
          expect(outcome.error).toEqual({
            _tag: "TerminalLifecycleMutation",
            entity: "Dependency",
            lifecycle: "Satisfied",
          });
        }
        const stored = yield* storedDependency(dep);
        expect(stored?.state).toBe("Satisfied");
        expect(stored?.revision).toBe(0);
        expect(stored?.satisfiedAtDependencyRevision).toBe(0);
        expect(stored?.satisfiedByDeliverableId).toBe(DEL_1);
      }),
      makeP7App(),
    );
  });

  it("same-command replay does not double-write: CAS absorbs it and domain_events stays at one", async () => {
    await runP7(
      Effect.gen(function* () {
        yield* seed;
        const dep = DEP(9);
        yield* seedDependency(dep);
        const tx = yield* TransactionPort;
        const handler = yield* makeHandlers;
        const envelope = envelopeOf("WithdrawDependency", CMD("0123456789d2"), {
          dependencyId: dep,
          targetDependencyRevision: REV(0),
          reason: "replayed",
        });
        const first: WithdrawOutcome = yield* tx.transact(
          handler.withdraw.execute(envelope, context),
        );
        expect(first.ok).toBe(true);
        if (first.ok) {
          yield* tx.transact(appendEvents(first.value.events));
        }
        expect(yield* withdrawnEventCount).toBe(1);
        // Same command again (receipt dedup is gateway-level; under
        // direct execution the state+revision CAS must absorb it).
        const replay: WithdrawOutcome = yield* tx.transact(
          handler.withdraw.execute(envelope, context),
        );
        expectRejected(replay, "TerminalLifecycleMutation");
        expect(yield* withdrawnEventCount).toBe(1);
        const stored = yield* storedDependency(dep);
        expect(stored?.state).toBe("Withdrawn");
        expect(stored?.revision).toBe(0);
      }),
      makeP7App(),
    );
  });
});
