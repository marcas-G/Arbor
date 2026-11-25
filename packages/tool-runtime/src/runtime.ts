import {
  ArtifactService,
  type CanonicalToolObservation,
  Clock,
  canonicalArgumentsDigestV1,
  EnvironmentRevisionStore,
  ExecutableApprovalStore,
  type NoEffectDenialCode,
  P39RecoveryEvidenceStore,
  ProjectEnvironmentPort,
  ResourceAdmission,
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

import type { PendingReconciliation, ToolExecutionResult, ToolExecutor, ToolRuntimeQualificationProbe } from "./runtime/types.js";
import {
  bounded,
  operationalFailure,
} from "./runtime/errors.js";
import { makeProcessRunner } from "./runtime/process-runner.js";
import { makeObservationReplay } from "./runtime/recovery/observation-replay.js";
import { inspectPriorInvocation } from "./runtime/recovery/prior-invocation.js";
import { makeNoEffectSettlement } from "./runtime/no-effect-settlement.js";
import { resolveInvocationResources } from "./runtime/resources.js";
import { resolveInvocationAuthority } from "./runtime/invocation-authority.js";
import { executeAdmittedTool } from "./runtime/execute-admitted-tool.js";
import { settleToolOutcome } from "./runtime/settlement.js";
import { reconcileAdmittedInvocation } from "./runtime/recovery/reconcile-admitted-invocation.js";
import { claimNewInvocation } from "./runtime/claim-new-invocation.js";
import { finishPriorInvocation } from "./runtime/recovery/finish-prior-invocation.js";
import { admitNewEffect } from "./runtime/effect-admission.js";
import { prepareInvocation } from "./runtime/invocation-setup.js";
import { verifyPriorReplayAdmission } from "./runtime/recovery/replay-admission.js";

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
          const setup = yield* prepareInvocation(
            intent, context, executors, definitions, reconciliationProfiles,
            p39Recovery, environmentRevisions, workspaces, tx, store,
            processModeBlocksSpawn, testOnlyAllowTrustedLocalProcessExecution,
            processUnavailableReason, isIndependentVerificationExecution,
          );
          if (setup._tag === "Terminal") return setup.observation;
          const { definition, trustedProfile, trustedEffectKey, executor, p39BindingEnabled } = setup;
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
            address, regions, region,
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
          const { needsApproval } = authorityResolution;
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
            const replayAdmission = yield* verifyPriorReplayAdmission(
              intent, context, definition, recorded, resourceResolution, authorityResolution,
              verifiedReplayBinding, p39BindingEnabled, p39Recovery, observationEvidence,
              trustedProfile, trustedEffectKey, tx, clock, recordNoEffectDenial, refreshAfterStale,
            );
            if (replayAdmission._tag === "Terminal") return replayAdmission.observation;
            const { replayBindingValue, replayBindingSha256 } = replayAdmission;
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
