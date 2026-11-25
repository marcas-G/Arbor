import {
  decodeCanonicalVerificationSandboxBindingV1,
  decodeExecutionEpisodeBinding,
  decodeNetworkBrokerControlsV2,
  decodeNetworkPolicyV1,
  decodeSandboxProviderId,
  encodeExecutionEpisodeBinding,
  encodeNetworkPolicyV1,
  encodeVerificationSandboxBindingV1,
  resolveSandboxProvider,
} from "@arbor/domain";
import type {
  SandboxHandle,
  SandboxProcessPortService,
  SandboxProcessRunner,
  SandboxProcessRunnerOutcome,
  ToolExecutionContext,
  ToolIntent,
  TrustedLocalProcessPortService,
} from "@arbor/ports";
import { Effect, Option } from "effect";

/** Bound process capabilities; each call checks the exact policy and handle. */
export const makeProcessRunner = (
  sandboxProcess: Option.Option<SandboxProcessPortService>,
  trustedLocalProcess: Option.Option<TrustedLocalProcessPortService>,
  testOnlyAllowTrustedLocalProcessExecution: boolean,
) => {
  const runProcessFor =
    (
      context: ToolExecutionContext,
      handle: SandboxHandle,
      intent: ToolIntent,
    ): SandboxProcessRunner =>
    (invocation) =>
      Effect.gen(function* () {
        const policy = context.sandboxProcessPolicy;
        if (policy === undefined) {
          return {
            _tag: "Rejected" as const,
            failureCode: "PolicyMissing",
          };
        }
        const sourceAction = context.recoveryBindingIdentity;
        if (
          sourceAction === undefined ||
          sourceAction.executionId !== context.executionId ||
          sourceAction.callRef !== intent.callRef ||
          sourceAction.logicalStepNo < 0 ||
          sourceAction.repairAttempt < 0 ||
          sourceAction.actionIndex < 0
        ) {
          return {
            _tag: "Rejected" as const,
            failureCode: "ExecutionBindingMismatch",
          };
        }
        const unavailable = (
          failureCode: string,
          probeEvidenceRef: string | null = null,
          providerVersion = policy.providerVersion,
          capabilityRevision = policy.capabilityRevision,
        ): SandboxProcessRunnerOutcome =>
          policy.kind === "IndependentVerificationProcessPolicyV1"
            ? {
                _tag: "Rejected",
                failureCode: "VerificationEnvironmentUnavailable",
              }
            : {
                _tag: "SandboxProviderUnavailable",
                projectId: context.projectId,
                workspaceId: context.workspaceId,
                executionId: context.executionId,
                episodeBinding: policy.episodeBinding,
                policyRevision: policy.policyRevision,
                policyDigest: policy.policyDigest,
                profileId: policy.profile,
                providerId: policy.providerId,
                providerVersion,
                capabilityRevision,
                probeEvidenceRef,
                failureCode,
                actionBinding: {
                  identity: {
                    executionId: sourceAction.executionId,
                    logicalStepNo: sourceAction.logicalStepNo,
                    repairAttempt: sourceAction.repairAttempt,
                  },
                  providerTurnId: sourceAction.providerTurnId,
                  logicalActionId: sourceAction.logicalActionId,
                  actionIndex: sourceAction.actionIndex,
                  callRef: sourceAction.callRef,
                  invocationId: intent.invocationId,
                },
              };
        if (policy.executionId !== context.executionId) {
          return {
            _tag: "Rejected" as const,
            failureCode: "ExecutionBindingMismatch",
          };
        }
        if (policy.kind === "IndependentVerificationProcessPolicyV1") {
          const binding = decodeCanonicalVerificationSandboxBindingV1(
            encodeVerificationSandboxBindingV1(policy.verificationBinding),
          );
          const target = context.independentVerificationTarget;
          if (
            binding === undefined ||
            target === undefined ||
            binding.projectId !== context.projectId ||
            binding.workspaceId !== context.workspaceId ||
            binding.executionId !== context.executionId ||
            binding.verificationId !== target.verificationId ||
            binding.workId !== target.workId ||
            binding.targetWorkRevision !== target.targetWorkRevision ||
            binding.authorizationRevision !==
              policy.workspaceAuthorizationRevision ||
            binding.policyRevision !== policy.policyRevision ||
            binding.expiresAt !== policy.expiresAt ||
            !/^blob:sha256:[0-9a-f]{64}$/u.test(
              policy.verificationMountQualificationEvidenceRef,
            )
          ) {
            return {
              _tag: "Rejected" as const,
              failureCode: "ExecutionBindingMismatch",
            };
          }
        } else {
          if (context.executionEpisodeBinding === undefined) {
            return {
              _tag: "Rejected" as const,
              failureCode: "ExecutionBindingMismatch",
            };
          }
          const policyEpisode = decodeExecutionEpisodeBinding(
            policy.episodeBinding,
          );
          const currentEpisode =
            context.executionEpisodeBinding === undefined
              ? undefined
              : decodeExecutionEpisodeBinding(
                  context.executionEpisodeBinding,
                );
          if (
            policyEpisode === undefined ||
            currentEpisode === undefined ||
            encodeExecutionEpisodeBinding(policyEpisode) !==
              encodeExecutionEpisodeBinding(currentEpisode)
          ) {
            return {
              _tag: "Rejected" as const,
              failureCode: "EpisodeBindingMismatch",
            };
          }
        }
        if (policy.sandboxHandleId !== handle.handleId) {
          return {
            _tag: "Rejected" as const,
            failureCode: "HandleBindingMismatch",
          };
        }

        const isOsPolicy =
          policy.kind === "OsEnforcedProcessPolicy" ||
          policy.kind === "OsEnforcedProcessPolicyV2" ||
          policy.kind === "IndependentVerificationProcessPolicyV1";
        const networkPolicy = isOsPolicy
          ? decodeNetworkPolicyV1(policy.networkPolicy)
          : undefined;
        if (
          !Number.isSafeInteger(policy.policyRevision) ||
          policy.policyRevision < 1 ||
          !/^[0-9a-f]{64}$/u.test(policy.policyDigest) ||
          (isOsPolicy &&
            (decodeSandboxProviderId(policy.providerId) !==
              policy.providerId ||
              policy.providerVersion.trim().length === 0 ||
              policy.capabilityRevision.trim().length === 0 ||
              !/^[0-9a-f]{64}$/u.test(policy.enforcementRuleSetDigest) ||
              !/^blob:sha256:[0-9a-f]{64}$/u.test(
                policy.qualificationEvidenceRef,
              ) ||
              networkPolicy === undefined ||
              encodeNetworkPolicyV1(networkPolicy) !==
                encodeNetworkPolicyV1(policy.networkPolicy) ||
              ((policy.kind === "OsEnforcedProcessPolicyV2" ||
                policy.kind === "IndependentVerificationProcessPolicyV1") &&
                (decodeNetworkBrokerControlsV2(
                  policy.networkBrokerControls,
                ) === undefined ||
                  policy.networkBrokerControls.mode !==
                    policy.networkPolicy.mode)))) ||
          (!isOsPolicy &&
            (policy.trustedRuntimeIdentity !== "TrustedLocal" ||
              policy.trustedRuntimeVersion !== "builtin-v1" ||
              policy.boundary !== "TrustedLocal" ||
              policy.profile !== "FullAccess" ||
              policy.providerId !== "TrustedLocal" ||
              policy.providerVersion !== "builtin-v1" ||
              policy.capabilityRevision !== "builtin-v1" ||
              policy.networkBoundary !== "Unconfined")) ||
          !Object.values(policy.limits).every(
            (value) => Number.isSafeInteger(value) && value > 0,
          ) ||
          policy.environmentAllowlist.some(
            (name) => !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name),
          ) ||
          new Set(policy.environmentAllowlist).size !==
            policy.environmentAllowlist.length
        ) {
          return {
            _tag: "Rejected" as const,
            failureCode: "PolicyMissing",
          };
        }

        const actualMounts = (handle.mounts ?? []).map(
          ({ ref, rootPath, access }) => ({ ref, rootPath, access }),
        );
        const policyMounts = policy.admittedMounts.map(
          ({ ref, rootPath, access }) => ({ ref, rootPath, access }),
        );
        const canonicalMounts = (mounts: typeof actualMounts) =>
          JSON.stringify(
            [...mounts].sort((left, right) =>
              left.ref.localeCompare(right.ref),
            ),
          );
        if (
          actualMounts.length === 0 ||
          canonicalMounts(actualMounts) !== canonicalMounts(policyMounts)
        ) {
          return {
            _tag: "Rejected" as const,
            failureCode: "MountBindingMismatch",
          };
        }

        const requestedTimeoutMs = invocation.requestedTimeoutMs;
        if (
          requestedTimeoutMs !== undefined &&
          (!Number.isSafeInteger(requestedTimeoutMs) ||
            requestedTimeoutMs < 1)
        ) {
          return {
            _tag: "Rejected" as const,
            failureCode: "InvalidTimeout",
          };
        }
        const timeoutMs = Math.min(
          requestedTimeoutMs ?? policy.limits.wallTimeMs,
          policy.limits.wallTimeMs,
        );

        if (policy.kind === "TrustedLocalUnconfinedRuntimePolicy") {
          if (!testOnlyAllowTrustedLocalProcessExecution) {
            return unavailable("NativeOsProviderRequired");
          }
          if (!Option.isSome(trustedLocalProcess)) {
            return {
              _tag: "Rejected" as const,
              failureCode: "ProcessCapabilityNotBound",
            };
          }
          return yield* trustedLocalProcess.value.run({
            ...invocation,
            timeoutMs,
            policy,
            handle,
          });
        }

        if (networkPolicy === undefined) {
          return {
            _tag: "Rejected" as const,
            failureCode: "PolicyMissing",
          };
        }

        if (!Option.isSome(sandboxProcess)) {
          return unavailable("SandboxProcessPortUnavailable");
        }

        const capabilities = yield* sandboxProcess.value.capabilities();
        const resolved = resolveSandboxProvider(
          {
            providerId: policy.providerId,
            expectedProviderVersion: policy.providerVersion,
            expectedCapabilityRevision: policy.capabilityRevision,
            expectedEnforcementRuleSetDigest:
              policy.enforcementRuleSetDigest,
            expectedQualificationEvidenceRef:
              policy.qualificationEvidenceRef,
            profile: policy.profile,
            networkPolicy,
            boundary: policy.boundary,
          },
          capabilities,
        );
        if (resolved._tag !== "Available") {
          return unavailable(
            resolved.reason,
            resolved.capability?.probeEvidenceRef ?? null,
          );
        }

        const result = yield* sandboxProcess.value.run({
          ...invocation,
          timeoutMs,
          policy,
          handle,
        });
        if (result._tag === "Unavailable") {
          if (
            result.providerId !== policy.providerId ||
            result.providerVersion !== policy.providerVersion ||
            result.capabilityRevision !== policy.capabilityRevision ||
            result.failureCode.trim() !== result.failureCode ||
            result.failureCode.length === 0 ||
            new TextEncoder().encode(result.failureCode).byteLength > 128
          ) {
            return {
              _tag: "Rejected" as const,
              failureCode: "ProviderOutcomeMismatch",
            };
          }
          return unavailable(
            result.failureCode,
            result.probeEvidenceRef,
            result.providerVersion,
            result.capabilityRevision,
          );
        }
        return result;
      });

  return runProcessFor;
};
