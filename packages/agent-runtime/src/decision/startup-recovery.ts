import { executionEpisode } from "@arbor/domain";
import { projectSessionTimeline } from "@arbor/model-context";
import type {
  ExecutionDriverError,
  SessionRepositoryService,
} from "@arbor/ports";
import { sha256Hex } from "@arbor/ports";
import { Effect, Option } from "effect";
import { type ModelDecisionOutcome, safetyStop } from "../agent-loop-policy.js";
import {
  containsNativeCheckpointInput,
  decodeUniqueNativePortableFrontier,
  nativeCheckpointOwnerExecutionId,
  nativeCompactionProviderTurnId,
} from "../checkpoint/native-evidence.js";
import {
  commitRecoveredNativeCompaction,
  runCompaction,
  runSummaryCompaction,
  type SummaryCompactionInput,
} from "../compaction-coordinator.js";
import type { ModelDecisionDependencies } from "./contract.js";

type StartupDependencies = Pick<
  ModelDecisionDependencies,
  | "input"
  | "capability"
  | "tx"
  | "loopSteps"
  | "loopStepFence"
  | "providerTurns"
  | "sessions"
  | "options"
  | "failure"
>;

export interface DecisionCursor {
  readonly turn: number;
  readonly repairAttempt: number;
}

export type StartupRecoveryResult =
  | { readonly _tag: "Ready"; readonly cursor: DecisionCursor }
  | { readonly _tag: "Complete"; readonly outcome: ModelDecisionOutcome };

/** Recover the exact durable checkpoint owner before creating a new Prepared
 * step. The decision driver owns the process-local cursor; this phase returns
 * its resolved value or an existing terminal outcome. */
export const recoverStartupDecision = (
  dependencies: StartupDependencies,
  phase: {
    readonly cursor: DecisionCursor;
    readonly currentBindingFingerprint: string;
    readonly providerNativeSupported: boolean;
    readonly compactionDependencies: Parameters<typeof runCompaction>[1];
    readonly readExecutionTimeline: () => ReturnType<
      SessionRepositoryService["listRecentEntries"]
    >;
    readonly loadWorkCompactionPinning: () => Effect.Effect<
      Pick<
        SummaryCompactionInput,
        "pinnedInstructions" | "pinnedInstructionFragments" | "controlBasis"
      >,
      ExecutionDriverError
    >;
  },
): Effect.Effect<StartupRecoveryResult, ExecutionDriverError> => {
  const {
    input,
    capability,
    tx,
    loopSteps,
    loopStepFence,
    providerTurns,
    sessions,
    options,
    failure,
  } = dependencies;
  const {
    currentBindingFingerprint,
    providerNativeSupported,
    compactionDependencies,
    readExecutionTimeline,
    loadWorkCompactionPinning,
  } = phase;
  return Effect.gen(function* () {
    let { turn, repairAttempt } = phase.cursor;
    // A Work checkpoint may have been committed after the process-local loop
    // cursor was last observed. Resolve its durable source before creating a
    // fresh Prepared step so restart cannot accidentally create/replay step 0.
    if (
      executionEpisode(input.execution)?._tag === "WorkEpisode" &&
      providerTurns !== undefined &&
      loopSteps !== undefined
    ) {
      const startupTimeline = yield* tx
        .transact(readExecutionTimeline())
        .pipe(Effect.mapError(failure));
      const startupProjection = projectSessionTimeline(
        startupTimeline,
        currentBindingFingerprint,
        providerNativeSupported,
      );
      const startupCheckpoint = startupProjection.nativeCheckpoint;
      const startupSession = yield* tx
        .transact(sessions.findById(input.execution.sessionId))
        .pipe(Effect.mapError(failure));
      let startupCheckpointInherited = false;
      if (
        startupCheckpoint?.providerTurnId !== undefined &&
        Option.isSome(startupSession)
      ) {
        const startupNativeTurnId = nativeCompactionProviderTurnId(
          startupCheckpoint.providerTurnId,
        );
        if (startupNativeTurnId !== null) {
          const startupManifest = yield* tx
            .transact(providerTurns.findManifestByTurn(startupNativeTurnId))
            .pipe(Effect.mapError(failure));
          const ownerExecutionId =
            startupManifest === null
              ? undefined
              : nativeCheckpointOwnerExecutionId(startupManifest.manifestJson);
          startupCheckpointInherited =
            ownerExecutionId !== undefined &&
            ownerExecutionId !== input.execution.executionId;
        }
      }
      if (
        startupCheckpoint === undefined &&
        !startupCheckpointInherited &&
        Option.isSome(startupSession) &&
        loopStepFence !== undefined
      ) {
        const pendingNative = yield* tx
          .transact(
            providerTurns.findNativeCompactionsBySessionEpoch({
              sessionId: input.execution.sessionId,
              contextEpoch: startupSession.value.contextEpoch,
            }),
          )
          .pipe(Effect.mapError(failure));
        if (pendingNative.length > 1) {
          if (options.qualificationProbe !== undefined) {
            yield* Effect.promise(
              () =>
                options.qualificationProbe?.({
                  boundary: "AH19NativeCheckpointRecovery",
                  stage: `NativeCompactionCandidateAmbiguity:count=${pendingNative.length}`,
                  executionId: String(input.execution.executionId),
                  providerTurnId: pendingNative[0]?.providerTurnId ?? "unknown",
                }) ?? Promise.resolve(),
            );
          }
          return yield* Effect.fail(
            failure({ _tag: "AgentLoopStepReplayBindingMismatch" }),
          );
        }
        const candidate = pendingNative[0];
        const candidateSourceLinkOption =
          candidate === undefined
            ? Option.none()
            : yield* tx
                .transact(
                  loopSteps.findProviderTurnLinkByProviderTurnId(
                    candidate.providerTurnId,
                  ),
                )
                .pipe(Effect.mapError(failure));
        if (
          Option.isSome(candidateSourceLinkOption) &&
          candidateSourceLinkOption.value.role !== "OverflowCompaction"
        ) {
          return yield* Effect.fail(
            failure({ _tag: "AgentLoopStepReplayBindingMismatch" }),
          );
        }
        // P20 owns every Native ProviderTurn with an OverflowCompaction link.
        // Only unlinked ordinary compactions may use this Session/epoch scan.
        if (
          candidate !== undefined &&
          !Option.isSome(candidateSourceLinkOption)
        ) {
          const frontier = decodeUniqueNativePortableFrontier(
            candidate.manifestJson,
            candidate.portableRequestJson,
          );
          const manifest = frontier?.manifest;
          const sourceValue = manifest?.sourceAgentLoopStep;
          if (
            frontier === null ||
            manifest === undefined ||
            typeof sourceValue !== "object" ||
            sourceValue === null ||
            Array.isArray(sourceValue)
          ) {
            return yield* Effect.fail(
              failure({ _tag: "AgentLoopStepReplayBindingMismatch" }),
            );
          }
          const sourceRecord = sourceValue as Record<string, unknown>;
          if (
            sourceRecord.executionId !== input.execution.executionId ||
            !Number.isSafeInteger(sourceRecord.logicalStepNo) ||
            !Number.isSafeInteger(sourceRecord.repairAttempt) ||
            typeof sourceRecord.providerTurnId !== "string" ||
            candidate.executionId !== input.execution.executionId ||
            candidate.sessionId !== input.execution.sessionId ||
            Number(candidate.contextEpoch) !==
              Number(startupSession.value.contextEpoch) ||
            candidate.modelRef !== capability.modelRef ||
            candidate.outputContractRef !== "provider-native-compaction-v1" ||
            manifest.providerTurnId !== candidate.providerTurnId ||
            manifest.executionId !== input.execution.executionId ||
            manifest.sessionId !== input.execution.sessionId ||
            manifest.contextEpoch !== candidate.contextEpoch ||
            manifest.logicalStepNo !== sourceRecord.logicalStepNo ||
            manifest.operationKind !== "CompactionNative" ||
            manifest.outputContractRef !== "provider-native-compaction-v1" ||
            manifest.compiledRequestHash !==
              sha256Hex(candidate.portableRequestJson)
          ) {
            return yield* Effect.fail(
              failure({ _tag: "AgentLoopStepReplayBindingMismatch" }),
            );
          }
          const sourceIdentity = {
            executionId: input.execution.executionId,
            logicalStepNo: Number(sourceRecord.logicalStepNo),
            repairAttempt: Number(sourceRecord.repairAttempt),
          };
          const sourceStepOption = yield* tx
            .transact(loopSteps.find(sourceIdentity))
            .pipe(Effect.mapError(failure));
          if (
            !Option.isSome(sourceStepOption) ||
            sourceStepOption.value.providerTurnId !==
              sourceRecord.providerTurnId
          ) {
            return yield* Effect.fail(
              failure({ _tag: "AgentLoopStepReplayBindingMismatch" }),
            );
          }
          const sourceStep = sourceStepOption.value;
          if (
            sourceStep.state === "Prepared" ||
            sourceStep.state === "ProviderResultAvailable" ||
            sourceStep.state === "OutputRejected" ||
            sourceStep.state === "OutputAccepted" ||
            sourceStep.state === "ActionsInProgress"
          ) {
            turn = sourceIdentity.logicalStepNo;
            repairAttempt = sourceIdentity.repairAttempt;
          } else if (
            (sourceStep.state === "StepEffectsCommitted" ||
              sourceStep.state === "NextStepReady") &&
            sourceStep.successor !== undefined
          ) {
            turn = sourceStep.successor.logicalStepNo;
            repairAttempt = sourceStep.successor.repairAttempt;
          } else {
            return yield* Effect.fail(
              failure({ _tag: "AgentLoopStepReplayBindingMismatch" }),
            );
          }
          const priorReceipt = yield* tx
            .transact(providerTurns.findSettledResult(candidate.providerTurnId))
            .pipe(Effect.mapError(failure));
          const sourceAgentLoopStep = {
            executionId: String(sourceIdentity.executionId),
            logicalStepNo: sourceIdentity.logicalStepNo,
            repairAttempt: sourceIdentity.repairAttempt,
            providerTurnId: String(sourceStep.providerTurnId),
          };
          if (
            manifest.resolvedModelBindingFingerprint ===
              currentBindingFingerprint &&
            priorReceipt._tag === "SettledSuccess"
          ) {
            const continuationEvents = priorReceipt.canonicalEvents.filter(
              (event) => event._tag === "ContinuationState",
            );
            if (
              priorReceipt.evidenceVersion !== "provider-success-v1" ||
              priorReceipt.finishReason !== "Stop" ||
              priorReceipt.manifestJson !== candidate.manifestJson ||
              priorReceipt.turn.providerTurnId !== candidate.providerTurnId ||
              priorReceipt.turn.manifestId !== candidate.manifestId ||
              priorReceipt.turn.executionId !== input.execution.executionId ||
              priorReceipt.turn.sessionId !== input.execution.sessionId ||
              priorReceipt.turn.contextEpoch !== candidate.contextEpoch ||
              priorReceipt.turn.modelRef !== capability.modelRef ||
              priorReceipt.turn.outputContractRef !==
                "provider-native-compaction-v1" ||
              continuationEvents.length !== 1 ||
              continuationEvents[0]?._tag !== "ContinuationState" ||
              continuationEvents[0].stateRef.length === 0
            ) {
              return yield* Effect.fail(
                failure({ _tag: "AgentLoopStepReplayBindingMismatch" }),
              );
            }
            yield* commitRecoveredNativeCompaction(
              {
                execution: input.execution,
                providerTurnId: candidate.providerTurnId,
                expectedEpoch: startupSession.value.contextEpoch,
                bindingFingerprint: currentBindingFingerprint,
                opaqueItemRef: continuationEvents[0].stateRef,
                fence: loopStepFence,
              },
              { sessions, tx },
            ).pipe(Effect.mapError(failure));
          } else if (
            manifest.resolvedModelBindingFingerprint ===
              currentBindingFingerprint &&
            priorReceipt._tag === "Unsettled"
          ) {
            const startupCompaction = yield* runCompaction(
              {
                execution: input.execution,
                logicalStepNo: sourceIdentity.logicalStepNo,
                sourceAgentLoopStep,
                currentEpoch: startupSession.value.contextEpoch,
                modelRef: capability.modelRef,
                ...(options.secretRef === undefined
                  ? {}
                  : { secretRef: options.secretRef }),
                bindingFingerprint: currentBindingFingerprint,
                inputFrontier: frontier.inputFrontier,
                contextRefs: frontier.contextRefs,
                inputItems: frontier.inputItems,
                ...(yield* loadWorkCompactionPinning()),
                fence: loopStepFence,
                nativeSupported: true,
                nativeRecovery: {
                  manifestJson: candidate.manifestJson,
                  request: frontier.request,
                },
              },
              compactionDependencies,
            ).pipe(Effect.mapError(failure));
            if ("_tag" in startupCompaction) {
              return {
                _tag: "Complete" as const,
                outcome: {
                  _tag: "Settle" as const,
                  settlement: safetyStop("RuntimeSafetyStop"),
                },
              };
            }
          } else if (
            priorReceipt._tag === "SettledFailure" ||
            priorReceipt._tag === "SettledSuccess" ||
            priorReceipt._tag === "Unsettled"
          ) {
            const startupCompaction = yield* runSummaryCompaction(
              {
                execution: input.execution,
                logicalStepNo: sourceIdentity.logicalStepNo,
                sourceAgentLoopStep,
                currentEpoch: startupSession.value.contextEpoch,
                modelRef: capability.modelRef,
                ...(options.secretRef === undefined
                  ? {}
                  : { secretRef: options.secretRef }),
                bindingFingerprint: currentBindingFingerprint,
                inputFrontier: frontier.inputFrontier,
                contextRefs: frontier.contextRefs,
                inputItems: frontier.inputItems,
                fence: loopStepFence,
              },
              compactionDependencies,
            ).pipe(Effect.mapError(failure));
            if ("_tag" in startupCompaction) {
              return {
                _tag: "Complete" as const,
                outcome: {
                  _tag: "Settle" as const,
                  settlement: safetyStop("RuntimeSafetyStop"),
                },
              };
            }
          } else {
            return yield* Effect.fail(
              failure({ _tag: "AgentLoopStepReplayBindingMismatch" }),
            );
          }
        }
      }
      if (
        startupCheckpoint?.providerTurnId !== undefined &&
        startupCheckpoint.fromEpoch !== undefined &&
        Option.isSome(startupSession) &&
        !startupCheckpointInherited &&
        startupCheckpoint.toEpoch === Number(startupSession.value.contextEpoch)
      ) {
        const startupNativeTurnId = nativeCompactionProviderTurnId(
          startupCheckpoint.providerTurnId,
        );
        if (startupNativeTurnId === null) {
          return yield* Effect.fail(
            failure({ _tag: "AgentLoopStepReplayBindingMismatch" }),
          );
        }
        const startupManifest = yield* tx
          .transact(providerTurns.findManifestByTurn(startupNativeTurnId))
          .pipe(Effect.mapError(failure));
        if (startupManifest === null) {
          return yield* Effect.fail(
            failure({ _tag: "AgentLoopStepReplayBindingMismatch" }),
          );
        }
        let startupManifestValue: Record<string, unknown>;
        try {
          const parsed = JSON.parse(startupManifest.manifestJson) as unknown;
          if (
            typeof parsed !== "object" ||
            parsed === null ||
            Array.isArray(parsed)
          ) {
            return yield* Effect.fail(
              failure({ _tag: "AgentLoopStepReplayBindingMismatch" }),
            );
          }
          startupManifestValue = parsed as Record<string, unknown>;
        } catch {
          return yield* Effect.fail(
            failure({ _tag: "AgentLoopStepReplayBindingMismatch" }),
          );
        }
        const startupSource = startupManifestValue.sourceAgentLoopStep;
        if (
          typeof startupSource !== "object" ||
          startupSource === null ||
          Array.isArray(startupSource)
        ) {
          return yield* Effect.fail(
            failure({ _tag: "AgentLoopStepReplayBindingMismatch" }),
          );
        }
        const startupSourceRecord = startupSource as Record<string, unknown>;
        if (options.qualificationProbe !== undefined) {
          const sourceIdentityValid =
            startupSourceRecord.executionId === input.execution.executionId &&
            Number.isSafeInteger(startupSourceRecord.logicalStepNo) &&
            Number(startupSourceRecord.logicalStepNo) >= 0 &&
            Number.isSafeInteger(startupSourceRecord.repairAttempt) &&
            Number(startupSourceRecord.repairAttempt) >= 0 &&
            typeof startupSourceRecord.providerTurnId === "string";
          const sourceStepOption = sourceIdentityValid
            ? yield* tx
                .transact(
                  loopSteps.find({
                    executionId: input.execution.executionId,
                    logicalStepNo: Number(startupSourceRecord.logicalStepNo),
                    repairAttempt: Number(startupSourceRecord.repairAttempt),
                  }),
                )
                .pipe(Effect.mapError(failure))
            : Option.none();
          const sourceStep = Option.isSome(sourceStepOption)
            ? sourceStepOption.value
            : undefined;
          const sourceLinkOption = yield* tx
            .transact(
              loopSteps.findProviderTurnLinkByProviderTurnId(
                startupNativeTurnId,
              ),
            )
            .pipe(Effect.mapError(failure));
          const startupReceipt = yield* tx
            .transact(providerTurns.findSettledResult(startupNativeTurnId))
            .pipe(Effect.mapError(failure));
          let startupRequestValue: Record<string, unknown> | undefined;
          try {
            const parsed = JSON.parse(
              startupManifest.portableRequestJson,
            ) as unknown;
            if (
              typeof parsed === "object" &&
              parsed !== null &&
              !Array.isArray(parsed)
            ) {
              startupRequestValue = parsed as Record<string, unknown>;
            }
          } catch {
            startupRequestValue = undefined;
          }
          const frontierValue = startupManifestValue.inputFrontier;
          const frontierRecord =
            typeof frontierValue === "object" &&
            frontierValue !== null &&
            !Array.isArray(frontierValue)
              ? (frontierValue as Record<string, unknown>)
              : undefined;
          const firstSequence = frontierRecord?.firstSequence;
          const lastSequence = frontierRecord?.lastSequence;
          const contextRefs = startupManifestValue.contextRefs;
          const inputItems = startupRequestValue?.inputItems;
          const frontierValid =
            typeof firstSequence === "number" &&
            Number.isSafeInteger(firstSequence) &&
            firstSequence >= 0 &&
            typeof lastSequence === "number" &&
            Number.isSafeInteger(lastSequence) &&
            lastSequence >= firstSequence &&
            lastSequence < startupCheckpoint.sequence &&
            Array.isArray(contextRefs) &&
            contextRefs.length > 0 &&
            contextRefs.every(
              (ref): ref is string => typeof ref === "string" && ref.length > 0,
            ) &&
            new Set(contextRefs).size === contextRefs.length &&
            Array.isArray(inputItems) &&
            inputItems.length > 0 &&
            !containsNativeCheckpointInput(inputItems);
          const receiptValid =
            startupReceipt._tag === "SettledSuccess" &&
            startupReceipt.evidenceVersion === "provider-success-v1" &&
            startupReceipt.finishReason === "Stop" &&
            startupReceipt.manifestId === startupManifest.manifestId &&
            startupReceipt.manifestJson === startupManifest.manifestJson &&
            startupReceipt.turn.providerTurnId === startupNativeTurnId &&
            startupReceipt.turn.executionId === input.execution.executionId &&
            startupReceipt.turn.sessionId === input.execution.sessionId &&
            startupReceipt.turn.contextEpoch === startupCheckpoint.fromEpoch &&
            startupReceipt.turn.modelRef === capability.modelRef &&
            startupReceipt.turn.outputContractRef ===
              "provider-native-compaction-v1" &&
            startupReceipt.canonicalEvents.filter(
              (event) =>
                event._tag === "ContinuationState" &&
                event.stateRef === startupCheckpoint.opaqueItemRef,
            ).length === 1;
          const startupChecks = {
            checkpoint:
              startupCheckpoint.providerTurnId === startupNativeTurnId &&
              startupCheckpoint.fromEpoch !== undefined &&
              startupCheckpoint.toEpoch === startupCheckpoint.fromEpoch + 1 &&
              startupCheckpoint.toEpoch ===
                Number(startupSession.value.contextEpoch) &&
              startupCheckpoint.opaqueItemRef !== undefined &&
              startupCheckpoint.bindingFingerprint !== undefined &&
              startupCheckpoint.bindingMatches,
            providerTurn:
              startupManifestValue.providerTurnId === startupNativeTurnId,
            execution:
              startupManifestValue.executionId === input.execution.executionId,
            session:
              startupManifestValue.sessionId === input.execution.sessionId,
            source: sourceIdentityValid,
            step: sourceStep !== undefined,
            sourceProviderTurn:
              sourceStep?.providerTurnId === startupSourceRecord.providerTurnId,
            stepState:
              sourceStep !== undefined &&
              (sourceStep.state === "Prepared" ||
                sourceStep.state === "ProviderResultAvailable" ||
                sourceStep.state === "OutputRejected" ||
                sourceStep.state === "OutputAccepted" ||
                sourceStep.state === "ActionsInProgress" ||
                sourceStep.state === "StepEffectsCommitted" ||
                (sourceStep.state === "NextStepReady" &&
                  sourceStep.successor !== undefined)),
            sourceLinkAbsent: !Option.isSome(sourceLinkOption),
            frontier: frontierValid,
            receipt: receiptValid,
            operation:
              startupManifestValue.operationKind === "CompactionNative" &&
              startupManifestValue.outputContractRef ===
                "provider-native-compaction-v1",
            bindingFingerprint:
              startupManifestValue.resolvedModelBindingFingerprint ===
              startupCheckpoint.bindingFingerprint,
            contextEpoch:
              startupManifestValue.contextEpoch === startupCheckpoint.fromEpoch,
            compiledRequestHash:
              startupManifestValue.compiledRequestHash ===
              sha256Hex(startupManifest.portableRequestJson),
          };
          yield* Effect.promise(
            () =>
              options.qualificationProbe?.({
                boundary: "AH19NativeCheckpointRecovery",
                stage: `NativeStartupManifestChecks:${Object.entries(
                  startupChecks,
                )
                  .map(([key, value]) => `${key}=${String(value)}`)
                  .join(",")}`,
                executionId: String(input.execution.executionId),
                providerTurnId: startupNativeTurnId,
              }) ?? Promise.resolve(),
          );
        }
        if (
          startupSourceRecord.executionId !== input.execution.executionId ||
          !Number.isSafeInteger(startupSourceRecord.logicalStepNo) ||
          !Number.isSafeInteger(startupSourceRecord.repairAttempt) ||
          typeof startupSourceRecord.providerTurnId !== "string" ||
          startupManifestValue.providerTurnId !== startupNativeTurnId ||
          startupManifestValue.executionId !== input.execution.executionId ||
          startupManifestValue.sessionId !== input.execution.sessionId ||
          startupManifestValue.contextEpoch !== startupCheckpoint.fromEpoch ||
          startupManifestValue.operationKind !== "CompactionNative" ||
          startupManifestValue.resolvedModelBindingFingerprint !==
            startupCheckpoint.bindingFingerprint ||
          startupManifestValue.compiledRequestHash !==
            sha256Hex(startupManifest.portableRequestJson)
        ) {
          return yield* Effect.fail(
            failure({ _tag: "AgentLoopStepReplayBindingMismatch" }),
          );
        }
        const startupIdentity = {
          executionId: input.execution.executionId,
          logicalStepNo: Number(startupSourceRecord.logicalStepNo),
          repairAttempt: Number(startupSourceRecord.repairAttempt),
        };
        const startupStepOption = yield* tx
          .transact(loopSteps.find(startupIdentity))
          .pipe(Effect.mapError(failure));
        if (!Option.isSome(startupStepOption)) {
          return yield* Effect.fail(
            failure({ _tag: "AgentLoopStepReplayBindingMismatch" }),
          );
        }
        const startupStep = startupStepOption.value;
        if (startupStep.providerTurnId !== startupSourceRecord.providerTurnId) {
          return yield* Effect.fail(
            failure({ _tag: "AgentLoopStepReplayBindingMismatch" }),
          );
        }
        if (
          startupStep.state === "NextStepReady" &&
          startupStep.successor === undefined
        ) {
          return yield* Effect.fail(
            failure({ _tag: "AgentLoopStepReplayBindingMismatch" }),
          );
        }
        if (
          startupStep.state === "Prepared" ||
          startupStep.state === "ProviderResultAvailable" ||
          startupStep.state === "OutputRejected" ||
          startupStep.state === "OutputAccepted" ||
          startupStep.state === "ActionsInProgress"
        ) {
          turn = startupIdentity.logicalStepNo;
          repairAttempt = startupIdentity.repairAttempt;
        } else if (
          startupStep.state === "StepEffectsCommitted" ||
          startupStep.state === "NextStepReady"
        ) {
          if (
            !startupCheckpoint.bindingMatches ||
            startupStep.successor === undefined
          ) {
            // Rebase must settle the persisted checkpoint owner before its
            // successor can inspect the old Native frontier.
            turn = startupIdentity.logicalStepNo;
            repairAttempt = startupIdentity.repairAttempt;
          } else {
            turn = startupStep.successor.logicalStepNo;
            repairAttempt = startupStep.successor.repairAttempt;
          }
        }
        if (options.qualificationProbe !== undefined) {
          yield* Effect.promise(
            () =>
              options.qualificationProbe?.({
                boundary: "AH19NativeCheckpointRecovery",
                stage: `StartupCheckpointCursor:bindingMatches=${startupCheckpoint.bindingMatches}:source=${startupIdentity.logicalStepNo}:repair=${startupIdentity.repairAttempt}:state=${startupStep.state}:successor=${startupStep.successor?.providerTurnId ?? "none"}:cursor=${turn}`,
                executionId: String(input.execution.executionId),
                providerTurnId: startupCheckpoint.providerTurnId ?? "unknown",
              }) ?? Promise.resolve(),
          );
        }
      }
    }
    const resumeExactActionStepIdentity = options.resumeExactActionStepIdentity;
    if (
      resumeExactActionStepIdentity !== undefined &&
      resumeExactActionStepIdentity.executionId === input.execution.executionId
    ) {
      turn = resumeExactActionStepIdentity.logicalStepNo;
      repairAttempt = resumeExactActionStepIdentity.repairAttempt;
    }
    return { _tag: "Ready" as const, cursor: { turn, repairAttempt } };
  });
};
