import {
  type ProviderTurnId,
  providerTurnRepairInferenceId,
} from "@arbor/domain";
import {
  decodeTurn,
  type InstructionFragment,
  type TurnPreparation,
} from "@arbor/model-context";
import type {
  AgentLoopStepRecord,
  ExecutionActivity,
  ExecutionDriverError,
  ProviderRunResult,
} from "@arbor/ports";
import { Effect } from "effect";
import {
  type ModelDecisionOutcome,
  REPAIR_POLICY,
  safetyStop,
} from "../../agent-loop-policy.js";
import { decideRepair } from "../../repair.js";
import type { ModelDecisionDependencies } from "../contract.js";
import type { OverflowRecoveryState } from "../recovery/overflow-state.js";

type ResultDependencies = Pick<
  ModelDecisionDependencies,
  | "input"
  | "tx"
  | "loopSteps"
  | "loopStepFence"
  | "providerTurns"
  | "options"
  | "completeProviderTurn"
  | "failure"
  | "now"
>;

export type ProviderDecisionResult =
  | ModelDecisionOutcome
  | {
      readonly _tag: "Restart";
      readonly overflow: OverflowRecoveryState;
      readonly repairAttempt: number;
      readonly repairFragments: ReadonlyArray<InstructionFragment>;
    };

/** Persist the successful Provider result, close its activity, and decode
 * or record the exact repair transition. Do not admit another call here. */
export const processSuccessfulProviderResult = (
  dependencies: ResultDependencies,
  phase: {
    readonly turn: number;
    readonly repairAttempt: number;
    readonly providerTurnId: ProviderTurnId;
    readonly loopStep: AgentLoopStepRecord | undefined;
    readonly preparation: Extract<TurnPreparation, { readonly _tag: "Ready" }>;
    readonly providerRun: ProviderRunResult;
    readonly providerAdmission:
      | { readonly activity: ExecutionActivity }
      | undefined;
    readonly conversationExecution: boolean;
    readonly overflow: OverflowRecoveryState;
  },
): Effect.Effect<ProviderDecisionResult, ExecutionDriverError> => {
  const {
    input,
    tx,
    loopSteps,
    loopStepFence,
    providerTurns,
    options,
    completeProviderTurn,
    failure,
    now,
  } = dependencies;
  const {
    turn,
    repairAttempt,
    providerTurnId,
    preparation,
    providerRun,
    providerAdmission,
    conversationExecution,
  } = phase;
  return Effect.gen(function* () {
    let loopStep = phase.loopStep;
    const events = providerRun.events;
    if (
      loopStep !== undefined &&
      loopSteps !== undefined &&
      loopStepFence !== undefined
    ) {
      const settled =
        providerTurns === undefined
          ? undefined
          : yield* tx
              .transact(providerTurns.findSettledResult(providerTurnId))
              .pipe(Effect.mapError(failure));
      if (
        settled?._tag === "SettledSuccess" &&
        options.qualificationProbe !== undefined
      ) {
        yield* Effect.promise(
          () =>
            options.qualificationProbe?.({
              boundary: "AH3BeforeStepAvailable",
              providerTurnId,
            }) ?? Promise.resolve(),
        );
      }
      loopStep = yield* tx
        .transact(
          loopSteps.transition(
            {
              identity: loopStep.identity,
              expectedRevision: loopStep.revision,
              expectedState: "Prepared",
              next: {
                ...loopStep,
                ...(settled?._tag === "SettledSuccess"
                  ? { manifestId: settled.manifestId }
                  : {}),
                state: "ProviderResultAvailable",
                decoderVersion: "decode-turn-v1",
                revision: loopStep.revision + 1,
                updatedAt: yield* now(),
              },
            },
            loopStepFence,
          ),
        )
        .pipe(Effect.mapError(failure));
      if (options.qualificationProbe !== undefined) {
        yield* Effect.promise(
          () =>
            options.qualificationProbe?.({
              boundary: "AH3AfterStepAvailable",
              providerTurnId,
            }) ?? Promise.resolve(),
        );
      }
    }
    // D5: end-bracket the provider call (call completion). D1
    // (B-4): report the real ProviderAttempt ordinal observed by
    // ProviderRuntime, so the gate sees actual transient retries
    // (retry never creates a new ProviderTurn — DID §6A.9). The
    // end bracket is not a D4 turn boundary.
    if (providerAdmission !== undefined) {
      const endDecision = yield* completeProviderTurn(
        providerAdmission.activity,
        providerRun.attemptNo,
      );
      if (endDecision === "Stop") {
        return {
          _tag: "Settle" as const,
          settlement: safetyStop("RuntimeSafetyStop"),
        };
      }
    }
    const decoded = decodeTurn(events);
    if (decoded.ok) {
      return {
        _tag: "Ready" as const,
        turn: preparation.turn,
        output: decoded.output,
        ...(loopStep === undefined ? {} : { loopStep }),
        ...(conversationExecution ? { conversation: true } : {}),
      };
    }
    const repair = decideRepair(
      REPAIR_POLICY,
      repairAttempt,
      preparation.turn.manifest.outputContractRef,
      decoded.reason,
    );
    if (repair._tag === "Exhausted") {
      if (
        loopStep !== undefined &&
        loopSteps !== undefined &&
        loopStepFence !== undefined &&
        loopStep.state === "ProviderResultAvailable"
      ) {
        const rejectedStep = loopStep;
        const outputRejected = yield* tx
          .transact(
            loopSteps.transition(
              {
                identity: rejectedStep.identity,
                expectedRevision: rejectedStep.revision,
                expectedState: "ProviderResultAvailable",
                next: {
                  ...rejectedStep,
                  state: "OutputRejected",
                  repairDisposition: {
                    _tag: "Exhausted",
                    settlement: repair.settlement,
                  },
                  revision: rejectedStep.revision + 1,
                  updatedAt: yield* now(),
                },
              },
              loopStepFence,
            ),
          )
          .pipe(Effect.mapError(failure));
        if (
          repair.settlement._tag === "Failed" &&
          options.qualificationProbe !== undefined
        ) {
          yield* Effect.promise(
            () =>
              options.qualificationProbe?.({
                boundary: "AH4RepairBeforeSettlementProposal",
                providerTurnId,
              }) ?? Promise.resolve(),
          );
        }
        yield* tx
          .transact(
            loopSteps.transition(
              {
                identity: outputRejected.identity,
                expectedRevision: outputRejected.revision,
                expectedState: "OutputRejected",
                next: {
                  ...outputRejected,
                  state: "SettlementProposed",
                  settlement: repair.settlement,
                  revision: outputRejected.revision + 1,
                  updatedAt: yield* now(),
                },
              },
              loopStepFence,
            ),
          )
          .pipe(Effect.mapError(failure));
        if (
          repair.settlement._tag === "Failed" &&
          options.qualificationProbe !== undefined
        ) {
          yield* Effect.promise(
            () =>
              options.qualificationProbe?.({
                boundary: "AH4RepairAfterSettlementProposal",
                providerTurnId,
              }) ?? Promise.resolve(),
          );
        }
      }
      return { _tag: "Settle" as const, settlement: repair.settlement };
    }
    if (
      loopStep !== undefined &&
      loopSteps !== undefined &&
      loopStepFence !== undefined &&
      loopStep.state === "ProviderResultAvailable"
    ) {
      const rejectedStep = loopStep;
      const successorIdentity = {
        executionId: input.execution.executionId,
        logicalStepNo: turn,
        repairAttempt: repairAttempt + 1,
      } as const;
      const successorProviderTurnId = providerTurnRepairInferenceId(
        input.execution.executionId,
        turn,
        repairAttempt + 1,
      );
      yield* tx
        .transact(
          Effect.gen(function* () {
            yield* loopSteps.transition(
              {
                identity: rejectedStep.identity,
                expectedRevision: rejectedStep.revision,
                expectedState: "ProviderResultAvailable",
                next: {
                  ...rejectedStep,
                  state: "OutputRejected",
                  repairDisposition: {
                    _tag: "Retry",
                    successor: {
                      ...successorIdentity,
                      providerTurnId: successorProviderTurnId,
                    },
                  },
                  successor: {
                    ...successorIdentity,
                    providerTurnId: successorProviderTurnId,
                  },
                  revision: rejectedStep.revision + 1,
                  updatedAt: yield* now(),
                },
              },
              loopStepFence,
            );
            yield* loopSteps.ensureSuccessor(
              rejectedStep.identity,
              {
                identity: successorIdentity,
                predecessor: rejectedStep.identity,
                providerTurnId: successorProviderTurnId,
                state: "Prepared",
                nextActionIndex: 0,
                revision: 0,
                updatedAt: yield* now(),
              },
              loopStepFence,
            );
          }),
        )
        .pipe(Effect.mapError(failure));
    }
    return {
      _tag: "Restart" as const,
      overflow: phase.overflow,
      repairAttempt: repairAttempt + 1,
      repairFragments: [repair.repairFragment],
    };
  });
};
