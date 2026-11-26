import type { ExecutionSettlement, ProviderTurnId } from "@arbor/domain";
import type { AgentLoopStepRecord } from "@arbor/ports";
import { Effect } from "effect";
import type { ModelDecisionDependencies } from "./contract.js";
import type { SettlementProposalError } from "./errors.js";

type SettlementDependencies = Pick<
  ModelDecisionDependencies,
  "loopSteps" | "loopStepFence" | "providerTurns" | "tx" | "options" | "now"
>;

/** Propose, but do not authoritatively commit, an execution settlement.
 * Close a dangling failed provider turn and transition the Prepared step
 * inside the same existing fenced transaction. The caller owns its cursor.
 * E09: store and transaction failures propagate as their narrow union;
 * the consumer folds once at its ExecutionDriverError boundary. */
export const proposePreparedStepSettlement = (
  dependencies: SettlementDependencies,
  input: {
    readonly loopStep: AgentLoopStepRecord | undefined;
    readonly providerTurnId: ProviderTurnId;
    readonly settlement: ExecutionSettlement;
  },
): Effect.Effect<AgentLoopStepRecord | undefined, SettlementProposalError> => {
  const { loopSteps, loopStepFence, providerTurns, tx, options, now } =
    dependencies;
  const { loopStep, providerTurnId, settlement } = input;
  return Effect.gen(function* () {
    let nextStep = loopStep;
    if (
      loopStep !== undefined &&
      loopSteps !== undefined &&
      loopStepFence !== undefined &&
      loopStep.state === "Prepared"
    ) {
      const preparedStep = loopStep;
      if (
        settlement._tag === "Failed" &&
        options.qualificationProbe !== undefined
      ) {
        yield* Effect.promise(
          () =>
            options.qualificationProbe?.({
              boundary: "AH4BeforeSettlementProposal",
              providerTurnId,
            }) ?? Promise.resolve(),
        );
      }
      nextStep = yield* tx.transact(
        Effect.gen(function* () {
          if (
            settlement._tag === "Failed" &&
            settlement.failure.reason.startsWith("ProviderFailure:") &&
            providerTurns !== undefined
          ) {
            const dangling =
              yield* providerTurns.findUnsettledByTurn(providerTurnId);
            if (dangling !== null) {
              yield* providerTurns.failTurn(providerTurnId, yield* now());
            }
          }
          return yield* loopSteps.transition(
            {
              identity: preparedStep.identity,
              expectedRevision: preparedStep.revision,
              expectedState: "Prepared",
              next: {
                ...preparedStep,
                state: "SettlementProposed",
                settlement,
                revision: preparedStep.revision + 1,
                updatedAt: yield* now(),
              },
            },
            loopStepFence,
          );
        }),
      );
      if (
        settlement._tag === "Failed" &&
        options.qualificationProbe !== undefined
      ) {
        yield* Effect.promise(
          () =>
            options.qualificationProbe?.({
              boundary: "AH4AfterSettlementProposal",
              providerTurnId,
            }) ?? Promise.resolve(),
        );
      }
    }
    return nextStep;
  });
};
