import {
  CommandId as CommandIdSchema,
  ExecutionId as ExecutionIdSchema,
  ProjectId as ProjectIdSchema,
  parse,
  WorkspaceId as WorkspaceIdSchema,
} from "./ids.js";
import {
  decodeCanonicalExecutionEpisodeBinding,
  decodeNetworkPolicyV1,
  encodeExecutionEpisodeBinding,
  encodeNetworkPolicyV1,
} from "./sandbox-policy.js";
import type {
  SandboxNetworkBrokerControlsV2,
  SandboxPolicyMountV1,
} from "./sandbox-policy-producers.js";
import {
  decodeNetworkBrokerControlsV2,
  encodeNetworkBrokerControlsV2,
  encodeSandboxTargetRefV1,
} from "./sandbox-policy-producers.js";
import type {
  OsEnforcedPolicySummaryV1,
  SandboxPolicyDecisionCommittedInternalV1,
  SandboxPolicyDecisionCommittedViewV1,
  SandboxPolicyLimitsV1,
} from "./sandbox-policy-result.js";
import { decodeEffectivePolicySummaryV1 } from "./sandbox-policy-result.js";

export interface OsEnforcedPolicySummaryV2
  extends Omit<OsEnforcedPolicySummaryV1, "version" | "networkBrokerControls"> {
  readonly version: 2;
  readonly networkBrokerControls: SandboxNetworkBrokerControlsV2;
}

export type EffectivePolicySummaryV2 = OsEnforcedPolicySummaryV2;

export interface SandboxPolicyDecisionCommittedInternalV2
  extends Omit<
    SandboxPolicyDecisionCommittedInternalV1,
    "version" | "effectivePolicySnapshot"
  > {
  readonly version: 2;
  readonly effectivePolicySnapshot: EffectivePolicySummaryV2;
}

const digestPattern = /^[0-9a-f]{64}$/u;
const safePositive = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0;
const exactKeys = (
  value: Record<string, unknown>,
  expected: ReadonlyArray<string>,
): boolean =>
  Object.keys(value).length === expected.length &&
  expected.every((key) => Object.hasOwn(value, key));

const encodeMount = (mount: SandboxPolicyMountV1): string =>
  `{"mountId":${JSON.stringify(mount.mountId)},"targetRef":${encodeSandboxTargetRefV1(mount.targetRef)},"targetIdentityDigest":${JSON.stringify(mount.targetIdentityDigest)},"access":${JSON.stringify(mount.access)}}`;
const encodeLimits = (limits: SandboxPolicyLimitsV1): string =>
  `{"wallTimeMs":${limits.wallTimeMs},"stdoutBytes":${limits.stdoutBytes},"stderrBytes":${limits.stderrBytes},"processCount":${limits.processCount},"memoryBytes":${limits.memoryBytes},"cpuTimeMs":${limits.cpuTimeMs}}`;

const encodeCommon = (summary: OsEnforcedPolicySummaryV2): string =>
  `"version":2,"kind":"OsEnforced","projectId":${JSON.stringify(summary.projectId)},"workspaceId":${JSON.stringify(summary.workspaceId)},"executionId":${JSON.stringify(summary.executionId)},"episodeBinding":${encodeExecutionEpisodeBinding(summary.episodeBinding)},"workspaceRevision":${summary.workspaceRevision},"resourceBoundaryRevision":${summary.resourceBoundaryRevision},"resourceBoundaryDigest":${JSON.stringify(summary.resourceBoundaryDigest)},"sandboxEnvironmentBasisDigest":${JSON.stringify(summary.sandboxEnvironmentBasisDigest)},"policyRevision":${summary.policyRevision},"expiresAt":${JSON.stringify(summary.expiresAt)},"profile":${JSON.stringify(summary.profile)},"providerId":${JSON.stringify(summary.providerId)},"providerVersion":${JSON.stringify(summary.providerVersion)},"capabilityRevision":${summary.capabilityRevision},"osFamily":"Linux","osBuild":${JSON.stringify(summary.osBuild)},"qualificationEvidenceRef":${JSON.stringify(summary.qualificationEvidenceRef)},"networkPolicy":${encodeNetworkPolicyV1(summary.networkPolicy)},"networkPolicyDigest":${JSON.stringify(summary.networkPolicyDigest)},"networkBrokerControls":${encodeNetworkBrokerControlsV2(summary.networkBrokerControls)},"providerRegistryRevision":${summary.providerRegistryRevision},"providerRegistryDigest":${JSON.stringify(summary.providerRegistryDigest)},"sandboxHandleBindingDigest":${JSON.stringify(summary.sandboxHandleBindingDigest)},"mounts":[${summary.mounts.map(encodeMount).join(",")}],"environmentAllowlist":[${summary.environmentAllowlist.map((name) => JSON.stringify(name)).join(",")}],"limits":${encodeLimits(summary.limits)},"auditRefs":[${summary.auditRefs.map((ref) => JSON.stringify(ref)).join(",")}],"authorityBundleRevision":${summary.authorityBundleRevision},"authorityBundleDigest":${JSON.stringify(summary.authorityBundleDigest)},"operatorConfigRevision":${summary.operatorConfigRevision},"operatorConfigDigest":${JSON.stringify(summary.operatorConfigDigest)}`;

export const encodeEffectivePolicySummaryV2 = (
  summary: OsEnforcedPolicySummaryV2,
): string => `{${encodeCommon(summary)}}`;

const normalizeV2SummaryToV1 = (
  value: Record<string, unknown>,
): Record<string, unknown> => ({
  ...value,
  version: 1,
  networkBrokerControls: networkBrokerControlsV1ForMode(
    (
      value.networkBrokerControls as {
        mode: "Disabled" | "Restricted" | "Enabled";
      }
    ).mode,
  ),
});

const networkBrokerControlsV1ForMode = (
  mode: "Disabled" | "Restricted" | "Enabled",
) =>
  mode === "Disabled"
    ? {
        version: 1 as const,
        mode,
        directNetwork: "Denied" as const,
        broker: "Disabled" as const,
      }
    : {
        version: 1 as const,
        mode,
        brokerProtocolVersion: 1 as const,
        directNetwork: "Denied" as const,
        dns: "BrokerOnly" as const,
        pref64: "FreshPerResolutionAndConnection" as const,
        ipPinning: "AllAnswersPublicPerConnection" as const,
        redirectMaxHops: 5 as const,
        tlsIdentity: "ExactSniHostCertificate" as const,
        rawIp: "Denied" as const,
        udp: "Denied" as const,
        specialUse: "Denied" as const,
      };

const decodeV2SummaryShape = (
  input: unknown,
  digestOf: (canonicalBytes: string) => string,
): OsEnforcedPolicySummaryV2 | undefined => {
  if (typeof input !== "object" || input === null || Array.isArray(input))
    return undefined;
  const value = input as Record<string, unknown>;
  const keys = [
    "version",
    "kind",
    "projectId",
    "workspaceId",
    "executionId",
    "episodeBinding",
    "workspaceRevision",
    "resourceBoundaryRevision",
    "resourceBoundaryDigest",
    "sandboxEnvironmentBasisDigest",
    "policyRevision",
    "expiresAt",
    "profile",
    "providerId",
    "providerVersion",
    "capabilityRevision",
    "osFamily",
    "osBuild",
    "qualificationEvidenceRef",
    "networkPolicy",
    "networkPolicyDigest",
    "networkBrokerControls",
    "providerRegistryRevision",
    "providerRegistryDigest",
    "sandboxHandleBindingDigest",
    "mounts",
    "environmentAllowlist",
    "limits",
    "auditRefs",
    "authorityBundleRevision",
    "authorityBundleDigest",
    "operatorConfigRevision",
    "operatorConfigDigest",
  ];
  const controls = decodeNetworkBrokerControlsV2(value.networkBrokerControls);
  const policy = decodeNetworkPolicyV1(value.networkPolicy);
  if (
    !exactKeys(value, keys) ||
    value.version !== 2 ||
    value.kind !== "OsEnforced" ||
    value.osFamily !== "Linux" ||
    value.providerId !== "linux-bwrap" ||
    controls === undefined ||
    policy === undefined ||
    controls.mode !== policy.mode ||
    !digestPattern.test(String(value.networkPolicyDigest)) ||
    digestOf(encodeNetworkPolicyV1(policy)) !== value.networkPolicyDigest
  )
    return undefined;
  const normalized = normalizeV2SummaryToV1(value);
  const legacy = decodeEffectivePolicySummaryV1(normalized, digestOf);
  if (legacy === undefined || legacy.kind !== "OsEnforced") return undefined;
  const summary = {
    ...legacy,
    version: 2 as const,
    networkBrokerControls: controls,
  } satisfies OsEnforcedPolicySummaryV2;
  return encodeEffectivePolicySummaryV2(summary) === JSON.stringify(value)
    ? summary
    : undefined;
};

export const decodeEffectivePolicySummaryV2 = (
  input: unknown,
  digestOf: (canonicalBytes: string) => string,
): EffectivePolicySummaryV2 | undefined =>
  decodeV2SummaryShape(input, digestOf);

export const encodeSandboxPolicyDecisionCommittedInternalV2 = (
  result: SandboxPolicyDecisionCommittedInternalV2,
): string =>
  `{"version":2,"commandId":${JSON.stringify(result.commandId)},"projectId":${JSON.stringify(result.projectId)},"workspaceId":${JSON.stringify(result.workspaceId)},"executionId":${JSON.stringify(result.executionId)},"episodeBinding":${encodeExecutionEpisodeBinding(result.episodeBinding)},"policyRevision":${result.policyRevision},"policyDigest":${JSON.stringify(result.policyDigest)},"effectivePolicySnapshot":${encodeEffectivePolicySummaryV2(result.effectivePolicySnapshot)}}`;

export const decodeCanonicalSandboxPolicyDecisionCommittedInternalV2 = (
  json: string,
  digestOf: (canonicalBytes: string) => string,
): SandboxPolicyDecisionCommittedInternalV2 | undefined => {
  try {
    let byteLength = 0;
    for (const character of json) {
      const code = character.codePointAt(0) ?? 0;
      byteLength +=
        code <= 0x7f ? 1 : code <= 0x7ff ? 2 : code <= 0xffff ? 3 : 4;
      if (byteLength > 65_536) return undefined;
    }
    const row = JSON.parse(json) as Record<string, unknown>;
    const keys = [
      "version",
      "commandId",
      "projectId",
      "workspaceId",
      "executionId",
      "episodeBinding",
      "policyRevision",
      "policyDigest",
      "effectivePolicySnapshot",
    ];
    if (
      !exactKeys(row, keys) ||
      row.version !== 2 ||
      typeof row.commandId !== "string" ||
      !safePositive(row.policyRevision) ||
      !digestPattern.test(String(row.policyDigest))
    )
      return undefined;
    const snapshot = decodeV2SummaryShape(
      row.effectivePolicySnapshot,
      digestOf,
    );
    if (
      snapshot === undefined ||
      snapshot.projectId !== row.projectId ||
      snapshot.workspaceId !== row.workspaceId ||
      snapshot.executionId !== row.executionId ||
      snapshot.policyRevision !== row.policyRevision ||
      encodeExecutionEpisodeBinding(snapshot.episodeBinding) !==
        JSON.stringify(row.episodeBinding) ||
      digestOf(encodeEffectivePolicySummaryV2(snapshot)) !== row.policyDigest
    )
      return undefined;
    const episode = decodeCanonicalExecutionEpisodeBinding(
      JSON.stringify(row.episodeBinding),
    );
    if (episode === undefined) return undefined;
    const result: SandboxPolicyDecisionCommittedInternalV2 = {
      version: 2,
      commandId: parse(CommandIdSchema)(String(row.commandId)),
      projectId: parse(ProjectIdSchema)(String(row.projectId)),
      workspaceId: parse(WorkspaceIdSchema)(String(row.workspaceId)),
      executionId: parse(ExecutionIdSchema)(String(row.executionId)),
      episodeBinding: episode,
      policyRevision: row.policyRevision,
      policyDigest: String(row.policyDigest),
      effectivePolicySnapshot: snapshot,
    };
    return encodeSandboxPolicyDecisionCommittedInternalV2(result) === json
      ? result
      : undefined;
  } catch {
    return undefined;
  }
};

export const sandboxPolicyCommittedViewOfV2 = (
  result: SandboxPolicyDecisionCommittedInternalV2,
): SandboxPolicyDecisionCommittedViewV1 => ({
  kind: "OsEnforced",
  profile: result.effectivePolicySnapshot.profile,
  providerId: result.effectivePolicySnapshot.providerId,
  providerVersion: result.effectivePolicySnapshot.providerVersion,
  networkMode: result.effectivePolicySnapshot.networkPolicy.mode,
  policyRevision: result.policyRevision,
  expiresAt: result.effectivePolicySnapshot.expiresAt,
  status: "Committed",
});
