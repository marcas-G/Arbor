import type { Execution, Principal } from "@arbor/domain";
import { type AgentLoopStepFence, IdGenerator } from "@arbor/ports";
import { Effect, Option } from "effect";

/** P9 `07` / DID v1.40: record the existing escalation source while the
 * originating action still has its current Worker fence and its Execution is
 * unsettled. P3 calls this before persisting its terminal OutcomeUnknown
 * action; the event identity matches the recovery-sweep path below. */
export const makeReconciliationEscalationRecorder =
  (dependencies: {
    readonly tx: import("@arbor/ports").TransactionPortService;
    readonly repository: import("@arbor/ports").ExecutionRepositoryService;
    readonly leases: import("@arbor/ports").LeaseServiceService;
    readonly journal: import("@arbor/ports").DomainEventJournalService;
    readonly clock: import("@arbor/ports").ClockService;
    readonly ids: import("@arbor/ports").IdGeneratorService;
  }) =>
  (input: {
    readonly execution: Execution;
    readonly fence: AgentLoopStepFence;
    readonly principal: Principal;
    readonly invocationRefs: ReadonlyArray<string>;
  }) =>
    Effect.gen(function* () {
      const { tx, repository, leases, journal, clock, ids } = dependencies;
      const { execution, fence, invocationRefs } = input;
      if (
        invocationRefs.length === 0 ||
        fence.executionId !== execution.executionId
      ) {
        return yield* Effect.fail({
          _tag: "ReconciliationEscalationBindingMismatch",
          executionId: execution.executionId,
        });
      }
      const fingerprint = [...invocationRefs].sort().join(",");
      const now = yield* clock.now();
      yield* tx.transact(
        Effect.gen(function* () {
          yield* leases.renew(
            fence.executionId,
            fence.workerId,
            fence.workerIncarnationId,
            fence.fencingGeneration,
          );
          const current = yield* repository.findById(fence.executionId);
          if (
            Option.isNone(current) ||
            current.value.state.status !== "Active" ||
            current.value.projectId !== execution.projectId
          ) {
            return yield* Effect.fail({
              _tag: "ReconciliationEscalationExecutionNotActive",
              executionId: execution.executionId,
            });
          }
          const events = yield* journal.readAfter(
            execution.projectId,
            0,
            1_000_000,
          );
          const alreadyFact = events.some(
            (event) =>
              event.eventType === "ReconciliationEscalated" &&
              event.aggregateRef === execution.executionId &&
              (event.payload as { invocationRefsFingerprint?: string })
                .invocationRefsFingerprint === fingerprint,
          );
          if (!alreadyFact) {
            yield* journal
              .append([
                {
                  projectId: execution.projectId,
                  eventType: "ReconciliationEscalated",
                  eventVersion: 1,
                  occurredAt: now,
                  aggregateRef: execution.executionId,
                  actor: input.principal as never,
                  payload: {
                    executionId: execution.executionId,
                    invocationRefsFingerprint: fingerprint,
                    refs: invocationRefs,
                  },
                } as never,
              ])
              .pipe(Effect.provideService(IdGenerator, ids));
          }
        }),
      );
    });
