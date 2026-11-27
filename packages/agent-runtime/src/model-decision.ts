import type { ExecutionSettlement } from "@arbor/domain";
import {
  conversationResponseEpisode,
  executionEpisode,
  ProviderTurnId,
  parse,
  providerTurnInferenceId,
  providerTurnRepairInferenceId,
  workEpisode,
} from "@arbor/domain";
import {
  type InstructionFragment,
  SESSION_TIMELINE_ENTRY_LIMIT,
} from "@arbor/model-context";
import type {
  ConversationAttemptStore,
  ConversationResponseJobStore,
  ExecutionDriverError,
  ExecutionRepository,
  HumanMessageStore,
  LocalPlanStore,
  RecoveryAttentionFactStore,
  SessionEntryRecord,
  WorkspaceKnowledgePort,
  WorkspacePlacementPort,
} from "@arbor/ports";
import { PROVIDER_REASONING_ATTACHMENT_MEDIA_TYPE } from "@arbor/ports";
import { Effect, Option } from "effect";
import type { ModelDecisionOutcome } from "./agent-loop-policy.js";
import {
  foldDecisionSessionContextError,
  foldDecisionWorkspaceContextError,
} from "./decision/context/errors.js";
import { loadDecisionSessionContext } from "./decision/context/session.js";
import { loadDecisionWorkspaceContext } from "./decision/context/workspace.js";
import type { ModelDecisionDependencies } from "./decision/contract.js";
import { loadConversationDecisionContext } from "./decision/conversation-context.js";
import {
  foldConversationDecisionContextError,
  foldSettlementProposalError,
  foldStartupRecoveryError,
  foldStepRecoveryError,
} from "./decision/errors.js";
import { foldTurnPreparationError } from "./decision/preparation/errors.js";
import { prepareTurnForDecision } from "./decision/preparation/turn.js";
import {
  foldProviderInvocationError,
  foldProviderReplayError,
} from "./decision/provider/errors.js";
import { invokePreparedProviderTurn } from "./decision/provider/invocation.js";
import { replayPreparedProviderTurn } from "./decision/provider/replay.js";
import {
  foldNativeCheckpointRecoveryError,
  foldWorkPlanRebaseError,
} from "./decision/recovery/errors.js";
import { recoverNativeCheckpointContext } from "./decision/recovery/native-rebase.js";
import type { OverflowRecoveryState } from "./decision/recovery/overflow-state.js";
import { rebaseWorkPlanCheckpoint } from "./decision/recovery/work-plan-rebase.js";
import { proposePreparedStepSettlement } from "./decision/settlement.js";
import { recoverStartupDecision } from "./decision/startup-recovery.js";
import { recoverDecisionStep } from "./decision/step-recovery.js";
import { assembleWorkContext } from "./work-context.js";

export { isValidOverflowCompactionLinkPair } from "./agent-loop-step-recovery.js";
export type {
  ModelDecisionDependencies,
  ModelDecisionOptions,
} from "./decision/contract.js";
export {
  classifySubmittedDecisionBindingFailure,
  isPinnedSubmittedDecisionReplay,
  type SubmittedDecisionBindingFailureCode,
} from "./decision/submitted-replay.js";

const decodedProviderTurnId = (value: unknown): ProviderTurnId | null => {
  if (typeof value !== "string") return null;
  try {
    return parse(ProviderTurnId)(value);
  } catch {
    return null;
  }
};

export const runModelDecision = (
  dependencies: ModelDecisionDependencies,
  turn: number,
  initialRepairAttempt = 0,
): Effect.Effect<
  ModelDecisionOutcome,
  ExecutionDriverError,
  // E05 sink: capabilities acquired directly by decision submodules.
  | LocalPlanStore
  | WorkspaceKnowledgePort
  | WorkspacePlacementPort
  | RecoveryAttentionFactStore
  | HumanMessageStore
  | ConversationResponseJobStore
  | ConversationAttemptStore
  | ExecutionRepository
> => {
  const {
    input,
    capability,
    currentControlBasis,
    providerRuntime,
    tx,
    providerTurns,
    sessions,
    works,
    workspaces,
    options,
    admitProviderTurn,
    completeProviderTurn,
    failure,
  } = dependencies;
  const compactionDependencies = {
    providerRuntime,
    sessions,
    tx,
    ...(providerTurns === undefined ? {} : { providerTurns }),
    admitProviderTurn,
    completeProviderTurn,
    ...(options.qualificationProbe === undefined
      ? {}
      : { qualificationProbe: options.qualificationProbe }),
  };
  const currentBindingFingerprint =
    capability.bindingFingerprint ??
    `legacy:${capability.providerRef ?? options.providerRef ?? "provider"}:${capability.modelRef}`;
  const providerNativeSupported =
    capability.portableRequestCompatibility?.operationKinds.includes(
      "CompactionNative",
    ) === true;
  const reasoningProjectionBinding =
    options.protocolFamily !== undefined &&
    /^p16fp_[0-9a-f]{64}$/.test(currentBindingFingerprint)
      ? {
          modelRef: capability.modelRef,
          protocolFamily: options.protocolFamily,
          bindingFingerprint: currentBindingFingerprint,
        }
      : undefined;
  const loadReasoningAttachmentBlobs = (
    entries: ReadonlyArray<SessionEntryRecord>,
  ): Effect.Effect<ReadonlyMap<string, Uint8Array>, ExecutionDriverError> => {
    const refs = [
      ...new Set(
        entries.flatMap((entry) => {
          if (typeof entry.payload !== "object" || entry.payload === null) {
            return [];
          }
          const payload = entry.payload as Record<string, unknown>;
          return payload._tag === "AttachmentRef" &&
            payload.mediaType === PROVIDER_REASONING_ATTACHMENT_MEDIA_TYPE &&
            typeof payload.ref === "string" &&
            payload.ref.length > 0
            ? [payload.ref]
            : [];
        }),
      ),
    ];
    if (refs.length === 0) return Effect.succeed(new Map());
    if (dependencies.blobs === undefined) {
      return Effect.fail(
        failure({ _tag: "ReasoningRoundTripBlobStoreUnavailable" }),
      );
    }
    const blobs = dependencies.blobs;
    return Effect.forEach(refs, (ref) =>
      blobs.get(ref).pipe(
        Effect.mapError(failure),
        Effect.map((bytes) => [ref, bytes] as const),
      ),
    ).pipe(Effect.map((entries) => new Map(entries)));
  };
  const isConversationResponseExecution =
    conversationResponseEpisode(input.execution) !== null;
  return Effect.gen(function* () {
    let repairAttempt = initialRepairAttempt;
    let compactionAttempts = 0;
    let overflow: OverflowRecoveryState = {
      overflowRecoveryAttempt: 0,
      replayPersistedContextLimit: false,
      resumeOverflowCompactionProviderTurnId: undefined,
      resumeOverflowNativeCompaction: false,
      resumeOverflowNativeCompactionInput: undefined,
      overflowReplacementProviderTurnId: undefined,
    };
    let repairFragments: ReadonlyArray<InstructionFragment> = [];
    const readExecutionTimeline = () =>
      executionEpisode(input.execution)?._tag === "WorkEpisode"
        ? sessions.listWorkActiveFrontier(
            input.execution.sessionId,
            input.execution.executionId,
            workEpisode(input.execution)?.workId,
          )
        : sessions.listRecentEntries(
            input.execution.sessionId,
            SESSION_TIMELINE_ENTRY_LIMIT,
          );
    const loadWorkCompactionPinning = () =>
      Effect.gen(function* () {
        if (executionEpisode(input.execution)?._tag !== "WorkEpisode") {
          return {};
        }
        const boundWork = workEpisode(input.execution);
        if (boundWork === null) return {};
        const [workspace, work] = yield* Effect.all(
          [
            tx.transact(workspaces.findById(input.execution.workspaceId)),
            tx.transact(works.findById(boundWork.workId)),
          ],
          { concurrency: 1 },
        ).pipe(Effect.mapError(failure));
        if (Option.isNone(workspace)) {
          return yield* Effect.fail(
            failure({
              _tag: "WorkspaceContextMissing",
              workspaceId: input.execution.workspaceId,
            }),
          );
        }
        if (Option.isNone(work)) {
          return yield* Effect.fail(
            failure({
              _tag: "WorkContextMissing",
              workId: boundWork.workId,
            }),
          );
        }
        const workContext = assembleWorkContext(
          workspace.value,
          work.value,
          input.execution,
        );
        const controlBasis = yield* currentControlBasis();
        return {
          pinnedInstructions: workContext.fragments.map((fragment) => ({
            slotId: fragment.scope,
            authorityRole: fragment.authorityRole,
            text:
              workContext.contents.get(fragment.contentRef) ??
              fragment.contentRef,
          })),
          pinnedInstructionFragments: workContext.fragments.map((fragment) => ({
            identity: fragment.identity,
            revision: fragment.revision,
            hash: fragment.hash,
            source: fragment.source,
            scope: fragment.scope,
          })),
          controlBasis,
        };
      });
    const startupRecovery = yield* recoverStartupDecision(dependencies, {
      cursor: { turn, repairAttempt },
      currentBindingFingerprint,
      providerNativeSupported,
      compactionDependencies,
      readExecutionTimeline,
      loadWorkCompactionPinning,
    }).pipe(Effect.mapError(foldStartupRecoveryError));
    if (startupRecovery._tag === "Complete") {
      return startupRecovery.outcome;
    }
    turn = startupRecovery.cursor.turn;
    repairAttempt = startupRecovery.cursor.repairAttempt;
    while (true) {
      const controlBasis = yield* currentControlBasis();
      const providerTurnId =
        overflow.overflowReplacementProviderTurnId ??
        (repairAttempt === 0
          ? providerTurnInferenceId(input.execution.executionId, turn)
          : providerTurnRepairInferenceId(
              input.execution.executionId,
              turn,
              repairAttempt,
            ));
      const loopStepIdentity = {
        executionId: input.execution.executionId,
        logicalStepNo: turn,
        repairAttempt,
      } as const;
      const stepRecovery = yield* recoverDecisionStep(dependencies, {
        turn,
        repairAttempt,
        providerTurnId,
        loopStepIdentity,
        overflow,
        isConversationResponseExecution,
        currentBindingFingerprint,
        providerNativeSupported,
        compactionDependencies,
        readExecutionTimeline,
        loadWorkCompactionPinning,
      }).pipe(Effect.mapError(foldStepRecoveryError));
      if (stepRecovery._tag === "Complete") return stepRecovery.outcome;
      overflow = stepRecovery.overflow;
      if (stepRecovery._tag === "Restart") continue;
      let loopStep = stepRecovery.loopStep;
      const proposeSettlement = (
        settlement: ExecutionSettlement,
      ): Effect.Effect<ModelDecisionOutcome, ExecutionDriverError> =>
        Effect.gen(function* () {
          loopStep = yield* proposePreparedStepSettlement(dependencies, {
            loopStep,
            providerTurnId,
            settlement,
          }).pipe(Effect.mapError(foldSettlementProposalError));
          return { _tag: "Settle", settlement };
        });
      const conversationContext = yield* loadConversationDecisionContext(
        dependencies,
        {
          turn,
          loopStep,
          currentBindingFingerprint,
          providerNativeSupported,
          compactionDependencies,
          readExecutionTimeline,
          proposeSettlement,
        },
      ).pipe(Effect.mapError(foldConversationDecisionContextError));
      if (conversationContext._tag === "Restart") continue;
      if (conversationContext._tag === "Complete") {
        return conversationContext.outcome;
      }
      const { conversationExecution, placementExecution } = conversationContext;
      const sessionContext = yield* loadDecisionSessionContext(dependencies, {
        ...conversationContext,
        turn,
        repairAttempt,
        providerTurnId,
        loopStep,
        controlBasis,
        currentBindingFingerprint,
        providerNativeSupported,
        reasoningProjectionBinding,
        loadReasoningAttachmentBlobs,
        readExecutionTimeline,
      }).pipe(Effect.mapError(foldDecisionSessionContextError));
      if (sessionContext._tag === "Complete") return sessionContext.outcome;
      const {
        recentSessionEntries,
        reasoningAttachmentBlobs,
        sessionProjection,
        sessionRecord,
        stepContext,
        inputItems,
        historyContext,
        messageContextRefs,
        nativeCheckpoint,
        checkpointOwnerExecutionId,
        nativeCheckpointIsInherited,
      } = sessionContext;
      const nativeRecovery = yield* recoverNativeCheckpointContext(
        dependencies,
        {
          cursor: { turn, repairAttempt },
          loopStepIdentity,
          nativeCheckpoint,
          sessionRecord,
          checkpointOwnerExecutionId,
          nativeCheckpointIsInherited,
          recentSessionEntries,
          currentBindingFingerprint,
          providerNativeSupported,
          reasoningProjectionBinding,
          reasoningAttachmentBlobs,
          compactionDependencies,
          loadWorkCompactionPinning,
          proposeSettlement,
          decodedProviderTurnId,
          compactionAttempts,
          overflow,
        },
      ).pipe(Effect.mapError(foldNativeCheckpointRecoveryError));
      if (nativeRecovery._tag === "Complete") return nativeRecovery.outcome;
      turn = nativeRecovery.cursor.turn;
      repairAttempt = nativeRecovery.cursor.repairAttempt;
      compactionAttempts = nativeRecovery.compactionAttempts;
      overflow = nativeRecovery.overflow;
      if (nativeRecovery._tag === "Restart") continue;
      const workspaceContext = yield* loadDecisionWorkspaceContext(
        dependencies,
        placementExecution,
      ).pipe(Effect.mapError(foldDecisionWorkspaceContextError));
      const { workspace, currentWork, localPlanScope } = workspaceContext;
      inputItems.push(...workspaceContext.inputItems);
      messageContextRefs.push(...workspaceContext.messageContextRefs);
      if (
        localPlanScope &&
        nativeCheckpoint !== undefined &&
        !nativeCheckpoint.bindingMatches
      ) {
        const planRebase = yield* rebaseWorkPlanCheckpoint(dependencies, {
          turn,
          loopStepIdentity,
          loopStep,
          nativeCheckpoint,
          recentSessionEntries,
          currentBindingFingerprint,
          providerNativeSupported,
          reasoningProjectionBinding,
          reasoningAttachmentBlobs,
          compactionDependencies,
          loadWorkCompactionPinning,
          proposeSettlement,
          compactionAttempts,
          overflow,
        }).pipe(Effect.mapError(foldWorkPlanRebaseError));
        if (planRebase._tag === "Complete") return planRebase.outcome;
        compactionAttempts = planRebase.compactionAttempts;
        overflow = planRebase.overflow;
        continue;
      }
      const turnPreparation = yield* prepareTurnForDecision(dependencies, {
        turn,
        repairAttempt,
        repairFragments,
        providerTurnId,
        loopStep,
        loopStepIdentity,
        workspace,
        currentWork,
        conversation: conversationContext,
        controlBasis,
        stepContext,
        sessionProjection,
        historyContext,
        inputItems,
        messageContextRefs,
        overflow,
        compactionAttempts,
        currentBindingFingerprint,
        providerNativeSupported,
        compactionDependencies,
        proposeSettlement,
      }).pipe(Effect.mapError(foldTurnPreparationError));
      if (turnPreparation._tag === "Restart") {
        compactionAttempts = turnPreparation.compactionAttempts;
        overflow = turnPreparation.overflow;
        continue;
      }
      if (turnPreparation._tag !== "Prepared") return turnPreparation;
      const { preparation, turnInput, compactionWorkPinning } = turnPreparation;
      const replay = yield* replayPreparedProviderTurn(dependencies, {
        loopStep,
        preparation,
        conversationExecution,
        replayPersistedContextLimit: overflow.replayPersistedContextLimit,
      }).pipe(Effect.mapError(foldProviderReplayError));
      if (replay._tag !== "Proceed") return replay;
      loopStep = replay.loopStep;
      const invocation = yield* invokePreparedProviderTurn(dependencies, {
        turn,
        repairAttempt,
        repairFragments,
        providerTurnId,
        loopStep,
        preparation,
        turnInput,
        overflow,
        conversation: conversationContext,
        stepContext,
        inputItems,
        messageContextRefs,
        currentBindingFingerprint,
        compactionDependencies,
        compactionWorkPinning,
        proposeSettlement,
      }).pipe(Effect.mapError(foldProviderInvocationError));
      if (invocation._tag !== "Restart") return invocation;
      overflow = invocation.overflow;
      repairAttempt = invocation.repairAttempt;
      repairFragments = invocation.repairFragments;
    }
  });
};
