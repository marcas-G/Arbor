import type { Execution, ExecutionSettlement } from "@arbor/domain";
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
  decodeTurn,
  GENERIC_COGNITION_PROGRAM,
  type InstructionFragment,
  projectSessionTimeline,
  SESSION_TIMELINE_ENTRY_LIMIT,
} from "@arbor/model-context";
import type {
  ExecutionDriverError,
  PortableInputItem,
  PortableModelRequestV2,
  ProviderRunInput,
  SessionEntryRecord,
} from "@arbor/ports";
import {
  canonicalizeLegacyAdoptionEvidenceV1,
  LEGACY_ADOPTION_MISSING,
  PROVIDER_REASONING_ATTACHMENT_MEDIA_TYPE,
  PROVIDER_TURN_ADMISSION_EXECUTION_STOPPING,
  sha256Hex,
} from "@arbor/ports";
import { Effect, Option } from "effect";
import {
  isProviderExecutionTimeout,
  isProviderFailure,
  isProviderTurnBindingChanged,
  MAX_TURNS,
  type ModelDecisionOutcome,
  providerExecutionTimeoutSettlement,
  providerFailureSettlement,
  providerTurnBindingChangedSettlement,
  REPAIR_POLICY,
  runtimeSafetyFragment,
  safetyStop,
} from "./agent-loop-policy.js";
import {
  hasValidCompiledInferenceRequestHash,
} from "./agent-loop-step-recovery.js";
import {
  runCompaction,
  runSummaryCompaction,
} from "./compaction-coordinator.js";
import { runConversationCheckpointCompaction } from "./checkpoint/conversation/compaction.js";
import { loadConversationDecisionContext } from "./decision/conversation-context.js";
import { loadDecisionSessionContext } from "./decision/context/session.js";
import { validateNativeCheckpointSource } from "./decision/recovery/native-checkpoint-source.js";
import { reconstructNativePortableFrontier } from "./decision/recovery/native-portable-frontier.js";
import { recoverCommittedRebaseStep } from "./decision/recovery/committed-rebase-step.js";
import {
  decodeUniqueNativePortableFrontier,
  nativeCompactionProviderTurnId,
} from "./checkpoint/native-evidence.js";
import {
  GENERIC_INSTRUCTION_ASSETS,
  instructionAssetFragment,
  workExecutionLoopFragmentsFor,
} from "./prompt-assets.js";
import type { ModelDecisionDependencies } from "./decision/contract.js";
import { recoverStartupDecision } from "./decision/startup-recovery.js";
import { recoverDecisionStep } from "./decision/step-recovery.js";
import { proposePreparedStepSettlement } from "./decision/settlement.js";
import { decideRepair } from "./repair.js";
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
    localPlans,
    decisionRequests,
    workspaces,
    workspaceKnowledge,
    workspacePlacement,
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
      if (nativeCheckpoint !== undefined) {
        const checkpointEvidence = yield* validateNativeCheckpointSource(
          dependencies,
          {
            nativeCheckpoint,
            sessionRecord,
            checkpointOwnerExecutionId,
            nativeCheckpointIsInherited,
            cursor: { turn, repairAttempt },
          },
        );
        turn = checkpointEvidence.cursor.turn;
        repairAttempt = checkpointEvidence.cursor.repairAttempt;
        const {
          checkpointSourceIdentity,
          checkpointFrontier,
          checkpointReceipt,
          checkpointManifestJson,
          checkpointNativeProviderTurnId,
          expectedCheckpointOwnerExecutionId,
        } = checkpointEvidence;
        if (!nativeCheckpoint.bindingMatches) {
          if (options.qualificationProbe !== undefined) {
            yield* Effect.promise(
              () =>
                options.qualificationProbe?.({
                  boundary: "AH19NativeCheckpointRecovery",
                  stage: "ProjectorObservedBindingMismatch",
                  executionId: String(input.execution.executionId),
                  providerTurnId: nativeCheckpoint.providerTurnId ?? "unknown",
                }) ?? Promise.resolve(),
            );
          }
          if (
            nativeCheckpoint.providerTurnId === undefined ||
            nativeCheckpoint.fromEpoch === undefined ||
            nativeCheckpoint.opaqueItemRef === undefined ||
            nativeCheckpoint.bindingFingerprint === undefined ||
            providerTurns === undefined ||
            loopSteps === undefined ||
            loopStepFence === undefined
          ) {
            if (options.qualificationProbe !== undefined) {
              yield* Effect.promise(
                () =>
                  options.qualificationProbe?.({
                    boundary: "AH19NativeCheckpointRecovery",
                    stage: `PrerequisitesMissing:turn=${nativeCheckpoint.providerTurnId !== undefined}:from=${nativeCheckpoint.fromEpoch !== undefined}:opaque=${nativeCheckpoint.opaqueItemRef !== undefined}:fingerprint=${nativeCheckpoint.bindingFingerprint !== undefined}:providerStore=${providerTurns !== undefined}:fence=${loopStepFence !== undefined}`,
                    executionId: String(input.execution.executionId),
                    providerTurnId:
                      nativeCheckpoint.providerTurnId ?? "unknown",
                  }) ?? Promise.resolve(),
              );
            }
            return yield* Effect.fail(
              failure({ _tag: "AgentLoopStepReplayBindingMismatch" }),
            );
          }
          if (options.qualificationProbe !== undefined) {
            yield* Effect.promise(
              () =>
                options.qualificationProbe?.({
                  boundary: "AH19NativeCheckpointRecovery",
                  stage: "PrerequisitesValidated",
                  executionId: String(input.execution.executionId),
                  providerTurnId: nativeCheckpoint.providerTurnId ?? "unknown",
                }) ?? Promise.resolve(),
            );
          }
          const nativeCheckpointProviderTurnId =
            nativeCheckpoint.providerTurnId;
          const nativeProviderTurnId = nativeCompactionProviderTurnId(
            nativeCheckpoint.providerTurnId,
          );
          if (nativeProviderTurnId === null) {
            if (options.qualificationProbe !== undefined) {
              yield* Effect.promise(
                () =>
                  options.qualificationProbe?.({
                    boundary: "AH19NativeCheckpointRecovery",
                    stage: "NativeProviderTurnIdInvalid",
                    executionId: String(input.execution.executionId),
                    providerTurnId:
                      nativeCheckpoint.providerTurnId ?? "unknown",
                  }) ?? Promise.resolve(),
              );
            }
            return yield* Effect.fail(
              failure({ _tag: "AgentLoopStepReplayBindingMismatch" }),
            );
          }
          const portableFrontier = yield* reconstructNativePortableFrontier(
            { input, tx, loopSteps, providerTurns, options, failure },
            {
              cursor: { turn, repairAttempt },
              nativeCheckpoint,
              nativeCheckpointIsInherited,
              nativeCheckpointProviderTurnId,
              nativeProviderTurnId,
              expectedCheckpointOwnerExecutionId,
              checkpointSourceIdentity,
              checkpointFrontier,
              checkpointReceipt,
              checkpointManifestJson,
              checkpointNativeProviderTurnId,
              currentBindingFingerprint,
              providerNativeSupported,
              recentSessionEntries,
              reasoningProjectionBinding,
              reasoningAttachmentBlobs,
            },
          );
          turn = portableFrontier.cursor.turn;
          repairAttempt = portableFrontier.cursor.repairAttempt;
          const {
            sourceStepIdentity,
            sourceStep,
            sourceStepLinks,
            nativeManifestJson,
            portableContextRefs,
            firstSequence,
            lastSequence,
            portableItems,
          } = portableFrontier;
          const terminalInboxEpisode = executionEpisode(input.execution);
          const isTerminalResponseEpisode =
            conversationResponseEpisode(input.execution) !== null ||
            terminalInboxEpisode?._tag === "InboxEpisode";
          if (
            isTerminalResponseEpisode &&
            sourceStep.state === "StepEffectsCommitted"
          ) {
            const sequence = sourceStep.modelOutputSessionSequence;
            const outputRows = recentSessionEntries.filter(
              (entry) => entry.sequence === sequence,
            );
            const outputEntry = outputRows[0];
            const outputPayload =
              typeof outputEntry?.payload === "object" &&
              outputEntry.payload !== null
                ? (outputEntry.payload as Record<string, unknown>)
                : undefined;
            const outputProviderTurnId = outputPayload?.providerTurnId;
            const outputTurnId = decodedProviderTurnId(outputProviderTurnId);
            const replacementLinks = sourceStepLinks.filter(
              (link) => link.role === "OverflowReplacement",
            );
            const replacementLink = replacementLinks[0];
            if (
              sequence === undefined ||
              sourceStep.decodedOutputHash === undefined ||
              sourceStep.nextActionIndex !== 0 ||
              outputRows.length !== 1 ||
              outputEntry?.entryKind !== "ModelOutput" ||
              outputEntry.source?.kind !== "ProviderTurn" ||
              outputPayload?._tag !== "AssistantMessage" ||
              outputTurnId === null ||
              outputEntry.source.ref !== `${outputTurnId}:assistant` ||
              replacementLinks.length !== 1 ||
              replacementLink?.providerTurnId !== outputTurnId ||
              replacementLink.identity.logicalStepNo !==
                sourceStep.identity.logicalStepNo ||
              replacementLink.identity.repairAttempt !==
                sourceStep.identity.repairAttempt ||
              replacementLink.predecessorProviderTurnId !==
                nativeCheckpointProviderTurnId ||
              replacementLink.contextEpoch !== nativeCheckpoint.toEpoch
            ) {
              return yield* Effect.fail(
                failure({ _tag: "AgentLoopStepReplayBindingMismatch" }),
              );
            }
            const sourceManifest = yield* tx
              .transact(providerTurns.findManifestByTurn(outputTurnId))
              .pipe(Effect.mapError(failure));
            if (sourceManifest === null) {
              return yield* Effect.fail(
                failure({ _tag: "AgentLoopStepReplayBindingMismatch" }),
              );
            }
            let sourceManifestJson: Record<string, unknown>;
            try {
              const parsed = JSON.parse(sourceManifest.manifestJson) as unknown;
              if (
                typeof parsed !== "object" ||
                parsed === null ||
                Array.isArray(parsed)
              ) {
                return yield* Effect.fail(
                  failure({ _tag: "AgentLoopStepReplayBindingMismatch" }),
                );
              }
              sourceManifestJson = parsed as Record<string, unknown>;
            } catch {
              return yield* Effect.fail(
                failure({ _tag: "AgentLoopStepReplayBindingMismatch" }),
              );
            }
            if (
              sourceManifestJson.providerTurnId !== outputProviderTurnId ||
              sourceManifestJson.executionId !== input.execution.executionId ||
              sourceManifestJson.sessionId !== input.execution.sessionId ||
              sourceManifestJson.contextEpoch !==
                replacementLink.contextEpoch ||
              sourceManifestJson.operationKind !== "Inference" ||
              sourceManifestJson.logicalStepNo !==
                sourceStep.identity.logicalStepNo ||
              sourceManifestJson.repairAttempt !==
                sourceStep.identity.repairAttempt ||
              sourceManifestJson.resolvedModelBindingFingerprint !==
                nativeManifestJson.resolvedModelBindingFingerprint ||
              !hasValidCompiledInferenceRequestHash(
                sourceManifestJson,
                sourceManifest.portableRequestJson,
              )
            ) {
              return yield* Effect.fail(
                failure({ _tag: "AgentLoopStepReplayBindingMismatch" }),
              );
            }
          }
          if (options.qualificationProbe !== undefined) {
            yield* Effect.promise(
              () =>
                options.qualificationProbe?.({
                  boundary: "AH19NativeCheckpointRecovery",
                  stage: "PortableSummaryStarted",
                  executionId: String(input.execution.executionId),
                  providerTurnId: nativeCheckpointProviderTurnId,
                }) ?? Promise.resolve(),
            );
          }
          const rebuilt = yield* runSummaryCompaction(
            {
              execution: input.execution,
              logicalStepNo: sourceStepIdentity.logicalStepNo,
              sourceAgentLoopStep: {
                executionId: String(sourceStepIdentity.executionId),
                logicalStepNo: sourceStepIdentity.logicalStepNo,
                repairAttempt: sourceStepIdentity.repairAttempt,
                providerTurnId: String(sourceStep.providerTurnId),
              },
              currentEpoch: sessionRecord.value.contextEpoch,
              modelRef: capability.modelRef,
              ...(options.secretRef === undefined
                ? {}
                : { secretRef: options.secretRef }),
              bindingFingerprint: currentBindingFingerprint,
              inputFrontier: { firstSequence, lastSequence },
              contextRefs: portableContextRefs,
              inputItems: portableItems,
              ...(yield* loadWorkCompactionPinning()),
              fence: loopStepFence,
            },
            compactionDependencies,
          ).pipe(Effect.mapError(failure));
          if ("_tag" in rebuilt) {
            return yield* proposeSettlement(safetyStop("RuntimeSafetyStop"));
          }
          if (options.qualificationProbe !== undefined) {
            yield* Effect.promise(
              () =>
                options.qualificationProbe?.({
                  boundary: "AH19NativeCheckpointRecovery",
                  stage: "PortableSummaryCommitted",
                  executionId: String(input.execution.executionId),
                  providerTurnId: nativeCheckpointProviderTurnId,
                }) ?? Promise.resolve(),
            );
          }
          if (
            Number(rebuilt.newEpoch) !==
            Number(sessionRecord.value.contextEpoch) + 1
          ) {
            return yield* Effect.fail(
              failure({ _tag: "AgentLoopStepReplayBindingMismatch" }),
            );
          }
          if (nativeCheckpointIsInherited) {
            // The old execution was only the producer of the inherited
            // checkpoint. Its step must never be transitioned with the new
            // execution's fence or reused as the new execution's cursor.
            // Summary has replaced the opaque continuation in the Session;
            // restart the current execution at its own Prepared step.
            turn = 0;
            repairAttempt = 0;
            compactionAttempts = 0;
            overflowRecoveryAttempt = 0;
            replayPersistedContextLimit = false;
            overflowReplacementProviderTurnId = undefined;
            resumeOverflowCompactionProviderTurnId = undefined;
            resumeOverflowNativeCompaction = false;
            resumeOverflowNativeCompactionInput = undefined;
            continue;
          }
          const committedRebase = yield* recoverCommittedRebaseStep(
            { input, capability, tx, loopSteps, loopStepFence, providerTurns, options, failure, now },
            {
              turn,
              sourceStepIdentity,
              sourceStep,
              sourceStepLinks,
              nativeManifestJson,
              nativeCheckpoint,
              nativeCheckpointProviderTurnId,
              recentSessionEntries,
              decodedProviderTurnId,
            },
          );
          if (committedRebase._tag === "Complete") return committedRebase.outcome;
          if (committedRebase._tag === "Restart") {
            turn = committedRebase.cursor.turn;
            repairAttempt = committedRebase.cursor.repairAttempt;
            compactionAttempts = 0;
            overflowRecoveryAttempt = 0;
            replayPersistedContextLimit = false;
            overflowReplacementProviderTurnId = undefined;
            resumeOverflowCompactionProviderTurnId = undefined;
            resumeOverflowNativeCompaction = false;
            resumeOverflowNativeCompactionInput = undefined;
            continue;
          }
          const stepProviderLinks = sourceStepLinks;
          const overflowNativeLink = stepProviderLinks.some(
            (link) =>
              link.role === "OverflowCompaction" &&
              link.providerTurnId === nativeProviderTurnId,
          );
          if (overflowNativeLink) {
            if (loopSteps === undefined) {
              return yield* Effect.fail(
                failure({ _tag: "AgentLoopStepReplayBindingMismatch" }),
              );
            }
            const replacementProviderTurnId =
              makeOverflowReplacementProviderTurnId(
                input.execution.executionId,
                sourceStepIdentity.logicalStepNo,
              );
            const existingReplacement = stepProviderLinks.filter(
              (link) => link.role === "OverflowReplacement",
            );
            if (existingReplacement.length > 1) {
              return yield* Effect.fail(
                failure({ _tag: "AgentLoopStepReplayBindingMismatch" }),
              );
            }
            const priorReplacement = existingReplacement[0];
            if (priorReplacement !== undefined) {
              if (options.qualificationProbe !== undefined) {
                yield* Effect.promise(
                  () =>
                    options.qualificationProbe?.({
                      boundary: "AH19NativeCheckpointRecovery",
                      stage: `ExistingOverflowReplacement:sourceStep=${sourceStepIdentity.logicalStepNo}:state=${sourceStep.state}:successor=${sourceStep.successor?.providerTurnId ?? "none"}:linkEpoch=${Number(priorReplacement.contextEpoch)}:rebuiltEpoch=${Number(rebuilt.newEpoch)}`,
                      executionId: String(input.execution.executionId),
                      providerTurnId: nativeCheckpointProviderTurnId,
                    }) ?? Promise.resolve(),
                );
              }
              if (
                priorReplacement.providerTurnId !== replacementProviderTurnId ||
                priorReplacement.predecessorProviderTurnId !==
                  nativeProviderTurnId ||
                Number(priorReplacement.contextEpoch) !==
                  Number(rebuilt.newEpoch)
              ) {
                return yield* Effect.fail(
                  failure({ _tag: "AgentLoopStepReplayBindingMismatch" }),
                );
              }
            } else {
              yield* tx
                .transact(
                  loopSteps.ensureProviderTurnLink(
                    {
                      identity: loopStepIdentity,
                      overflowOrdinal: 0,
                      role: "OverflowReplacement",
                      providerTurnId: replacementProviderTurnId,
                      predecessorProviderTurnId: nativeProviderTurnId,
                      contextEpoch: parse(ContextEpochNumber)(
                        Number(rebuilt.newEpoch),
                      ),
                      state: "Prepared",
                      createdAt: yield* now(),
                    },
                    loopStepFence,
                  ),
                )
                .pipe(Effect.mapError(failure));
            }
            overflowRecoveryAttempt = 1;
            overflowReplacementProviderTurnId = replacementProviderTurnId;
            replayPersistedContextLimit = false;
            resumeOverflowCompactionProviderTurnId = undefined;
          }
          compactionAttempts = Math.max(compactionAttempts, 1);
          continue;
        }
      }
      const workspace = yield* tx
        .transact(workspaces.findById(input.execution.workspaceId))
        .pipe(Effect.mapError(failure));
      if (Option.isNone(workspace)) {
        return yield* Effect.fail(
          failure({
            _tag: "WorkspaceContextMissing",
            workspaceId: input.execution.workspaceId,
          }),
        );
      }
      if (workspaceKnowledge !== undefined) {
        const knowledge = yield* workspaceKnowledge
          .load(input.execution.workspaceId)
          .pipe(Effect.mapError(failure));
        if (knowledge.entries.length > 0) {
          inputItems.push({
            _tag: "ContextUpdate",
            sourceRef: `workspace-knowledge:${input.execution.workspaceId}`,
            revision: Number(workspace.value.revision),
            updateKind: "Full",
            text: JSON.stringify({
              scope: "accepted-workspace-knowledge",
              provenance: "CanonicalAcceptance",
              entries: knowledge.entries,
            }),
          });
          messageContextRefs.push(
            `workspace-knowledge:${input.execution.workspaceId}:${knowledge.fingerprint}`,
          );
        }
      }
      if (placementExecution && workspacePlacement !== undefined) {
        const placement = yield* workspacePlacement
          .list({ rootWorkspaceId: input.execution.workspaceId })
          .pipe(Effect.mapError(failure));
        inputItems.push({
          _tag: "ContextUpdate",
          sourceRef: `workspace-placement:${input.execution.workspaceId}`,
          revision: Number(workspace.value.revision),
          updateKind: "Full",
          text: JSON.stringify({
            scope: "workspace-placement",
            current: placement.current,
            directChildren: placement.directChildren,
            inFlightFormations: placement.inFlightFormations,
            nextCursor: placement.nextCursor,
          }),
        });
        messageContextRefs.push(
          `workspace-placement:${input.execution.workspaceId}:${placement.fingerprint}`,
        );
      }
      let currentWork: import("@arbor/domain").Work | null = null;
      const boundWork = workEpisode(input.execution);
      if (boundWork !== null) {
        const work = yield* tx
          .transact(works.findById(boundWork.workId))
          .pipe(Effect.mapError(failure));
        if (Option.isNone(work)) {
          return yield* Effect.fail(
            failure({
              _tag: "WorkContextMissing",
              workId: boundWork.workId,
            }),
          );
        }
        currentWork = work.value;
        if (
          localPlans !== undefined &&
          executionEpisode(input.execution)?._tag === "WorkEpisode"
        ) {
          const plan = yield* tx
            .transact(localPlans.findByWork(boundWork.workId))
            .pipe(Effect.mapError(failure));
          if (
            Option.isSome(plan) &&
            plan.value.targetWorkRevision === currentWork.revision
          ) {
            inputItems.push({
              _tag: "ContextUpdate",
              sourceRef: `local-plan:${boundWork.workId}`,
              revision: plan.value.revision,
              updateKind: "Full",
              text: JSON.stringify({
                scope: "progress-only",
                items: plan.value.items,
              }),
            });
            messageContextRefs.push(
              `local-plan:${boundWork.workId}:${String(plan.value.revision)}`,
            );
          }
          if (
            nativeCheckpoint !== undefined &&
            !nativeCheckpoint.bindingMatches
          ) {
            if (providerTurns === undefined || loopStepFence === undefined) {
              return yield* Effect.fail(
                failure({ _tag: "AgentLoopStepReplayBindingMismatch" }),
              );
            }
            let nativeProviderTurnId: ProviderTurnId;
            try {
              nativeProviderTurnId = parse(ProviderTurnId)(
                nativeCheckpoint.providerTurnId,
              );
            } catch {
              return yield* Effect.fail(
                failure({ _tag: "AgentLoopStepReplayBindingMismatch" }),
              );
            }
            const [nativeManifestRow, nativeReceipt] = yield* Effect.all(
              [
                tx.transact(
                  providerTurns.findManifestByTurn(nativeProviderTurnId),
                ),
                tx.transact(
                  providerTurns.findSettledResult(nativeProviderTurnId),
                ),
              ],
              { concurrency: 1 },
            ).pipe(Effect.mapError(failure));
            if (
              nativeManifestRow === null ||
              nativeReceipt._tag !== "SettledSuccess" ||
              nativeReceipt.evidenceVersion !== "provider-success-v1" ||
              nativeReceipt.finishReason !== "Stop" ||
              nativeReceipt.turn.providerTurnId !== nativeProviderTurnId ||
              nativeReceipt.turn.sessionId !== input.execution.sessionId ||
              nativeReceipt.manifestJson !== nativeManifestRow.manifestJson
            ) {
              return yield* Effect.fail(
                failure({ _tag: "AgentLoopStepReplayBindingMismatch" }),
              );
            }
            const nativeFrontier = decodeUniqueNativePortableFrontier(
              nativeManifestRow.manifestJson,
              nativeManifestRow.portableRequestJson,
            );
            const nativeManifest = nativeFrontier?.manifest;
            const nativeStateRefs = nativeReceipt.canonicalEvents.filter(
              (event) => event._tag === "ContinuationState",
            );
            if (
              nativeFrontier === null ||
              nativeManifest === undefined ||
              nativeManifest.providerTurnId !== nativeProviderTurnId ||
              nativeManifest.executionId !== nativeReceipt.turn.executionId ||
              nativeManifest.sessionId !== input.execution.sessionId ||
              nativeManifest.contextEpoch !== nativeCheckpoint.fromEpoch ||
              nativeManifest.operationKind !== "CompactionNative" ||
              nativeManifest.outputContractRef !==
                "provider-native-compaction-v1" ||
              nativeManifest.resolvedModelBindingFingerprint !==
                nativeCheckpoint.bindingFingerprint ||
              nativeReceipt.turn.contextEpoch !== nativeCheckpoint.fromEpoch ||
              nativeReceipt.turn.modelRef !== nativeManifest.modelRef ||
              nativeReceipt.turn.outputContractRef !==
                "provider-native-compaction-v1" ||
              nativeStateRefs.length !== 1 ||
              nativeStateRefs[0]?._tag !== "ContinuationState" ||
              nativeStateRefs[0].stateRef !== nativeCheckpoint.opaqueItemRef ||
              (nativeFrontier.inputFrontier.lastSequence !== null &&
                nativeFrontier.inputFrontier.lastSequence >=
                  nativeCheckpoint.sequence) ||
              nativeFrontier.inputItems.some(
                (item) =>
                  item._tag === "CompactionCheckpoint" &&
                  item.implementation === "ProviderNative",
              )
            ) {
              return yield* Effect.fail(
                failure({ _tag: "AgentLoopStepReplayBindingMismatch" }),
              );
            }
            const postCheckpointEntries = recentSessionEntries.filter(
              (entry) => entry.sequence > nativeCheckpoint.sequence,
            );
            const postCheckpointProjection = projectSessionTimeline(
              postCheckpointEntries,
              currentBindingFingerprint,
              providerNativeSupported,
              reasoningProjectionBinding,
              reasoningAttachmentBlobs,
            );
            if (postCheckpointProjection.nativeCheckpoint !== undefined) {
              return yield* Effect.fail(
                failure({ _tag: "AgentLoopStepReplayBindingMismatch" }),
              );
            }
            const portableContextRefs = [
              ...nativeFrontier.contextRefs,
              ...postCheckpointProjection.contextRefs,
            ];
            if (
              portableContextRefs.length === 0 ||
              new Set(portableContextRefs).size !== portableContextRefs.length
            ) {
              return yield* Effect.fail(
                failure({ _tag: "AgentLoopStepReplayBindingMismatch" }),
              );
            }
            const rebuiltFrontier = {
              firstSequence: nativeFrontier.inputFrontier.firstSequence,
              lastSequence:
                postCheckpointProjection.frontier.lastSequence !== null
                  ? postCheckpointProjection.frontier.lastSequence
                  : nativeFrontier.inputFrontier.lastSequence,
            };
            if (
              rebuiltFrontier.firstSequence !== null &&
              rebuiltFrontier.lastSequence !== null &&
              rebuiltFrontier.lastSequence < rebuiltFrontier.firstSequence
            ) {
              return yield* Effect.fail(
                failure({ _tag: "AgentLoopStepReplayBindingMismatch" }),
              );
            }
            const [stepProviderLinks, sourceSession] = yield* Effect.all(
              [
                loopSteps === undefined
                  ? Effect.succeed([])
                  : tx.transact(
                      loopSteps.listProviderTurnLinks(loopStepIdentity),
                    ),
                tx.transact(sessions.findById(input.execution.sessionId)),
              ],
              { concurrency: 1 },
            ).pipe(Effect.mapError(failure));
            if (Option.isNone(sourceSession)) {
              return yield* Effect.fail(
                failure({ _tag: "AgentLoopStepReplayBindingMismatch" }),
              );
            }
            const isOverflowNativeCheckpoint = stepProviderLinks.some(
              (link) =>
                link.role === "OverflowCompaction" &&
                link.providerTurnId === nativeProviderTurnId,
            );
            const portableItems = [
              ...nativeFrontier.inputItems,
              ...postCheckpointProjection.inputItems,
            ];
            if (loopStep === undefined) {
              return yield* Effect.fail(
                failure({ _tag: "AgentLoopStepReplayBindingMismatch" }),
              );
            }
            const rebuilt = yield* runSummaryCompaction(
              {
                execution: input.execution,
                logicalStepNo: loopStepIdentity.logicalStepNo,
                sourceAgentLoopStep: {
                  executionId: String(loopStepIdentity.executionId),
                  logicalStepNo: loopStepIdentity.logicalStepNo,
                  repairAttempt: loopStepIdentity.repairAttempt,
                  providerTurnId: String(loopStep.providerTurnId),
                },
                currentEpoch: sourceSession.value.contextEpoch,
                modelRef: capability.modelRef,
                ...(options.secretRef === undefined
                  ? {}
                  : { secretRef: options.secretRef }),
                bindingFingerprint: currentBindingFingerprint,
                inputFrontier: rebuiltFrontier,
                contextRefs: portableContextRefs,
                inputItems: portableItems,
                ...(yield* loadWorkCompactionPinning()),
                fence: loopStepFence,
              },
              compactionDependencies,
            ).pipe(Effect.mapError(failure));
            if ("_tag" in rebuilt) {
              return yield* proposeSettlement(safetyStop("RuntimeSafetyStop"));
            }
            if (
              Number(rebuilt.newEpoch) !==
              Number(sourceSession.value.contextEpoch) + 1
            ) {
              return yield* Effect.fail(
                failure({ _tag: "AgentLoopStepReplayBindingMismatch" }),
              );
            }
            if (isOverflowNativeCheckpoint) {
              const replacementProviderTurnId =
                makeOverflowReplacementProviderTurnId(
                  input.execution.executionId,
                  turn,
                );
              const existingReplacement = stepProviderLinks.filter(
                (link) => link.role === "OverflowReplacement",
              );
              if (existingReplacement.length > 1) {
                return yield* Effect.fail(
                  failure({ _tag: "AgentLoopStepReplayBindingMismatch" }),
                );
              }
              const priorReplacement = existingReplacement[0];
              if (priorReplacement !== undefined) {
                if (
                  priorReplacement.providerTurnId !==
                    replacementProviderTurnId ||
                  priorReplacement.predecessorProviderTurnId !==
                    nativeProviderTurnId ||
                  Number(priorReplacement.contextEpoch) !==
                    Number(rebuilt.newEpoch)
                ) {
                  return yield* Effect.fail(
                    failure({ _tag: "AgentLoopStepReplayBindingMismatch" }),
                  );
                }
              } else {
                if (loopSteps === undefined) {
                  return yield* Effect.fail(
                    failure({ _tag: "AgentLoopStepReplayBindingMismatch" }),
                  );
                }
                yield* tx
                  .transact(
                    loopSteps.ensureProviderTurnLink(
                      {
                        identity: loopStepIdentity,
                        overflowOrdinal: 0,
                        role: "OverflowReplacement",
                        providerTurnId: replacementProviderTurnId,
                        predecessorProviderTurnId: nativeProviderTurnId,
                        contextEpoch: parse(ContextEpochNumber)(
                          Number(rebuilt.newEpoch),
                        ),
                        state: "Prepared",
                        createdAt: yield* now(),
                      },
                      loopStepFence,
                    ),
                  )
                  .pipe(Effect.mapError(failure));
              }
              overflowRecoveryAttempt = 1;
              overflowReplacementProviderTurnId = replacementProviderTurnId;
              replayPersistedContextLimit = false;
            }
            compactionAttempts = Math.max(compactionAttempts, 1);
            continue;
          }
        }
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
      if (
        loopStep !== undefined &&
        loopSteps !== undefined &&
        loopStepFence !== undefined &&
        providerTurns !== undefined &&
        loopStep.state !== "OutputRejected"
      ) {
        const durableLoopSteps = loopSteps;
        const durableFence = loopStepFence;
        const settled = yield* tx
          .transact(
            providerTurns.findSettledResult(
              preparation.turn.manifest.providerTurnId,
            ),
          )
          .pipe(Effect.mapError(failure));
        if (settled._tag === "SettledSuccess") {
          let persistedManifest: typeof preparation.turn.manifest;
          try {
            persistedManifest = JSON.parse(
              settled.manifestJson,
            ) as typeof preparation.turn.manifest;
          } catch {
            return yield* Effect.fail(
              failure({
                _tag: "AgentLoopStepReplayManifestInvalid",
              }),
            );
          }
          if (
            settled.turn.executionId !== input.execution.executionId ||
            settled.turn.sessionId !== input.execution.sessionId ||
            settled.turn.contextEpoch !==
              preparation.turn.manifest.contextEpoch ||
            persistedManifest.providerTurnId !== settled.turn.providerTurnId ||
            persistedManifest.executionId !== settled.turn.executionId ||
            persistedManifest.sessionId !== settled.turn.sessionId ||
            persistedManifest.contextEpoch !== settled.turn.contextEpoch ||
            persistedManifest.modelRef !== settled.turn.modelRef ||
            persistedManifest.outputContractRef !==
              settled.turn.outputContractRef
          ) {
            return yield* Effect.fail(
              failure({
                _tag: "AgentLoopStepReplayBindingMismatch",
              }),
            );
          }
          const decoded = decodeTurn(settled.canonicalEvents);
          if (settled.evidenceVersion === "legacy-success-v1" && !decoded.ok) {
            return yield* Effect.fail(
              failure({
                _tag: "LegacyProviderResultRequiresAttention",
                reason: decoded.reason,
              }),
            );
          }
          if (
            settled.evidenceVersion === "legacy-success-v1" &&
            decoded.ok &&
            decoded.output.toolInvocations.length > 0 &&
            loopStep.state === "Prepared"
          ) {
            const episode = executionEpisode(input.execution);
            const recoveryStore = dependencies.recoveryAttentionFacts;
            const recordLegacyAdoptionFailure =
              recoveryStore?.recordLegacyAdoptionFailure;
            const resolveLegacyAdoptionFailure =
              recoveryStore?.resolveLegacyAdoptionFailure;
            if (
              loopStepFence === undefined ||
              recordLegacyAdoptionFailure === undefined ||
              resolveLegacyAdoptionFailure === undefined ||
              episode === undefined ||
              settled.settledAt === undefined ||
              settled.settledAt.length === 0
            ) {
              return yield* Effect.fail(
                failure({
                  _tag: "LegacyProviderResultRequiresAttention",
                  reason:
                    "legacy action disposition cannot be safely inspected",
                }),
              );
            }
            const actionEvidence = [];
            for (const [
              actionIndex,
              invocation,
            ] of decoded.output.toolInvocations.entries()) {
              const matches = persistedManifest.toolRoutes.filter(
                (route) => route.name === invocation.toolName,
              );
              const route = matches[0];
              if (
                matches.length !== 1 ||
                route === undefined ||
                typeof route.version !== "string" ||
                route.version.length === 0
              ) {
                return yield* Effect.fail(
                  failure({
                    _tag: "LegacyProviderResultRequiresAttention",
                    reason:
                      "legacy action route identity is not uniquely bound",
                  }),
                );
              }
              const logicalActionId = `lac_${sha256Hex(
                JSON.stringify({
                  executionId: input.execution.executionId,
                  providerTurnId: settled.turn.providerTurnId,
                  callRef: invocation.callRef,
                  routeKind: route.route,
                  actionKind: invocation.toolName,
                }),
              )}`;
              actionEvidence.push({
                actionIndex,
                logicalActionId,
                callRef: invocation.callRef,
                toolName: invocation.toolName,
                toolSchemaVersion: route.version,
                inputHash: sha256Hex(invocation.argumentsJson),
                stableActionId:
                  typeof route.stableId === "string"
                    ? route.stableId
                    : LEGACY_ADOPTION_MISSING,
                actionVersion: route.version,
                argumentsSha256: sha256Hex(invocation.argumentsJson),
                // A P9 action row alone is not P4 disposition evidence. The
                // explicit marker lets a later exact P4 proof resolve this
                // original fingerprint without guessing at restart.
                disposition: LEGACY_ADOPTION_MISSING,
              });
            }
            const episodeEvidence = (() => {
              switch (episode._tag) {
                case "WorkEpisode":
                  return {
                    kind: episode._tag,
                    ref: episode.workId,
                    revision: episode.targetWorkRevision,
                  };
                case "ConversationResponseEpisode":
                  return {
                    kind: episode._tag,
                    ref: episode.messageId,
                    revision: episode.responseJobRevision,
                  };
                case "InboxEpisode":
                  return {
                    kind: episode._tag,
                    ref: episode.entryKey,
                    revision: 0,
                  };
                case "DecisionEpisode":
                  return {
                    kind: episode._tag,
                    ref: episode.decisionId,
                    revision: episode.requestRevision,
                  };
              }
            })();
            let canonicalEventsSha256: string;
            try {
              canonicalEventsSha256 = sha256Hex(
                canonicalizeLegacyAdoptionEvidenceV1(settled.canonicalEvents),
              );
            } catch {
              return yield* Effect.fail(
                failure({
                  _tag: "LegacyProviderResultRequiresAttention",
                  reason:
                    "legacy canonical Provider evidence cannot be fingerprinted",
                }),
              );
            }
            const evidence = {
              version: 1 as const,
              executionId: input.execution.executionId,
              projectId: input.execution.projectId,
              workspaceId: input.execution.workspaceId,
              episode: episodeEvidence,
              step: {
                logicalStepNo: loopStep.identity.logicalStepNo,
                repairAttempt: loopStep.identity.repairAttempt,
                providerTurnId: settled.turn.providerTurnId,
                manifestId: settled.manifestId,
                decoderVersion: "decode-turn-v1",
              },
              providerSuccess: {
                attemptNo: settled.attemptNo,
                evidenceVersion: settled.evidenceVersion,
                finishReason: settled.finishReason,
                settledAt: settled.settledAt,
                canonicalEventsSha256,
              },
              actions: actionEvidence,
              failureCode: "LegacyActionDispositionUnproven" as const,
            };
            const preparedLegacyStep = loopStep;
            const resolution = yield* tx
              .transact(
                Effect.gen(function* () {
                  const firstDetectedAt = yield* now();
                  const resolved = yield* resolveLegacyAdoptionFailure({
                    evidence,
                    fence: loopStepFence,
                    resolvedAt: firstDetectedAt,
                  });
                  if (Option.isSome(resolved)) {
                    if (options.qualificationProbe !== undefined) {
                      yield* Effect.promise(
                        () =>
                          options.qualificationProbe?.({
                            boundary:
                              "AH14BeforeLegacyAdoptionResolutionCommit",
                            providerTurnId: settled.turn.providerTurnId,
                            executionId: input.execution.executionId,
                            logicalActionId: resolved.value.resolutionFactId,
                          }) ?? Promise.resolve(),
                      );
                    }
                    yield* providerTurns.adoptSettledSuccessEvidence(
                      settled.turn.providerTurnId,
                      settled.attemptNo,
                      "legacy-success-v1",
                      "provider-success-v1",
                    );
                    const adoptedStep = yield* durableLoopSteps.transition(
                      {
                        identity: preparedLegacyStep.identity,
                        expectedRevision: preparedLegacyStep.revision,
                        expectedState: "Prepared",
                        next: {
                          ...preparedLegacyStep,
                          manifestId: settled.manifestId,
                          state: "ProviderResultAvailable",
                          decoderVersion: "decode-turn-v1",
                          migrationProvenance: {
                            _tag: "LegacySettledProviderSuccess",
                            evidenceVersion: settled.evidenceVersion,
                          },
                          revision: preparedLegacyStep.revision + 1,
                          updatedAt: yield* now(),
                        },
                      },
                      durableFence,
                    );
                    return {
                      _tag: "Resolved" as const,
                      fact: resolved.value,
                      step: adoptedStep,
                    };
                  }
                  const fact = yield* recordLegacyAdoptionFailure({
                    evidence,
                    fence: loopStepFence,
                    firstDetectedAt,
                  });
                  if (options.qualificationProbe !== undefined) {
                    yield* Effect.promise(
                      () =>
                        options.qualificationProbe?.({
                          boundary: "AH14BeforeLegacyAdoptionAttentionCommit",
                          providerTurnId: settled.turn.providerTurnId,
                          executionId: input.execution.executionId,
                        }) ?? Promise.resolve(),
                    );
                  }
                  return { _tag: "Blocked" as const, fact };
                }),
              )
              .pipe(Effect.mapError(failure));
            if (resolution._tag === "Blocked") {
              if (options.qualificationProbe !== undefined) {
                yield* Effect.promise(
                  () =>
                    options.qualificationProbe?.({
                      boundary: "AH14AfterLegacyAdoptionAttentionCommit",
                      providerTurnId: settled.turn.providerTurnId,
                      executionId: input.execution.executionId,
                      logicalActionId: resolution.fact.attentionFactId,
                    }) ?? Promise.resolve(),
                );
              }
              return { _tag: "RecoveryBlocked" };
            }
            loopStep = resolution.step;
            if (options.qualificationProbe !== undefined) {
              yield* Effect.promise(
                () =>
                  options.qualificationProbe?.({
                    boundary: "AH14AfterLegacyAdoptionResolutionCommit",
                    providerTurnId: settled.turn.providerTurnId,
                    executionId: input.execution.executionId,
                    logicalActionId: resolution.fact.resolutionFactId,
                  }) ?? Promise.resolve(),
              );
            }
          }
          if (loopStep.state === "Prepared") {
            const preparedStep = loopStep;
            if (
              settled.evidenceVersion === "legacy-success-v1" &&
              options.qualificationProbe !== undefined
            ) {
              yield* Effect.promise(
                () =>
                  options.qualificationProbe?.({
                    boundary: "AH14BeforeLegacyAdoptionCommit",
                    providerTurnId: settled.turn.providerTurnId,
                    executionId: input.execution.executionId,
                  }) ?? Promise.resolve(),
              );
            }
            loopStep = yield* tx
              .transact(
                Effect.gen(function* () {
                  if (settled.evidenceVersion === "legacy-success-v1") {
                    yield* providerTurns.adoptSettledSuccessEvidence(
                      settled.turn.providerTurnId,
                      settled.attemptNo,
                      "legacy-success-v1",
                      "provider-success-v1",
                    );
                  }
                  return yield* durableLoopSteps.transition(
                    {
                      identity: preparedStep.identity,
                      expectedRevision: preparedStep.revision,
                      expectedState: "Prepared",
                      next: {
                        ...preparedStep,
                        manifestId: settled.manifestId,
                        state: "ProviderResultAvailable",
                        decoderVersion: "decode-turn-v1",
                        ...(settled.evidenceVersion === "legacy-success-v1"
                          ? {
                              migrationProvenance: {
                                _tag: "LegacySettledProviderSuccess",
                                evidenceVersion: settled.evidenceVersion,
                              },
                            }
                          : {}),
                        revision: preparedStep.revision + 1,
                        updatedAt: yield* now(),
                      },
                    },
                    durableFence,
                  );
                }),
              )
              .pipe(Effect.mapError(failure));
            if (
              settled.evidenceVersion === "legacy-success-v1" &&
              options.qualificationProbe !== undefined
            ) {
              yield* Effect.promise(
                () =>
                  options.qualificationProbe?.({
                    boundary: "AH14AfterLegacyAdoptionCommit",
                    providerTurnId: settled.turn.providerTurnId,
                    executionId: input.execution.executionId,
                  }) ?? Promise.resolve(),
              );
            }
          }
          if (decoded.ok) {
            return {
              _tag: "Ready",
              turn: {
                ...preparation.turn,
                manifest: persistedManifest,
                toolRoutes: persistedManifest.toolRoutes,
              },
              output: decoded.output,
              loopStep,
              ...(conversationExecution ? { conversation: true } : {}),
            };
          }
        } else if (settled._tag === "SettledFailure") {
          if (
            settled.turn.executionId !== input.execution.executionId ||
            settled.turn.sessionId !== input.execution.sessionId ||
            settled.turn.contextEpoch !== preparation.turn.manifest.contextEpoch
          ) {
            return yield* Effect.fail(
              failure({
                _tag: "AgentLoopStepReplayBindingMismatch",
              }),
            );
          }
          const settlement: ExecutionSettlement =
            settled.finishReason === "Cancelled"
              ? {
                  _tag: "Interrupted",
                  result: {
                    _tag: "ControlledInterruption",
                    reason: "ProviderTurnSettled:Cancelled",
                  },
                }
              : {
                  _tag: "Failed",
                  failure: {
                    _tag: "ExecutionFailure",
                    reason: `ProviderTurnSettled:${settled.finishReason}`,
                  },
                };
          if (
            settled.failureKind === "ContextLimitExceeded" &&
            replayPersistedContextLimit
          ) {
            // The same settled inference failure is fed to the existing
            // ordinal-0 overflow path below; do not terminalize the step.
          } else if (loopStep.state === "Prepared") {
            const failedStep = loopStep;
            yield* tx
              .transact(
                durableLoopSteps.transition(
                  {
                    identity: failedStep.identity,
                    expectedRevision: failedStep.revision,
                    expectedState: "Prepared",
                    next: {
                      ...failedStep,
                      state: "SettlementProposed",
                      settlement,
                      revision: failedStep.revision + 1,
                      updatedAt: yield* now(),
                    },
                  },
                  durableFence,
                ),
              )
              .pipe(Effect.mapError(failure));
          }
          if (!replayPersistedContextLimit) {
            return { _tag: "Settle", settlement };
          }
        } else if (settled._tag === "SettledEvidenceInvalid") {
          return yield* Effect.fail(
            failure({
              _tag: "SettledProviderEvidenceInvalid",
              reason: settled.reason,
            }),
          );
        }
      }
      const providerAdmission = replayPersistedContextLimit
        ? undefined
        : yield* admitProviderTurn(
            preparation.turn.manifest.operationKind ?? "Inference",
            preparation.turn.manifest.compiledRequestHash,
          );
      if (providerAdmission?.decision === "Stop") {
        return yield* proposeSettlement(safetyStop("RuntimeSafetyStop"));
      }
      const providerResult = replayPersistedContextLimit
        ? {
            ok: false as const,
            cause: {
              _tag: "ProviderFailure" as const,
              kind: "ContextLimitExceeded" as const,
            },
          }
        : yield* Effect.match(providerRuntime.runTurn(turnInput), {
            onFailure: (cause) => ({ ok: false as const, cause }),
            onSuccess: (value) => ({ ok: true as const, value }),
          });
      if (!providerResult.ok) {
        if (providerAdmission !== undefined) {
          const endDecision = yield* completeProviderTurn(
            providerAdmission.activity,
          );
          if (endDecision === "Stop") {
            return yield* proposeSettlement(safetyStop("RuntimeSafetyStop"));
          }
        }
        if (isProviderTurnBindingChanged(providerResult.cause)) {
          return yield* proposeSettlement(
            providerTurnBindingChangedSettlement(),
          );
        }
        if (
          isProviderFailure(providerResult.cause) &&
          providerResult.cause.safeDiagnostic ===
            PROVIDER_TURN_ADMISSION_EXECUTION_STOPPING
        ) {
          return yield* proposeSettlement({
            _tag: "Interrupted",
            result: { _tag: "StopRequested" },
          });
        }
        if (isProviderExecutionTimeout(providerResult.cause)) {
          return yield* proposeSettlement(
            providerExecutionTimeoutSettlement(providerResult.cause),
          );
        }
        if (
          typeof providerResult.cause === "object" &&
          providerResult.cause !== null &&
          "_tag" in providerResult.cause &&
          providerResult.cause._tag === "ProviderFailure" &&
          "kind" in providerResult.cause &&
          providerResult.cause.kind === "ContextLimitExceeded" &&
          overflowRecoveryAttempt === 0 &&
          loopStepFence !== undefined &&
          loopStep !== undefined &&
          loopSteps !== undefined
        ) {
          const overflowStep = loopStep;
          const overflowFence = loopStepFence;
          const overflowSteps = loopSteps;
          const observedAt = yield* now();
          if (providerTurns !== undefined) {
            const existingTurn = yield* tx
              .transact(providerTurns.findUnsettledByTurn(providerTurnId))
              .pipe(Effect.mapError(failure));
            if (existingTurn !== null) {
              yield* tx
                .transact(
                  Effect.gen(function* () {
                    yield* providerTurns.failTurn(providerTurnId, observedAt);
                    if (options.qualificationProbe !== undefined) {
                      yield* Effect.promise(async () => {
                        await options.qualificationProbe?.({
                          boundary: "AH18BeforeInferenceFailTurnCommit",
                          executionId: String(input.execution.executionId),
                          providerTurnId: String(providerTurnId),
                        });
                      });
                    }
                  }),
                )
                .pipe(Effect.mapError(failure));
            }
          }
          const nativeSupported =
            capability.portableRequestCompatibility?.operationKinds.includes(
              "CompactionNative",
            ) === true;
          const compactTurnId = nativeSupported
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
          if (!replayPersistedContextLimit) {
            const compactionProviderTurnId = compactTurnId;
            const linkProbeIdentity = {
              executionId: String(input.execution.executionId),
              providerTurnId: String(compactionProviderTurnId),
            };
            yield* tx
              .transact(
                Effect.gen(function* () {
                  yield* overflowSteps.ensureProviderTurnLink(
                    {
                      identity: overflowStep.identity,
                      overflowOrdinal: 0,
                      role: "Inference",
                      providerTurnId,
                      contextEpoch: stepContext.contextEpoch,
                      state: "SettledFailure",
                      createdAt: observedAt,
                    },
                    overflowFence,
                  );
                  yield* overflowSteps.ensureProviderTurnLink(
                    {
                      identity: overflowStep.identity,
                      overflowOrdinal: 0,
                      role: "OverflowCompaction",
                      providerTurnId: compactTurnId,
                      predecessorProviderTurnId: providerTurnId,
                      contextEpoch: stepContext.contextEpoch,
                      state: "Prepared",
                      createdAt: observedAt,
                    },
                    overflowFence,
                  );
                  if (options.qualificationProbe !== undefined) {
                    yield* Effect.promise(async () => {
                      await options.qualificationProbe?.({
                        boundary: "AH18BeforeOverflowLinksCommit",
                        ...linkProbeIdentity,
                      });
                    });
                  }
                }),
              )
              .pipe(Effect.mapError(failure));
            if (options.qualificationProbe !== undefined) {
              yield* Effect.promise(async () => {
                await options.qualificationProbe?.({
                  boundary: "AH18AfterOverflowLinksCommit",
                  ...linkProbeIdentity,
                });
              });
            }
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
                    failure({
                      _tag: "ConversationCheckpointRuntimeUnavailable",
                    }),
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
                    logicalStepNo: overflowStep.identity.logicalStepNo,
                    providerTurnId: compactTurnId,
                    owner: conversationOwner,
                    sources,
                    coveredThrough,
                    currentMessageId: exactConversation?.messageId ?? "",
                    currentResponseJob: conversationCurrentJob,
                    checkpointKind: nativeSupported
                      ? "ProviderNative"
                      : "Summary",
                    bindingFingerprint: currentBindingFingerprint,
                    modelRef: capability.modelRef,
                    ...(options.secretRef === undefined
                      ? {}
                      : { secretRef: options.secretRef }),
                    fence: overflowFence,
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
                  fence: overflowFence,
                  nativeSupported,
                },
                compactionDependencies,
              ).pipe(Effect.mapError(failure));
          if ("_tag" in compacted) {
            return yield* proposeSettlement(safetyStop("RuntimeSafetyStop"));
          }
          overflowReplacementProviderTurnId =
            makeOverflowReplacementProviderTurnId(
              input.execution.executionId,
              turn,
            );
          yield* tx
            .transact(
              overflowSteps.ensureProviderTurnLink(
                {
                  identity: overflowStep.identity,
                  overflowOrdinal: 0,
                  role: "OverflowReplacement",
                  providerTurnId: overflowReplacementProviderTurnId,
                  predecessorProviderTurnId: compacted.providerTurnId,
                  contextEpoch: compacted.newEpoch,
                  state: "Prepared",
                  createdAt: yield* now(),
                },
                overflowFence,
              ),
            )
            .pipe(Effect.mapError(failure));
          overflowRecoveryAttempt = 1;
          replayPersistedContextLimit = false;
          continue;
        }
        if (isProviderFailure(providerResult.cause)) {
          return yield* proposeSettlement(
            providerFailureSettlement(providerResult.cause),
          );
        }
        return yield* Effect.fail(failure(providerResult.cause));
      }
      const providerRun = providerResult.value;
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
            _tag: "Settle",
            settlement: safetyStop("RuntimeSafetyStop"),
          };
        }
      }
      const decoded = decodeTurn(events);
      if (decoded.ok) {
        return {
          _tag: "Ready",
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
        return { _tag: "Settle", settlement: repair.settlement };
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
      repairFragments = [repair.repairFragment];
      repairAttempt += 1;
    }
  });
};
