import type {
  ExecutionSettlement,
  ProviderTurnId,
  Work,
  Workspace,
} from "@arbor/domain";
import { responsibilityBound } from "@arbor/domain";
import {
  type ControlBasis,
  GENERIC_COGNITION_PROGRAM,
  type InstructionFragment,
  ModelContext,
  type projectCompressibleHistory,
  type SessionTimelineProjection,
  type TurnPreparation,
  TurnProfileResolver,
} from "@arbor/model-context";
import type {
  AgentLoopStepIdentity,
  AgentLoopStepRecord,
  DecisionRequestStore,
  ExecutionDriverError,
  PortableInputItem,
  ProviderRunInput,
} from "@arbor/ports";
import { Effect, type Option } from "effect";
import {
  type ModelDecisionOutcome,
  runtimeSafetyFragment,
  safetyStop,
} from "../../agent-loop-policy.js";
import { runCompaction } from "../../compaction-coordinator.js";
import { workExecutionLoopFragmentsFor } from "../../prompt-assets.js";
import type { AgentStepContext } from "../../step-context.js";
import type { ModelDecisionDependencies } from "../contract.js";
import type { ConversationDecisionContextResult } from "../conversation-context.js";
import type { OverflowRecoveryState } from "../recovery/overflow-state.js";
import { resumePinnedOverflowCompaction } from "../recovery/resume-overflow-compaction.js";
import type { TurnPreparationError } from "./errors.js";
import {
  assembleDecisionInstructions,
  type CompactionWorkPinning,
} from "./instructions.js";

type PreparationDependencies = Pick<
  ModelDecisionDependencies,
  | "input"
  | "capability"
  | "tx"
  | "loopSteps"
  | "loopStepFence"
  | "providerTurns"
  | "options"
  | "now"
  | "conversationCheckpoints"
  | "blobs"
>;

type PreparationResult =
  | ModelDecisionOutcome
  | {
      readonly _tag: "Prepared";
      readonly preparation: Extract<
        TurnPreparation,
        { readonly _tag: "Ready" }
      >;
      readonly turnInput: ProviderRunInput;
      readonly compactionWorkPinning: CompactionWorkPinning;
    }
  | {
      readonly _tag: "Restart";
      readonly overflow: OverflowRecoveryState;
      readonly compactionAttempts: number;
    };

/** Assemble canonical instructions and decision context, resume any pinned
 * compaction, then prepare the exact Provider request. No inference is admitted here. */
export const prepareTurnForDecision = (
  dependencies: PreparationDependencies,
  phase: {
    readonly turn: number;
    readonly repairAttempt: number;
    readonly repairFragments: ReadonlyArray<InstructionFragment>;
    readonly providerTurnId: ProviderTurnId;
    readonly loopStep: AgentLoopStepRecord | undefined;
    readonly loopStepIdentity: AgentLoopStepIdentity;
    readonly workspace: Option.Some<Workspace>;
    readonly currentWork: Work | null;
    readonly conversation: Extract<
      ConversationDecisionContextResult,
      { readonly _tag: "Ready" }
    >;
    readonly controlBasis: ControlBasis;
    readonly stepContext: AgentStepContext;
    readonly sessionProjection: SessionTimelineProjection;
    readonly historyContext: ReturnType<typeof projectCompressibleHistory>;
    readonly inputItems: PortableInputItem[];
    readonly messageContextRefs: string[];
    readonly overflow: OverflowRecoveryState;
    readonly compactionAttempts: number;
    readonly currentBindingFingerprint: string;
    readonly providerNativeSupported: boolean;
    readonly compactionDependencies: Parameters<typeof runCompaction>[1];
    readonly proposeSettlement: (
      settlement: ExecutionSettlement,
    ) => Effect.Effect<ModelDecisionOutcome, ExecutionDriverError>;
  },
): Effect.Effect<
  PreparationResult,
  TurnPreparationError,
  ModelContext | TurnProfileResolver | DecisionRequestStore
> => {
  const { input, capability, loopStepFence, options } = dependencies;
  const agentBinding =
    input.execution.binding._tag === "WorkspaceExecution"
      ? responsibilityBound(input.execution.binding.workspaceId)
      : input.execution.binding;
  const {
    turn,
    repairFragments,
    providerTurnId,
    loopStep,
    loopStepIdentity,
    workspace,
    currentWork,
    controlBasis,
    stepContext,
    sessionProjection,
    historyContext,
    inputItems,
    messageContextRefs,
    currentBindingFingerprint,
    providerNativeSupported,
    compactionDependencies,
    proposeSettlement,
  } = phase;
  const { conversationMessages, conversationExecution } = phase.conversation;
  return Effect.gen(function* () {
    const modelContext = yield* ModelContext;
    const turnProfileResolver = yield* TurnProfileResolver;
    let compactionAttempts = phase.compactionAttempts;
    const instructions = yield* assembleDecisionInstructions(dependencies, {
      workspace,
      currentWork,
      controlBasis,
      conversationExecution,
      loopStep,
      providerTurnId,
      inputItems,
      messageContextRefs,
      proposeSettlement,
    });
    if (instructions._tag !== "Assembled") return instructions;
    const {
      workContext,
      compactionWorkPinning,
      conversationActionFragments,
      workExecutionLoopAsset,
      instructionContents,
    } = instructions;
    const resumed = yield* resumePinnedOverflowCompaction(dependencies, {
      turn,
      loopStepIdentity,
      loopStep,
      conversation: phase.conversation,
      stepContext,
      inputItems,
      messageContextRefs,
      currentBindingFingerprint,
      providerNativeSupported,
      compactionDependencies,
      compactionWorkPinning,
      compactionAttempts,
      overflow: phase.overflow,
      proposeSettlement,
    });
    if (resumed._tag !== "Proceed") return resumed;
    const turnProfile = yield* turnProfileResolver.resolve({
      execution: input.execution,
      conversation: conversationExecution && conversationMessages.length > 0,
    });
    const workExecutionLoopFragments = workExecutionLoopFragmentsFor(
      turnProfile.purpose,
    );
    if (workExecutionLoopFragments.length > 0) {
      instructionContents.set(
        workExecutionLoopAsset.contentRef,
        workExecutionLoopAsset.text,
      );
    }
    const prepared = yield* Effect.match(
      modelContext.prepareTurn({
        executionId: input.execution.executionId,
        sessionId: input.execution.sessionId,
        contextEpoch: stepContext.contextEpoch,
        providerTurnId,
        binding: agentBinding,
        workspaceId: input.execution.workspaceId,
        cognitiveMode: input.agentExecutionState.currentMode ?? "execute",
        program: GENERIC_COGNITION_PROGRAM,
        fragments: [
          runtimeSafetyFragment,
          ...workContext.fragments,
          ...workExecutionLoopFragments,
          ...conversationActionFragments,
          ...repairFragments,
        ],
        contextFragments: historyContext.contextFragments,
        compressibleInputItemIndexes:
          historyContext.compressibleInputItemIndexes,
        budget: {
          modelWindow: capability.contextWindow,
          outputReserve: capability.outputCeiling,
          protocolReserve: 100,
          toolReserve: 100,
        },
        controlBasis,
        maxOutputTokens: capability.outputCeiling,
        bodySkillIds: [],
        turnProfile,
        instructionContents,
        stepContext,
        ...(inputItems.length > 0 ? { inputItems } : {}),
        ...(messageContextRefs.length > 0 ? { messageContextRefs } : {}),
        ...(options.providerRef !== undefined
          ? { providerRef: options.providerRef }
          : {}),
        ...(options.protocolFamily !== undefined
          ? { protocolFamily: options.protocolFamily }
          : {}),
        ...((sessionProjection.reasoningAttachmentRefs?.length ?? 0) > 0
          ? {
              reasoningAttachmentRefs:
                sessionProjection.reasoningAttachmentRefs as NonNullable<
                  typeof sessionProjection.reasoningAttachmentRefs
                >,
            }
          : {}),
      }),
      {
        onFailure: (cause) => ({ ok: false as const, cause }),
        onSuccess: (value) => ({ ok: true as const, value }),
      },
    );
    if (!prepared.ok) {
      if (prepared.cause._tag === "ContextUnsatisfiable") {
        return yield* proposeSettlement({
          _tag: "Failed",
          failure: {
            _tag: "ExecutionFailure",
            reason: "ContextUnsatisfiable",
          },
        });
      }
      return yield* Effect.fail<TurnPreparationError>(prepared.cause);
    }
    const preparation = prepared.value;

    if (preparation._tag === "GovernanceBlocked") {
      return yield* proposeSettlement(safetyStop("GovernanceBlocked"));
    }
    if (preparation._tag === "NeedsCompaction") {
      if (loopStepFence === undefined) {
        return yield* Effect.fail<TurnPreparationError>({
          _tag: "CompactionFenceUnavailable",
          executionId: input.execution.executionId,
        });
      }
      if (compactionAttempts >= 1) {
        return yield* proposeSettlement(safetyStop("CompactionNoGain"));
      }
      compactionAttempts += 1;
      const nativeSupported =
        capability.portableRequestCompatibility?.operationKinds.includes(
          "CompactionNative",
        ) === true;
      const compacted = yield* runCompaction(
        {
          execution: input.execution,
          logicalStepNo: loopStep?.identity.logicalStepNo ?? turn,
          ...(loopStep === undefined
            ? {}
            : {
                sourceAgentLoopStep: {
                  executionId: String(loopStep.identity.executionId),
                  logicalStepNo: loopStep.identity.logicalStepNo,
                  repairAttempt: loopStep.identity.repairAttempt,
                  providerTurnId: String(loopStep.providerTurnId),
                },
              }),
          currentEpoch: stepContext.contextEpoch,
          modelRef: capability.modelRef,
          ...(options.secretRef === undefined
            ? {}
            : { secretRef: options.secretRef }),
          bindingFingerprint: stepContext.bindingFingerprint,
          inputFrontier: stepContext.inputFrontier,
          contextRefs: messageContextRefs,
          inputItems,
          ...compactionWorkPinning,
          fence: loopStepFence,
          nativeSupported,
        },
        compactionDependencies,
      );
      if ("_tag" in compacted) {
        return yield* proposeSettlement(safetyStop("RuntimeSafetyStop"));
      }
      return {
        _tag: "Restart" as const,
        overflow: phase.overflow,
        compactionAttempts,
      };
    }

    const turnInput: ProviderRunInput = {
      providerTurnId: preparation.turn.manifest.providerTurnId,
      executionId: input.execution.executionId,
      sessionId: input.execution.sessionId,
      contextEpoch: preparation.turn.manifest.contextEpoch,
      modelRef: capability.modelRef,
      outputContractRef: preparation.turn.manifest.outputContractRef,
      ...(options.onProviderProgress !== undefined
        ? {
            onProgress: (
              event: import("@arbor/ports").ProviderRuntimeProgress,
            ) => {
              options.onProviderProgress?.(
                String(input.execution.executionId),
                event,
              );
            },
          }
        : {}),
      manifestJson: JSON.stringify(preparation.turn.manifest),
      request: preparation.turn.request,
      ...(options.cancellationSignal === undefined
        ? {}
        : { cancellationSignal: options.cancellationSignal }),
      ...(options.secretRef !== undefined
        ? { secretRef: options.secretRef }
        : {}),
      ...(options.executionPolicyOverrides !== undefined
        ? {
            executionPolicyOverrides: options.executionPolicyOverrides,
          }
        : {}),
    };
    return {
      _tag: "Prepared" as const,
      preparation,
      turnInput,
      compactionWorkPinning,
    };
  });
};
