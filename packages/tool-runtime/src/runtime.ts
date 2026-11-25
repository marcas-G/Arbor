import type {
  Workspace,
} from "@arbor/domain";
import {
  ArtifactService,
  type CanonicalToolObservation,
  Clock,
  canonicalArgumentsDigestV1,
  canonicalizeRecoveryBindingV1,
  EnvironmentRevisionStore,
  ExecutableApprovalStore,
  type NoEffectDenialCode,
  P39RecoveryEvidenceStore,
  ProjectEnvironmentPort,
  type RecoveryBindingV1,
  ResourceAdmission,
  recoveryBindingV1Digest,
  SandboxPort,
  type SandboxProcessPolicyResolution,
  SandboxProcessPort,
  ToolAuthorityResolver,
  ToolDefinitionStore,
  type ToolExecutionContext,
  type ToolIntent,
  ToolInvocationStore,
  ToolObservationEvidenceStore,
  ToolObservationReplayAttentionFactStore,
  ToolReconciliationFactStore,
  ToolReconciliationPort,
  ToolReconciliationProfileRegistry,
  type ToolRuntimeError,
  ToolRuntimePort,
  TransactionPort,
  TrustedLocalProcessPort,
  WorkspaceRepository,
} from "@arbor/ports";
import { Effect, Layer, Option } from "effect";
import {
  makeRecoveryBindingV1,
  recoveryApprovalSnapshotFromRecord,
  recoveryBindingIdentityMatches,
  recoveryBindingToolDefinitionHashV1,
} from "./recovery-binding.js";
import { validateToolInput } from "./validation.js";

import type { PendingReconciliation, ToolExecutionResult, ToolExecutor, ToolRuntimeQualificationProbe } from "./runtime/types.js";
import {
  bounded,
  denied,
  executableApprovalTerminalDenial,
  hasCompleteExecutionFence,
  isP39ResourceResolutionStale,
  operationalFailure,
  reconciliationRetryDenialReasonCode,
} from "./runtime/errors.js";
import { makeProcessRunner } from "./runtime/process-runner.js";
import { makeObservationReplay } from "./runtime/observation-replay.js";
import { inspectPriorInvocation } from "./runtime/prior-invocation.js";
import { makeNoEffectSettlement } from "./runtime/no-effect-settlement.js";
import { resolveInvocationResources } from "./runtime/resources.js";
import { resolveInvocationAuthority } from "./runtime/invocation-authority.js";
import { executeAdmittedTool } from "./runtime/execute-admitted-tool.js";
import { settleToolOutcome } from "./runtime/settlement.js";
import { reconcileAdmittedInvocation } from "./runtime/reconcile-admitted-invocation.js";
import { claimNewInvocation } from "./runtime/claim-new-invocation.js";
import { finishPriorInvocation } from "./runtime/finish-prior-invocation.js";
import { admitNewEffect } from "./runtime/effect-admission.js";

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
          const { persistNoEffectInterruption, recordNoEffectDenial } = makeNoEffectSettlement(
            intent, context, now, options, tx, clock, store,
            observationEvidence, artifactService, findInvocationFenced,
            decodeRecordedEvidence, resolveReplaySandboxPolicy,
          );
          const priorInspection = yield* inspectPriorInvocation(
            intent, context, definition, trustedProfile, trustedEffectKey, tx, clock,
            p39Recovery, p39RecoveryEvidence, observationEvidence, reconciliationPort,
            reconciliationFacts, findInvocationFenced, decodeRecordedEvidenceResult,
            resolveReplaySandboxPolicy,
          );
          if (priorInspection._tag === "Terminal") {
            return priorInspection.observation;
          }
          const { prior, priorRecord, priorModelIdentityMatches, verifiedReplayBinding } = priorInspection;
          const resourceResolution = yield* resolveInvocationResources(
            intent, context, definition, executor, tx, workspaces, environment,
            environmentRevisions, admission, p39BindingEnabled,
            priorModelIdentityMatches, priorRecord, verifiedReplayBinding !== undefined,
            recordNoEffectDenial, refreshAfterStale,
          );
          if (resourceResolution._tag === "Terminal") {
            return resourceResolution.observation;
          }
          const {
            address, capturedWorkspace, resolved, regions, boundaryRegions,
            validateCapturedSnapshot, validateCapturedSnapshotAndAdmit,
            checkCapturedSnapshotAndAdmit, region,
          } = resourceResolution;

          const authorityResolution = yield* resolveInvocationAuthority(
            intent, context, definition, executor, regions, now, options,
            authorityResolver, executableApprovals, tx, store,
            p39BindingEnabled, verifiedReplayBinding !== undefined,
            recordNoEffectDenial,
          );
          if (authorityResolution._tag === "Terminal") {
            return authorityResolution.observation;
          }
          const { resolvedAuthority, needsApproval, currentApprovalRecord } = authorityResolution;
          let { approvalAlreadyConsumedBySelf } = authorityResolution;

          let recoveredToolOutcome: ToolExecutionResult | undefined;
          let pendingReconciliation: PendingReconciliation | undefined;
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
              const recovery = yield* reconcileAdmittedInvocation(
                intent, context, definition, executor, resourceResolution, needsApproval,
                trustedProfile, trustedEffectKey, replayBindingValue, replayBindingSha256,
                tx, clock, store, admission, p39Recovery, reconciliationPort, reconciliationFacts,
                observationEvidence, artifactService, authorityResolver, executableApprovals,
                options, probeReconciliation,
              );
              if (recovery._tag === "Terminal") return recovery.observation;
              recoveredToolOutcome = recovery.recoveredToolOutcome;
              pendingReconciliation = recovery.pendingReconciliation;
              retryAdmitted = recovery.retryAdmitted;
            }
            const terminalReplay = yield* finishPriorInvocation(
              intent, context, recorded, recoveredToolOutcome, retryAdmitted,
              options, tx, clock, store, observationEvidence, artifactService,
              decodeRecordedEvidence, resolveReplaySandboxPolicy,
            );
            if (terminalReplay !== undefined) return terminalReplay;
          } else {
            const claim = yield* claimNewInvocation(
              intent, context, definition, resourceResolution, authorityResolution, now,
              trustedProfile, trustedEffectKey, tx, store, p39Recovery, p39BindingEnabled,
              executableApprovals, options, recordNoEffectDenial, refreshAfterStale,
            );
            if (claim._tag === "Terminal") return claim.observation;
            approvalAlreadyConsumedBySelf = claim.approvalAlreadyConsumedBySelf;
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
            const gate = yield* admitNewEffect(
              intent, context, definition, executor, resourceResolution,
              needsApproval, approvalAlreadyConsumedBySelf, recoveredToolOutcome,
              prior, retryAdmitted, p39BindingEnabled, p39Recovery, authorityResolver,
              tx, clock, store, options, recordNoEffectDenial, persistNoEffectInterruption,
              resolveSandboxPolicyOnce, (dispose) => { sandboxPolicyCleanup = dispose; },
            );
            if (gate._tag === "Terminal") return gate.observation;
            processExecutionContext = gate.processExecutionContext;
          }

          const outcome = yield* executeAdmittedTool(
            intent, context, processExecutionContext, definition, executor, sandbox,
            address, region, regions, recoveredToolOutcome, runProcessFor,
          );
          return yield* settleToolOutcome(
            intent, context, executor, outcome, recoveredToolOutcome, pendingReconciliation,
            now, options, tx, clock, store, p39RecoveryEvidence, observationEvidence,
            artifactService, findInvocationFenced, recordReplayFailure, replayFailureCode,
          );
        }).pipe(Effect.ensuring(Effect.suspend(() => sandboxPolicyCleanup)));
      };

      return ToolRuntimePort.of({ invoke });
    }),
  );

export { bounded };
