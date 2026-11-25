import type {
  CanonicalResourceRegion,
  ResourceAddress,
  Workspace,
} from "@arbor/domain";
import {
  ArtifactId,
  decodeExecutionEpisodeBinding,
  encodeExecutionEpisodeBinding,
  parse,
} from "@arbor/domain";
import {
  ArtifactService,
  type CanonicalToolObservation,
  Clock,
  canonicalArgumentsDigestV1,
  canonicalizeRecoveryBindingV1,
  EnvironmentRevisionStore,
  type ExecutableApprovalConsumptionReceipt,
  type ExecutableApprovalRecord,
  ExecutableApprovalStore,
  executableApprovalBindingMatches,
  type NoEffectDenialCode,
  P39RecoveryEvidenceStore,
  ProjectEnvironmentPort,
  type RecoveryBindingV1,
  ResourceAdmission,
  reconciliationFactId,
  recoveryBindingV1Digest,
  type SandboxHandle,
  SandboxPort,
  type SandboxProcessPolicyResolution,
  SandboxProcessPort,
  type SelectedP39RecoveryEvidence,
  ToolAuthorityResolver,
  type ToolDefinition,
  ToolDefinitionStore,
  type ToolExecutionContext,
  type ToolIntent,
  type ToolInvocationIntent,
  type ToolInvocationSettlement,
  ToolInvocationStore,
  ToolObservationEvidenceStore,
  ToolObservationReplayAttentionFactStore,
  ToolReconciliationFactStore,
  ToolReconciliationPort,
  type ToolReconciliationProfile,
  ToolReconciliationProfileRegistry,
  type ToolReconciliationRequest,
  type ToolReconciliationResult,
  type ToolRuntimeError,
  ToolRuntimePort,
  TransactionPort,
  TrustedLocalProcessPort,
  targetResourceIdentityDigestV1,
  validateToolReconciliationResult,
  verifyRecoveryBindingV1,
  WorkspaceRepository,
} from "@arbor/ports";
import { Effect, Layer, Option } from "effect";
import { actionDigestOf, matchApproval } from "./approval.js";
import { checkInvocationAuthority } from "./authority.js";
import {
  makeRecoveryBindingV1,
  matchesAuthenticatedP39Evidence,
  recoveryApprovalSnapshotFromReceipt,
  recoveryApprovalSnapshotFromRecord,
  type RecoveryApprovalSnapshot,
  recoveryBindingIdentityMatches,
  recoveryBindingToolDefinitionHashV1,
} from "./recovery-binding.js";
import {
  type FilesystemAddress,
  legacyResourceArguments,
  primaryFilesystemAddress,
  requestedFilesystemTarget,
  requestedMountRefs,
} from "./requested-resources.js";
import { validateToolInput } from "./validation.js";

import type { ToolExecutionResult, ToolExecutor, ToolRuntimeQualificationProbe } from "./runtime/types.js";
import {
  approvalDenialCode,
  bounded,
  denied,
  executableApprovalTerminalDenial,
  hasCompleteExecutionFence,
  isLeaseFencingRejected,
  isP39ResourceResolutionStale,
  operationalFailure,
  P39_RESOURCE_RESOLUTION_STALE,
  reconciliationRetryDenialReasonCode,
} from "./runtime/errors.js";
import { makeProcessRunner } from "./runtime/process-runner.js";
import { makeObservationReplay } from "./runtime/observation-replay.js";

export {
  recoveryBindingIdentityMatches,
  recoveryBindingToolDefinitionHashV1,
} from "./recovery-binding.js";

export type { ToolExecutionResult, ToolExecutor, ToolRuntimeQualificationEvent, ToolRuntimeQualificationProbe } from "./runtime/types.js";
export { executableApprovalTerminalDenial, reconciliationRetryDenialReasonCode } from "./runtime/errors.js";

export const ToolRuntimeLive = (
  executors: ReadonlyArray<ToolExecutor>,
  options: {
    readonly maxDelegationDepth?: number;
    readonly now?: string;
    readonly qualificationProbe?: ToolRuntimeQualificationProbe;
    readonly processExecutionMode?: "Disabled" | "NativeOsSupportedOnly";
    readonly nativeOsSupportedTupleAvailable?: boolean;
    readonly testOnlyAllowTrustedLocalProcessExecution?: boolean;
  } = {},
): Layer.Layer<
  ToolRuntimePort,
  never,
  | ToolDefinitionStore
  | SandboxPort
  | ResourceAdmission
  | ToolInvocationStore
  | ProjectEnvironmentPort
  | TransactionPort
  | Clock
> =>
  Layer.effect(
    ToolRuntimePort,
    Effect.gen(function* () {
      const processExecutionMode = options.processExecutionMode ?? "Disabled";
      const testOnlyAllowTrustedLocalProcessExecution =
        options.testOnlyAllowTrustedLocalProcessExecution === true;
      const nativeOsSupportedTupleAvailable =
        options.nativeOsSupportedTupleAvailable === true;
      const processUnavailableReason: NoEffectDenialCode =
        processExecutionMode === "Disabled"
          ? "ProcessExecutionDisabled"
          : "NativeOsTupleUnavailable";
      const processModeBlocksSpawn =
        processExecutionMode === "Disabled" || !nativeOsSupportedTupleAvailable;
      // Independent Verification runs in a freshly captured, OS-enforced
      // temporary environment. They are deliberately allowed to reach the
      // sandbox-process path even when ordinary Workspace shell execution is
      // disabled; the independent policy resolver below is still mandatory
      // and must materialize the exact captured environment before spawn.
      const isIndependentVerificationExecution = (
        context: ToolExecutionContext,
      ): boolean => context.independentVerificationTarget !== undefined;
      const definitions = yield* ToolDefinitionStore;
      const sandbox = yield* SandboxPort;
      const sandboxProcess = yield* Effect.serviceOption(SandboxProcessPort);
      const trustedLocalProcess = yield* Effect.serviceOption(
        TrustedLocalProcessPort,
      );
      const admission = yield* ResourceAdmission;
      const store = yield* ToolInvocationStore;
      const executableApprovals = yield* Effect.serviceOption(
        ExecutableApprovalStore,
      );
      const tx = yield* TransactionPort;
      const clock = yield* Clock;
      const environment = yield* ProjectEnvironmentPort;
      const workspaces = yield* Effect.serviceOption(WorkspaceRepository);
      const environmentRevisions = yield* Effect.serviceOption(
        EnvironmentRevisionStore,
      );
      const p39Recovery = yield* Effect.serviceOption(P39RecoveryEvidenceStore);
      const authorityResolver = yield* Effect.serviceOption(
        ToolAuthorityResolver,
      );
      const artifactService = yield* Effect.serviceOption(ArtifactService);
      const observationEvidence = yield* Effect.serviceOption(
        ToolObservationEvidenceStore,
      );
      const replayAttentionFacts = yield* Effect.serviceOption(
        ToolObservationReplayAttentionFactStore,
      );
      const p39RecoveryEvidence = yield* Effect.serviceOption(
        P39RecoveryEvidenceStore,
      );
      const reconciliationProfiles = yield* Effect.serviceOption(
        ToolReconciliationProfileRegistry,
      );
      const reconciliationPort = yield* Effect.serviceOption(
        ToolReconciliationPort,
      );
      const reconciliationFacts = yield* Effect.serviceOption(
        ToolReconciliationFactStore,
      );
      const runProcessFor = makeProcessRunner(
        sandboxProcess,
        trustedLocalProcess,
        testOnlyAllowTrustedLocalProcessExecution,
      );
      const {
        decodeRecordedEvidence,
        decodeRecordedEvidenceResult,
        findInvocationFenced,
        recordReplayFailure,
        replayFailureCode,
      } = makeObservationReplay(
        tx,
        clock,
        store,
        observationEvidence,
        replayAttentionFacts,
        p39RecoveryEvidence,
      );

      const invoke = (
        intent: ToolIntent,
        context: ToolExecutionContext,
        staleRefreshCount = 0,
      ): Effect.Effect<CanonicalToolObservation, ToolRuntimeError> => {
        let sandboxPolicyCleanup: Effect.Effect<void> = Effect.void;
        return Effect.gen(function* () {
          let sandboxPolicyResolutionLoaded = false;
          let sandboxPolicyResolution:
            | SandboxProcessPolicyResolution
            | undefined;
          const resolveSandboxPolicyOnce = (
            now: string,
          ): Effect.Effect<SandboxProcessPolicyResolution | undefined> =>
            Effect.suspend(() => {
              if (sandboxPolicyResolutionLoaded) {
                return Effect.succeed(sandboxPolicyResolution);
              }
              const resolver = context.resolveSandboxProcessPolicy;
              if (resolver === undefined) {
                sandboxPolicyResolutionLoaded = true;
                return Effect.succeed(undefined);
              }
              return resolver({ now }).pipe(
                Effect.catch(() => Effect.succeed(undefined)),
                Effect.tap((resolved) =>
                  Effect.sync(() => {
                    sandboxPolicyResolution = resolved;
                    sandboxPolicyResolutionLoaded = true;
                  }),
                ),
              );
            });
          const resolveReplaySandboxPolicy =
            context.resolveSandboxProcessPolicy === undefined
              ? undefined
              : resolveSandboxPolicyOnce;
          const probeReconciliation = (
            boundary:
              | "AH7BeforeReconciliationFactCommit"
              | "AH7AfterReconciliationFactCommit"
              | "AH7ReconciliationResultFenceRejected",
            input: {
              readonly attemptNo: 0 | 1;
              readonly outcomeTag: "NotOccurred" | "Occurred" | "StillUnknown";
              readonly factId?: string;
            },
          ) =>
            options.qualificationProbe === undefined
              ? Effect.void
              : Effect.promise(
                  () =>
                    options.qualificationProbe?.({
                      boundary,
                      executionId: context.executionId,
                      invocationId: intent.invocationId,
                      callRef: intent.callRef,
                      attemptNo: input.attemptNo,
                      outcomeTag: input.outcomeTag,
                      ...(input.factId === undefined
                        ? {}
                        : { factId: input.factId }),
                    }) ?? Promise.resolve(),
                );
          const completeFence = hasCompleteExecutionFence(
            context.executionFence,
          );
          if (
            !completeFence ||
            context.executionFence.executionId !== context.executionId
          ) {
            return yield* Effect.fail<ToolRuntimeError>(
              operationalFailure(
                "IntentJournal",
                String(intent.invocationId),
              )({
                _tag: completeFence
                  ? "ExecutionFenceExecutionMismatch"
                  : "ExecutionFenceUnavailable",
              }),
            );
          }
          const definitionOption = yield* definitions.definition(
            intent.toolName,
            intent.toolVersion,
          );
          if (Option.isNone(definitionOption)) {
            return denied("InvocationAuthorityDenied");
          }
          const definition = definitionOption.value;
          const trustedProfile =
            definition.sideEffectSemantics === "Reconcilable" &&
            Option.isSome(reconciliationProfiles)
              ? reconciliationProfiles.value.resolve({
                  toolName: definition.name,
                  toolVersion: definition.version,
                  toolDefinitionHash: definition.hash,
                })
              : undefined;
          let trustedEffectKey: string | null = null;
          if (trustedProfile !== undefined) {
            try {
              trustedEffectKey = trustedProfile.effectKey({
                invocationId: intent.invocationId,
                argumentsJson: intent.argumentsJson,
              });
            } catch {
              trustedEffectKey = null;
            }
            if (
              typeof trustedEffectKey !== "string" ||
              trustedEffectKey.trim().length === 0
            ) {
              return yield* Effect.fail<ToolRuntimeError>(
                operationalFailure(
                  "RecoveryBinding",
                  String(intent.invocationId),
                )({ _tag: "ReconciliationEffectIdentityUnavailable" }),
              );
            }
          }
          const executor = executors.find(
            (entry) => entry.name === intent.toolName,
          );
          if (executor === undefined) {
            return denied("InvocationAuthorityDenied");
          }
          if (
            executor.processCapability === "SandboxProcess" &&
            processModeBlocksSpawn &&
            !testOnlyAllowTrustedLocalProcessExecution &&
            !isIndependentVerificationExecution(context)
          ) {
            const durableInvocation = yield* tx
              .transact(store.findById(intent.invocationId))
              .pipe(
                Effect.mapError(
                  operationalFailure(
                    "IntentJournal",
                    String(intent.invocationId),
                  ),
                ),
              );
            if (Option.isNone(durableInvocation)) {
              return denied(processUnavailableReason);
            }
          }
          const p39BindingEnabled = Option.isSome(p39Recovery);
          if (
            p39BindingEnabled &&
            (!recoveryBindingIdentityMatches({
              identity: context.recoveryBindingIdentity,
              executionId: context.executionId,
              invocationId: intent.invocationId,
              callRef: intent.callRef,
              ...(context.executableApproval === undefined
                ? {}
                : { approvalBinding: context.executableApproval.binding }),
            }) ||
              context.recoveryBindingPolicyRevisions === undefined ||
              !Number.isSafeInteger(
                context.recoveryBindingPolicyRevisions.workspacePolicyRevision,
              ) ||
              context.recoveryBindingPolicyRevisions.workspacePolicyRevision <
                0 ||
              !Number.isSafeInteger(
                context.recoveryBindingPolicyRevisions.projectPolicyRevision,
              ) ||
              context.recoveryBindingPolicyRevisions.projectPolicyRevision <
                0 ||
              Option.isNone(environmentRevisions) ||
              Option.isNone(workspaces))
          ) {
            return yield* Effect.fail<ToolRuntimeError>(
              operationalFailure(
                "RecoveryBinding",
                String(intent.invocationId),
              )({ _tag: "RecoveryBindingSourceUnavailable" }),
            );
          }
          const refreshAfterStale = (
            cause: unknown,
          ): Effect.Effect<CanonicalToolObservation, ToolRuntimeError> =>
            staleRefreshCount === 0
              ? invoke(intent, context, staleRefreshCount + 1)
              : Effect.fail<ToolRuntimeError>(
                  operationalFailure(
                    "ResourceResolutionStale",
                    String(intent.invocationId),
                  )(cause),
                );

          const validation = validateToolInput(
            definition.inputSchemaJson,
            intent.argumentsJson,
          );
          if (validation._tag === "Invalid") {
            return {
              _tag: "ExpectedFailure" as const,
              observation: bounded(validation.reason),
            };
          }

          if (p39BindingEnabled && Option.isSome(p39Recovery)) {
            const priorDenial = yield* tx
              .transact(store.findById(intent.invocationId))
              .pipe(
                Effect.mapError(
                  operationalFailure(
                    "IntentJournal",
                    String(intent.invocationId),
                  ),
                ),
              );
            if (
              Option.isSome(priorDenial) &&
              priorDenial.value.settlement?._tag === "Denied" &&
              priorDenial.value.settledAt !== null &&
              priorDenial.value.effectAdmissionState === "NotAdmitted" &&
              priorDenial.value.resultRef === null &&
              priorDenial.value.executionId === context.executionId &&
              priorDenial.value.workspaceId === context.workspaceId &&
              priorDenial.value.toolName === intent.toolName &&
              priorDenial.value.toolVersion === intent.toolVersion &&
              priorDenial.value.sideEffectSemantics ===
                definition.sideEffectSemantics &&
              priorDenial.value.argumentsJson === intent.argumentsJson &&
              priorDenial.value.approvalId ===
                (context.executableApproval?.approvalId ?? intent.approvalId)
            ) {
              const unboundDenial = yield* tx
                .transact(
                  p39Recovery.value.findTerminalUnboundDenial(
                    intent.invocationId,
                  ),
                )
                .pipe(
                  Effect.mapError(
                    operationalFailure(
                      "RecoveryBinding",
                      String(intent.invocationId),
                    ),
                  ),
                );
              if (Option.isSome(unboundDenial)) {
                return denied(priorDenial.value.settlement.reasonCode);
              }
            }
          }

          const now = options.now ?? (yield* clock.now());
          const persistNoEffectInterruption = (
            invocation: ToolInvocationIntent | undefined,
            settledAt: string,
          ): Effect.Effect<CanonicalToolObservation, ToolRuntimeError> =>
            Effect.gen(function* () {
              const failure = operationalFailure(
                "IntentJournal",
                String(intent.invocationId),
              );
              const current = yield* findInvocationFenced(
                intent.invocationId,
                context,
                "IntentJournal",
              );
              if (Option.isNone(current))
                return { _tag: "Interrupted" as const };
              const currentRecord = current.value;
              if (currentRecord.settlement !== null) {
                if (currentRecord.settlement._tag === "Denied") {
                  return denied(currentRecord.settlement.reasonCode);
                }
                if (currentRecord.settlement._tag === "Interrupted") {
                  return Option.isSome(observationEvidence)
                    ? yield* decodeRecordedEvidence(
                        intent,
                        context,
                        currentRecord,
                        resolveReplaySandboxPolicy,
                      )
                    : { _tag: "Interrupted" as const };
                }
                if (Option.isSome(observationEvidence)) {
                  return yield* decodeRecordedEvidence(
                    intent,
                    context,
                    currentRecord,
                    resolveReplaySandboxPolicy,
                  );
                }
                return {
                  _tag: "OutcomeUnknown" as const,
                  reconciliationRefs: [String(intent.invocationId)],
                };
              }
              if (currentRecord.effectAdmissionState !== "NotAdmitted") {
                return {
                  _tag: "OutcomeUnknown" as const,
                  reconciliationRefs: [String(intent.invocationId)],
                };
              }
              if (
                Option.isSome(observationEvidence) &&
                invocation !== undefined
              ) {
                const winner = yield* tx
                  .transact(
                    observationEvidence.value.settleOrReadWinner({
                      invocation,
                      settlement: { _tag: "Interrupted" },
                      resultRef: null,
                      observation: { _tag: "Interrupted" },
                      settledAt,
                      executionFence: context.executionFence,
                      fenceNow: settledAt,
                    }),
                  )
                  .pipe(Effect.mapError(failure));
                if (winner._tag === "Applied") {
                  return { _tag: "Interrupted" as const };
                }
                if (winner._tag === "ExistingDenied") {
                  return denied(winner.reasonCode);
                }
                const committed = yield* findInvocationFenced(
                  intent.invocationId,
                  context,
                  "IntentJournal",
                );
                if (Option.isSome(committed)) {
                  if (committed.value.settlement?._tag === "Denied") {
                    return denied(committed.value.settlement.reasonCode);
                  }
                  if (committed.value.settlement !== null) {
                    return yield* decodeRecordedEvidence(
                      intent,
                      context,
                      committed.value,
                      resolveReplaySandboxPolicy,
                    );
                  }
                }
                return yield* Effect.fail<ToolRuntimeError>(
                  failure({
                    _tag: "NoEffectInterruptionWinnerMissing",
                  }),
                );
              }
              const interrupted = yield* tx
                .transact(
                  store.recordNoEffectInterruption(
                    intent.invocationId,
                    settledAt,
                    context.executionFence,
                    settledAt,
                  ),
                )
                .pipe(Effect.mapError(failure));
              if (interrupted) return { _tag: "Interrupted" as const };
              const winner = yield* findInvocationFenced(
                intent.invocationId,
                context,
                "IntentJournal",
              );
              if (Option.isNone(winner))
                return { _tag: "Interrupted" as const };
              if (winner.value.settlement?._tag === "Denied") {
                return denied(winner.value.settlement.reasonCode);
              }
              if (
                winner.value.settlement?._tag === "Interrupted" &&
                Option.isNone(observationEvidence)
              ) {
                return { _tag: "Interrupted" as const };
              }
              if (
                winner.value.settlement !== null &&
                Option.isSome(observationEvidence)
              ) {
                return yield* decodeRecordedEvidence(
                  intent,
                  context,
                  winner.value,
                  resolveReplaySandboxPolicy,
                );
              }
              if (winner.value.effectAdmissionState !== "NotAdmitted") {
                return {
                  _tag: "OutcomeUnknown" as const,
                  reconciliationRefs: [String(intent.invocationId)],
                };
              }
              return { _tag: "Interrupted" as const };
            });
          const recordNoEffectDenial = (
            sideEffectSemantics: ToolDefinition["sideEffectSemantics"],
            resolvedRegions: ReadonlyArray<CanonicalResourceRegion>,
            reasonCode: NoEffectDenialCode,
            nativeProcessModeDenial = false,
          ) =>
            Effect.gen(function* () {
              const settledAt = yield* clock.now();
              const current = yield* findInvocationFenced(
                intent.invocationId,
                context,
                "IntentJournal",
              );
              if (Option.isSome(current)) {
                const record = current.value;
                const exact =
                  record.executionId === context.executionId &&
                  record.workspaceId === context.workspaceId &&
                  record.toolName === intent.toolName &&
                  record.toolVersion === intent.toolVersion &&
                  record.sideEffectSemantics === sideEffectSemantics &&
                  record.argumentsJson === intent.argumentsJson &&
                  JSON.stringify(record.resolvedRegions) ===
                    JSON.stringify(resolvedRegions) &&
                  record.approvalId === intent.approvalId;
                if (exact && record.settlement !== null) {
                  if (record.settlement._tag === "Denied") {
                    return denied(record.settlement.reasonCode);
                  }
                  if (
                    record.settlement._tag === "Interrupted" &&
                    Option.isNone(observationEvidence)
                  ) {
                    return { _tag: "Interrupted" as const };
                  }
                  if (Option.isSome(observationEvidence)) {
                    return yield* decodeRecordedEvidence(
                      intent,
                      context,
                      record,
                      resolveReplaySandboxPolicy,
                    );
                  }
                  if (
                    record.settlement._tag === "Success" &&
                    record.resultRef !== null &&
                    Option.isSome(artifactService)
                  ) {
                    let artifactId: ArtifactId;
                    try {
                      artifactId = parse(ArtifactId)(record.resultRef);
                    } catch {
                      return {
                        _tag: "OutcomeUnknown" as const,
                        reconciliationRefs: [String(intent.invocationId)],
                      };
                    }
                    const bytes = yield* tx
                      .transact(artifactService.value.load(artifactId))
                      .pipe(
                        Effect.mapError(
                          operationalFailure(
                            "SettlementJournal",
                            String(intent.invocationId),
                          ),
                        ),
                      );
                    if (Option.isSome(bytes)) {
                      return {
                        _tag: "Success" as const,
                        observation: bounded(
                          new TextDecoder().decode(bytes.value),
                        ),
                        resultRef: record.resultRef,
                      };
                    }
                  }
                  return {
                    _tag: "OutcomeUnknown" as const,
                    reconciliationRefs: [String(intent.invocationId)],
                  };
                }
                if (exact && record.effectAdmissionState !== "NotAdmitted") {
                  return {
                    _tag: "OutcomeUnknown" as const,
                    reconciliationRefs: [String(intent.invocationId)],
                  };
                }
              }
              const recorded = yield* tx
                .transact(
                  Effect.gen(function* () {
                    const winner = yield* store.recordNoEffectDenial(
                      {
                        invocationId: intent.invocationId,
                        executionId: context.executionId,
                        workspaceId: context.workspaceId,
                        toolName: intent.toolName,
                        toolVersion: intent.toolVersion,
                        sideEffectSemantics,
                        argumentsJson: intent.argumentsJson,
                        resolvedRegions,
                        approvalId:
                          context.executableApproval?.approvalId ??
                          intent.approvalId,
                        intentAt: Option.isSome(current)
                          ? current.value.intentAt
                          : now,
                      },
                      reasonCode,
                      settledAt,
                      context.executionFence,
                      settledAt,
                      nativeProcessModeDenial
                        ? context.recoveryBindingIdentity
                        : undefined,
                    );
                    if (
                      nativeProcessModeDenial &&
                      winner !== "ExecutionStopping" &&
                      options.qualificationProbe !== undefined
                    ) {
                      yield* Effect.promise(
                        () =>
                          options.qualificationProbe?.({
                            boundary: "NativeProcessModeDenialBeforeCommit",
                            executionId: context.executionId,
                            invocationId: intent.invocationId,
                            callRef: intent.callRef,
                            logicalActionId:
                              context.recoveryBindingIdentity?.logicalActionId,
                            denialReasonCode: reasonCode,
                          }) ?? Promise.resolve(),
                      );
                    }
                    return winner;
                  }),
                )
                .pipe(
                  Effect.mapError(
                    operationalFailure(
                      "IntentJournal",
                      String(intent.invocationId),
                    ),
                  ),
                );
              if (
                nativeProcessModeDenial &&
                recorded !== "ExecutionStopping" &&
                options.qualificationProbe !== undefined
              ) {
                yield* Effect.promise(
                  () =>
                    options.qualificationProbe?.({
                      boundary: "NativeProcessModeDenialAfterCommit",
                      executionId: context.executionId,
                      invocationId: intent.invocationId,
                      callRef: intent.callRef,
                      logicalActionId:
                        context.recoveryBindingIdentity?.logicalActionId,
                      denialReasonCode: reasonCode,
                    }) ?? Promise.resolve(),
                );
              }
              if (recorded === "ExecutionStopping") {
                return yield* persistNoEffectInterruption(
                  Option.isSome(current)
                    ? {
                        invocationId: intent.invocationId,
                        executionId: context.executionId,
                        workspaceId: context.workspaceId,
                        toolName: intent.toolName,
                        toolVersion: intent.toolVersion,
                        sideEffectSemantics,
                        argumentsJson: intent.argumentsJson,
                        resolvedRegions,
                        approvalId:
                          context.executableApproval?.approvalId ??
                          intent.approvalId,
                        intentAt: current.value.intentAt,
                      }
                    : undefined,
                  settledAt,
                );
              }
              return denied(
                recorded.settlement?._tag === "Denied"
                  ? recorded.settlement.reasonCode
                  : reasonCode,
              );
            });
          const prior = yield* findInvocationFenced(
            intent.invocationId,
            context,
            "IntentJournal",
          );
          const priorRecord = Option.isSome(prior) ? prior.value : undefined;
          const priorModelIdentityMatches =
            priorRecord !== undefined &&
            priorRecord.invocationId === intent.invocationId &&
            priorRecord.executionId === context.executionId &&
            priorRecord.workspaceId === context.workspaceId &&
            priorRecord.toolName === intent.toolName &&
            priorRecord.toolVersion === intent.toolVersion &&
            priorRecord.sideEffectSemantics ===
              definition.sideEffectSemantics &&
            priorRecord.argumentsJson === intent.argumentsJson &&
            priorRecord.approvalId === intent.approvalId &&
            (context.executableApproval === undefined ||
              context.executableApproval.approvalId === priorRecord.approvalId);
          if (priorRecord !== undefined && !priorModelIdentityMatches) {
            return yield* Effect.fail<ToolRuntimeError>(
              operationalFailure(
                "IntentJournal",
                String(intent.invocationId),
              )({ _tag: "ToolInvocationIdentityConflict" }),
            );
          }
          const terminalP39ReceiptCandidate =
            priorRecord !== undefined &&
            priorModelIdentityMatches &&
            priorRecord.settlement !== null &&
            priorRecord.sideEffectSemantics === "Reconcilable" &&
            priorRecord.effectAdmissionState === "MayHaveStarted" &&
            definition.sideEffectSemantics === "Reconcilable" &&
            trustedProfile !== undefined &&
            trustedEffectKey !== null &&
            Option.isSome(p39Recovery) &&
            Option.isSome(p39RecoveryEvidence) &&
            Option.isSome(observationEvidence) &&
            priorRecord.approvalId === intent.approvalId &&
            (context.executableApproval === undefined ||
              context.executableApproval.approvalId === priorRecord.approvalId);
          if (terminalP39ReceiptCandidate && priorRecord !== undefined) {
            const receipt = yield* decodeRecordedEvidenceResult(
              intent,
              context,
              priorRecord,
              {
                allowMissingSelected: true,
                definition,
                profile: trustedProfile,
                effectKey: trustedEffectKey as string,
              },
              resolveReplaySandboxPolicy,
            );
            if (receipt._tag !== "NotP39Receipt") return receipt;
          }
          const exactReconcilableReplayCandidate =
            priorModelIdentityMatches &&
            priorRecord.settlement === null &&
            priorRecord.effectAdmissionState === "MayHaveStarted" &&
            priorRecord.sideEffectSemantics === "Reconcilable" &&
            definition.sideEffectSemantics === "Reconcilable" &&
            trustedProfile !== undefined &&
            Option.isSome(p39Recovery) &&
            Option.isSome(reconciliationPort) &&
            Option.isSome(reconciliationFacts) &&
            Option.isSome(observationEvidence);
          let verifiedReplayBinding:
            | import("@arbor/ports").VerifiedRecoveryBindingV1
            | undefined;
          if (exactReconcilableReplayCandidate && priorRecord !== undefined) {
            const identity = context.recoveryBindingIdentity;
            if (Option.isNone(p39Recovery)) {
              return yield* Effect.fail<ToolRuntimeError>(
                operationalFailure(
                  "RecoveryBinding",
                  String(intent.invocationId),
                )({ _tag: "P39RecoveryEvidenceStoreUnavailable" }),
              );
            }
            const stored = yield* tx
              .transact(
                Effect.gen(function* () {
                  yield* observationEvidence.value.assertCurrentFence(
                    context.executionFence,
                    yield* clock.now(),
                  );
                  const binding = yield* p39Recovery.value.findBinding(
                    intent.invocationId,
                  );
                  const attempt = yield* p39Recovery.value.findLatestAttempt(
                    intent.invocationId,
                  );
                  return { binding, attempt };
                }),
              )
              .pipe(
                Effect.mapError(
                  operationalFailure(
                    "RecoveryBinding",
                    String(intent.invocationId),
                  ),
                ),
              );
            if (
              Option.isNone(stored.binding) ||
              Option.isNone(stored.attempt)
            ) {
              return yield* Effect.fail<ToolRuntimeError>(
                operationalFailure(
                  "RecoveryBinding",
                  String(intent.invocationId),
                )({ _tag: "RecoveryBindingReplayMismatch" }),
              );
            }
            const bound = stored.binding.value;
            const verified = verifyRecoveryBindingV1({
              invocationId: intent.invocationId,
              canonicalJson: bound.canonicalJson,
              bindingSha256: bound.bindingSha256,
            });
            const binding = verified?.value;
            const expectedArgumentsDigest = (() => {
              try {
                return canonicalArgumentsDigestV1(
                  JSON.parse(intent.argumentsJson),
                );
              } catch {
                return null;
              }
            })();
            const attempt = stored.attempt.value;
            const bindingMatchesIdentity =
              identity !== undefined &&
              binding !== undefined &&
              binding.executionId === context.executionId &&
              binding.invocationId === intent.invocationId &&
              binding.providerTurnId === identity.providerTurnId &&
              binding.logicalStepNo === identity.logicalStepNo &&
              binding.repairAttempt === identity.repairAttempt &&
              binding.logicalActionId === identity.logicalActionId &&
              binding.actionIndex === identity.actionIndex &&
              binding.callRef === intent.callRef &&
              binding.toolName === intent.toolName &&
              binding.toolVersion === intent.toolVersion &&
              binding.toolDefinitionHash ===
                recoveryBindingToolDefinitionHashV1(definition) &&
              binding.sideEffectSemantics === "Reconcilable" &&
              binding.canonicalArgumentsDigest === expectedArgumentsDigest &&
              binding.targetResourceIdentityDigest ===
                targetResourceIdentityDigestV1(priorRecord.resolvedRegions) &&
              binding.approvalId === priorRecord.approvalId &&
              binding.approvalId ===
                (context.executableApproval?.approvalId ?? intent.approvalId) &&
              (binding.approvalId === null ||
                binding.approvalConsumedBy === intent.invocationId) &&
              attempt.invocationId === intent.invocationId &&
              attempt.admissionState === "MayHaveStarted" &&
              attempt.sideEffectSemantics === "Reconcilable" &&
              attempt.bindingSha256 === bound.bindingSha256 &&
              attempt.toolDefinitionHash === binding.toolDefinitionHash &&
              binding.profileId === attempt.profileId &&
              binding.profileVersion === attempt.profileVersion &&
              binding.profileHash === attempt.profileHash &&
              binding.profileProtocol === attempt.profileProtocol &&
              binding.effectKey === attempt.effectKey;
            if (verified === null || !bindingMatchesIdentity) {
              return yield* Effect.fail<ToolRuntimeError>(
                operationalFailure(
                  "RecoveryBinding",
                  String(intent.invocationId),
                )({ _tag: "RecoveryBindingReplayMismatch" }),
              );
            }
            const currentProfileMatchesPersistedAttempt =
              trustedProfile !== undefined &&
              trustedEffectKey !== null &&
              binding.profileId === trustedProfile.profileId &&
              binding.profileVersion === trustedProfile.profileVersion &&
              binding.profileHash === trustedProfile.profileHash &&
              binding.profileProtocol === trustedProfile.profileProtocol &&
              binding.effectKey === trustedEffectKey &&
              attempt.profileId === trustedProfile.profileId &&
              attempt.profileVersion === trustedProfile.profileVersion &&
              attempt.profileHash === trustedProfile.profileHash &&
              attempt.profileProtocol === trustedProfile.profileProtocol &&
              attempt.effectKey === trustedEffectKey;
            if (!currentProfileMatchesPersistedAttempt) {
              return {
                _tag: "OutcomeUnknown" as const,
                reconciliationRefs: [String(intent.invocationId)],
              };
            }
            verifiedReplayBinding = verified;
          }
          const mountRefs = requestedMountRefs(intent.argumentsJson);
          let address: FilesystemAddress | undefined;
          let addresses: ReadonlyArray<ResourceAddress>;
          let boundaryWorkspace: Workspace | undefined;
          if (mountRefs.length > 0) {
            if (
              mountRefs.length !== 1 ||
              mountRefs.some((mount) => mount !== "workspace")
            ) {
              return yield* recordNoEffectDenial(
                definition.sideEffectSemantics,
                [],
                "ResourceResolutionDenied",
              );
            }
            if (Option.isNone(workspaces)) {
              return yield* recordNoEffectDenial(
                definition.sideEffectSemantics,
                [],
                "ResourceResolutionDenied",
              );
            }
            const workspace = yield* tx
              .transact(workspaces.value.findById(context.workspaceId))
              .pipe(
                Effect.mapError(
                  operationalFailure(
                    "WorkspaceLookup",
                    String(intent.invocationId),
                  ),
                ),
              );
            if (Option.isNone(workspace)) {
              return yield* recordNoEffectDenial(
                definition.sideEffectSemantics,
                [],
                "ResourceResolutionDenied",
              );
            }
            boundaryWorkspace = workspace.value;
            address = primaryFilesystemAddress(
              workspace.value.resourceBoundary.addresses,
            );
            if (address === undefined) {
              return yield* recordNoEffectDenial(
                definition.sideEffectSemantics,
                [],
                "ResourceResolutionDenied",
              );
            }
            const exactTarget =
              executor.processCapability !== "SandboxProcess" &&
              ["read", "list", "patch", "write", "glob", "grep"].includes(
                intent.toolName,
              )
                ? requestedFilesystemTarget(intent.argumentsJson, address)
                : ({ _tag: "Absent" } as const);
            if (exactTarget._tag === "Invalid") {
              return yield* recordNoEffectDenial(
                definition.sideEffectSemantics,
                [],
                "ResourceResolutionDenied",
              );
            }
            addresses = [
              exactTarget._tag === "Address" ? exactTarget.address : address,
            ];
          } else {
            addresses = legacyResourceArguments(intent.argumentsJson);
          }
          if (boundaryWorkspace === undefined) {
            if (Option.isNone(workspaces)) {
              return yield* recordNoEffectDenial(
                definition.sideEffectSemantics,
                [],
                "ResourceResolutionDenied",
              );
            }
            const workspace = yield* tx
              .transact(workspaces.value.findById(context.workspaceId))
              .pipe(
                Effect.mapError(
                  operationalFailure(
                    "WorkspaceLookup",
                    String(intent.invocationId),
                  ),
                ),
              );
            if (
              Option.isNone(workspace) ||
              workspace.value.projectId !== context.projectId
            ) {
              return yield* recordNoEffectDenial(
                definition.sideEffectSemantics,
                [],
                "ResourceResolutionDenied",
              );
            }
            boundaryWorkspace = workspace.value;
          }
          const capturedWorkspace = boundaryWorkspace;
          if (capturedWorkspace.projectId !== context.projectId) {
            return yield* recordNoEffectDenial(
              definition.sideEffectSemantics,
              [],
              "ResourceResolutionDenied",
            );
          }
          const resolved = yield* environment
            .resolve(context.projectId, addresses)
            .pipe(
              Effect.mapError(
                operationalFailure(
                  "EnvironmentResolution",
                  String(intent.invocationId),
                ),
              ),
            );
          const resolvedBoundary = yield* environment
            .resolve(
              context.projectId,
              capturedWorkspace.resourceBoundary.addresses,
            )
            .pipe(
              Effect.mapError(
                operationalFailure(
                  "EnvironmentResolution",
                  String(intent.invocationId),
                ),
              ),
            );
          if (
            resolved.observedEnvironmentRevision !==
            resolvedBoundary.observedEnvironmentRevision
          ) {
            return yield* refreshAfterStale({
              _tag: "ResourceResolutionStale",
              observed: resolved.observedEnvironmentRevision,
              boundaryObserved: resolvedBoundary.observedEnvironmentRevision,
            });
          }
          const regions =
            priorModelIdentityMatches &&
            priorRecord !== undefined &&
            ((priorRecord.settlement === null &&
              priorRecord.effectAdmissionState === "NotAdmitted") ||
              priorRecord.settlement?._tag === "Interrupted")
              ? priorRecord.resolvedRegions
              : resolved.regions;
          const boundaryRegions = resolvedBoundary.regions;
          const validateCapturedSnapshot = () =>
            Effect.gen(function* () {
              if (Option.isNone(workspaces)) {
                return yield* Effect.fail(P39_RESOURCE_RESOLUTION_STALE);
              }
              const currentWorkspace = yield* workspaces.value.findById(
                context.workspaceId,
              );
              if (
                Option.isNone(currentWorkspace) ||
                currentWorkspace.value.projectId !== context.projectId ||
                currentWorkspace.value.resourceBoundaryRevision !==
                  capturedWorkspace.resourceBoundaryRevision ||
                JSON.stringify(
                  currentWorkspace.value.resourceBoundary.addresses,
                ) !==
                  JSON.stringify(capturedWorkspace.resourceBoundary.addresses)
              ) {
                return yield* Effect.fail(P39_RESOURCE_RESOLUTION_STALE);
              }
              if (p39BindingEnabled) {
                if (Option.isNone(environmentRevisions)) {
                  return yield* Effect.fail<ToolRuntimeError>(
                    operationalFailure(
                      "RecoveryBinding",
                      String(intent.invocationId),
                    )({ _tag: "EnvironmentRevisionStoreUnavailable" }),
                  );
                }
                const currentEnvironment = yield* environmentRevisions.value
                  .current(context.projectId)
                  .pipe(
                    Effect.mapError(
                      operationalFailure(
                        "RecoveryBinding",
                        String(intent.invocationId),
                      ),
                    ),
                  );
                if (
                  (Option.isSome(currentEnvironment) &&
                    currentEnvironment.value !==
                      resolved.observedEnvironmentRevision) ||
                  (Option.isNone(currentEnvironment) &&
                    resolved.observedEnvironmentRevision !== "0")
                ) {
                  return yield* Effect.fail(P39_RESOURCE_RESOLUTION_STALE);
                }
              }
              return undefined;
            });
          const validateCapturedSnapshotAndAdmit = () =>
            Effect.gen(function* () {
              yield* validateCapturedSnapshot();
              return yield* admission.admit({
                workspaceId: context.workspaceId,
                regions,
                resolvedBoundaryRegions: boundaryRegions,
                write: executor.write,
              });
            });
          const checkCapturedSnapshotAndAdmit = () =>
            tx
              .transact(validateCapturedSnapshotAndAdmit())
              .pipe(
                Effect.mapError((cause) =>
                  isP39ResourceResolutionStale(cause)
                    ? cause
                    : operationalFailure(
                        "ResourceAdmission",
                        String(intent.invocationId),
                      )(cause),
                ),
              );
          const region = regions[0];
          if (
            address !== undefined &&
            (region === undefined || regions.length !== 1) &&
            verifiedReplayBinding === undefined
          ) {
            return yield* recordNoEffectDenial(
              definition.sideEffectSemantics,
              [],
              "ResourceResolutionDenied",
            );
          }

          const resolvedAuthorityFromCurrent = Option.isSome(authorityResolver)
            ? yield* authorityResolver.value
                .resolve({
                  intent,
                  definition,
                  context,
                  regions,
                  now,
                })
                .pipe(
                  Effect.catchTag("ToolAuthorityDenied", () =>
                    Effect.succeed(undefined),
                  ),
                  Effect.mapError(
                    operationalFailure(
                      "AuthorityResolution",
                      String(intent.invocationId),
                    ),
                  ),
                )
            : context.authority;
          if (
            resolvedAuthorityFromCurrent === undefined &&
            verifiedReplayBinding === undefined
          ) {
            return yield* recordNoEffectDenial(
              definition.sideEffectSemantics,
              regions,
              "InvocationAuthorityDenied",
            );
          }
          const resolvedAuthority =
            resolvedAuthorityFromCurrent ??
            context.authority ??
            ({
              principal: context.authenticatedPrincipal,
              workspaceId: context.workspaceId,
              executionId: context.executionId,
              toolName: intent.toolName,
              toolVersion: intent.toolVersion,
              resourceSpaceIds: regions.map((item) => item.resourceSpaceId),
              allowedCapabilities: definition.capabilityMetadata,
              controlBasisDigest: context.controlBasisDigest,
              expiresAt: context.requestedAt,
              delegationDepth: context.delegationDepth ?? 0,
            } as NonNullable<ToolExecutionContext["authority"]>);
          const authority = checkInvocationAuthority({
            authority: resolvedAuthority,
            definition,
            intent,
            context,
            regions,
            now,
            maxDelegationDepth: options.maxDelegationDepth ?? 1,
          });
          if (
            authority._tag === "Denied" &&
            verifiedReplayBinding === undefined
          ) {
            return yield* recordNoEffectDenial(
              definition.sideEffectSemantics,
              regions,
              "InvocationAuthorityDenied",
            );
          }

          const needsApproval = executor.requiresApproval(intent);
          let approvalAlreadyConsumedBySelf = false;
          let currentApprovalRecord: ExecutableApprovalRecord | undefined;
          if (verifiedReplayBinding !== undefined) {
            approvalAlreadyConsumedBySelf = needsApproval;
          }
          if (
            verifiedReplayBinding === undefined &&
            !needsApproval &&
            context.executableApproval !== undefined
          ) {
            return yield* recordNoEffectDenial(
              definition.sideEffectSemantics,
              regions,
              "ApprovalMismatch",
            );
          }
          if (verifiedReplayBinding === undefined && needsApproval) {
            if (context.executableApproval === undefined) {
              const legacyApprovalId = intent.approvalId;
              if (p39BindingEnabled && legacyApprovalId !== null) {
                return yield* recordNoEffectDenial(
                  definition.sideEffectSemantics,
                  regions,
                  "ApprovalMismatch",
                );
              }
              if (legacyApprovalId === null) {
                return {
                  _tag: "ApprovalRequired" as const,
                  authority: resolvedAuthority,
                  targetResourceSpaceIds: regions.map(
                    (region) => region.resourceSpaceId,
                  ),
                  actionDigest: actionDigestOf(intent),
                  requestedCapabilities: definition.capabilityMetadata,
                  sideEffectSemantics: definition.sideEffectSemantics,
                  controlBasisDigest: context.controlBasisDigest,
                };
              }
              const legacyApproval = yield* tx
                .transact(store.findApproval(legacyApprovalId))
                .pipe(
                  Effect.mapError(
                    operationalFailure(
                      "ApprovalLookup",
                      String(intent.invocationId),
                    ),
                  ),
                );
              if (Option.isNone(legacyApproval)) {
                return yield* recordNoEffectDenial(
                  definition.sideEffectSemantics,
                  regions,
                  "ApprovalNotFound",
                );
              }
              if (legacyApproval.value.consumedBy === intent.invocationId) {
                const priorInvocation = yield* tx
                  .transact(store.findById(intent.invocationId))
                  .pipe(
                    Effect.mapError(
                      operationalFailure(
                        "ApprovalLookup",
                        String(intent.invocationId),
                      ),
                    ),
                  );
                if (Option.isNone(priorInvocation)) {
                  return yield* recordNoEffectDenial(
                    definition.sideEffectSemantics,
                    regions,
                    "ApprovalConsumedByOtherInvocation",
                  );
                }
                approvalAlreadyConsumedBySelf = true;
              }
              const matched = matchApproval({
                approval: legacyApproval.value,
                intent,
                definition,
                context,
                regions,
                now,
                replayOfRecordedInvocation: approvalAlreadyConsumedBySelf,
              });
              if (matched._tag === "Denied") {
                return yield* recordNoEffectDenial(
                  definition.sideEffectSemantics,
                  regions,
                  approvalDenialCode(matched.reason),
                );
              }
            } else {
              if (intent.approvalId !== context.executableApproval.approvalId) {
                return yield* recordNoEffectDenial(
                  definition.sideEffectSemantics,
                  regions,
                  "ApprovalMismatch",
                );
              }
              if (Option.isNone(executableApprovals)) {
                return yield* Effect.fail(
                  operationalFailure(
                    "ApprovalLookup",
                    String(intent.invocationId),
                  )({
                    _tag: "ExecutableApprovalStoreUnavailable",
                  }),
                );
              }
              const exactExecutableApproval = yield* tx
                .transact(
                  executableApprovals.value.findById(
                    context.executableApproval.approvalId,
                  ),
                )
                .pipe(
                  Effect.mapError(
                    operationalFailure(
                      "ApprovalLookup",
                      String(intent.invocationId),
                    ),
                  ),
                );
              if (Option.isSome(exactExecutableApproval)) {
                const currentApproval = exactExecutableApproval.value;
                currentApprovalRecord = currentApproval;
                if (currentApproval.state === "Pending") {
                  if (
                    context.executableApproval.state !== "Pending" ||
                    currentApproval.revision !==
                      context.executableApproval.expectedRevision ||
                    !executableApprovalBindingMatches(
                      currentApproval,
                      context.executableApproval.binding,
                    )
                  ) {
                    return yield* recordNoEffectDenial(
                      definition.sideEffectSemantics,
                      regions,
                      "ApprovalMismatch",
                    );
                  }
                  return {
                    _tag: "ApprovalRequired" as const,
                    authority: resolvedAuthority,
                    targetResourceSpaceIds: regions.map(
                      (region) => region.resourceSpaceId,
                    ),
                    actionDigest: actionDigestOf(intent),
                    requestedCapabilities: definition.capabilityMetadata,
                    sideEffectSemantics: definition.sideEffectSemantics,
                    controlBasisDigest: context.controlBasisDigest,
                  };
                }
                if (currentApproval.state === "Cancelled") {
                  return { _tag: "Interrupted" as const };
                }
                const terminalDenial = executableApprovalTerminalDenial(
                  currentApproval,
                  now,
                );
                if (terminalDenial !== null) {
                  return yield* recordNoEffectDenial(
                    definition.sideEffectSemantics,
                    regions,
                    terminalDenial,
                  );
                }
                if (
                  currentApproval.state === "Consumed" &&
                  currentApproval.consumedBy === intent.invocationId
                ) {
                  const priorInvocation = yield* tx
                    .transact(store.findById(intent.invocationId))
                    .pipe(
                      Effect.mapError(
                        operationalFailure(
                          "ApprovalLookup",
                          String(intent.invocationId),
                        ),
                      ),
                    );
                  if (Option.isSome(priorInvocation)) {
                    approvalAlreadyConsumedBySelf = true;
                  }
                }
              }
              if (
                Option.isNone(exactExecutableApproval) ||
                exactExecutableApproval.value.routeKind !== "Executable" ||
                (exactExecutableApproval.value.state !==
                  context.executableApproval.state &&
                  !approvalAlreadyConsumedBySelf) ||
                !(
                  (exactExecutableApproval.value.state === "Approved" &&
                    exactExecutableApproval.value.revision ===
                      context.executableApproval.expectedRevision) ||
                  (approvalAlreadyConsumedBySelf &&
                    exactExecutableApproval.value.state === "Consumed" &&
                    exactExecutableApproval.value.revision ===
                      context.executableApproval.expectedRevision + 1)
                ) ||
                exactExecutableApproval.value.expiresAt <= now ||
                !executableApprovalBindingMatches(
                  exactExecutableApproval.value,
                  context.executableApproval.binding,
                )
              ) {
                return yield* recordNoEffectDenial(
                  definition.sideEffectSemantics,
                  regions,
                  exactExecutableApproval._tag === "Some" &&
                    exactExecutableApproval.value.expiresAt <= now
                    ? "ApprovalExpired"
                    : "ApprovalMismatch",
                );
              }
              if (intent.approvalId !== context.executableApproval.approvalId) {
                return yield* recordNoEffectDenial(
                  definition.sideEffectSemantics,
                  regions,
                  "ApprovalMismatch",
                );
              }
            }
          }
          if (
            p39BindingEnabled &&
            context.executableApproval !== undefined &&
            !recoveryBindingIdentityMatches({
              identity: context.recoveryBindingIdentity,
              executionId: context.executionId,
              invocationId: intent.invocationId,
              callRef: intent.callRef,
              approvalBinding: context.executableApproval.binding,
            })
          ) {
            return yield* Effect.fail<ToolRuntimeError>(
              operationalFailure(
                "RecoveryBinding",
                String(intent.invocationId),
              )({ _tag: "RecoveryBindingApprovalSourceMismatch" }),
            );
          }

          let recoveredToolOutcome: ToolExecutionResult | undefined;
          let pendingReconciliation:
            | {
                readonly request: ToolReconciliationRequest;
                readonly result: Exclude<
                  ToolReconciliationResult,
                  { readonly _tag: "StillUnknown" }
                >;
                readonly observedAt: string;
                readonly selection: {
                  readonly attemptNo: 0 | 1;
                  readonly factId: string;
                };
              }
            | undefined;
          let retryAdmitted = false;
          if (options.qualificationProbe !== undefined) {
            const priorRecord = Option.isSome(prior) ? prior.value : undefined;
            yield* Effect.promise(
              () =>
                options.qualificationProbe?.({
                  boundary: "P38StopInvocationLookup",
                  executionId: context.executionId,
                  invocationId: intent.invocationId,
                  callRef: intent.callRef,
                  ...((context.logicalActionId ??
                    context.recoveryBindingIdentity?.logicalActionId) ===
                  undefined
                    ? {}
                    : {
                        logicalActionId:
                          context.logicalActionId ??
                          context.recoveryBindingIdentity?.logicalActionId,
                      }),
                  inputHash: canonicalArgumentsDigestV1(intent.argumentsJson),
                  toolName: intent.toolName,
                  toolVersion: intent.toolVersion,
                  fencingGeneration: context.executionFence.fencingGeneration,
                  priorFound: priorRecord !== undefined,
                  priorIdentityMatches:
                    priorRecord === undefined
                      ? false
                      : priorRecord.executionId === context.executionId &&
                        priorRecord.toolName === intent.toolName &&
                        priorRecord.toolVersion === intent.toolVersion &&
                        priorRecord.argumentsJson === intent.argumentsJson &&
                        priorRecord.approvalId === intent.approvalId,
                  priorEffectAdmissionState:
                    priorRecord?.effectAdmissionState ?? null,
                  priorSettlementKind: priorRecord?.settlement?._tag ?? null,
                }) ?? Promise.resolve(),
            );
          }
          if (Option.isSome(prior)) {
            const recorded = prior.value;
            let replayBindingValue: RecoveryBindingV1 | undefined;
            let replayBindingSha256: string | undefined;
            const sameIntent =
              recorded.executionId === context.executionId &&
              recorded.workspaceId === context.workspaceId &&
              recorded.toolName === intent.toolName &&
              recorded.toolVersion === intent.toolVersion &&
              recorded.sideEffectSemantics === definition.sideEffectSemantics &&
              recorded.argumentsJson === intent.argumentsJson &&
              recorded.approvalId === intent.approvalId;
            if (
              !sameIntent ||
              (verifiedReplayBinding === undefined &&
                JSON.stringify(recorded.resolvedRegions) !==
                  JSON.stringify(regions))
            ) {
              return yield* Effect.fail<ToolRuntimeError>(
                operationalFailure(
                  "IntentJournal",
                  String(intent.invocationId),
                )({
                  _tag: "ToolInvocationIdentityConflict",
                }),
              );
            }
            if (
              recorded.settlement === null &&
              recorded.sideEffectSemantics === "Reconcilable" &&
              recorded.effectAdmissionState !== "NotAdmitted" &&
              trustedProfile === undefined
            ) {
              // Historical shell@2 and any other profile-less legacy row are
              // ambiguous external effects. Do not synthesize P39 identity or
              // enter the Executor path during recovery.
              return {
                _tag: "OutcomeUnknown" as const,
                reconciliationRefs: [String(intent.invocationId)],
              };
            }
            if (verifiedReplayBinding !== undefined) {
              replayBindingValue = verifiedReplayBinding.value;
              replayBindingSha256 = verifiedReplayBinding.bindingSha256;
            } else {
              const replayAdmission = yield* Effect.match(
                checkCapturedSnapshotAndAdmit(),
                {
                  onFailure: (cause) => ({ ok: false as const, cause }),
                  onSuccess: (value) => ({ ok: true as const, value }),
                },
              );
              if (!replayAdmission.ok) {
                if (isP39ResourceResolutionStale(replayAdmission.cause)) {
                  return yield* refreshAfterStale(replayAdmission.cause);
                }
                return yield* Effect.fail<ToolRuntimeError>(
                  replayAdmission.cause as ToolRuntimeError,
                );
              }
              if (replayAdmission.value._tag === "Denied") {
                return yield* recordNoEffectDenial(
                  definition.sideEffectSemantics,
                  regions,
                  "ResourceAdmissionDenied",
                );
              }
            }
            if (
              verifiedReplayBinding === undefined &&
              p39BindingEnabled &&
              Option.isSome(p39Recovery)
            ) {
              const approvalSnapshot = needsApproval
                ? recoveryApprovalSnapshotFromRecord(
                    currentApprovalRecord,
                    intent.invocationId,
                  )
                : null;
              if (needsApproval && approvalSnapshot === null) {
                return yield* Effect.fail<ToolRuntimeError>(
                  operationalFailure(
                    "RecoveryBinding",
                    String(intent.invocationId),
                  )({ _tag: "ConsumedApprovalSourceUnavailable" }),
                );
              }
              let expectedBinding: RecoveryBindingV1;
              try {
                expectedBinding = makeRecoveryBindingV1({
                  context,
                  intent,
                  definition,
                  authority: resolvedAuthority,
                  regions,
                  resourceBoundaryRevision:
                    capturedWorkspace.resourceBoundaryRevision,
                  environmentRevision: resolved.observedEnvironmentRevision,
                  approval: approvalSnapshot,
                  ...(trustedProfile === undefined
                    ? {}
                    : {
                        profile: trustedProfile,
                        effectKey: trustedEffectKey,
                      }),
                });
              } catch (cause) {
                return yield* Effect.fail<ToolRuntimeError>(
                  operationalFailure(
                    "RecoveryBinding",
                    String(intent.invocationId),
                  )(cause),
                );
              }
              const bound = yield* tx
                .transact(
                  Effect.gen(function* () {
                    if (Option.isSome(observationEvidence)) {
                      yield* observationEvidence.value.assertCurrentFence(
                        context.executionFence,
                        yield* clock.now(),
                      );
                    }
                    return yield* p39Recovery.value.findBinding(
                      intent.invocationId,
                    );
                  }),
                )
                .pipe(
                  Effect.mapError(
                    operationalFailure(
                      "RecoveryBinding",
                      String(intent.invocationId),
                    ),
                  ),
                );
              if (
                Option.isNone(bound) ||
                bound.value.canonicalJson !==
                  canonicalizeRecoveryBindingV1(expectedBinding) ||
                bound.value.bindingSha256 !==
                  recoveryBindingV1Digest(expectedBinding)
              ) {
                return yield* Effect.fail<ToolRuntimeError>(
                  operationalFailure(
                    "RecoveryBinding",
                    String(intent.invocationId),
                  )({ _tag: "RecoveryBindingReplayMismatch" }),
                );
              }
              replayBindingValue = bound.value.value;
              replayBindingSha256 = bound.value.bindingSha256;
            }
            if (
              recorded.settlement === null &&
              recorded.effectAdmissionState === "MayHaveStarted" &&
              recorded.sideEffectSemantics === "Reconcilable"
            ) {
              if (
                trustedProfile === undefined ||
                replayBindingValue === undefined ||
                replayBindingSha256 === undefined ||
                !Option.isSome(p39Recovery) ||
                !Option.isSome(reconciliationPort) ||
                !Option.isSome(reconciliationFacts) ||
                !Option.isSome(observationEvidence)
              ) {
                return {
                  _tag: "OutcomeUnknown" as const,
                  reconciliationRefs: [String(intent.invocationId)],
                };
              }
              const latestAttempt = yield* tx
                .transact(
                  Effect.gen(function* () {
                    yield* observationEvidence.value.assertCurrentFence(
                      context.executionFence,
                      yield* clock.now(),
                    );
                    return yield* p39Recovery.value.findLatestAttempt(
                      intent.invocationId,
                    );
                  }),
                )
                .pipe(
                  Effect.mapError(
                    operationalFailure(
                      "RecoveryBinding",
                      String(intent.invocationId),
                    ),
                  ),
                );
              if (Option.isNone(latestAttempt)) {
                return {
                  _tag: "OutcomeUnknown" as const,
                  reconciliationRefs: [String(intent.invocationId)],
                };
              }
              const attempt = latestAttempt.value;
              if (
                attempt.admissionState !== "MayHaveStarted" ||
                attempt.bindingSha256 !== replayBindingSha256 ||
                attempt.profileId !== trustedProfile.profileId ||
                attempt.profileVersion !== trustedProfile.profileVersion ||
                attempt.profileHash !== trustedProfile.profileHash ||
                attempt.profileProtocol !== trustedProfile.profileProtocol ||
                attempt.effectKey === null ||
                trustedEffectKey === null ||
                attempt.effectKey !== trustedEffectKey
              ) {
                return {
                  _tag: "OutcomeUnknown" as const,
                  reconciliationRefs: [String(intent.invocationId)],
                };
              }
              const request: ToolReconciliationRequest = {
                invocationId: intent.invocationId,
                attemptNo: attempt.attemptNo,
                bindingSha256: replayBindingSha256,
                profileHash: trustedProfile.profileHash,
                effectKey: attempt.effectKey,
                visibilityScopeSha256:
                  replayBindingValue.targetResourceIdentityDigest,
              };
              yield* tx
                .transact(
                  observationEvidence.value.assertCurrentFence(
                    context.executionFence,
                    yield* clock.now(),
                  ),
                )
                .pipe(
                  Effect.mapError(
                    operationalFailure(
                      "RecoveryBinding",
                      String(intent.invocationId),
                    ),
                  ),
                );
              const portResult = yield* Effect.match(
                reconciliationPort.value.reconcile(request),
                {
                  onFailure: () => ({
                    _tag: "StillUnknown" as const,
                    reasonCode: "ExternalSourceUnavailable" as const,
                    evidenceRef: null,
                  }),
                  onSuccess: (value) =>
                    validateToolReconciliationResult(request, value)
                      ? value
                      : {
                          _tag: "StillUnknown" as const,
                          reasonCode: "EvidenceBindingMismatch" as const,
                          evidenceRef: null,
                        },
                },
              );
              const persistUnknownFact = (
                result: Extract<
                  ToolReconciliationResult,
                  { readonly _tag: "StillUnknown" }
                >,
                observedAt: string,
              ) =>
                tx.transact(
                  Effect.gen(function* () {
                    const fenceNow = yield* clock.now();
                    yield* observationEvidence.value.assertCurrentFence(
                      context.executionFence,
                      fenceNow,
                    );
                    yield* probeReconciliation(
                      "AH7BeforeReconciliationFactCommit",
                      {
                        attemptNo: request.attemptNo,
                        outcomeTag: result._tag,
                      },
                    );
                    yield* reconciliationFacts.value.record(
                      request,
                      result,
                      observedAt,
                    );
                  }),
                );
              if (portResult._tag === "StillUnknown") {
                const observedAt = yield* clock.now();
                yield* persistUnknownFact(portResult, observedAt).pipe(
                  Effect.mapError(
                    operationalFailure(
                      "SettlementJournal",
                      String(intent.invocationId),
                    ),
                  ),
                );
                yield* probeReconciliation("AH7AfterReconciliationFactCommit", {
                  attemptNo: request.attemptNo,
                  outcomeTag: portResult._tag,
                });
                return {
                  _tag: "OutcomeUnknown" as const,
                  reconciliationRefs: [String(intent.invocationId)],
                };
              }
              const observedAt = portResult.proof.observedAt;
              const factId = reconciliationFactId({
                request,
                result: portResult,
                factDisposition: "RecoveryInput",
                evidenceSha256: portResult.proof.evidenceSha256,
              });
              if (portResult._tag === "NotOccurred") {
                if (attempt.attemptNo === 0) {
                  const retryGate = yield* tx
                    .transact(
                      Effect.gen(function* () {
                        const gateNow = yield* clock.now();
                        yield* observationEvidence.value.assertCurrentFence(
                          context.executionFence,
                          gateNow,
                        );
                        yield* probeReconciliation(
                          "AH7BeforeReconciliationFactCommit",
                          {
                            attemptNo: request.attemptNo,
                            outcomeTag: portResult._tag,
                            factId,
                          },
                        );
                        const fact = yield* reconciliationFacts.value.record(
                          request,
                          portResult,
                          observedAt,
                        );
                        if (fact.factId !== factId) {
                          return yield* Effect.fail({
                            _tag: "P39ReconciliationFactIdentityMismatch",
                          });
                        }

                        const snapshotAdmission = yield* Effect.match(
                          Effect.gen(function* () {
                            yield* validateCapturedSnapshot();
                            if (
                              replayBindingValue === undefined ||
                              targetResourceIdentityDigestV1(regions) !==
                                replayBindingValue.targetResourceIdentityDigest ||
                              capturedWorkspace.resourceBoundaryRevision !==
                                replayBindingValue.resourceBoundaryRevision ||
                              resolved.observedEnvironmentRevision !==
                                replayBindingValue.environmentRevision
                            ) {
                              return {
                                _tag: "Denied" as const,
                                reason: "RecoveryBindingSnapshotChanged",
                              };
                            }
                            return yield* admission.admit({
                              workspaceId: context.workspaceId,
                              regions,
                              resolvedBoundaryRegions: boundaryRegions,
                              write: executor.write,
                            });
                          }),
                          {
                            onFailure: (cause) =>
                              isP39ResourceResolutionStale(cause)
                                ? { _tag: "ResourceSnapshotChanged" as const }
                                : { _tag: "Failure" as const, cause },
                            onSuccess: (value) =>
                              value._tag === "Denied"
                                ? { _tag: "ResourceSnapshotChanged" as const }
                                : { _tag: "Admitted" as const },
                          },
                        );
                        if (snapshotAdmission._tag === "Failure") {
                          return yield* Effect.fail(
                            operationalFailure(
                              "ResourceAdmission",
                              String(intent.invocationId),
                            )(snapshotAdmission.cause),
                          );
                        }
                        if (snapshotAdmission._tag !== "Admitted") {
                          return snapshotAdmission;
                        }

                        const currentAuthority = Option.isSome(
                          authorityResolver,
                        )
                          ? yield* authorityResolver.value
                              .resolve({
                                intent,
                                definition,
                                context,
                                regions,
                                now: gateNow,
                              })
                              .pipe(
                                Effect.catchTag("ToolAuthorityDenied", () =>
                                  Effect.succeed(undefined),
                                ),
                                Effect.mapError(
                                  operationalFailure(
                                    "AuthorityResolution",
                                    String(intent.invocationId),
                                  ),
                                ),
                              )
                          : context.authority;
                        if (
                          currentAuthority === undefined ||
                          checkInvocationAuthority({
                            authority: currentAuthority,
                            definition,
                            intent,
                            context,
                            regions,
                            now: gateNow,
                            maxDelegationDepth: options.maxDelegationDepth ?? 1,
                          })._tag === "Denied"
                        ) {
                          return {
                            _tag: "AuthoritySnapshotChanged" as const,
                          };
                        }

                        if (
                          needsApproval &&
                          intent.approvalId !== null &&
                          context.executableApproval !== undefined
                        ) {
                          if (Option.isNone(executableApprovals)) {
                            return {
                              _tag: "ApprovalNoLongerAuthorized" as const,
                            };
                          }
                          const currentApproval =
                            yield* executableApprovals.value
                              .findById(context.executableApproval.approvalId)
                              .pipe(
                                Effect.mapError(
                                  operationalFailure(
                                    "ApprovalLookup",
                                    String(intent.invocationId),
                                  ),
                                ),
                              );
                          if (
                            Option.isNone(currentApproval) ||
                            currentApproval.value.state !== "Consumed" ||
                            currentApproval.value.consumedBy !==
                              intent.invocationId ||
                            currentApproval.value.revision !==
                              context.executableApproval.expectedRevision + 1 ||
                            currentApproval.value.expiresAt <= gateNow ||
                            !executableApprovalBindingMatches(
                              currentApproval.value,
                              context.executableApproval.binding,
                            )
                          ) {
                            return {
                              _tag: "ApprovalNoLongerAuthorized" as const,
                            };
                          }
                        } else if (
                          needsApproval &&
                          intent.approvalId !== null &&
                          context.executableApproval === undefined
                        ) {
                          const approval = yield* store
                            .findApproval(intent.approvalId)
                            .pipe(
                              Effect.mapError(
                                operationalFailure(
                                  "ApprovalLookup",
                                  String(intent.invocationId),
                                ),
                              ),
                            );
                          if (
                            Option.isNone(approval) ||
                            matchApproval({
                              approval: approval.value,
                              intent,
                              definition,
                              context,
                              regions,
                              now: gateNow,
                              replayOfRecordedInvocation: true,
                            })._tag === "Denied"
                          ) {
                            return {
                              _tag: "ApprovalNoLongerAuthorized" as const,
                            };
                          }
                        }

                        const admitted = yield* store.admitEffect(
                          intent.invocationId,
                          currentAuthority,
                          gateNow,
                          context.executionFence,
                        );
                        if (admitted._tag === "ExecutionStopping") {
                          return admitted;
                        }
                        if (admitted._tag === "Denied") {
                          return {
                            _tag: reconciliationRetryDenialReasonCode(
                              admitted.reasonCode,
                            ),
                          };
                        }
                        yield* p39Recovery.value.admitRetryAttempt({
                          invocationId: intent.invocationId,
                          factId,
                          admittedAt: gateNow,
                        });
                        return { _tag: "Admitted" as const };
                      }),
                    )
                    .pipe(
                      Effect.tapError((cause) =>
                        isLeaseFencingRejected(cause)
                          ? probeReconciliation(
                              "AH7ReconciliationResultFenceRejected",
                              {
                                attemptNo: request.attemptNo,
                                outcomeTag: portResult._tag,
                                factId,
                              },
                            ).pipe(Effect.catchCause(() => Effect.void))
                          : Effect.void,
                      ),
                      Effect.mapError(
                        operationalFailure(
                          "RecoveryBinding",
                          String(intent.invocationId),
                        ),
                      ),
                    );
                  yield* probeReconciliation(
                    "AH7AfterReconciliationFactCommit",
                    {
                      attemptNo: request.attemptNo,
                      outcomeTag: portResult._tag,
                      factId,
                    },
                  );
                  if (retryGate._tag === "Admitted") {
                    retryAdmitted = true;
                  } else {
                    recoveredToolOutcome = {
                      settlement: {
                        _tag: "ReconciledNoEffect",
                        reasonCode:
                          retryGate._tag === "ExecutionStopping"
                            ? "StopRequested"
                            : retryGate._tag,
                        reconciliationFactRef: factId,
                      },
                      observation: bounded(
                        "authoritative source confirmed that the effect attempt did not occur",
                      ),
                      resultRef: null,
                    };
                    pendingReconciliation = {
                      request,
                      result: portResult,
                      observedAt,
                      selection: { attemptNo: attempt.attemptNo, factId },
                    };
                  }
                } else {
                  const fact = yield* tx
                    .transact(
                      Effect.gen(function* () {
                        yield* observationEvidence.value.assertCurrentFence(
                          context.executionFence,
                          yield* clock.now(),
                        );
                        yield* probeReconciliation(
                          "AH7BeforeReconciliationFactCommit",
                          {
                            attemptNo: request.attemptNo,
                            outcomeTag: portResult._tag,
                            factId,
                          },
                        );
                        return yield* reconciliationFacts.value.record(
                          request,
                          portResult,
                          observedAt,
                        );
                      }),
                    )
                    .pipe(
                      Effect.mapError(
                        operationalFailure(
                          "SettlementJournal",
                          String(intent.invocationId),
                        ),
                      ),
                    );
                  yield* probeReconciliation(
                    "AH7AfterReconciliationFactCommit",
                    {
                      attemptNo: request.attemptNo,
                      outcomeTag: portResult._tag,
                      factId,
                    },
                  );
                  if (fact.factId !== factId) {
                    return yield* Effect.fail<ToolRuntimeError>(
                      operationalFailure(
                        "SettlementJournal",
                        String(intent.invocationId),
                      )({ _tag: "P39ReconciliationFactIdentityMismatch" }),
                    );
                  }
                  recoveredToolOutcome = {
                    settlement: {
                      _tag: "ReconciledNoEffect",
                      reasonCode: "ReplayLimitReached",
                      reconciliationFactRef: factId,
                    },
                    observation: bounded(
                      "authoritative source confirmed that the single retry did not occur",
                    ),
                    resultRef: null,
                  };
                  pendingReconciliation = {
                    request,
                    result: portResult,
                    observedAt,
                    selection: { attemptNo: attempt.attemptNo, factId },
                  };
                }
              } else {
                let resultBytes: Uint8Array | undefined;
                if (Option.isSome(artifactService)) {
                  try {
                    const resultArtifactId = parse(ArtifactId)(
                      portResult.resultRef,
                    );
                    const loaded = yield* tx
                      .transact(artifactService.value.load(resultArtifactId))
                      .pipe(
                        Effect.mapError(
                          operationalFailure(
                            "SettlementJournal",
                            String(intent.invocationId),
                          ),
                        ),
                      );
                    if (Option.isSome(loaded)) resultBytes = loaded.value;
                  } catch {
                    resultBytes = undefined;
                  }
                }
                const reconstructed =
                  resultBytes === undefined
                    ? null
                    : trustedProfile.reconstructOccurred({
                        bytes: resultBytes,
                        settlement: portResult.settlement,
                      });
                if (
                  reconstructed === null ||
                  reconstructed.settlement !== portResult.settlement
                ) {
                  const unknown = {
                    _tag: "StillUnknown" as const,
                    reasonCode: "ResultEvidenceUnavailable" as const,
                    evidenceRef: portResult.proof.evidenceRef,
                  };
                  const unknownAt = yield* clock.now();
                  yield* persistUnknownFact(unknown, unknownAt).pipe(
                    Effect.mapError(
                      operationalFailure(
                        "SettlementJournal",
                        String(intent.invocationId),
                      ),
                    ),
                  );
                  return {
                    _tag: "OutcomeUnknown" as const,
                    reconciliationRefs: [String(intent.invocationId)],
                  };
                }
                recoveredToolOutcome = {
                  settlement:
                    portResult.settlement === "Success"
                      ? { _tag: "Success" }
                      : { _tag: "ExpectedFailure" },
                  observation: reconstructed.observation,
                  resultRef:
                    portResult.settlement === "Success"
                      ? portResult.resultRef
                      : null,
                };
                const fact = yield* tx
                  .transact(
                    Effect.gen(function* () {
                      yield* observationEvidence.value.assertCurrentFence(
                        context.executionFence,
                        yield* clock.now(),
                      );
                      yield* probeReconciliation(
                        "AH7BeforeReconciliationFactCommit",
                        {
                          attemptNo: request.attemptNo,
                          outcomeTag: portResult._tag,
                          factId,
                        },
                      );
                      return yield* reconciliationFacts.value.record(
                        request,
                        portResult,
                        observedAt,
                      );
                    }),
                  )
                  .pipe(
                    Effect.mapError(
                      operationalFailure(
                        "SettlementJournal",
                        String(intent.invocationId),
                      ),
                    ),
                  );
                yield* probeReconciliation("AH7AfterReconciliationFactCommit", {
                  attemptNo: request.attemptNo,
                  outcomeTag: portResult._tag,
                  factId,
                });
                if (fact.factId !== factId) {
                  return yield* Effect.fail<ToolRuntimeError>(
                    operationalFailure(
                      "SettlementJournal",
                      String(intent.invocationId),
                    )({ _tag: "P39ReconciliationFactIdentityMismatch" }),
                  );
                }
                pendingReconciliation = {
                  request,
                  result: portResult,
                  observedAt,
                  selection: { attemptNo: attempt.attemptNo, factId },
                };
              }
            }
            if (recorded.settlement !== null) {
              if (recorded.settlement._tag === "Denied") {
                return denied(recorded.settlement.reasonCode);
              }
              if (
                recorded.settlement._tag === "Interrupted" &&
                Option.isNone(observationEvidence)
              ) {
                return { _tag: "Interrupted" as const };
              }
              if (Option.isSome(observationEvidence)) {
                return yield* decodeRecordedEvidence(
                  intent,
                  context,
                  recorded,
                  resolveReplaySandboxPolicy,
                );
              }
              if (
                recorded.settlement._tag === "Success" &&
                recorded.resultRef !== null &&
                Option.isSome(artifactService)
              ) {
                let artifactId: ArtifactId;
                try {
                  artifactId = parse(ArtifactId)(recorded.resultRef);
                } catch {
                  return {
                    _tag: "OutcomeUnknown" as const,
                    reconciliationRefs: [String(intent.invocationId)],
                  };
                }
                const bytes = yield* tx
                  .transact(artifactService.value.load(artifactId))
                  .pipe(
                    Effect.mapError(
                      operationalFailure(
                        "SettlementJournal",
                        String(intent.invocationId),
                      ),
                    ),
                  );
                if (Option.isSome(bytes)) {
                  return {
                    _tag: "Success" as const,
                    observation: bounded(new TextDecoder().decode(bytes.value)),
                    resultRef: recorded.resultRef,
                  };
                }
              }
              return {
                _tag: "OutcomeUnknown" as const,
                reconciliationRefs: [String(intent.invocationId)],
              };
            }
            if (
              recorded.effectAdmissionState !== "NotAdmitted" &&
              recoveredToolOutcome === undefined &&
              !retryAdmitted &&
              (recorded.sideEffectSemantics === "NonIdempotent" ||
                recorded.sideEffectSemantics === "Reconcilable")
            ) {
              const reconciliationRefs = [String(intent.invocationId)];
              if (recorded.sideEffectSemantics === "NonIdempotent") {
                const settledAt = yield* clock.now();
                const unknownWrite = yield* Effect.match(
                  tx.transact(
                    Effect.gen(function* () {
                      const unknownSettlement = {
                        _tag: "OutcomeUnknown" as const,
                        reconciliationRefs,
                      };
                      const applied = Option.isSome(observationEvidence)
                        ? (yield* observationEvidence.value.settleOrReadWinner({
                            invocation: recorded,
                            settlement: unknownSettlement,
                            resultRef: null,
                            observation: unknownSettlement,
                            settledAt,
                            executionFence: context.executionFence,
                            fenceNow: yield* clock.now(),
                          }))._tag === "Applied"
                        : yield* store.settle(
                            intent.invocationId,
                            unknownSettlement,
                            null,
                            settledAt,
                            context.executionFence,
                            yield* clock.now(),
                          );
                      return {
                        applied,
                        current: applied
                          ? Option.none()
                          : yield* store.findById(intent.invocationId),
                      };
                    }),
                  ),
                  {
                    onFailure: (cause) => ({ ok: false as const, cause }),
                    onSuccess: (value) => ({ ok: true as const, value }),
                  },
                );
                if (!unknownWrite.ok) {
                  if (
                    isLeaseFencingRejected(unknownWrite.cause) &&
                    options.qualificationProbe !== undefined
                  ) {
                    yield* Effect.promise(
                      () =>
                        options.qualificationProbe?.({
                          boundary: "AH7ToolSettlementFenceRejected",
                          executionId: context.executionId,
                          invocationId: intent.invocationId,
                          callRef: intent.callRef,
                        }) ?? Promise.resolve(),
                    );
                  }
                  return yield* Effect.fail<ToolRuntimeError>(
                    isLeaseFencingRejected(unknownWrite.cause)
                      ? unknownWrite.cause
                      : operationalFailure(
                          "SettlementJournal",
                          String(intent.invocationId),
                        )(unknownWrite.cause),
                  );
                }
                if (!unknownWrite.value.applied) {
                  const canonical = unknownWrite.value.current;
                  if (
                    Option.isSome(canonical) &&
                    canonical.value.settlement?._tag === "OutcomeUnknown"
                  ) {
                    return {
                      _tag: "OutcomeUnknown" as const,
                      reconciliationRefs:
                        canonical.value.settlement.reconciliationRefs,
                    };
                  }
                }
              }
              return {
                _tag: "OutcomeUnknown" as const,
                reconciliationRefs,
              };
            }
            if (recorded.effectAdmissionState === "LegacyUnknown") {
              return {
                _tag: "OutcomeUnknown" as const,
                reconciliationRefs: [String(intent.invocationId)],
              };
            }
          } else {
            if (
              p39BindingEnabled &&
              definition.sideEffectSemantics === "Reconcilable" &&
              trustedProfile === undefined
            ) {
              return yield* Effect.fail<ToolRuntimeError>(
                operationalFailure(
                  "RecoveryBinding",
                  String(intent.invocationId),
                )({ _tag: "ReconciliationProfileUnavailable" }),
              );
            }
            const invocation = {
              invocationId: intent.invocationId,
              executionId: context.executionId,
              workspaceId: context.workspaceId,
              toolName: intent.toolName,
              toolVersion: intent.toolVersion,
              sideEffectSemantics: definition.sideEffectSemantics,
              argumentsJson: intent.argumentsJson,
              resolvedRegions: regions,
              approvalId:
                context.executableApproval?.approvalId ?? intent.approvalId,
              intentAt: now,
            } as const;
            const claimStopped = { _tag: "AH7ClaimStopped" as const };
            const approvalClaimLost = { _tag: "AH7ApprovalClaimLost" as const };
            let approvalReceipt: ExecutableApprovalConsumptionReceipt | null =
              null;
            if (p39BindingEnabled && options.qualificationProbe !== undefined) {
              yield* Effect.promise(
                () =>
                  options.qualificationProbe?.({
                    boundary: "P38P39ClaimBeforeTransaction",
                    executionId: context.executionId,
                    invocationId: intent.invocationId,
                    callRef: intent.callRef,
                    approvalId:
                      context.executableApproval?.approvalId ??
                      intent.approvalId,
                  }) ?? Promise.resolve(),
              );
            }
            const claim = yield* Effect.match(
              tx.transact(
                Effect.gen(function* () {
                  const snapshotAdmission =
                    yield* validateCapturedSnapshotAndAdmit().pipe(
                      Effect.mapError((cause) =>
                        isP39ResourceResolutionStale(cause)
                          ? cause
                          : operationalFailure(
                              "ResourceAdmission",
                              String(intent.invocationId),
                            )(cause),
                      ),
                    );
                  if (snapshotAdmission._tag === "Denied") {
                    return "AdmissionDenied" as const;
                  }
                  const recordedIntent = yield* store.recordIntent(
                    invocation,
                    context.executionFence,
                    now,
                  );
                  if (recordedIntent === "ExecutionStopping") {
                    return "ExecutionStopping" as const;
                  }
                  if (
                    needsApproval &&
                    context.executableApproval !== undefined &&
                    Option.isSome(executableApprovals)
                  ) {
                    if (approvalAlreadyConsumedBySelf) {
                      if (p39BindingEnabled) {
                        return yield* Effect.fail<ToolRuntimeError>(
                          operationalFailure(
                            "RecoveryBinding",
                            String(intent.invocationId),
                          )({ _tag: "ConsumedApprovalHasNoPriorBinding" }),
                        );
                      }
                      return "Claimed" as const;
                    }
                    const consumed =
                      yield* executableApprovals.value.consumeApproved({
                        approvalId: context.executableApproval.approvalId,
                        expectedRevision:
                          context.executableApproval.expectedRevision,
                        consumedBy: intent.invocationId,
                        consumedAt: now,
                        binding: context.executableApproval.binding,
                        executionFence: context.executionFence,
                      });
                    if (consumed === "ExecutionStopping") {
                      return yield* Effect.fail(claimStopped);
                    }
                    if (consumed === false) {
                      return yield* Effect.fail(approvalClaimLost);
                    }
                    if (p39BindingEnabled) approvalReceipt = consumed;
                  } else if (
                    needsApproval &&
                    intent.approvalId !== null &&
                    !approvalAlreadyConsumedBySelf
                  ) {
                    if (p39BindingEnabled) {
                      return yield* Effect.fail<ToolRuntimeError>(
                        operationalFailure(
                          "RecoveryBinding",
                          String(intent.invocationId),
                        )({ _tag: "P38ConsumptionReceiptUnavailable" }),
                      );
                    }
                    const consumed = yield* store.consumeApproval(
                      intent.approvalId,
                      intent.invocationId,
                      context.executionFence,
                      now,
                    );
                    if (consumed === "ExecutionStopping") {
                      return yield* Effect.fail(claimStopped);
                    }
                    if (!consumed) {
                      return yield* Effect.fail(approvalClaimLost);
                    }
                  }
                  if (p39BindingEnabled) {
                    if (Option.isNone(p39Recovery)) {
                      return yield* Effect.fail<ToolRuntimeError>(
                        operationalFailure(
                          "RecoveryBinding",
                          String(intent.invocationId),
                        )({ _tag: "P39RecoveryEvidenceStoreUnavailable" }),
                      );
                    }
                    let approvalSnapshot: RecoveryApprovalSnapshot | null =
                      null;
                    if (needsApproval) {
                      const receipt = approvalReceipt;
                      const expected = context.executableApproval;
                      if (
                        receipt === null ||
                        expected === undefined ||
                        receipt.approvalId !== expected.approvalId ||
                        receipt.consumedBy !== intent.invocationId ||
                        receipt.preConsumeRevision !==
                          expected.expectedRevision ||
                        receipt.consumedRevision !==
                          expected.expectedRevision + 1 ||
                        !executableApprovalBindingMatches(
                          receipt.binding,
                          expected.binding,
                        )
                      ) {
                        return yield* Effect.fail<ToolRuntimeError>(
                          operationalFailure(
                            "RecoveryBinding",
                            String(intent.invocationId),
                          )({ _tag: "P38ReceiptBindingMismatch" }),
                        );
                      }
                      approvalSnapshot =
                        recoveryApprovalSnapshotFromReceipt(receipt);
                    }
                    let recoveryBinding: RecoveryBindingV1;
                    try {
                      recoveryBinding = makeRecoveryBindingV1({
                        context,
                        intent,
                        definition,
                        authority: resolvedAuthority,
                        regions,
                        resourceBoundaryRevision:
                          capturedWorkspace.resourceBoundaryRevision,
                        environmentRevision:
                          resolved.observedEnvironmentRevision,
                        approval: approvalSnapshot,
                        ...(trustedProfile === undefined
                          ? {}
                          : {
                              profile: trustedProfile,
                              effectKey: trustedEffectKey,
                            }),
                      });
                    } catch (cause) {
                      return yield* Effect.fail<ToolRuntimeError>(
                        operationalFailure(
                          "RecoveryBinding",
                          String(intent.invocationId),
                        )(cause),
                      );
                    }
                    yield* p39Recovery.value
                      .bindClaim({
                        binding: recoveryBinding,
                        createdAt: now,
                      })
                      .pipe(
                        Effect.mapError(
                          operationalFailure(
                            "RecoveryBinding",
                            String(intent.invocationId),
                          ),
                        ),
                      );
                  }
                  return "Claimed" as const;
                }),
              ),
              {
                onFailure: (cause) => ({ _tag: "Failed" as const, cause }),
                onSuccess: (value) => ({ _tag: "Succeeded" as const, value }),
              },
            );
            if (claim._tag === "Failed") {
              if (isP39ResourceResolutionStale(claim.cause)) {
                return yield* refreshAfterStale(claim.cause);
              }
              if (
                typeof claim.cause === "object" &&
                claim.cause !== null &&
                "_tag" in claim.cause &&
                claim.cause._tag === "AH7ApprovalClaimLost"
              ) {
                return yield* recordNoEffectDenial(
                  definition.sideEffectSemantics,
                  regions,
                  "ApprovalConsumedByOtherInvocation",
                );
              }
              if (
                typeof claim.cause === "object" &&
                claim.cause !== null &&
                "_tag" in claim.cause &&
                claim.cause._tag === "AH7ClaimStopped"
              ) {
                return { _tag: "Interrupted" as const };
              }
              return yield* Effect.fail<ToolRuntimeError>(
                isLeaseFencingRejected(claim.cause) ||
                  (typeof claim.cause === "object" &&
                    claim.cause !== null &&
                    "_tag" in claim.cause &&
                    claim.cause._tag === "ToolRuntimeOperationalFailure")
                  ? claim.cause
                  : operationalFailure(
                      "IntentJournal",
                      String(intent.invocationId),
                    )(claim.cause),
              );
            }
            if (claim.value === "ExecutionStopping") {
              return { _tag: "Interrupted" as const };
            }
            if (claim.value === "AdmissionDenied") {
              return yield* recordNoEffectDenial(
                definition.sideEffectSemantics,
                regions,
                "ResourceAdmissionDenied",
              );
            }
            if (needsApproval) approvalAlreadyConsumedBySelf = true;
            if (options.qualificationProbe !== undefined) {
              yield* Effect.promise(
                () =>
                  options.qualificationProbe?.({
                    boundary: "AH7AfterToolIntentCommit",
                    executionId: context.executionId,
                    invocationId: intent.invocationId,
                    callRef: intent.callRef,
                  }) ?? Promise.resolve(),
              );
            }
          }

          if (
            executor.processCapability === "SandboxProcess" &&
            processModeBlocksSpawn &&
            !testOnlyAllowTrustedLocalProcessExecution &&
            !isIndependentVerificationExecution(context) &&
            priorRecord !== undefined &&
            priorRecord.settlement === null &&
            priorRecord.effectAdmissionState === "NotAdmitted"
          ) {
            // `prior` identity and, when P39 is active, its exact RecoveryBinding
            // have already been verified above. This uses the existing fenced
            // Denied CAS: no effect admission, P39 attempt, P40 observation,
            // sandbox open, executor, or provider call can precede it.
            return yield* recordNoEffectDenial(
              definition.sideEffectSemantics,
              regions,
              processUnavailableReason,
              true,
            );
          }

          // A NotOccurred proof whose retry gate was denied is already a
          // complete, fenced no-effect decision. Do not send that settled
          // recovery outcome through the ordinary new-effect authority,
          // approval, or admission path: those checks govern a new attempt
          // and can only overwrite or obscure the authenticated P39/P40
          // terminal selection below.
          let processExecutionContext = context;
          if (recoveredToolOutcome === undefined) {
            const effectGateNow = yield* clock.now();
            const effectAuthority = Option.isSome(authorityResolver)
              ? yield* authorityResolver.value
                  .resolve({
                    intent,
                    definition,
                    context,
                    regions,
                    now: effectGateNow,
                  })
                  .pipe(
                    Effect.catchTag("ToolAuthorityDenied", () =>
                      Effect.succeed(undefined),
                    ),
                    Effect.mapError(
                      operationalFailure(
                        "AuthorityResolution",
                        String(intent.invocationId),
                      ),
                    ),
                  )
              : context.authority;
            if (effectAuthority === undefined) {
              return yield* recordNoEffectDenial(
                definition.sideEffectSemantics,
                regions,
                approvalAlreadyConsumedBySelf
                  ? "ApprovalNoLongerAuthorized"
                  : "InvocationAuthorityDenied",
              );
            }
            if (options.qualificationProbe !== undefined) {
              yield* Effect.promise(
                () =>
                  options.qualificationProbe?.({
                    boundary: "AH7AfterEffectAuthorityResolvedBeforeAdmission",
                    executionId: context.executionId,
                    invocationId: intent.invocationId,
                    callRef: intent.callRef,
                  }) ?? Promise.resolve(),
              );
            }
            if (effectAuthority.sourceRevision === undefined) {
              return yield* recordNoEffectDenial(
                definition.sideEffectSemantics,
                regions,
                approvalAlreadyConsumedBySelf
                  ? "ApprovalNoLongerAuthorized"
                  : "InvocationAuthorityDenied",
              );
            }
            const effectAuthorityCheck = checkInvocationAuthority({
              authority: effectAuthority,
              definition,
              intent,
              context,
              regions,
              now: effectGateNow,
              maxDelegationDepth: options.maxDelegationDepth ?? 1,
            });
            if (effectAuthorityCheck._tag === "Denied") {
              return yield* recordNoEffectDenial(
                definition.sideEffectSemantics,
                regions,
                approvalAlreadyConsumedBySelf
                  ? "ApprovalNoLongerAuthorized"
                  : "InvocationAuthorityDenied",
              );
            }
            if (
              needsApproval &&
              intent.approvalId !== null &&
              context.executableApproval === undefined
            ) {
              const approval = yield* tx
                .transact(store.findApproval(intent.approvalId))
                .pipe(
                  Effect.mapError(
                    operationalFailure(
                      "ApprovalLookup",
                      String(intent.invocationId),
                    ),
                  ),
                );
              const matched = Option.isSome(approval)
                ? matchApproval({
                    approval: approval.value,
                    intent,
                    definition,
                    context,
                    regions,
                    now: effectGateNow,
                    replayOfRecordedInvocation: approvalAlreadyConsumedBySelf,
                  })
                : { _tag: "Denied" as const, reason: "approval not found" };
              if (matched._tag === "Denied") {
                return yield* recordNoEffectDenial(
                  definition.sideEffectSemantics,
                  regions,
                  approvalAlreadyConsumedBySelf
                    ? "ApprovalNoLongerAuthorized"
                    : approvalDenialCode(matched.reason),
                );
              }
            }
            if (
              executor.processCapability === "SandboxProcess" &&
              p39BindingEnabled &&
              Option.isSome(p39Recovery) &&
              recoveredToolOutcome === undefined &&
              (retryAdmitted ||
                Option.isNone(prior) ||
                prior.value.effectAdmissionState === "NotAdmitted")
            ) {
              const isPolicyExpired = (
                policy: ToolExecutionContext["sandboxProcessPolicy"],
                now: string,
              ) =>
                policy?.expiresAt !== undefined &&
                Number.isFinite(Date.parse(policy.expiresAt)) &&
                new Date(Date.parse(policy.expiresAt)).toISOString() ===
                  policy.expiresAt &&
                Date.parse(policy.expiresAt) <= Date.parse(now);
              let processPolicy = context.sandboxProcessPolicy;
              let policyNow = effectGateNow;
              const authorizationRevision =
                effectAuthority.workspaceSandboxSources?.find(
                  (source) => source.workspaceId === context.workspaceId,
                )?.authorizationRevision;
              const sourceMatches = (
                policy: ToolExecutionContext["sandboxProcessPolicy"],
              ) =>
                authorizationRevision == null ||
                policy?.workspaceAuthorizationRevision ===
                  authorizationRevision;
              if (
                (processPolicy === undefined ||
                  isPolicyExpired(processPolicy, policyNow) ||
                  !sourceMatches(processPolicy)) &&
                context.resolveSandboxProcessPolicy !== undefined
              ) {
                // This resolver may read the current durable decision,
                // authority bundle and P11 paths. It is intentionally run
                // after the exact NotAdmitted intent/RecoveryBinding commit,
                // after the existing authority/approval gate, and outside
                // every TransactionPort scope.
                policyNow = yield* clock.now();
                const materialized = yield* resolveSandboxPolicyOnce(policyNow);
                if (materialized !== undefined) {
                  processPolicy = materialized.policy;
                  sandboxPolicyCleanup = materialized.dispose ?? Effect.void;
                  processExecutionContext = {
                    ...context,
                    sandboxProcessPolicy: materialized.policy,
                    sandboxProcessMountBindings: materialized.mounts,
                  };
                }
              }
              if (
                processPolicy === undefined ||
                isPolicyExpired(processPolicy, policyNow) ||
                !sourceMatches(processPolicy)
              ) {
                // P4 has already durably claimed the exact P3 action and bound
                // its immutable recovery proof above. Policy absence parks that
                // same action before effect admission; it is neither a denial
                // nor a terminal ExpectedFailure/Observation.
                return { _tag: "SandboxPolicyRequiredInterruption" as const };
              }
            }
            if (options.qualificationProbe !== undefined) {
              yield* Effect.promise(
                () =>
                  options.qualificationProbe?.({
                    boundary: "AH7BeforeEffectAdmission",
                    executionId: context.executionId,
                    invocationId: intent.invocationId,
                    callRef: intent.callRef,
                  }) ?? Promise.resolve(),
              );
            }
            const effectAdmission = retryAdmitted
              ? {
                  _tag: "Succeeded" as const,
                  value: { _tag: "Admitted" as const },
                }
              : yield* Effect.match(
                  tx.transact(
                    Effect.gen(function* () {
                      const admissionNow = yield* clock.now();
                      const admissionResult = yield* store.admitEffect(
                        intent.invocationId,
                        effectAuthority,
                        admissionNow,
                        context.executionFence,
                      );
                      if (
                        admissionResult._tag === "Admitted" &&
                        p39BindingEnabled &&
                        Option.isSome(p39Recovery)
                      ) {
                        yield* p39Recovery.value.admitFirstAttempt(
                          intent.invocationId,
                          admissionNow,
                        );
                      }
                      return admissionResult;
                    }),
                  ),
                  {
                    onFailure: (cause) => ({ _tag: "Failed" as const, cause }),
                    onSuccess: (value) => ({
                      _tag: "Succeeded" as const,
                      value,
                    }),
                  },
                );
            if (effectAdmission._tag === "Failed") {
              return yield* Effect.fail<ToolRuntimeError>(
                isLeaseFencingRejected(effectAdmission.cause)
                  ? effectAdmission.cause
                  : operationalFailure(
                      "IntentJournal",
                      String(intent.invocationId),
                    )(effectAdmission.cause),
              );
            }
            if (effectAdmission.value._tag === "Denied") {
              if (recoveredToolOutcome !== undefined) {
                // A known Occurred fact is accounted under the current fence even
                // if current authority no longer admits new effects.
              } else {
                return yield* recordNoEffectDenial(
                  definition.sideEffectSemantics,
                  regions,
                  approvalAlreadyConsumedBySelf
                    ? "ApprovalNoLongerAuthorized"
                    : effectAdmission.value.reasonCode,
                );
              }
            }
            if (effectAdmission.value._tag === "ExecutionStopping") {
              if (options.qualificationProbe !== undefined) {
                yield* Effect.promise(
                  () =>
                    options.qualificationProbe?.({
                      boundary: "P38StopEffectAdmissionResult",
                      executionId: context.executionId,
                      invocationId: intent.invocationId,
                      callRef: intent.callRef,
                      logicalActionId:
                        context.logicalActionId ??
                        context.recoveryBindingIdentity?.logicalActionId,
                      fencingGeneration:
                        context.executionFence.fencingGeneration,
                      admissionResult: effectAdmission.value._tag,
                    }) ?? Promise.resolve(),
                );
              }
              if (recoveredToolOutcome !== undefined) {
                // Stop gates new execution; it does not discard a confirmed
                // external outcome.
              } else {
                const settledAt = yield* clock.now();
                return yield* persistNoEffectInterruption(
                  Option.isSome(prior)
                    ? {
                        invocationId: intent.invocationId,
                        executionId: context.executionId,
                        workspaceId: context.workspaceId,
                        toolName: intent.toolName,
                        toolVersion: intent.toolVersion,
                        sideEffectSemantics: definition.sideEffectSemantics,
                        argumentsJson: intent.argumentsJson,
                        resolvedRegions: regions,
                        approvalId:
                          context.executableApproval?.approvalId ??
                          intent.approvalId,
                        intentAt: prior.value.intentAt,
                      }
                    : undefined,
                  settledAt,
                );
              }
            }

            if (
              options.qualificationProbe !== undefined &&
              recoveredToolOutcome === undefined
            ) {
              yield* Effect.promise(
                () =>
                  options.qualificationProbe?.({
                    boundary: "P38StopEffectAdmissionResult",
                    executionId: context.executionId,
                    invocationId: intent.invocationId,
                    callRef: intent.callRef,
                    ...((context.logicalActionId ??
                      context.recoveryBindingIdentity?.logicalActionId) ===
                    undefined
                      ? {}
                      : {
                          logicalActionId:
                            context.logicalActionId ??
                            context.recoveryBindingIdentity?.logicalActionId,
                        }),
                    fencingGeneration: context.executionFence.fencingGeneration,
                    admissionResult: effectAdmission.value._tag,
                    ...(effectAdmission.value._tag === "Denied"
                      ? {
                          admissionDenialReason:
                            effectAdmission.value.reasonCode,
                        }
                      : {}),
                  }) ?? Promise.resolve(),
              );
            }

            if (options.qualificationProbe !== undefined) {
              yield* Effect.promise(
                () =>
                  options.qualificationProbe?.({
                    boundary: "AH7AfterEffectAdmissionCommit",
                    executionId: context.executionId,
                    invocationId: intent.invocationId,
                    callRef: intent.callRef,
                  }) ?? Promise.resolve(),
              );
            }
          }

          const executionBundle =
            recoveredToolOutcome !== undefined
              ? {
                  executed: {
                    ok: true as const,
                    value: recoveredToolOutcome,
                  },
                  closed: { ok: true as const },
                }
              : yield* Effect.gen(function* () {
                  const handle = yield* sandbox
                    .open(
                      executor.processCapability === "SandboxProcess" &&
                        processExecutionContext.sandboxProcessMountBindings !==
                          undefined
                        ? {
                            executionId: context.executionId,
                            workspaceId: context.workspaceId,
                            mounts:
                              processExecutionContext.sandboxProcessMountBindings,
                          }
                        : address === undefined || region === undefined
                          ? {
                              executionId: context.executionId,
                              workspaceId: context.workspaceId,
                              regions,
                            }
                          : {
                              executionId: context.executionId,
                              workspaceId: context.workspaceId,
                              mounts: [
                                {
                                  ref: "workspace",
                                  address,
                                  region,
                                  access: executor.write
                                    ? "ReadWrite"
                                    : "ReadOnly",
                                },
                              ],
                            },
                    )
                    .pipe(
                      Effect.mapError(
                        operationalFailure(
                          "SandboxOpen",
                          String(intent.invocationId),
                        ),
                      ),
                    );
                  const executed = yield* Effect.match(
                    executor.execute({
                      intent,
                      definition,
                      context: processExecutionContext,
                      sandbox: handle,
                      regions,
                      ...(executor.processCapability === "SandboxProcess"
                        ? {
                            runProcess: runProcessFor(
                              processExecutionContext,
                              handle,
                              intent,
                            ),
                          }
                        : {}),
                    }),
                    {
                      onFailure: (cause) => ({ ok: false as const, cause }),
                      onSuccess: (value) => ({ ok: true as const, value }),
                    },
                  );
                  const closed = yield* Effect.match(sandbox.close(handle), {
                    onFailure: (cause) => ({ ok: false as const, cause }),
                    onSuccess: () => ({ ok: true as const }),
                  });
                  return { executed, closed };
                });
          const { executed, closed } = executionBundle;
          if (!closed.ok) {
            return yield* Effect.fail<ToolRuntimeError>({
              _tag: "ToolRuntimeCleanupFailure",
              stage: "SandboxClose",
              effectDisposition: "OutcomeUncertain",
              invocationRef: String(intent.invocationId),
              cause: closed.cause,
              ...(executed.ok
                ? {}
                : {
                    priorFailure: {
                      _tag: "ToolRuntimeOperationalFailure" as const,
                      stage: "Executor" as const,
                      effectDisposition: "OutcomeUncertain" as const,
                      invocationRef: String(intent.invocationId),
                      cause: executed.cause,
                    },
                  }),
            });
          }
          if (!executed.ok) {
            return yield* Effect.fail<ToolRuntimeError>({
              _tag: "ToolRuntimeOperationalFailure",
              stage: "Executor",
              effectDisposition: "OutcomeUncertain",
              invocationRef: String(intent.invocationId),
              cause: executed.cause,
            });
          }
          const outcome = executed.value;
          if (
            options.qualificationProbe !== undefined &&
            recoveredToolOutcome === undefined &&
            outcome.sandboxProviderUnavailable === undefined
          ) {
            yield* Effect.promise(
              () =>
                options.qualificationProbe?.({
                  boundary: "AH7AfterToolEffectBeforeSettlement",
                  executionId: context.executionId,
                  invocationId: intent.invocationId,
                  callRef: intent.callRef,
                }) ?? Promise.resolve(),
            );
          }

          let authenticatedRecoveryEvidence:
            | SelectedP39RecoveryEvidence
            | undefined;
          if (outcome.settlement._tag === "ReconciledNoEffect") {
            const rejectUnverifiedSelection = (
              cause: unknown,
            ): Effect.Effect<never, ToolRuntimeError> =>
              Effect.fail({
                _tag: "ToolRuntimeOperationalFailure",
                stage: "SettlementJournal",
                effectDisposition: "OutcomeUncertain",
                invocationRef: String(intent.invocationId),
                cause: {
                  _tag: "P40AuthenticatedRecoveryEvidenceUnavailable",
                  cause,
                },
              });
            if (Option.isNone(p39RecoveryEvidence)) {
              return yield* rejectUnverifiedSelection({
                _tag: "P39RecoveryEvidenceStoreUnavailable",
              });
            }
            if (
              pendingReconciliation !== undefined &&
              pendingReconciliation.result._tag === "NotOccurred" &&
              outcome.settlement.reconciliationFactRef ===
                pendingReconciliation.selection.factId
            ) {
              // This invocation just recorded the exact RecoveryInput fact.
              // The P4 winner transaction validates the fact/binding/attempt
              // tuple and selects it atomically with the terminal Observation;
              // findSelected is intentionally reserved for replay of an
              // already-selected terminal winner.
            } else {
              const selectedRead = yield* Effect.match(
                tx.transact(
                  p39RecoveryEvidence.value.findSelected(intent.invocationId),
                ),
                {
                  onFailure: (cause) => ({ ok: false as const, cause }),
                  onSuccess: (value) => ({ ok: true as const, value }),
                },
              );
              if (!selectedRead.ok) {
                return yield* rejectUnverifiedSelection(selectedRead.cause);
              }
              if (Option.isNone(selectedRead.value)) {
                return yield* rejectUnverifiedSelection({
                  _tag: "P39SelectedRecoveryEvidenceMissing",
                });
              }
              const selected = selectedRead.value.value;
              if (
                !matchesAuthenticatedP39Evidence({
                  selected,
                  intent,
                  context,
                  factId: outcome.settlement.reconciliationFactRef,
                })
              ) {
                return yield* rejectUnverifiedSelection({
                  _tag: "P39SelectedRecoveryEvidenceMismatch",
                });
              }
              authenticatedRecoveryEvidence = selected;
            }
          }

          let resultRef = outcome.resultRef;
          if (
            Option.isNone(observationEvidence) &&
            outcome.settlement._tag === "ReconciledNoEffect"
          ) {
            return yield* Effect.fail<ToolRuntimeError>(
              operationalFailure(
                "SettlementJournal",
                String(intent.invocationId),
              )({
                _tag: "P40ObservationEvidenceStoreUnavailable",
              }),
            );
          }
          if (
            Option.isNone(observationEvidence) &&
            outcome.settlement._tag === "Success" &&
            resultRef === null &&
            Option.isSome(artifactService)
          ) {
            resultRef = String(
              (yield* tx
                .transact(
                  artifactService.value.store(
                    new TextEncoder().encode(outcome.observation.text),
                    `tool-result:${intent.toolName}`,
                    {
                      invocationId: intent.invocationId,
                      executionId: context.executionId,
                    },
                    now,
                  ),
                )
                .pipe(
                  Effect.mapError(
                    operationalFailure(
                      "SettlementJournal",
                      String(intent.invocationId),
                    ),
                  ),
                )).artifactId,
            );
          }

          const settledAt = yield* clock.now();
          if (options.qualificationProbe !== undefined) {
            yield* Effect.promise(
              () =>
                options.qualificationProbe?.({
                  boundary: "AH7BeforeToolSettlementTransaction",
                  executionId: context.executionId,
                  invocationId: intent.invocationId,
                  callRef: intent.callRef,
                }) ?? Promise.resolve(),
            );
          }
          if (
            Option.isSome(observationEvidence) &&
            outcome.settlement._tag !== "Denied"
          ) {
            if (context.executionFence === undefined) {
              return yield* Effect.fail<ToolRuntimeError>(
                operationalFailure(
                  "SettlementJournal",
                  String(intent.invocationId),
                )({
                  _tag: "P40ObservationEvidenceFenceUnavailable",
                }),
              );
            }
            const p4Intent = yield* findInvocationFenced(
              intent.invocationId,
              context,
              "SettlementJournal",
            );
            if (Option.isNone(p4Intent)) {
              return yield* Effect.fail<ToolRuntimeError>(
                operationalFailure(
                  "SettlementJournal",
                  String(intent.invocationId),
                )({
                  _tag: "P4IntentMissingAtObservationSettlement",
                }),
              );
            }
            const record = p4Intent.value;
            const invocation = {
              invocationId: record.invocationId,
              executionId: record.executionId,
              workspaceId: record.workspaceId,
              toolName: record.toolName,
              toolVersion: record.toolVersion,
              sideEffectSemantics: record.sideEffectSemantics,
              argumentsJson: record.argumentsJson,
              resolvedRegions: record.resolvedRegions,
              approvalId: record.approvalId,
              intentAt: record.intentAt,
            } as const;
            const candidateObservation: CanonicalToolObservation = (() => {
              switch (outcome.settlement._tag) {
                case "Success":
                  return {
                    _tag: "Success",
                    observation: outcome.observation,
                    resultRef,
                  };
                case "ExpectedFailure":
                  return {
                    _tag: "ExpectedFailure",
                    observation: outcome.observation,
                    ...(outcome.sandboxProviderUnavailable === undefined
                      ? {}
                      : {
                          sandboxProviderUnavailable: {
                            policyRevision:
                              outcome.sandboxProviderUnavailable.policyRevision,
                            policyDigest:
                              outcome.sandboxProviderUnavailable.policyDigest,
                            profile:
                              outcome.sandboxProviderUnavailable.profileId,
                            providerId:
                              outcome.sandboxProviderUnavailable.providerId,
                            providerVersion:
                              outcome.sandboxProviderUnavailable
                                .providerVersion,
                            capabilityRevision:
                              outcome.sandboxProviderUnavailable
                                .capabilityRevision,
                            probeEvidenceRef:
                              outcome.sandboxProviderUnavailable
                                .probeEvidenceRef,
                            failureCode:
                              outcome.sandboxProviderUnavailable.failureCode,
                            effectDisposition: "NoEffect" as const,
                          },
                        }),
                  };
                case "Interrupted":
                  return { _tag: "Interrupted" };
                case "OutcomeUnknown":
                  return {
                    _tag: "OutcomeUnknown",
                    reconciliationRefs: outcome.settlement.reconciliationRefs,
                  };
                case "RuntimeFailure":
                  return {
                    _tag: "RuntimeFailure",
                    cause: outcome.settlement.cause,
                  };
                case "ReconciledNoEffect":
                  return {
                    _tag: "ReconciledNoEffect",
                    reasonCode: outcome.settlement.reasonCode,
                    reconciliationFactRef:
                      outcome.settlement.reconciliationFactRef,
                    observation: outcome.observation,
                    resultRef: resultRef ?? "",
                  };
              }
            })();
            const candidate = {
              invocation,
              settlement: outcome.settlement,
              resultRef,
              observation: candidateObservation,
              ...(authenticatedRecoveryEvidence === undefined
                ? {}
                : {
                    reconciliationSelection: {
                      attemptNo:
                        authenticatedRecoveryEvidence.attempt.attemptNo,
                      factId: authenticatedRecoveryEvidence.fact.factId,
                    },
                    authenticatedRecoveryEvidence,
                  }),
              ...(pendingReconciliation === undefined
                ? {}
                : {
                    reconciliationSelection: pendingReconciliation.selection,
                  }),
              ...(Option.isSome(artifactService) && resultRef === null
                ? {
                    materializeResultRef: () =>
                      artifactService.value
                        .store(
                          new TextEncoder().encode(outcome.observation.text),
                          `tool-result:${intent.toolName}`,
                          {
                            invocationId: intent.invocationId,
                            executionId: context.executionId,
                          },
                          now,
                        )
                        .pipe(
                          Effect.map((artifact) => String(artifact.artifactId)),
                        ),
                  }
                : {}),
              settledAt,
              executionFence: context.executionFence,
              fenceNow: yield* clock.now(),
            } as const;
            const p40Write = yield* Effect.match(
              tx.transact(
                Effect.gen(function* () {
                  const result =
                    yield* observationEvidence.value.settleOrReadWinner(
                      candidate,
                    );
                  if (
                    result._tag === "Applied" &&
                    options.qualificationProbe !== undefined
                  ) {
                    yield* Effect.promise(
                      () =>
                        options.qualificationProbe?.({
                          boundary: "AH7BeforeToolSettlementCommit",
                          executionId: context.executionId,
                          invocationId: intent.invocationId,
                          callRef: intent.callRef,
                        }) ?? Promise.resolve(),
                    );
                  }
                  return result;
                }),
              ),
              {
                onFailure: (cause) => ({ ok: false as const, cause }),
                onSuccess: (value) => ({ ok: true as const, value }),
              },
            );
            if (!p40Write.ok) {
              if (isLeaseFencingRejected(p40Write.cause)) {
                return yield* Effect.fail<ToolRuntimeError>(p40Write.cause);
              }
              const failureCode = replayFailureCode(p40Write.cause);
              if (failureCode !== undefined) {
                const afterFailure = yield* findInvocationFenced(
                  intent.invocationId,
                  context,
                  "SettlementJournal",
                );
                if (
                  (Option.isSome(afterFailure) &&
                    afterFailure.value.settlement !== null) ||
                  record.settledAt !== null
                ) {
                  return yield* recordReplayFailure(
                    intent,
                    context,
                    failureCode,
                    yield* clock.now(),
                  );
                }
              }
              return yield* Effect.fail<ToolRuntimeError>(
                operationalFailure(
                  "SettlementJournal",
                  String(intent.invocationId),
                )(p40Write.cause),
              );
            }
            if (
              p40Write.value._tag === "Applied" &&
              options.qualificationProbe !== undefined
            ) {
              yield* Effect.promise(
                () =>
                  options.qualificationProbe?.({
                    boundary: "AH7AfterToolSettlementCommit",
                    executionId: context.executionId,
                    invocationId: intent.invocationId,
                    callRef: intent.callRef,
                  }) ?? Promise.resolve(),
              );
            }
            if (p40Write.value._tag === "ExistingDenied") {
              return denied(p40Write.value.reasonCode);
            }
            return p40Write.value.evidence
              .observation as CanonicalToolObservation;
          }
          const settlementWrite = yield* Effect.match(
            tx.transact(
              Effect.gen(function* () {
                const fenceNow = yield* clock.now();
                const applied = yield* store.settle(
                  intent.invocationId,
                  outcome.settlement,
                  resultRef,
                  settledAt,
                  context.executionFence,
                  fenceNow,
                );
                if (applied && options.qualificationProbe !== undefined) {
                  yield* Effect.promise(
                    () =>
                      options.qualificationProbe?.({
                        boundary: "AH7BeforeToolSettlementCommit",
                        executionId: context.executionId,
                        invocationId: intent.invocationId,
                        callRef: intent.callRef,
                      }) ?? Promise.resolve(),
                  );
                }
                return {
                  applied,
                  current: applied
                    ? Option.none()
                    : yield* store.findById(intent.invocationId),
                };
              }),
            ),
            {
              onFailure: (cause) => ({ ok: false as const, cause }),
              onSuccess: (value) => ({ ok: true as const, value }),
            },
          );
          if (!settlementWrite.ok) {
            if (
              isLeaseFencingRejected(settlementWrite.cause) &&
              options.qualificationProbe !== undefined
            ) {
              yield* Effect.promise(
                () =>
                  options.qualificationProbe?.({
                    boundary: "AH7ToolSettlementFenceRejected",
                    executionId: context.executionId,
                    invocationId: intent.invocationId,
                    callRef: intent.callRef,
                  }) ?? Promise.resolve(),
              );
            }
            return yield* Effect.fail<ToolRuntimeError>(
              isLeaseFencingRejected(settlementWrite.cause)
                ? settlementWrite.cause
                : operationalFailure(
                    "SettlementJournal",
                    String(intent.invocationId),
                  )(settlementWrite.cause),
            );
          }
          if (!settlementWrite.value.applied) {
            const canonical = settlementWrite.value.current;
            if (
              Option.isSome(canonical) &&
              canonical.value.settlement?._tag === "OutcomeUnknown"
            ) {
              return {
                _tag: "OutcomeUnknown" as const,
                reconciliationRefs:
                  canonical.value.settlement.reconciliationRefs,
              };
            }
            return yield* Effect.fail<ToolRuntimeError>(
              operationalFailure(
                "SettlementJournal",
                String(intent.invocationId),
              )({
                _tag: "ToolInvocationSettlementNotApplied",
                canonicalSettlement: Option.isSome(canonical)
                  ? (canonical.value.settlement?._tag ?? "Unsettled")
                  : "Missing",
              }),
            );
          }
          if (options.qualificationProbe !== undefined) {
            yield* Effect.promise(
              () =>
                options.qualificationProbe?.({
                  boundary: "AH7AfterToolSettlementCommit",
                  executionId: context.executionId,
                  invocationId: intent.invocationId,
                  callRef: intent.callRef,
                }) ?? Promise.resolve(),
            );
          }

          if (
            executor.processCapability === "SandboxProcess" &&
            outcome.sandboxProviderUnavailable !== undefined
          ) {
            return outcome.sandboxProviderUnavailable;
          }

          const observation: CanonicalToolObservation = (() => {
            switch (outcome.settlement._tag) {
              case "Success":
                return {
                  _tag: "Success",
                  observation: outcome.observation,
                  resultRef,
                };
              case "ExpectedFailure":
                return {
                  _tag: "ExpectedFailure",
                  observation: outcome.observation,
                };
              case "Denied":
                return denied(outcome.settlement.reasonCode);
              case "Interrupted":
                return { _tag: "Interrupted" };
              case "OutcomeUnknown":
                return {
                  _tag: "OutcomeUnknown",
                  reconciliationRefs: outcome.settlement.reconciliationRefs,
                };
              case "RuntimeFailure":
                return {
                  _tag: "RuntimeFailure",
                  cause: outcome.settlement.cause,
                };
              case "ReconciledNoEffect":
                return {
                  _tag: "ReconciledNoEffect",
                  reasonCode: outcome.settlement.reasonCode,
                  reconciliationFactRef:
                    outcome.settlement.reconciliationFactRef,
                  observation: outcome.observation,
                  resultRef: resultRef ?? "",
                };
            }
          })();
          return observation;
        }).pipe(Effect.ensuring(Effect.suspend(() => sandboxPolicyCleanup)));
      };

      return ToolRuntimePort.of({ invoke });
    }),
  );

export { bounded };
