import type { ExecutionEpisodeBinding } from "./execution.js";
import type { ExecutionId, ProjectId, WorkspaceId } from "./ids.js";
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
  decodeSandboxProviderId,
  encodeExecutionEpisodeBinding,
  encodeNetworkPolicyV1,
} from "./sandbox-policy.js";
import type {
  SandboxNetworkBrokerControlsV1,
  SandboxPolicyMountV1,
} from "./sandbox-policy-producers.js";
import {
  decodeNetworkBrokerControlsV1,
  decodeSandboxTargetRefV1,
  encodeNetworkBrokerControlsV1,
  encodeSandboxTargetRefV1,
} from "./sandbox-policy-producers.js";

export type {
  SandboxNetworkBrokerControlsV1,
  SandboxPolicyMountV1,
} from "./sandbox-policy-producers.js";

export interface SandboxPolicyLimitsV1 {
  readonly wallTimeMs: number;
  readonly stdoutBytes: number;
  readonly stderrBytes: number;
  readonly processCount: number;
  readonly memoryBytes: number;
  readonly cpuTimeMs: number;
}

export interface OsEnforcedPolicySummaryV1 {
  readonly version: 1;
  readonly kind: "OsEnforced";
  readonly projectId: ProjectId;
  readonly workspaceId: WorkspaceId;
  readonly executionId: ExecutionId;
  readonly episodeBinding: ExecutionEpisodeBinding;
  readonly workspaceRevision: number;
  readonly resourceBoundaryRevision: number;
  readonly resourceBoundaryDigest: string;
  readonly sandboxEnvironmentBasisDigest: string;
  readonly policyRevision: number;
  readonly expiresAt: string;
  readonly profile: "ReadOnly" | "WorkspaceWrite";
  readonly providerId: string;
  readonly providerVersion: string;
  readonly capabilityRevision: number;
  readonly osFamily: "Linux" | "macOS" | "Windows";
  readonly osBuild: string;
  readonly qualificationEvidenceRef: string;
  readonly networkPolicy: import("./sandbox-policy.js").NetworkPolicyV1;
  readonly networkPolicyDigest: string;
  readonly networkBrokerControls: SandboxNetworkBrokerControlsV1;
  readonly providerRegistryRevision: number;
  readonly providerRegistryDigest: string;
  readonly sandboxHandleBindingDigest: string;
  readonly mounts: ReadonlyArray<SandboxPolicyMountV1>;
  readonly environmentAllowlist: ReadonlyArray<string>;
  readonly limits: SandboxPolicyLimitsV1;
  readonly auditRefs: ReadonlyArray<string>;
  readonly authorityBundleRevision: number;
  readonly authorityBundleDigest: string;
  readonly operatorConfigRevision: number;
  readonly operatorConfigDigest: string;
}

export interface TrustedLocalUnconfinedPolicySummaryV1 {
  readonly version: 1;
  readonly kind: "TrustedLocalUnconfinedV1";
  readonly projectId: ProjectId;
  readonly workspaceId: WorkspaceId;
  readonly executionId: ExecutionId;
  readonly episodeBinding: ExecutionEpisodeBinding;
  readonly workspaceRevision: number;
  readonly resourceBoundaryRevision: number;
  readonly resourceBoundaryDigest: string;
  readonly sandboxEnvironmentBasisDigest: string;
  readonly policyRevision: number;
  readonly expiresAt: string;
  readonly trustedRuntimeIdentity: "TrustedLocal";
  readonly trustedRuntimeVersion: "builtin-v1";
  readonly profile: "FullAccess";
  readonly networkBoundary: "Unconfined";
  readonly sandboxHandleBindingDigest: string;
  readonly mounts: ReadonlyArray<SandboxPolicyMountV1>;
  readonly environmentAllowlist: ReadonlyArray<string>;
  readonly limits: SandboxPolicyLimitsV1;
  readonly auditRefs: ReadonlyArray<string>;
  readonly authorityBundleRevision: number;
  readonly authorityBundleDigest: string;
  readonly operatorConfigRevision: number;
  readonly operatorConfigDigest: string;
}

export type EffectivePolicySummaryV1 =
  | OsEnforcedPolicySummaryV1
  | TrustedLocalUnconfinedPolicySummaryV1;

export interface SandboxPolicyDecisionCommittedInternalV1 {
  readonly version: 1;
  readonly commandId: import("./ids.js").CommandId;
  readonly projectId: ProjectId;
  readonly workspaceId: WorkspaceId;
  readonly executionId: ExecutionId;
  readonly episodeBinding: ExecutionEpisodeBinding;
  readonly policyRevision: number;
  readonly policyDigest: string;
  readonly effectivePolicySnapshot: EffectivePolicySummaryV1;
}

export type SandboxPolicyDecisionCommittedViewV1 =
  | {
      readonly kind: "OsEnforced";
      readonly profile: "ReadOnly" | "WorkspaceWrite";
      readonly providerId: string;
      readonly providerVersion: string;
      readonly networkMode: "Disabled" | "Restricted" | "Enabled";
      readonly policyRevision: number;
      readonly expiresAt: string;
      readonly status: "Committed";
    }
  | {
      readonly kind: "TrustedLocalUnconfinedV1";
      readonly profile: "FullAccess";
      readonly networkBoundary: "Unconfined";
      readonly policyRevision: number;
      readonly expiresAt: string;
      readonly status: "Committed";
    };

export type SandboxPolicyStatusViewV1 =
  | (Omit<
      Extract<SandboxPolicyDecisionCommittedViewV1, { kind: "OsEnforced" }>,
      "status"
    > & {
      readonly status: "Committed" | "Unavailable" | "NeedsDecision";
    })
  | (Omit<
      Extract<
        SandboxPolicyDecisionCommittedViewV1,
        { kind: "TrustedLocalUnconfinedV1" }
      >,
      "status"
    > & {
      readonly status: "Committed" | "Unavailable" | "NeedsDecision";
    });

interface SandboxPolicyPreconditionsCommonV1 {
  readonly expectedEpisodeRevision: number;
  readonly latestCommittedPolicyRevision: number;
  readonly episodeBinding: ExecutionEpisodeBinding;
  readonly workspaceRevision: number;
  readonly resourceBoundaryRevision: number;
  readonly sandboxHandleBindingDigest: string;
  readonly authorityBundleRevision: number;
  readonly authorityBundleDigest: string;
  readonly operatorConfigRevision: number;
  readonly operatorConfigDigest: string;
}

export type SandboxPolicyPreconditionsV1 =
  | (SandboxPolicyPreconditionsCommonV1 & {
      readonly kind: "OsEnforced";
      readonly providerRegistryRevision: number;
      readonly providerRegistryDigest: string;
    })
  | (SandboxPolicyPreconditionsCommonV1 & {
      readonly kind: "TrustedLocalUnconfinedV1";
    });

const digestPattern = /^[0-9a-f]{64}$/u;
const opaque = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length > 0 &&
  value.length <= 128 &&
  value === value.trim() &&
  !/[\\/]/u.test(value) &&
  !/\p{Cc}/u.test(value) &&
  !value.includes("..");
const safePositive = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0;
const safeNonnegative = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const exactKeys = (
  value: Record<string, unknown>,
  expected: ReadonlyArray<string>,
) =>
  Object.keys(value).length === expected.length &&
  expected.every((key) => Object.hasOwn(value, key));
const canonicalInstant = (value: unknown): value is string =>
  typeof value === "string" &&
  Number.isFinite(Date.parse(value)) &&
  new Date(Date.parse(value)).toISOString() === value;
const utf8Compare = (left: string, right: string): number => {
  const a = Array.from(left, (c) => c.codePointAt(0) ?? 0);
  const b = Array.from(right, (c) => c.codePointAt(0) ?? 0);
  for (let i = 0; i < Math.min(a.length, b.length); i += 1) {
    const difference = (a[i] ?? 0) - (b[i] ?? 0);
    if (difference !== 0) return difference;
  }
  return a.length - b.length;
};
const sortedUnique = (values: ReadonlyArray<string>): boolean =>
  values.every(
    (value, index) =>
      index === 0 || utf8Compare(values[index - 1] ?? "", value) < 0,
  );
const utf8Length = (text: string): number => {
  let size = 0;
  for (const character of text) {
    const code = character.codePointAt(0) ?? 0;
    size += code <= 0x7f ? 1 : code <= 0x7ff ? 2 : code <= 0xffff ? 3 : 4;
  }
  return size;
};

const encodeMount = (mount: SandboxPolicyMountV1): string =>
  `{"mountId":${JSON.stringify(mount.mountId)},"targetRef":${encodeSandboxTargetRefV1(mount.targetRef)},"targetIdentityDigest":${JSON.stringify(mount.targetIdentityDigest)},"access":${JSON.stringify(mount.access)}}`;
const encodeLimits = (limits: SandboxPolicyLimitsV1): string =>
  `{"wallTimeMs":${limits.wallTimeMs},"stdoutBytes":${limits.stdoutBytes},"stderrBytes":${limits.stderrBytes},"processCount":${limits.processCount},"memoryBytes":${limits.memoryBytes},"cpuTimeMs":${limits.cpuTimeMs}}`;
const encodeBroker = (controls: SandboxNetworkBrokerControlsV1): string =>
  encodeNetworkBrokerControlsV1(controls);

export const encodeEffectivePolicySummaryV1 = (
  summary: EffectivePolicySummaryV1,
): string => {
  const common = `"version":1,"kind":${JSON.stringify(summary.kind)},"projectId":${JSON.stringify(summary.projectId)},"workspaceId":${JSON.stringify(summary.workspaceId)},"executionId":${JSON.stringify(summary.executionId)},"episodeBinding":${encodeExecutionEpisodeBinding(summary.episodeBinding)},"workspaceRevision":${summary.workspaceRevision},"resourceBoundaryRevision":${summary.resourceBoundaryRevision},"resourceBoundaryDigest":${JSON.stringify(summary.resourceBoundaryDigest)},"sandboxEnvironmentBasisDigest":${JSON.stringify(summary.sandboxEnvironmentBasisDigest)},"policyRevision":${summary.policyRevision}`;
  const mounts = `[${summary.mounts.map(encodeMount).join(",")}]`;
  const environment = `[${summary.environmentAllowlist.map((name) => JSON.stringify(name)).join(",")}]`;
  const auditRefs = `[${summary.auditRefs.map((ref) => JSON.stringify(ref)).join(",")}]`;
  const authority = `"authorityBundleRevision":${summary.authorityBundleRevision},"authorityBundleDigest":${JSON.stringify(summary.authorityBundleDigest)},"operatorConfigRevision":${summary.operatorConfigRevision},"operatorConfigDigest":${JSON.stringify(summary.operatorConfigDigest)}`;
  if (summary.kind === "OsEnforced") {
    return `{${common},"expiresAt":${JSON.stringify(summary.expiresAt)},"profile":${JSON.stringify(summary.profile)},"providerId":${JSON.stringify(summary.providerId)},"providerVersion":${JSON.stringify(summary.providerVersion)},"capabilityRevision":${summary.capabilityRevision},"osFamily":${JSON.stringify(summary.osFamily)},"osBuild":${JSON.stringify(summary.osBuild)},"qualificationEvidenceRef":${JSON.stringify(summary.qualificationEvidenceRef)},"networkPolicy":${encodeNetworkPolicyV1(summary.networkPolicy)},"networkPolicyDigest":${JSON.stringify(summary.networkPolicyDigest)},"networkBrokerControls":${encodeBroker(summary.networkBrokerControls)},"providerRegistryRevision":${summary.providerRegistryRevision},"providerRegistryDigest":${JSON.stringify(summary.providerRegistryDigest)},"sandboxHandleBindingDigest":${JSON.stringify(summary.sandboxHandleBindingDigest)},"mounts":${mounts},"environmentAllowlist":${environment},"limits":${encodeLimits(summary.limits)},"auditRefs":${auditRefs},${authority}}`;
  }
  return `{${common},"expiresAt":${JSON.stringify(summary.expiresAt)},"trustedRuntimeIdentity":"TrustedLocal","trustedRuntimeVersion":"builtin-v1","profile":"FullAccess","networkBoundary":"Unconfined","sandboxHandleBindingDigest":${JSON.stringify(summary.sandboxHandleBindingDigest)},"mounts":${mounts},"environmentAllowlist":${environment},"limits":${encodeLimits(summary.limits)},"auditRefs":${auditRefs},${authority}}`;
};

const decodeEpisode = (value: unknown): ExecutionEpisodeBinding | undefined => {
  try {
    return decodeCanonicalExecutionEpisodeBinding(JSON.stringify(value));
  } catch {
    return undefined;
  }
};

const decodeMounts = (
  value: unknown,
): ReadonlyArray<SandboxPolicyMountV1> | undefined => {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  const mounts: SandboxPolicyMountV1[] = [];
  for (const raw of value) {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw))
      return undefined;
    const mount = raw as Record<string, unknown>;
    const targetRef = decodeSandboxTargetRefV1(mount.targetRef);
    if (
      !exactKeys(mount, [
        "mountId",
        "targetRef",
        "targetIdentityDigest",
        "access",
      ]) ||
      !opaque(mount.mountId) ||
      targetRef === undefined ||
      !digestPattern.test(String(mount.targetIdentityDigest)) ||
      !["ReadOnly", "ReadWrite"].includes(String(mount.access))
    )
      return undefined;
    mounts.push({
      mountId: mount.mountId,
      targetRef,
      targetIdentityDigest: mount.targetIdentityDigest as string,
      access: mount.access as SandboxPolicyMountV1["access"],
    });
  }
  return sortedUnique(mounts.map((mount) => mount.mountId))
    ? mounts
    : undefined;
};

const decodeLimits = (value: unknown): SandboxPolicyLimitsV1 | undefined => {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return undefined;
  const limits = value as Record<string, unknown>;
  const keys = [
    "wallTimeMs",
    "stdoutBytes",
    "stderrBytes",
    "processCount",
    "memoryBytes",
    "cpuTimeMs",
  ];
  if (
    !exactKeys(limits, keys) ||
    keys.some((key) => !safePositive(limits[key]))
  )
    return undefined;
  return limits as unknown as SandboxPolicyLimitsV1;
};

const decodeNames = (value: unknown): ReadonlyArray<string> | undefined =>
  Array.isArray(value) &&
  value.every(
    (name) =>
      typeof name === "string" && /^[A-Za-z_][A-Za-z0-9_]*$/u.test(name),
  ) &&
  sortedUnique(value)
    ? (value as ReadonlyArray<string>)
    : undefined;
const decodeAuditRefs = (value: unknown): ReadonlyArray<string> | undefined =>
  Array.isArray(value) &&
  value.length <= 32 &&
  value.every((ref) => opaque(ref) && utf8Length(ref) <= 128) &&
  sortedUnique(value)
    ? (value as ReadonlyArray<string>)
    : undefined;

const validCommon = (value: Record<string, unknown>) =>
  value.version === 1 &&
  typeof value.projectId === "string" &&
  typeof value.workspaceId === "string" &&
  typeof value.executionId === "string" &&
  decodeEpisode(value.episodeBinding) !== undefined &&
  safeNonnegative(value.workspaceRevision) &&
  safeNonnegative(value.resourceBoundaryRevision) &&
  digestPattern.test(String(value.resourceBoundaryDigest)) &&
  digestPattern.test(String(value.sandboxEnvironmentBasisDigest)) &&
  safePositive(value.policyRevision) &&
  canonicalInstant(value.expiresAt) &&
  digestPattern.test(String(value.sandboxHandleBindingDigest)) &&
  decodeMounts(value.mounts) !== undefined &&
  decodeNames(value.environmentAllowlist) !== undefined &&
  decodeLimits(value.limits) !== undefined &&
  decodeAuditRefs(value.auditRefs) !== undefined &&
  safePositive(value.authorityBundleRevision) &&
  digestPattern.test(String(value.authorityBundleDigest)) &&
  safePositive(value.operatorConfigRevision) &&
  digestPattern.test(String(value.operatorConfigDigest));

export const decodeEffectivePolicySummaryV1 = (
  input: unknown,
  digestOf: (canonicalBytes: string) => string,
): EffectivePolicySummaryV1 | undefined => {
  if (typeof input !== "object" || input === null || Array.isArray(input))
    return undefined;
  const value = input as Record<string, unknown>;
  try {
    if (value.kind === "OsEnforced") {
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
      const policy = decodeNetworkPolicyV1(value.networkPolicy);
      const controls = decodeNetworkBrokerControlsV1(
        value.networkBrokerControls,
      );
      if (
        !exactKeys(value, keys) ||
        !validCommon(value) ||
        !["ReadOnly", "WorkspaceWrite"].includes(String(value.profile)) ||
        decodeSandboxProviderId(value.providerId) !== value.providerId ||
        !opaque(value.providerVersion) ||
        !safePositive(value.capabilityRevision) ||
        !["Linux", "macOS", "Windows"].includes(String(value.osFamily)) ||
        !opaque(value.osBuild) ||
        typeof value.qualificationEvidenceRef !== "string" ||
        !/^blob:sha256:[0-9a-f]{64}$/u.test(value.qualificationEvidenceRef) ||
        policy === undefined ||
        !digestPattern.test(String(value.networkPolicyDigest)) ||
        digestOf(encodeNetworkPolicyV1(policy)) !== value.networkPolicyDigest ||
        controls === undefined ||
        controls.mode !== policy.mode ||
        !safePositive(value.providerRegistryRevision) ||
        !digestPattern.test(String(value.providerRegistryDigest))
      )
        return undefined;
      const summary = value as unknown as OsEnforcedPolicySummaryV1;
      return encodeEffectivePolicySummaryV1(summary) === JSON.stringify(value)
        ? summary
        : undefined;
    }
    if (value.kind === "TrustedLocalUnconfinedV1") {
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
        "trustedRuntimeIdentity",
        "trustedRuntimeVersion",
        "profile",
        "networkBoundary",
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
      if (
        !exactKeys(value, keys) ||
        !validCommon(value) ||
        value.trustedRuntimeIdentity !== "TrustedLocal" ||
        value.trustedRuntimeVersion !== "builtin-v1" ||
        value.profile !== "FullAccess" ||
        value.networkBoundary !== "Unconfined"
      )
        return undefined;
      const summary = value as unknown as TrustedLocalUnconfinedPolicySummaryV1;
      return encodeEffectivePolicySummaryV1(summary) === JSON.stringify(value)
        ? summary
        : undefined;
    }
    return undefined;
  } catch {
    return undefined;
  }
};

export const decodeCanonicalSandboxPolicyDecisionCommittedInternalV1 = (
  json: string,
  digestOf: (canonicalBytes: string) => string,
): SandboxPolicyDecisionCommittedInternalV1 | undefined => {
  try {
    if (utf8Length(json) > 65_536) return undefined;
    const value: unknown = JSON.parse(json);
    if (typeof value !== "object" || value === null || Array.isArray(value))
      return undefined;
    const row = value as Record<string, unknown>;
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
      row.version !== 1 ||
      typeof row.commandId !== "string" ||
      !safePositive(row.policyRevision) ||
      !digestPattern.test(String(row.policyDigest))
    )
      return undefined;
    const snapshot = decodeEffectivePolicySummaryV1(
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
      digestOf(encodeEffectivePolicySummaryV1(snapshot)) !== row.policyDigest
    )
      return undefined;
    const result: SandboxPolicyDecisionCommittedInternalV1 = {
      version: 1,
      commandId: parse(CommandIdSchema)(row.commandId),
      projectId: parse(ProjectIdSchema)(String(row.projectId)),
      workspaceId: parse(WorkspaceIdSchema)(String(row.workspaceId)),
      executionId: parse(ExecutionIdSchema)(String(row.executionId)),
      episodeBinding: snapshot.episodeBinding,
      policyRevision: row.policyRevision as number,
      policyDigest: row.policyDigest as string,
      effectivePolicySnapshot: snapshot,
    };
    return encodeSandboxPolicyDecisionCommittedInternalV1(result) === json
      ? result
      : undefined;
  } catch {
    return undefined;
  }
};

export const encodeSandboxPolicyDecisionCommittedInternalV1 = (
  result: SandboxPolicyDecisionCommittedInternalV1,
): string =>
  `{"version":1,"commandId":${JSON.stringify(result.commandId)},"projectId":${JSON.stringify(result.projectId)},"workspaceId":${JSON.stringify(result.workspaceId)},"executionId":${JSON.stringify(result.executionId)},"episodeBinding":${encodeExecutionEpisodeBinding(result.episodeBinding)},"policyRevision":${result.policyRevision},"policyDigest":${JSON.stringify(result.policyDigest)},"effectivePolicySnapshot":${encodeEffectivePolicySummaryV1(result.effectivePolicySnapshot)}}`;

export const sandboxPolicyCommittedViewOf = (
  result: SandboxPolicyDecisionCommittedInternalV1,
): SandboxPolicyDecisionCommittedViewV1 => {
  const snapshot = result.effectivePolicySnapshot;
  return snapshot.kind === "OsEnforced"
    ? {
        kind: "OsEnforced",
        profile: snapshot.profile,
        providerId: snapshot.providerId,
        providerVersion: snapshot.providerVersion,
        networkMode: snapshot.networkPolicy.mode,
        policyRevision: snapshot.policyRevision,
        expiresAt: snapshot.expiresAt,
        status: "Committed",
      }
    : {
        kind: "TrustedLocalUnconfinedV1",
        profile: "FullAccess",
        networkBoundary: "Unconfined",
        policyRevision: snapshot.policyRevision,
        expiresAt: snapshot.expiresAt,
        status: "Committed",
      };
};

export const decodeSandboxPolicyPreconditionsV1 = (
  input: unknown,
): SandboxPolicyPreconditionsV1 | undefined => {
  if (typeof input !== "object" || input === null || Array.isArray(input))
    return undefined;
  const value = input as Record<string, unknown>;
  const commonKeys = [
    "expectedEpisodeRevision",
    "latestCommittedPolicyRevision",
    "episodeBinding",
    "workspaceRevision",
    "resourceBoundaryRevision",
    "sandboxHandleBindingDigest",
    "authorityBundleRevision",
    "authorityBundleDigest",
    "operatorConfigRevision",
    "operatorConfigDigest",
  ];
  const episodeBinding = decodeEpisode(value.episodeBinding);
  if (
    commonKeys.some((key) => !Object.hasOwn(value, key)) ||
    !safeNonnegative(value.expectedEpisodeRevision) ||
    !safeNonnegative(value.latestCommittedPolicyRevision) ||
    episodeBinding === undefined ||
    !safeNonnegative(value.workspaceRevision) ||
    !safeNonnegative(value.resourceBoundaryRevision) ||
    !digestPattern.test(String(value.sandboxHandleBindingDigest)) ||
    !safePositive(value.authorityBundleRevision) ||
    !digestPattern.test(String(value.authorityBundleDigest)) ||
    !safePositive(value.operatorConfigRevision) ||
    !digestPattern.test(String(value.operatorConfigDigest))
  )
    return undefined;
  const hasRegistryRevision = Object.hasOwn(value, "providerRegistryRevision");
  const hasRegistryDigest = Object.hasOwn(value, "providerRegistryDigest");
  if (hasRegistryRevision !== hasRegistryDigest) return undefined;
  const osEnforced = hasRegistryRevision;
  const expected = [
    ...commonKeys,
    ...(osEnforced
      ? ["providerRegistryRevision", "providerRegistryDigest"]
      : []),
  ];
  if (
    !exactKeys(value, expected) ||
    (osEnforced &&
      (!safePositive(value.providerRegistryRevision) ||
        !digestPattern.test(String(value.providerRegistryDigest))))
  )
    return undefined;
  return osEnforced
    ? ({
        ...value,
        kind: "OsEnforced",
        episodeBinding,
      } as unknown as SandboxPolicyPreconditionsV1)
    : ({
        ...value,
        kind: "TrustedLocalUnconfinedV1",
        episodeBinding,
      } as unknown as SandboxPolicyPreconditionsV1);
};

export const encodeSandboxPolicyPreconditionsV1 = (
  value: SandboxPolicyPreconditionsV1,
): string => {
  const common = `"expectedEpisodeRevision":${value.expectedEpisodeRevision},"latestCommittedPolicyRevision":${value.latestCommittedPolicyRevision},"episodeBinding":${encodeExecutionEpisodeBinding(value.episodeBinding)},"workspaceRevision":${value.workspaceRevision},"resourceBoundaryRevision":${value.resourceBoundaryRevision},"sandboxHandleBindingDigest":${JSON.stringify(value.sandboxHandleBindingDigest)},"authorityBundleRevision":${value.authorityBundleRevision},"authorityBundleDigest":${JSON.stringify(value.authorityBundleDigest)},"operatorConfigRevision":${value.operatorConfigRevision},"operatorConfigDigest":${JSON.stringify(value.operatorConfigDigest)}`;
  return value.kind === "OsEnforced"
    ? `{${common},"providerRegistryRevision":${value.providerRegistryRevision},"providerRegistryDigest":${JSON.stringify(value.providerRegistryDigest)}}`
    : `{${common}}`;
};

export const decodeCanonicalSandboxPolicyPreconditionsV1 = (
  json: string,
): SandboxPolicyPreconditionsV1 | undefined => {
  try {
    const decoded = decodeSandboxPolicyPreconditionsV1(JSON.parse(json));
    return decoded !== undefined &&
      encodeSandboxPolicyPreconditionsV1(decoded) === json
      ? decoded
      : undefined;
  } catch {
    return undefined;
  }
};

export const decodeSandboxPolicyDecisionCommittedViewV1 = (
  input: unknown,
): SandboxPolicyDecisionCommittedViewV1 | undefined => {
  if (typeof input !== "object" || input === null || Array.isArray(input))
    return undefined;
  const value = input as Record<string, unknown>;
  if (value.kind === "OsEnforced") {
    if (
      !exactKeys(value, [
        "kind",
        "profile",
        "providerId",
        "providerVersion",
        "networkMode",
        "policyRevision",
        "expiresAt",
        "status",
      ]) ||
      !["ReadOnly", "WorkspaceWrite"].includes(String(value.profile)) ||
      decodeSandboxProviderId(value.providerId) !== value.providerId ||
      !opaque(value.providerVersion) ||
      !["Disabled", "Restricted", "Enabled"].includes(
        String(value.networkMode),
      ) ||
      !safePositive(value.policyRevision) ||
      !canonicalInstant(value.expiresAt) ||
      value.status !== "Committed"
    )
      return undefined;
    return value as unknown as SandboxPolicyDecisionCommittedViewV1;
  }
  if (
    value.kind === "TrustedLocalUnconfinedV1" &&
    exactKeys(value, [
      "kind",
      "profile",
      "networkBoundary",
      "policyRevision",
      "expiresAt",
      "status",
    ]) &&
    value.profile === "FullAccess" &&
    value.networkBoundary === "Unconfined" &&
    safePositive(value.policyRevision) &&
    canonicalInstant(value.expiresAt) &&
    value.status === "Committed"
  ) {
    return value as unknown as SandboxPolicyDecisionCommittedViewV1;
  }
  return undefined;
};

export const decodeCanonicalSandboxPolicyDecisionCommittedViewV1 = (
  json: string,
): SandboxPolicyDecisionCommittedViewV1 | undefined => {
  try {
    const decoded = decodeSandboxPolicyDecisionCommittedViewV1(
      JSON.parse(json),
    );
    return decoded !== undefined &&
      encodeSandboxPolicyDecisionCommittedViewV1(decoded) === json
      ? decoded
      : undefined;
  } catch {
    return undefined;
  }
};

export const encodeSandboxPolicyStatusViewV1 = (
  view: SandboxPolicyStatusViewV1,
): string =>
  view.kind === "OsEnforced"
    ? `{"kind":"OsEnforced","profile":${JSON.stringify(view.profile)},"providerId":${JSON.stringify(view.providerId)},"providerVersion":${JSON.stringify(view.providerVersion)},"networkMode":${JSON.stringify(view.networkMode)},"policyRevision":${view.policyRevision},"expiresAt":${JSON.stringify(view.expiresAt)},"status":${JSON.stringify(view.status)}}`
    : `{"kind":"TrustedLocalUnconfinedV1","profile":"FullAccess","networkBoundary":"Unconfined","policyRevision":${view.policyRevision},"expiresAt":${JSON.stringify(view.expiresAt)},"status":${JSON.stringify(view.status)}}`;

export const decodeSandboxPolicyStatusViewV1 = (
  input: unknown,
): SandboxPolicyStatusViewV1 | undefined => {
  if (typeof input !== "object" || input === null || Array.isArray(input))
    return undefined;
  const value = input as Record<string, unknown>;
  const committed = decodeSandboxPolicyDecisionCommittedViewV1({
    ...value,
    status: "Committed",
  });
  if (
    committed === undefined ||
    !["Committed", "Unavailable", "NeedsDecision"].includes(
      String(value.status),
    )
  )
    return undefined;
  return {
    ...committed,
    status: value.status as SandboxPolicyStatusViewV1["status"],
  } as SandboxPolicyStatusViewV1;
};

export const decodeCanonicalSandboxPolicyStatusViewV1 = (
  json: string,
): SandboxPolicyStatusViewV1 | undefined => {
  try {
    const decoded = decodeSandboxPolicyStatusViewV1(JSON.parse(json));
    return decoded !== undefined &&
      encodeSandboxPolicyStatusViewV1(decoded) === json
      ? decoded
      : undefined;
  } catch {
    return undefined;
  }
};

export const encodeSandboxPolicyDecisionCommittedViewV1 = (
  view: SandboxPolicyDecisionCommittedViewV1,
): string =>
  view.kind === "OsEnforced"
    ? `{"kind":"OsEnforced","profile":${JSON.stringify(view.profile)},"providerId":${JSON.stringify(view.providerId)},"providerVersion":${JSON.stringify(view.providerVersion)},"networkMode":${JSON.stringify(view.networkMode)},"policyRevision":${view.policyRevision},"expiresAt":${JSON.stringify(view.expiresAt)},"status":"Committed"}`
    : `{"kind":"TrustedLocalUnconfinedV1","profile":"FullAccess","networkBoundary":"Unconfined","policyRevision":${view.policyRevision},"expiresAt":${JSON.stringify(view.expiresAt)},"status":"Committed"}`;
