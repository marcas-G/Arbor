import { type Execution, executionEpisode } from "@arbor/domain";
import {
  projectSessionTimeline,
  SESSION_TIMELINE_ENTRY_LIMIT,
} from "@arbor/model-context";
import {
  type AgentLoopStepStoreService,
  type ConversationCheckpointStoreService,
  type DecisionRequestStoreService,
  type ExecutionDriverError,
  type ProviderTurnStoreService,
  type RecoveryEvidenceStoreService,
  type SessionRepositoryService,
  sha256Hex,
  type ToolInvocationStoreService,
  type TransactionPortService,
} from "@arbor/ports";
import { Effect, Option } from "effect";
import {
  isP20OverflowReplacementManifestBound,
  p20OverflowReplacementManifestBindingFailures,
  resolveOverflowReplacementChain,
  submittedDecisionManifestMismatchOutcome,
} from "../agent-loop-step-recovery.js";
import { classifySubmittedDecisionBindingFailure } from "../model-decision.js";
import type { AgentLoopQualificationProbe } from "../qualification-probe.js";
import {
  isAgentLoopStepManifestBound,
  isPreparedStepAwaitingInitialManifest,
  selectInitialAgentLoopStepCursor,
} from "./cursor.js";

/** Select the exact durable cursor and validate its manifest before model or action replay. */
export const recoverAgentLoopFrontier = (
  input: { readonly execution: Execution },
  loopSteps: AgentLoopStepStoreService | undefined,
  providerTurns: ProviderTurnStoreService | undefined,
  invocationStore: ToolInvocationStoreService,
  p39Recovery: RecoveryEvidenceStoreService,
  conversationCheckpointStore: ConversationCheckpointStoreService,
  decisionRequests: DecisionRequestStoreService,
  sessions: SessionRepositoryService,
  tx: TransactionPortService,
  failure: (cause: unknown) => ExecutionDriverError,
  options: { readonly qualificationProbe?: AgentLoopQualificationProbe },
) =>
  Effect.gen(function* () {
    // Resume from the latest durable P9 cursor, not turn zero. Without
    // this, a restart after a completed earlier step can re-open its
    // old executable output and repair later unresolved ToolCalls as
    // interrupted, even though a successor step is already persisted.
    let firstLogicalStepNo = 0;
    let firstRepairAttempt = 0;
    let exactNotAdmittedRecovery:
      | {
          readonly executionId: Execution["executionId"];
          readonly logicalStepNo: number;
          readonly repairAttempt: number;
          readonly providerTurnId: string;
          readonly logicalActionId: string;
          readonly actionIndex: number;
          readonly callRef: string;
        }
      | undefined;
    if (loopSteps !== undefined) {
      const persistedSteps = yield* tx
        .transact(loopSteps.listByExecution(input.execution.executionId))
        .pipe(Effect.mapError(failure));
      const cursor = selectInitialAgentLoopStepCursor(persistedSteps);
      if (cursor === undefined) {
        return yield* Effect.fail(
          failure({ _tag: "AgentLoopStepReplayBindingMismatch" }),
        );
      }
      firstLogicalStepNo = cursor.logicalStepNo;
      firstRepairAttempt = cursor.repairAttempt;
      {
        const unsettled = yield* tx
          .transact(invocationStore.findUnsettled(input.execution.executionId))
          .pipe(Effect.mapError(failure));
        const candidates: (typeof exactNotAdmittedRecovery)[] = [];
        for (const invocation of unsettled) {
          if (
            invocation.effectAdmissionState !== "NotAdmitted" ||
            invocation.settledAt !== null ||
            invocation.settlement !== null
          ) {
            continue;
          }
          const bindingOption = yield* tx
            .transact(p39Recovery.findBinding(invocation.invocationId))
            .pipe(Effect.mapError(failure));
          if (Option.isNone(bindingOption)) {
            continue;
          }
          const binding = bindingOption.value.value;
          const source = persistedSteps.find(
            (step) =>
              step.identity.logicalStepNo === binding.logicalStepNo &&
              step.identity.repairAttempt === binding.repairAttempt &&
              step.providerTurnId === binding.providerTurnId,
          );
          if (
            binding.executionId !== input.execution.executionId ||
            binding.invocationId !== invocation.invocationId ||
            source === undefined ||
            (source.state !== "NextStepReady" &&
              source.state !== "ActionsInProgress") ||
            (source.state === "NextStepReady" && source.successor === undefined)
          ) {
            continue;
          }
          const actions = yield* tx
            .transact(loopSteps.listActions(source.identity))
            .pipe(Effect.mapError(failure));
          const action = actions.find(
            (candidate) =>
              candidate.actionIndex === binding.actionIndex &&
              candidate.logicalActionId === binding.logicalActionId &&
              candidate.callRef === binding.callRef,
          );
          if (
            (action?.state !== "Applied" && action?.state !== "Pending") ||
            action.routeKind !== "Executable" ||
            action.actionKind !== binding.toolName
          ) {
            continue;
          }
          candidates.push({
            executionId: input.execution.executionId,
            logicalStepNo: binding.logicalStepNo,
            repairAttempt: binding.repairAttempt,
            providerTurnId: binding.providerTurnId,
            logicalActionId: binding.logicalActionId,
            actionIndex: binding.actionIndex,
            callRef: binding.callRef,
          });
        }
        if (candidates.length > 1) {
          return {
            _tag: "Terminal" as const,
            outcome: { _tag: "RecoveryBlocked" as const },
          };
        }
        exactNotAdmittedRecovery = candidates[0];
        if (exactNotAdmittedRecovery !== undefined) {
          firstLogicalStepNo = exactNotAdmittedRecovery.logicalStepNo;
          firstRepairAttempt = exactNotAdmittedRecovery.repairAttempt;
        }
      }
      if (persistedSteps.length > 0) {
        const current = persistedSteps.find(
          (step) =>
            step.identity.logicalStepNo === cursor.logicalStepNo &&
            step.identity.repairAttempt === cursor.repairAttempt,
        );
        if (
          current === undefined ||
          current.identity.executionId !== input.execution.executionId
        ) {
          return yield* Effect.fail(
            failure({ _tag: "AgentLoopStepReplayBindingMismatch" }),
          );
        }
        if (providerTurns === undefined) {
          return yield* Effect.fail(
            failure({ _tag: "AgentLoopStepReplayBindingMismatch" }),
          );
        }
        const priorManifest = yield* tx
          .transact(providerTurns.findManifestByTurn(current.providerTurnId))
          .pipe(Effect.mapError(failure));
        let manifestBound = isAgentLoopStepManifestBound(
          current,
          input.execution.executionId,
          input.execution.sessionId,
          priorManifest,
        );
        let p20ReplacementGateStage = "primary-manifest-bound";
        if (
          !manifestBound &&
          current.manifestId !== undefined &&
          priorManifest?.manifestId !== current.manifestId
        ) {
          const providerLinks = yield* tx
            .transact(loopSteps.listProviderTurnLinks(current.identity))
            .pipe(Effect.mapError(failure));
          const chain = resolveOverflowReplacementChain(
            providerLinks,
            current.identity,
            String(current.providerTurnId),
          );
          p20ReplacementGateStage = `chain=${chain !== undefined}`;
          if (chain !== undefined) {
            const [
              sourceInferenceReceipt,
              replacementManifest,
              replacementReceipt,
              compactionManifest,
              compactionReceipt,
            ] = yield* Effect.all(
              [
                tx.transact(
                  providerTurns.findSettledResult(
                    chain.inference.providerTurnId,
                  ),
                ),
                tx.transact(
                  providerTurns.findManifestByTurn(
                    chain.replacement.providerTurnId,
                  ),
                ),
                tx.transact(
                  providerTurns.findSettledResult(
                    chain.replacement.providerTurnId,
                  ),
                ),
                tx.transact(
                  providerTurns.findManifestByTurn(
                    chain.compaction.providerTurnId,
                  ),
                ),
                tx.transact(
                  providerTurns.findSettledResult(
                    chain.compaction.providerTurnId,
                  ),
                ),
              ],
              { concurrency: 1 },
            ).pipe(Effect.mapError(failure));
            const replacementManifestBound =
              isP20OverflowReplacementManifestBound({
                step: current,
                sessionId: String(input.execution.sessionId),
                chain,
                manifest: replacementManifest,
                settled: replacementReceipt,
              });
            const replacementManifestFailures =
              p20OverflowReplacementManifestBindingFailures({
                step: current,
                sessionId: String(input.execution.sessionId),
                chain,
                manifest: replacementManifest,
                settled: replacementReceipt,
              });
            p20ReplacementGateStage += `;replacement=${replacementManifestBound}:${replacementManifestFailures.join(",")}`;
            const parseManifest = (value: string | null) => {
              try {
                const parsed: unknown = JSON.parse(value ?? "null");
                return typeof parsed === "object" &&
                  parsed !== null &&
                  !Array.isArray(parsed)
                  ? (parsed as Record<string, unknown>)
                  : undefined;
              } catch {
                return undefined;
              }
            };
            const nativeManifest = parseManifest(
              compactionManifest?.manifestJson ?? null,
            );
            const nativeSourceStep = parseManifest(
              JSON.stringify(nativeManifest?.sourceAgentLoopStep ?? null) ??
                null,
            );
            const nativeRequest = parseManifest(
              compactionManifest?.portableRequestJson ?? null,
            );
            const nativeSuccess =
              sourceInferenceReceipt._tag === "SettledFailure" &&
              sourceInferenceReceipt.failureKind === "ContextLimitExceeded" &&
              sourceInferenceReceipt.turn.providerTurnId ===
                chain.inference.providerTurnId &&
              sourceInferenceReceipt.turn.executionId ===
                input.execution.executionId &&
              sourceInferenceReceipt.turn.sessionId ===
                input.execution.sessionId &&
              sourceInferenceReceipt.turn.contextEpoch ===
                chain.inference.contextEpoch &&
              compactionManifest !== null &&
              compactionReceipt._tag === "SettledSuccess" &&
              compactionReceipt.evidenceVersion === "provider-success-v1" &&
              compactionReceipt.finishReason === "Stop" &&
              compactionReceipt.manifestId === compactionManifest.manifestId &&
              compactionReceipt.manifestJson ===
                compactionManifest.manifestJson &&
              compactionReceipt.turn.providerTurnId ===
                chain.compaction.providerTurnId &&
              compactionReceipt.turn.executionId ===
                input.execution.executionId &&
              compactionReceipt.turn.sessionId === input.execution.sessionId &&
              compactionReceipt.turn.contextEpoch ===
                chain.compaction.contextEpoch &&
              compactionReceipt.turn.outputContractRef ===
                "provider-native-compaction-v1" &&
              nativeManifest !== undefined &&
              nativeRequest !== undefined &&
              nativeManifest?.providerTurnId ===
                chain.compaction.providerTurnId &&
              nativeManifest.executionId === input.execution.executionId &&
              nativeManifest.sessionId === input.execution.sessionId &&
              nativeManifest.logicalStepNo === current.identity.logicalStepNo &&
              nativeManifest.contextEpoch === chain.compaction.contextEpoch &&
              nativeManifest.operationKind === "CompactionNative" &&
              nativeManifest.outputContractRef ===
                "provider-native-compaction-v1" &&
              typeof nativeManifest.resolvedModelBindingFingerprint ===
                "string" &&
              nativeManifest.compiledRequestHash ===
                sha256Hex(compactionManifest.portableRequestJson) &&
              nativeRequest?.operationKind === "CompactionNative" &&
              nativeRequest.outputContractRef ===
                "provider-native-compaction-v1" &&
              nativeRequest.modelRef === nativeManifest.modelRef &&
              compactionReceipt.canonicalEvents.filter(
                (event) =>
                  event._tag === "ContinuationState" &&
                  event.stateRef.length > 0,
              ).length === 1;
            let checkpointOwnerCurrent = false;
            if (
              replacementManifestBound &&
              nativeSuccess &&
              nativeManifest !== undefined &&
              compactionReceipt._tag === "SettledSuccess"
            ) {
              const episode = executionEpisode(input.execution);
              const nativeStateRef = compactionReceipt.canonicalEvents.find(
                (event) => event._tag === "ContinuationState",
              );
              const nativeStateRefValue =
                nativeStateRef?._tag === "ContinuationState"
                  ? nativeStateRef.stateRef
                  : undefined;
              if (episode?._tag === "ConversationResponseEpisode") {
                const ownerOption = yield* tx
                  .transact(
                    conversationCheckpointStore.findOwner(
                      input.execution.workspaceId,
                    ),
                  )
                  .pipe(Effect.mapError(failure));
                if (Option.isSome(ownerOption)) {
                  const owner = ownerOption.value;
                  const ownerSource = parseManifest(owner.sourceManifestJson);
                  const nested = parseManifest(
                    JSON.stringify(nativeManifest.conversationCheckpoint),
                  );
                  checkpointOwnerCurrent =
                    owner.contextEpoch === chain.replacement.contextEpoch &&
                    owner.checkpointKind === "ProviderNative" &&
                    owner.producerExecutionId === input.execution.executionId &&
                    owner.producerProviderTurnId ===
                      chain.compaction.providerTurnId &&
                    typeof owner.bindingFingerprint === "string" &&
                    owner.bindingFingerprint ===
                      nativeManifest.resolvedModelBindingFingerprint &&
                    owner.checkpointRef !== null &&
                    nativeStateRef?._tag === "ContinuationState" &&
                    owner.checkpointRef === nativeStateRef.stateRef &&
                    ownerSource !== undefined &&
                    ownerSource.rootWorkspaceId ===
                      input.execution.workspaceId &&
                    ownerSource.fromEpoch === chain.compaction.contextEpoch &&
                    ownerSource.toEpoch === owner.contextEpoch &&
                    ownerSource.currentMessageId === episode.messageId &&
                    ownerSource.producerExecutionId ===
                      input.execution.executionId &&
                    ownerSource.producerProviderTurnId ===
                      chain.compaction.providerTurnId &&
                    nested !== undefined &&
                    nested.rootWorkspaceId === ownerSource.rootWorkspaceId &&
                    nested.fromEpoch === ownerSource.fromEpoch &&
                    nested.toEpoch === ownerSource.toEpoch &&
                    nested.currentMessageId === ownerSource.currentMessageId &&
                    JSON.stringify(nested.coveredSources) ===
                      JSON.stringify(ownerSource.coveredSources) &&
                    JSON.stringify(nested.coveredThrough) ===
                      JSON.stringify(ownerSource.coveredThrough) &&
                    JSON.stringify(nested.fromFrontier) ===
                      JSON.stringify(ownerSource.fromFrontier) &&
                    nested.currentRunningJobRevision ===
                      ownerSource.currentRunningJobRevision &&
                    nested.currentRunningAttemptNo ===
                      ownerSource.currentRunningAttemptNo &&
                    nested.currentAdmissionJobRevision ===
                      ownerSource.currentAdmissionJobRevision;
                }
              } else {
                const nativeSourceStepMatches =
                  nativeSourceStep !== undefined &&
                  nativeSourceStep.executionId ===
                    current.identity.executionId &&
                  nativeSourceStep.logicalStepNo ===
                    current.identity.logicalStepNo &&
                  nativeSourceStep.repairAttempt ===
                    current.identity.repairAttempt &&
                  nativeSourceStep.providerTurnId === current.providerTurnId;
                const sessionOption = yield* tx
                  .transact(sessions.findById(input.execution.sessionId))
                  .pipe(Effect.mapError(failure));
                if (Option.isSome(sessionOption)) {
                  const timeline = yield* tx
                    .transact(
                      sessions.listRecentEntries(
                        input.execution.sessionId,
                        SESSION_TIMELINE_ENTRY_LIMIT,
                      ),
                    )
                    .pipe(Effect.mapError(failure));
                  const projection = projectSessionTimeline(
                    timeline,
                    String(nativeManifest.resolvedModelBindingFingerprint),
                    true,
                  );
                  const checkpoint = projection.nativeCheckpoint;
                  checkpointOwnerCurrent =
                    Number(sessionOption.value.contextEpoch) ===
                      Number(chain.replacement.contextEpoch) &&
                    nativeSourceStepMatches &&
                    checkpoint !== undefined &&
                    checkpoint.providerTurnId ===
                      chain.compaction.providerTurnId &&
                    checkpoint.fromEpoch ===
                      Number(chain.compaction.contextEpoch) &&
                    checkpoint.toEpoch ===
                      Number(chain.replacement.contextEpoch) &&
                    checkpoint.bindingMatches &&
                    checkpoint.bindingFingerprint ===
                      nativeManifest.resolvedModelBindingFingerprint &&
                    checkpoint.opaqueItemRef === nativeStateRefValue;
                }
              }
            }
            manifestBound =
              replacementManifestBound &&
              nativeSuccess &&
              checkpointOwnerCurrent;
            p20ReplacementGateStage += `;native=${nativeSuccess};owner=${checkpointOwnerCurrent};bound=${manifestBound}`;
          }
        }
        if (
          p20ReplacementGateStage !== "primary-manifest-bound" &&
          options.qualificationProbe !== undefined
        ) {
          yield* Effect.promise(
            () =>
              options.qualificationProbe?.({
                boundary: "AH19NativeCheckpointRecovery",
                stage: `P20ReplacementStepManifestGate:${p20ReplacementGateStage}`,
                executionId: String(input.execution.executionId),
                providerTurnId: String(current.providerTurnId),
              }) ?? Promise.resolve(),
          );
        }
        let submittedDecisionBindingMismatch:
          | ReturnType<typeof submittedDecisionManifestMismatchOutcome>
          | undefined;
        const episode = executionEpisode(input.execution);
        if (!manifestBound && episode?._tag === "DecisionEpisode") {
          const [request, actions, settledResult] = yield* Effect.all(
            [
              tx.transact(decisionRequests.findById(episode.decisionId)),
              tx.transact(loopSteps.listActions(current.identity)),
              tx.transact(
                providerTurns.findSettledResult(current.providerTurnId),
              ),
            ],
            { concurrency: 1 },
          ).pipe(Effect.mapError(failure));
          const pendingAction = actions.find(
            (action) =>
              action.actionIndex === current.nextActionIndex &&
              action.routeKind === "Control" &&
              action.actionKind === "select_current_work" &&
              action.state === "Pending",
          );
          if (
            Option.isSome(request) &&
            settledResult?._tag === "SettledSuccess"
          ) {
            const failureCode = classifySubmittedDecisionBindingFailure({
              executionWorkspaceId: String(input.execution.workspaceId),
              episode,
              request: request.value,
              workspace: undefined,
              step: current,
              pendingAction,
              providerTurnId: String(current.providerTurnId),
              providerResult: {
                _tag: "SettledSuccess",
                manifestId: String(settledResult.manifestId),
              },
            });
            submittedDecisionBindingMismatch =
              submittedDecisionManifestMismatchOutcome({
                decisionEpisode: true,
                failureCode,
                step: current,
                executionId: String(input.execution.executionId),
                sessionId: String(input.execution.sessionId),
                manifest: priorManifest,
                settledManifestId: String(settledResult.manifestId),
                logicalActionId: pendingAction?.logicalActionId,
              });
          }
        }
        if (submittedDecisionBindingMismatch !== undefined) {
          // Return the typed outcome directly to ExecutionRuntime's
          // existing P9 fact transaction before context, Provider, or
          // action replay can observe the corrupted Step manifest.
          return {
            _tag: "Terminal" as const,
            outcome: submittedDecisionBindingMismatch,
          };
        }
        if (
          !isPreparedStepAwaitingInitialManifest(current, priorManifest) &&
          !manifestBound
        ) {
          return yield* Effect.fail(
            failure({ _tag: "AgentLoopStepReplayBindingMismatch" }),
          );
        }
      }
    }
    return {
      _tag: "Ready" as const,
      firstLogicalStepNo,
      firstRepairAttempt,
      exactNotAdmittedRecovery,
    };
  });
