import {
  ContextEpochNumber,
  conversationResponseEpisode,
  executionEpisode,
  type Execution,
  type ExecutionSettlement,
  parse,
  type ProviderTurnId,
  providerTurnOverflowReplacementId as makeOverflowReplacementProviderTurnId,
} from "@arbor/domain";
import type { projectSessionTimeline, SessionTimelineProjection } from "@arbor/model-context";
import type {
  AgentLoopStepIdentity,
  ExecutionDriverError,
  SessionEntryRecord,
} from "@arbor/ports";
import { Effect } from "effect";
import { type ModelDecisionOutcome, safetyStop } from "../../agent-loop-policy.js";
import { hasValidCompiledInferenceRequestHash } from "../../agent-loop-step-recovery.js";
import { nativeCompactionProviderTurnId } from "../../checkpoint/native-evidence.js";
import { runSummaryCompaction, type SummaryCompactionInput } from "../../compaction-coordinator.js";
import type { ModelDecisionDependencies } from "../contract.js";
import type { DecisionCursor } from "../startup-recovery.js";
import { recoverCommittedRebaseStep } from "./committed-rebase-step.js";
import { validateNativeCheckpointSource } from "./native-checkpoint-source.js";
import { reconstructNativePortableFrontier } from "./native-portable-frontier.js";
import type { OverflowRecoveryState } from "./overflow-state.js";

type NativeRebaseDependencies = Pick<
  ModelDecisionDependencies,
  "input" | "capability" | "tx" | "loopSteps" | "loopStepFence" |
  "providerTurns" | "options" | "failure" | "now"
>;

type NativeRebaseResult =
  | {
      readonly _tag: "Ready" | "Restart";
      readonly cursor: DecisionCursor;
      readonly compactionAttempts: number;
      readonly overflow: OverflowRecoveryState;
    }
  | { readonly _tag: "Complete"; readonly outcome: ModelDecisionOutcome };

/** Validate the native producer, rebuild portable context if needed, and
 * recover its exact step continuation. The driver owns the loop and cursor. */
export const recoverNativeCheckpointContext = (
  dependencies: NativeRebaseDependencies,
  phase: {
    readonly cursor: DecisionCursor;
    readonly loopStepIdentity: AgentLoopStepIdentity;
    readonly nativeCheckpoint: SessionTimelineProjection["nativeCheckpoint"];
    readonly sessionRecord: { readonly value: { readonly contextEpoch: ContextEpochNumber } };
    readonly checkpointOwnerExecutionId: Execution["executionId"] | undefined;
    readonly nativeCheckpointIsInherited: boolean;
    readonly recentSessionEntries: ReadonlyArray<SessionEntryRecord>;
    readonly currentBindingFingerprint: string;
    readonly providerNativeSupported: boolean;
    readonly reasoningProjectionBinding: Parameters<typeof projectSessionTimeline>[3];
    readonly reasoningAttachmentBlobs: ReadonlyMap<string, Uint8Array>;
    readonly compactionDependencies: Parameters<typeof runSummaryCompaction>[1];
    readonly loadWorkCompactionPinning: () => Effect.Effect<
      Pick<SummaryCompactionInput, "pinnedInstructions" | "pinnedInstructionFragments" | "controlBasis">,
      ExecutionDriverError
    >;
    readonly proposeSettlement: (
      settlement: ExecutionSettlement,
    ) => Effect.Effect<ModelDecisionOutcome, ExecutionDriverError>;
    readonly decodedProviderTurnId: (value: unknown) => ProviderTurnId | null;
    readonly compactionAttempts: number;
    readonly overflow: OverflowRecoveryState;
  },
): Effect.Effect<NativeRebaseResult, ExecutionDriverError> => {
  const { input, capability, tx, loopSteps, loopStepFence, providerTurns, options, failure, now } =
    dependencies;
  const {
    loopStepIdentity, nativeCheckpoint, sessionRecord, checkpointOwnerExecutionId,
    nativeCheckpointIsInherited, recentSessionEntries, currentBindingFingerprint,
    providerNativeSupported, reasoningProjectionBinding, reasoningAttachmentBlobs,
    compactionDependencies, loadWorkCompactionPinning, proposeSettlement, decodedProviderTurnId,
  } = phase;
  return Effect.gen(function* () {
    let { turn, repairAttempt } = phase.cursor;
    let compactionAttempts = phase.compactionAttempts;
    let {
      overflowRecoveryAttempt,
      replayPersistedContextLimit,
      resumeOverflowCompactionProviderTurnId,
      resumeOverflowNativeCompaction,
      resumeOverflowNativeCompactionInput,
      overflowReplacementProviderTurnId,
    } = phase.overflow;
    const recoveryState = (): OverflowRecoveryState => ({
      overflowRecoveryAttempt,
      replayPersistedContextLimit,
      resumeOverflowCompactionProviderTurnId,
      resumeOverflowNativeCompaction,
      resumeOverflowNativeCompactionInput,
      overflowReplacementProviderTurnId,
    });
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
          return { _tag: "Complete" as const, outcome: yield* proposeSettlement(safetyStop("RuntimeSafetyStop")) };
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
          return { _tag: "Restart" as const, cursor: { turn, repairAttempt }, compactionAttempts, overflow: recoveryState() };
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
        if (committedRebase._tag === "Complete") return committedRebase;
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
          return { _tag: "Restart" as const, cursor: { turn, repairAttempt }, compactionAttempts, overflow: recoveryState() };
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
        return { _tag: "Restart" as const, cursor: { turn, repairAttempt }, compactionAttempts, overflow: recoveryState() };
      }
    }
    return {
      _tag: "Ready" as const,
      cursor: { turn, repairAttempt },
      compactionAttempts,
      overflow: recoveryState(),
    };
  });
};
