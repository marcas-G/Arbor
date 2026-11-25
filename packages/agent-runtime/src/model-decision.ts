import type { ExecutionSettlement } from "@arbor/domain";
import {
  ContextEpochNumber,
  conversationResponseEpisode,
  executionEpisode,
  providerTurnOverflowReplacementId as makeOverflowReplacementProviderTurnId,
  ProviderTurnId,
  parse,
  providerTurnInferenceId,
  providerTurnNativeCompactionId,
  providerTurnRepairInferenceId,
  providerTurnSummaryCompactionId,
  workEpisode,
} from "@arbor/domain";
import {
  GENERIC_COGNITION_PROGRAM,
  type InstructionFragment,
  SESSION_TIMELINE_ENTRY_LIMIT,
} from "@arbor/model-context";
import type {
  ExecutionDriverError,
  PortableModelRequestV2,
  ProviderRunInput,
  SessionEntryRecord,
} from "@arbor/ports";
import {
  PROVIDER_REASONING_ATTACHMENT_MEDIA_TYPE,
} from "@arbor/ports";
import { Effect, Option } from "effect";
import {
  type ModelDecisionOutcome,
  runtimeSafetyFragment,
  safetyStop,
} from "./agent-loop-policy.js";
import { runCompaction } from "./compaction-coordinator.js";
import { runConversationCheckpointCompaction } from "./checkpoint/conversation/compaction.js";
import { loadConversationDecisionContext } from "./decision/conversation-context.js";
import { loadDecisionSessionContext } from "./decision/context/session.js";
import { loadDecisionWorkspaceContext } from "./decision/context/workspace.js";
import { rebaseWorkPlanCheckpoint } from "./decision/recovery/work-plan-rebase.js";
import { recoverNativeCheckpointContext } from "./decision/recovery/native-rebase.js";
import {
  GENERIC_INSTRUCTION_ASSETS,
  instructionAssetFragment,
  workExecutionLoopFragmentsFor,
} from "./prompt-assets.js";
import type { ModelDecisionDependencies } from "./decision/contract.js";
import { recoverStartupDecision } from "./decision/startup-recovery.js";
import { recoverDecisionStep } from "./decision/step-recovery.js";
import { proposePreparedStepSettlement } from "./decision/settlement.js";
import { replayPreparedProviderTurn } from "./decision/provider/replay.js";
import { invokePreparedProviderTurn } from "./decision/provider/invocation.js";
import {
  classifySubmittedDecisionBindingFailure,
  isPinnedSubmittedDecisionReplay,
} from "./decision/submitted-replay.js";
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
): Effect.Effect<ModelDecisionOutcome, ExecutionDriverError> => {
  const {
    input,
    agentBinding,
    capability,
    currentControlBasis,
    modelContext,
    providerRuntime,
    tx,
    loopSteps,
    loopStepFence,
    providerTurns,
    sessions,
    turnProfileResolver,
    works,
    decisionRequests,
    workspaces,
    options,
    admitProviderTurn,
    completeProviderTurn,
    failure,
    now,
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
    let overflowRecoveryAttempt = 0;
    let replayPersistedContextLimit = false;
    let resumeOverflowCompactionProviderTurnId:
      | import("@arbor/domain").ProviderTurnId
      | undefined;
    let resumeOverflowNativeCompaction = false;
    let resumeOverflowNativeCompactionInput:
      | {
          readonly manifestJson: string;
          readonly request: PortableModelRequestV2;
        }
      | undefined;
    let overflowReplacementProviderTurnId:
      | import("@arbor/domain").ProviderTurnId
      | undefined;
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
    });
    if (startupRecovery._tag === "Complete") {
      return startupRecovery.outcome;
    }
    turn = startupRecovery.cursor.turn;
    repairAttempt = startupRecovery.cursor.repairAttempt;
    while (true) {
      const controlBasis = yield* currentControlBasis();
      const providerTurnId =
        overflowReplacementProviderTurnId ??
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
        overflow: {
          overflowRecoveryAttempt,
          replayPersistedContextLimit,
          resumeOverflowCompactionProviderTurnId,
          resumeOverflowNativeCompaction,
          resumeOverflowNativeCompactionInput,
          overflowReplacementProviderTurnId,
        },
        isConversationResponseExecution,
        currentBindingFingerprint,
        providerNativeSupported,
        compactionDependencies,
        readExecutionTimeline,
        loadWorkCompactionPinning,
      });
      if (stepRecovery._tag === "Complete") return stepRecovery.outcome;
      overflowRecoveryAttempt = stepRecovery.overflow.overflowRecoveryAttempt;
      replayPersistedContextLimit = stepRecovery.overflow.replayPersistedContextLimit;
      resumeOverflowCompactionProviderTurnId = stepRecovery.overflow.resumeOverflowCompactionProviderTurnId;
      resumeOverflowNativeCompaction = stepRecovery.overflow.resumeOverflowNativeCompaction;
      resumeOverflowNativeCompactionInput = stepRecovery.overflow.resumeOverflowNativeCompactionInput;
      overflowReplacementProviderTurnId = stepRecovery.overflow.overflowReplacementProviderTurnId;
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
          });
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
      );
      if (conversationContext._tag === "Restart") continue;
      if (conversationContext._tag === "Complete") {
        return conversationContext.outcome;
      }
      const {
        conversationMessages,
        exactConversation,
        conversationExecution,
        conversationOwner,
        conversationProjection,
        conversationCurrentJob,
        placementExecution,
      } = conversationContext;
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
      });
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
          overflow: {
            overflowRecoveryAttempt,
            replayPersistedContextLimit,
            resumeOverflowCompactionProviderTurnId,
            resumeOverflowNativeCompaction,
            resumeOverflowNativeCompactionInput,
            overflowReplacementProviderTurnId,
          },
        },
      );
      if (nativeRecovery._tag === "Complete") return nativeRecovery.outcome;
      turn = nativeRecovery.cursor.turn;
      repairAttempt = nativeRecovery.cursor.repairAttempt;
      compactionAttempts = nativeRecovery.compactionAttempts;
      overflowRecoveryAttempt = nativeRecovery.overflow.overflowRecoveryAttempt;
      replayPersistedContextLimit = nativeRecovery.overflow.replayPersistedContextLimit;
      resumeOverflowCompactionProviderTurnId = nativeRecovery.overflow.resumeOverflowCompactionProviderTurnId;
      resumeOverflowNativeCompaction = nativeRecovery.overflow.resumeOverflowNativeCompaction;
      resumeOverflowNativeCompactionInput = nativeRecovery.overflow.resumeOverflowNativeCompactionInput;
      overflowReplacementProviderTurnId = nativeRecovery.overflow.overflowReplacementProviderTurnId;
      if (nativeRecovery._tag === "Restart") continue;
      const workspaceContext = yield* loadDecisionWorkspaceContext(
        dependencies,
        placementExecution,
      );
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
          overflow: {
            overflowRecoveryAttempt,
            replayPersistedContextLimit,
            resumeOverflowCompactionProviderTurnId,
            resumeOverflowNativeCompaction,
            resumeOverflowNativeCompactionInput,
            overflowReplacementProviderTurnId,
          },
        });
        if (planRebase._tag === "Complete") return planRebase.outcome;
        compactionAttempts = planRebase.compactionAttempts;
        overflowRecoveryAttempt = planRebase.overflow.overflowRecoveryAttempt;
        overflowReplacementProviderTurnId = planRebase.overflow.overflowReplacementProviderTurnId;
        replayPersistedContextLimit = planRebase.overflow.replayPersistedContextLimit;
        continue;
      }
      const workContext = assembleWorkContext(
        workspace.value,
        currentWork,
        input.execution,
      );
      const compactionWorkPinning =
        executionEpisode(input.execution)?._tag === "WorkEpisode"
          ? {
              pinnedInstructions: workContext.fragments.map((fragment) => ({
                slotId: fragment.scope,
                authorityRole: fragment.authorityRole,
                text:
                  workContext.contents.get(fragment.contentRef) ??
                  fragment.contentRef,
              })),
              pinnedInstructionFragments: workContext.fragments.map(
                (fragment) => ({
                  identity: fragment.identity,
                  revision: fragment.revision,
                  hash: fragment.hash,
                  source: fragment.source,
                  scope: fragment.scope,
                }),
              ),
              controlBasis,
            }
          : {};
      const conversationActionAsset =
        GENERIC_INSTRUCTION_ASSETS.rootConversationAction;
      const conversationActionFragments = conversationExecution
        ? [
            instructionAssetFragment(
              "root-conversation-action",
              conversationActionAsset,
            ),
          ]
        : [];
      const workExecutionLoopAsset = GENERIC_INSTRUCTION_ASSETS.baseLoop;
      const instructionContents = new Map(workContext.contents);
      if (conversationExecution) {
        instructionContents.set(
          conversationActionAsset.contentRef,
          conversationActionAsset.text,
        );
      }
      const boundEpisode = executionEpisode(input.execution);
      if (
        boundEpisode?._tag === "DecisionEpisode" &&
        decisionRequests !== undefined
      ) {
        const request = yield* tx
          .transact(decisionRequests.findById(boundEpisode.decisionId))
          .pipe(Effect.mapError(failure));
        if (Option.isNone(request)) {
          return yield* proposeSettlement({
            _tag: "Failed",
            failure: {
              _tag: "ExecutionFailure",
              reason: "DecisionRequestMissingOrSettled",
            },
          });
        }
        let requestContextRevision = request.value.revision;
        if (request.value.state._tag !== "Pending") {
          const pinnedActions =
            loopStep !== undefined && loopSteps !== undefined
              ? yield* tx
                  .transact(loopSteps.listActions(loopStep.identity))
                  .pipe(Effect.mapError(failure))
              : [];
          const pendingSelectionAction = pinnedActions.find(
            (action) =>
              action.actionIndex === loopStep?.nextActionIndex &&
              action.routeKind === "Control" &&
              action.actionKind === "select_current_work" &&
              action.state === "Pending",
          );
          const pinnedProviderResult =
            loopStep !== undefined && providerTurns !== undefined
              ? yield* tx
                  .transact(
                    providerTurns.findSettledResult(loopStep.providerTurnId),
                  )
                  .pipe(Effect.mapError(failure))
              : undefined;
          const replayingPinnedSelection = isPinnedSubmittedDecisionReplay({
            executionWorkspaceId: String(input.execution.workspaceId),
            episode: boundEpisode,
            request: request.value,
            workspace: Option.isSome(workspace)
              ? {
                  currentWorkId:
                    workspace.value.currentWorkId === null
                      ? null
                      : String(workspace.value.currentWorkId),
                  revision: Number(workspace.value.revision),
                }
              : undefined,
            step: loopStep,
            pendingAction: pendingSelectionAction,
            providerTurnId: String(providerTurnId),
            providerResult:
              pinnedProviderResult?._tag === "SettledSuccess"
                ? {
                    _tag: "SettledSuccess",
                    manifestId: String(pinnedProviderResult.manifestId),
                  }
                : undefined,
          });
          const bindingFailure = classifySubmittedDecisionBindingFailure({
            executionWorkspaceId: String(input.execution.workspaceId),
            episode: boundEpisode,
            request: request.value,
            workspace: Option.isSome(workspace)
              ? {
                  currentWorkId:
                    workspace.value.currentWorkId === null
                      ? null
                      : String(workspace.value.currentWorkId),
                  revision: Number(workspace.value.revision),
                }
              : undefined,
            step: loopStep,
            pendingAction: pendingSelectionAction,
            providerTurnId: String(providerTurnId),
            providerResult:
              pinnedProviderResult?._tag === "SettledSuccess"
                ? {
                    _tag: "SettledSuccess",
                    manifestId: String(pinnedProviderResult.manifestId),
                  }
                : undefined,
          });
          if (
            bindingFailure !== undefined &&
            loopStep !== undefined &&
            pendingSelectionAction !== undefined
          ) {
            return {
              _tag: "SubmittedDecisionBindingMismatch",
              failureCode: bindingFailure,
              logicalStepNo: loopStep.identity.logicalStepNo,
              repairAttempt: loopStep.identity.repairAttempt,
              providerTurnId: loopStep.providerTurnId,
              logicalActionId: pendingSelectionAction.logicalActionId,
            };
          }
          if (!replayingPinnedSelection) {
            return yield* proposeSettlement({
              _tag: "Failed",
              failure: {
                _tag: "ExecutionFailure",
                reason: "DecisionRequestMissingOrSettled",
              },
            });
          }
          // The submitted canonical request is the result of this exact
          // pinned SelectCurrentWork Action. Rebuild its original decision
          // context only long enough to replay the settled Provider result;
          // no new Provider request or action is admitted from this snapshot.
          requestContextRevision = boundEpisode.requestRevision;
        }
        inputItems.push({
          _tag: "ContextUpdate",
          sourceRef: `decision-request:${boundEpisode.decisionId}`,
          revision: requestContextRevision,
          updateKind: "Full",
          text: JSON.stringify({
            decisionKind: "SelectCurrentWork",
            candidateWorkIds: request.value.candidateWorkIds,
            workspaceRevision: request.value.workspaceRevision,
          }),
        });
        messageContextRefs.push(
          `decision-request:${boundEpisode.decisionId}:${String(requestContextRevision)}`,
        );
      }
      if (resumeOverflowCompactionProviderTurnId !== undefined) {
        if (
          loopStep === undefined ||
          loopSteps === undefined ||
          loopStepFence === undefined
        ) {
          return yield* Effect.fail(
            failure({ _tag: "AgentLoopStepReplayBindingMismatch" }),
          );
        }
        const expectedCompactionProviderTurnId = resumeOverflowNativeCompaction
          ? providerTurnNativeCompactionId(
              input.execution.executionId,
              turn,
              stepContext.contextEpoch,
            )
          : providerTurnSummaryCompactionId(
              input.execution.executionId,
              turn,
              stepContext.contextEpoch,
            );
        if (
          resumeOverflowCompactionProviderTurnId !==
          expectedCompactionProviderTurnId
        ) {
          return yield* Effect.fail(
            failure({ _tag: "AgentLoopStepReplayBindingMismatch" }),
          );
        }
        const compacted = conversationExecution
          ? yield* Effect.gen(function* () {
              if (
                conversationOwner === undefined ||
                conversationProjection === undefined ||
                conversationCurrentJob === undefined ||
                dependencies.conversationCheckpoints === undefined ||
                dependencies.blobs === undefined ||
                providerTurns === undefined
              ) {
                return yield* Effect.fail(
                  failure({ _tag: "ConversationCheckpointRuntimeUnavailable" }),
                );
              }
              const sources = [
                ...conversationProjection.coveredAnswered,
                ...conversationProjection.uncoveredAnswered,
              ];
              const latest = sources.at(-1);
              const coveredThrough =
                latest === undefined
                  ? conversationProjection.checkpoint.coveredThrough
                  : {
                      createdAt: latest.message.createdAt,
                      messageId: latest.message.messageId,
                    };
              return yield* runConversationCheckpointCompaction(
                {
                  execution: input.execution,
                  logicalStepNo: loopStep?.identity.logicalStepNo ?? turn,
                  ...(resumeOverflowCompactionProviderTurnId === undefined
                    ? {}
                    : {
                        providerTurnId: resumeOverflowCompactionProviderTurnId,
                      }),
                  owner: conversationOwner,
                  sources,
                  coveredThrough,
                  currentMessageId: exactConversation?.messageId ?? "",
                  currentResponseJob: conversationCurrentJob,
                  checkpointKind:
                    resumeOverflowNativeCompaction && providerNativeSupported
                      ? "ProviderNative"
                      : "Summary",
                  bindingFingerprint: currentBindingFingerprint,
                  modelRef: capability.modelRef,
                  ...(options.secretRef === undefined
                    ? {}
                    : { secretRef: options.secretRef }),
                  fence: loopStepFence,
                  updatedAt: yield* now(),
                  ...(options.qualificationProbe === undefined
                    ? {}
                    : { qualificationProbe: options.qualificationProbe }),
                },
                {
                  ...compactionDependencies,
                  checkpointStore: dependencies.conversationCheckpoints,
                  providerTurns,
                  blobs: dependencies.blobs,
                  tx,
                },
              ).pipe(Effect.mapError(failure));
            })
          : yield* runCompaction(
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
                nativeSupported:
                  resumeOverflowNativeCompaction && providerNativeSupported,
                ...(resumeOverflowNativeCompactionInput === undefined
                  ? {}
                  : { nativeRecovery: resumeOverflowNativeCompactionInput }),
              },
              compactionDependencies,
            ).pipe(Effect.mapError(failure));
        if ("_tag" in compacted) {
          return yield* proposeSettlement(safetyStop("RuntimeSafetyStop"));
        }
        if (
          compacted.providerTurnId !== resumeOverflowCompactionProviderTurnId ||
          Number(compacted.newEpoch) !== Number(stepContext.contextEpoch) + 1
        ) {
          return yield* Effect.fail(
            failure({ _tag: "AgentLoopStepReplayBindingMismatch" }),
          );
        }
        const replacementProviderTurnId = makeOverflowReplacementProviderTurnId(
          input.execution.executionId,
          turn,
        );
        yield* tx
          .transact(
            loopSteps.ensureProviderTurnLink(
              {
                identity: loopStepIdentity,
                overflowOrdinal: 0,
                role: "OverflowReplacement",
                providerTurnId: replacementProviderTurnId,
                predecessorProviderTurnId:
                  resumeOverflowCompactionProviderTurnId,
                contextEpoch: parse(ContextEpochNumber)(
                  Number(stepContext.contextEpoch) + 1,
                ),
                state: "Prepared",
                createdAt: yield* now(),
              },
              loopStepFence,
            ),
          )
          .pipe(Effect.mapError(failure));
        overflowRecoveryAttempt = 1;
        overflowReplacementProviderTurnId = replacementProviderTurnId;
        replayPersistedContextLimit = false;
        resumeOverflowNativeCompaction = false;
        resumeOverflowNativeCompactionInput = undefined;
        resumeOverflowCompactionProviderTurnId = undefined;
        continue;
      }
      const turnProfile = yield* turnProfileResolver
        .resolve({
          execution: input.execution,
          conversation:
            conversationExecution && conversationMessages.length > 0,
        })
        .pipe(Effect.mapError(failure));
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
        return yield* Effect.fail(failure(prepared.cause));
      }
      const preparation = prepared.value;

      if (preparation._tag === "GovernanceBlocked") {
        return yield* proposeSettlement(safetyStop("GovernanceBlocked"));
      }
      if (preparation._tag === "NeedsCompaction") {
        if (loopStepFence === undefined) {
          return yield* Effect.fail(
            failure({
              _tag: "CompactionFenceUnavailable",
              executionId: input.execution.executionId,
            }),
          );
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
        ).pipe(Effect.mapError(failure));
        if ("_tag" in compacted) {
          return yield* proposeSettlement(safetyStop("RuntimeSafetyStop"));
        }
        continue;
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
      const replay = yield* replayPreparedProviderTurn(dependencies, {
        loopStep,
        preparation,
        conversationExecution,
        replayPersistedContextLimit,
      });
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
        overflow: {
          overflowRecoveryAttempt,
          replayPersistedContextLimit,
          resumeOverflowCompactionProviderTurnId,
          resumeOverflowNativeCompaction,
          resumeOverflowNativeCompactionInput,
          overflowReplacementProviderTurnId,
        },
        conversation: conversationContext,
        stepContext,
        inputItems,
        messageContextRefs,
        currentBindingFingerprint,
        compactionDependencies,
        compactionWorkPinning,
        proposeSettlement,
      });
      if (invocation._tag !== "Restart") return invocation;
      overflowRecoveryAttempt = invocation.overflow.overflowRecoveryAttempt;
      replayPersistedContextLimit = invocation.overflow.replayPersistedContextLimit;
      overflowReplacementProviderTurnId = invocation.overflow.overflowReplacementProviderTurnId;
      repairAttempt = invocation.repairAttempt;
      repairFragments = invocation.repairFragments;
    }
  });
};
