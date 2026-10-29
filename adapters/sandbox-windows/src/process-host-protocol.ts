import type {
  ExecutionEpisodeBinding,
  NetworkPolicyV1,
  SandboxProviderId,
} from "@arbor/domain";
import {
  decodeExecutionEpisodeBinding,
  decodeNetworkPolicyV1,
  encodeExecutionEpisodeBinding,
  encodeNetworkPolicyV1,
} from "@arbor/domain";
import type { SandboxProcessLimits, SandboxProcessRequest } from "@arbor/ports";
import { projectSandboxEnvironment, SANDBOX_ENV_ALLOWLIST } from "@arbor/ports";

/** Private helper protocol. It is not a public HTTP/model contract and is not
 * an authorization source. D4a deliberately emits no process-start authority. */
export const WINDOWS_SANDBOX_PROCESS_HOST_PROTOCOL_VERSION = 1 as const;
export const WINDOWS_SANDBOX_PROCESS_HOST_MAX_FRAME_BYTES = 64 * 1024;

const MAX_MOUNTS = 16;
const MAX_ARGS = 256;
const MAX_ENVIRONMENT_ENTRIES = 32;
const MAX_TEXT_BYTES = 8192;
const MAX_PATH_BYTES = 4096;
const SHA256 = /^[0-9a-f]{64}$/u;
const QUALIFICATION_REF = /^blob:sha256:[0-9a-f]{64}$/u;
const ENVIRONMENT_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/u;
const MOUNT_REF = /^[a-z][a-z0-9_-]{0,63}$/u;

export type WindowsSandboxProcessHostProtocolError =
  | "RequestTooLarge"
  | "InvalidRequest"
  | "HandleBindingMismatch";

export interface WindowsSandboxProcessHostMountV1 {
  readonly ref: string;
  readonly rootPath: string;
  readonly access: "ReadOnly" | "ReadWrite";
}

export interface WindowsSandboxProcessHostEnvironmentEntryV1 {
  readonly name: string;
  readonly value: string;
}

export interface WindowsSandboxProcessHostPolicyV1 {
  readonly kind: "OsEnforcedProcessPolicy";
  readonly executionId: string;
  readonly episodeBinding: ExecutionEpisodeBinding;
  readonly sandboxHandleId: string;
  readonly policyRevision: number;
  readonly policyDigest: string;
  readonly admittedMounts: ReadonlyArray<WindowsSandboxProcessHostMountV1>;
  readonly environmentAllowlist: ReadonlyArray<string>;
  readonly limits: SandboxProcessLimits;
  readonly auditRefs: ReadonlyArray<string>;
  readonly profile: "ReadOnly" | "WorkspaceWrite";
  readonly providerId: SandboxProviderId;
  readonly providerVersion: string;
  readonly capabilityRevision: string;
  readonly enforcementRuleSetDigest: string;
  readonly qualificationEvidenceRef: string;
  readonly boundary: "OsEnforced";
  readonly networkPolicy: NetworkPolicyV1;
}

export interface WindowsSandboxProcessHostRequestV1 {
  readonly version: 1;
  readonly kind: "Run";
  readonly policy: WindowsSandboxProcessHostPolicyV1;
  readonly handle: {
    readonly handleId: string;
    readonly mounts: ReadonlyArray<WindowsSandboxProcessHostMountV1>;
  };
  readonly executable: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd: { readonly mount: string; readonly path: string };
  readonly timeoutMs: number;
  /** Values are projected from ambientEnvironment through the policy's exact
   * environmentAllowlist before they enter this private frame. */
  readonly environment: ReadonlyArray<WindowsSandboxProcessHostEnvironmentEntryV1>;
}

export type WindowsSandboxProcessHostResultV1 =
  | {
      readonly version: 1;
      readonly kind: "Result";
      readonly outcome: "Completed";
      readonly exitCode: number;
      readonly stdout: string;
      readonly stderr: string;
      readonly timedOut: boolean;
      readonly truncated: boolean;
    }
  | {
      readonly version: 1;
      readonly kind: "Result";
      readonly outcome: "Unavailable" | "Rejected";
      readonly failureCode: string;
    };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const hasExactKeys = (
  value: Record<string, unknown>,
  keys: ReadonlyArray<string>,
): boolean =>
  Object.keys(value).length === keys.length &&
  keys.every((key) => Object.hasOwn(value, key));

const utf8Length = (value: string): number => Buffer.byteLength(value, "utf8");

const boundedText = (
  value: unknown,
  maximum = MAX_TEXT_BYTES,
): value is string =>
  typeof value === "string" &&
  !value.includes("\0") &&
  utf8Length(value) <= maximum;

const validPositiveInteger = (value: unknown): value is number =>
  Number.isSafeInteger(value) && (value as number) > 0;

const validNonNegativeInteger = (value: unknown): value is number =>
  Number.isSafeInteger(value) && (value as number) >= 0;

const normalizeLimits = (value: unknown): SandboxProcessLimits | undefined => {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "wallTimeMs",
      "stdoutBytes",
      "stderrBytes",
      "processCount",
      "memoryBytes",
      "cpuTimeMs",
    ]) ||
    !Object.values(value).every(validPositiveInteger)
  )
    return undefined;
  return {
    wallTimeMs: value.wallTimeMs as number,
    stdoutBytes: value.stdoutBytes as number,
    stderrBytes: value.stderrBytes as number,
    processCount: value.processCount as number,
    memoryBytes: value.memoryBytes as number,
    cpuTimeMs: value.cpuTimeMs as number,
  };
};

const normalizeMount = (
  value: unknown,
): WindowsSandboxProcessHostMountV1 | undefined => {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["ref", "rootPath", "access"]) ||
    typeof value.ref !== "string" ||
    !MOUNT_REF.test(value.ref) ||
    !boundedText(value.rootPath, MAX_PATH_BYTES) ||
    value.rootPath.length === 0 ||
    (value.access !== "ReadOnly" && value.access !== "ReadWrite")
  )
    return undefined;
  return {
    ref: value.ref,
    rootPath: value.rootPath,
    access: value.access,
  };
};

const normalizePolicy = (
  value: unknown,
): WindowsSandboxProcessHostPolicyV1 | undefined => {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "kind",
      "executionId",
      "episodeBinding",
      "sandboxHandleId",
      "policyRevision",
      "policyDigest",
      "admittedMounts",
      "environmentAllowlist",
      "limits",
      "auditRefs",
      "profile",
      "providerId",
      "providerVersion",
      "capabilityRevision",
      "enforcementRuleSetDigest",
      "qualificationEvidenceRef",
      "boundary",
      "networkPolicy",
    ]) ||
    value.kind !== "OsEnforcedProcessPolicy" ||
    !boundedText(value.executionId) ||
    value.executionId.length === 0 ||
    !boundedText(value.sandboxHandleId, 256) ||
    value.sandboxHandleId.length === 0 ||
    !validNonNegativeInteger(value.policyRevision) ||
    !boundedText(value.policyDigest, 64) ||
    !SHA256.test(value.policyDigest) ||
    !Array.isArray(value.admittedMounts) ||
    value.admittedMounts.length === 0 ||
    value.admittedMounts.length > MAX_MOUNTS ||
    !Array.isArray(value.environmentAllowlist) ||
    value.environmentAllowlist.length > MAX_ENVIRONMENT_ENTRIES ||
    !Array.isArray(value.auditRefs) ||
    value.auditRefs.length > MAX_ENVIRONMENT_ENTRIES ||
    (value.profile !== "ReadOnly" && value.profile !== "WorkspaceWrite") ||
    value.providerId !== "windows-restricted-appcontainer-job" ||
    !boundedText(value.providerVersion, 128) ||
    value.providerVersion.length === 0 ||
    !boundedText(value.capabilityRevision, 128) ||
    value.capabilityRevision.length === 0 ||
    !boundedText(value.enforcementRuleSetDigest, 64) ||
    !SHA256.test(value.enforcementRuleSetDigest) ||
    !boundedText(value.qualificationEvidenceRef, 80) ||
    !QUALIFICATION_REF.test(value.qualificationEvidenceRef) ||
    value.boundary !== "OsEnforced"
  )
    return undefined;

  const episodeBinding = decodeExecutionEpisodeBinding(value.episodeBinding);
  const networkPolicy = decodeNetworkPolicyV1(value.networkPolicy);
  const limits = normalizeLimits(value.limits);
  const admittedMounts = value.admittedMounts.map(normalizeMount);
  const environmentAllowlist = value.environmentAllowlist;
  const auditRefs = value.auditRefs;
  if (
    episodeBinding === undefined ||
    networkPolicy === undefined ||
    limits === undefined ||
    admittedMounts.some((mount) => mount === undefined) ||
    environmentAllowlist.some(
      (name) =>
        typeof name !== "string" ||
        !ENVIRONMENT_NAME.test(name) ||
        !SANDBOX_ENV_ALLOWLIST.includes(name),
    ) ||
    new Set(environmentAllowlist).size !== environmentAllowlist.length ||
    auditRefs.some((ref) => !boundedText(ref, 256)) ||
    new Set(auditRefs).size !== auditRefs.length
  )
    return undefined;

  const normalizedMounts =
    admittedMounts as Array<WindowsSandboxProcessHostMountV1>;
  if (
    new Set(normalizedMounts.map(({ ref }) => ref)).size !==
    normalizedMounts.length
  )
    return undefined;

  return {
    kind: "OsEnforcedProcessPolicy",
    executionId: value.executionId,
    episodeBinding,
    sandboxHandleId: value.sandboxHandleId,
    policyRevision: value.policyRevision,
    policyDigest: value.policyDigest,
    admittedMounts: normalizedMounts,
    environmentAllowlist: [...environmentAllowlist] as Array<string>,
    limits,
    auditRefs: [...auditRefs] as Array<string>,
    profile: value.profile,
    providerId: value.providerId as SandboxProviderId,
    providerVersion: value.providerVersion,
    capabilityRevision: value.capabilityRevision,
    enforcementRuleSetDigest: value.enforcementRuleSetDigest,
    qualificationEvidenceRef: value.qualificationEvidenceRef,
    boundary: "OsEnforced",
    networkPolicy,
  };
};

const normalizeEnvironment = (
  value: unknown,
  allowlist: ReadonlyArray<string>,
): ReadonlyArray<WindowsSandboxProcessHostEnvironmentEntryV1> | undefined => {
  if (!Array.isArray(value) || value.length > MAX_ENVIRONMENT_ENTRIES)
    return undefined;
  const entries: Array<WindowsSandboxProcessHostEnvironmentEntryV1> = [];
  const seen = new Set<string>();
  for (const candidate of value) {
    if (
      !isRecord(candidate) ||
      !hasExactKeys(candidate, ["name", "value"]) ||
      typeof candidate.name !== "string" ||
      !ENVIRONMENT_NAME.test(candidate.name) ||
      !allowlist.includes(candidate.name) ||
      !boundedText(candidate.value, MAX_TEXT_BYTES) ||
      seen.has(candidate.name)
    )
      return undefined;
    seen.add(candidate.name);
    entries.push({ name: candidate.name, value: candidate.value });
  }
  return entries.sort((left, right) =>
    left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
  );
};

const encodeMount = (mount: WindowsSandboxProcessHostMountV1): string =>
  `{"ref":${JSON.stringify(mount.ref)},"rootPath":${JSON.stringify(mount.rootPath)},"access":${JSON.stringify(mount.access)}}`;

const encodeLimits = (limits: SandboxProcessLimits): string =>
  `{"wallTimeMs":${limits.wallTimeMs},"stdoutBytes":${limits.stdoutBytes},"stderrBytes":${limits.stderrBytes},"processCount":${limits.processCount},"memoryBytes":${limits.memoryBytes},"cpuTimeMs":${limits.cpuTimeMs}}`;

const encodePolicy = (policy: WindowsSandboxProcessHostPolicyV1): string =>
  `{"kind":"OsEnforcedProcessPolicy","executionId":${JSON.stringify(policy.executionId)},"episodeBinding":${encodeExecutionEpisodeBinding(policy.episodeBinding)},"sandboxHandleId":${JSON.stringify(policy.sandboxHandleId)},"policyRevision":${policy.policyRevision},"policyDigest":${JSON.stringify(policy.policyDigest)},"admittedMounts":[${policy.admittedMounts.map(encodeMount).join(",")}],"environmentAllowlist":[${policy.environmentAllowlist.map((name) => JSON.stringify(name)).join(",")}],"limits":${encodeLimits(policy.limits)},"auditRefs":[${policy.auditRefs.map((ref) => JSON.stringify(ref)).join(",")}],"profile":${JSON.stringify(policy.profile)},"providerId":${JSON.stringify(policy.providerId)},"providerVersion":${JSON.stringify(policy.providerVersion)},"capabilityRevision":${JSON.stringify(policy.capabilityRevision)},"enforcementRuleSetDigest":${JSON.stringify(policy.enforcementRuleSetDigest)},"qualificationEvidenceRef":${JSON.stringify(policy.qualificationEvidenceRef)},"boundary":"OsEnforced","networkPolicy":${encodeNetworkPolicyV1(policy.networkPolicy)}}`;

const encodeEnvironment = (
  entries: ReadonlyArray<WindowsSandboxProcessHostEnvironmentEntryV1>,
): string =>
  `[${entries
    .map(
      ({ name, value }) =>
        `{"name":${JSON.stringify(name)},"value":${JSON.stringify(value)}}`,
    )
    .join(",")}]`;

const encodeRequest = (request: WindowsSandboxProcessHostRequestV1): string =>
  `{"version":1,"kind":"Run","policy":${encodePolicy(request.policy)},"handle":{"handleId":${JSON.stringify(request.handle.handleId)},"mounts":[${request.handle.mounts.map(encodeMount).join(",")}]},"executable":${JSON.stringify(request.executable)},"args":[${request.args.map((arg) => JSON.stringify(arg)).join(",")}],"cwd":{"mount":${JSON.stringify(request.cwd.mount)},"path":${JSON.stringify(request.cwd.path)}},"timeoutMs":${request.timeoutMs},"environment":${encodeEnvironment(request.environment)}}`;

const normalizeRequest = (
  value: unknown,
): WindowsSandboxProcessHostRequestV1 | undefined => {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "version",
      "kind",
      "policy",
      "handle",
      "executable",
      "args",
      "cwd",
      "timeoutMs",
      "environment",
    ]) ||
    value.version !== 1 ||
    value.kind !== "Run"
  )
    return undefined;
  const policy = normalizePolicy(value.policy);
  if (policy === undefined) return undefined;
  if (
    !isRecord(value.handle) ||
    !hasExactKeys(value.handle, ["handleId", "mounts"]) ||
    !boundedText(value.handle.handleId, 256) ||
    value.handle.handleId.length === 0 ||
    value.handle.handleId !== policy.sandboxHandleId ||
    !Array.isArray(value.handle.mounts) ||
    value.handle.mounts.length !== policy.admittedMounts.length
  )
    return undefined;
  const handleMounts = value.handle.mounts.map(normalizeMount);
  if (
    handleMounts.some((mount) => mount === undefined) ||
    (handleMounts as Array<WindowsSandboxProcessHostMountV1>).some(
      (mount, index) => {
        const admitted = policy.admittedMounts[index];
        return (
          admitted === undefined ||
          mount.ref !== admitted.ref ||
          mount.rootPath !== admitted.rootPath ||
          mount.access !== admitted.access
        );
      },
    )
  )
    return undefined;
  if (
    !boundedText(value.executable, MAX_PATH_BYTES) ||
    value.executable.length === 0 ||
    !Array.isArray(value.args) ||
    value.args.length > MAX_ARGS ||
    value.args.some((arg) => !boundedText(arg)) ||
    !isRecord(value.cwd) ||
    !hasExactKeys(value.cwd, ["mount", "path"]) ||
    !boundedText(value.cwd.mount, 64) ||
    !MOUNT_REF.test(value.cwd.mount) ||
    !boundedText(value.cwd.path, MAX_PATH_BYTES) ||
    !validPositiveInteger(value.timeoutMs) ||
    value.timeoutMs > policy.limits.wallTimeMs
  )
    return undefined;
  const environment = normalizeEnvironment(
    value.environment,
    policy.environmentAllowlist,
  );
  if (environment === undefined) return undefined;
  const normalizedHandleMounts =
    handleMounts as Array<WindowsSandboxProcessHostMountV1>;
  return {
    version: 1,
    kind: "Run",
    policy,
    handle: { handleId: value.handle.handleId, mounts: normalizedHandleMounts },
    executable: value.executable,
    args: [...value.args] as Array<string>,
    cwd: { mount: value.cwd.mount, path: value.cwd.path },
    timeoutMs: value.timeoutMs,
    environment,
  };
};

export const encodeWindowsSandboxProcessHostRequestV1 = (
  request: SandboxProcessRequest,
): string => {
  const policy = normalizePolicy(request.policy);
  if (policy === undefined) throw new Error("InvalidRequest");
  if (
    request.handle.handleId !== policy.sandboxHandleId ||
    request.handle.mounts === undefined
  )
    throw new Error("HandleBindingMismatch");
  const handleMounts = request.handle.mounts.map((mount) => ({
    ref: mount.ref,
    rootPath: mount.rootPath,
    access: mount.access,
  }));
  const environment = projectSandboxEnvironment(
    request.ambientEnvironment,
    policy.environmentAllowlist,
  );
  const normalized = normalizeRequest({
    version: 1,
    kind: "Run",
    policy,
    handle: { handleId: request.handle.handleId, mounts: handleMounts },
    executable: request.executable,
    args: request.args,
    cwd: request.cwd,
    timeoutMs: request.timeoutMs,
    environment: Object.entries(environment).map(([name, value]) => ({
      name,
      value,
    })),
  });
  if (normalized === undefined) throw new Error("InvalidRequest");
  const encoded = encodeRequest(normalized);
  if (utf8Length(encoded) > WINDOWS_SANDBOX_PROCESS_HOST_MAX_FRAME_BYTES)
    throw new Error("RequestTooLarge");
  return encoded;
};

export const decodeCanonicalWindowsSandboxProcessHostRequestV1 = (
  json: string,
): WindowsSandboxProcessHostRequestV1 | undefined => {
  if (
    !boundedText(json, WINDOWS_SANDBOX_PROCESS_HOST_MAX_FRAME_BYTES) ||
    json.length === 0
  )
    return undefined;
  try {
    const normalized = normalizeRequest(JSON.parse(json) as unknown);
    return normalized !== undefined && encodeRequest(normalized) === json
      ? normalized
      : undefined;
  } catch {
    return undefined;
  }
};

const UNAVAILABLE_FAILURES = new Set([
  "ProductionRunNotEnabled",
  "ProtocolFrameInvalid",
]);
const REJECTION_FAILURES = new Set([
  "PolicyMissing",
  "ExecutionBindingMismatch",
  "EpisodeBindingMismatch",
  "HandleBindingMismatch",
  "MountBindingMismatch",
  "InvalidTimeout",
  "ProcessCapabilityNotBound",
  "ProviderOutcomeMismatch",
]);

const encodeResult = (result: WindowsSandboxProcessHostResultV1): string => {
  if (result.outcome === "Completed")
    return `{"version":1,"kind":"Result","outcome":"Completed","exitCode":${result.exitCode},"stdout":${JSON.stringify(result.stdout)},"stderr":${JSON.stringify(result.stderr)},"timedOut":${result.timedOut},"truncated":${result.truncated}}`;
  return `{"version":1,"kind":"Result","outcome":${JSON.stringify(result.outcome)},"failureCode":${JSON.stringify(result.failureCode)}}`;
};

export const decodeCanonicalWindowsSandboxProcessHostResultV1 = (
  json: string,
): WindowsSandboxProcessHostResultV1 | undefined => {
  if (!boundedText(json, WINDOWS_SANDBOX_PROCESS_HOST_MAX_FRAME_BYTES))
    return undefined;
  try {
    const value = JSON.parse(json) as unknown;
    if (
      !isRecord(value) ||
      value.version !== 1 ||
      value.kind !== "Result" ||
      typeof value.outcome !== "string"
    )
      return undefined;
    let result: WindowsSandboxProcessHostResultV1 | undefined;
    if (value.outcome === "Completed") {
      if (
        !hasExactKeys(value, [
          "version",
          "kind",
          "outcome",
          "exitCode",
          "stdout",
          "stderr",
          "timedOut",
          "truncated",
        ]) ||
        !Number.isInteger(value.exitCode) ||
        !boundedText(
          value.stdout,
          WINDOWS_SANDBOX_PROCESS_HOST_MAX_FRAME_BYTES,
        ) ||
        !boundedText(
          value.stderr,
          WINDOWS_SANDBOX_PROCESS_HOST_MAX_FRAME_BYTES,
        ) ||
        typeof value.timedOut !== "boolean" ||
        typeof value.truncated !== "boolean"
      )
        return undefined;
      result = {
        version: 1,
        kind: "Result",
        outcome: "Completed",
        exitCode: value.exitCode as number,
        stdout: value.stdout,
        stderr: value.stderr,
        timedOut: value.timedOut,
        truncated: value.truncated,
      };
    } else if (
      value.outcome === "Unavailable" ||
      value.outcome === "Rejected"
    ) {
      if (
        !hasExactKeys(value, ["version", "kind", "outcome", "failureCode"]) ||
        !boundedText(value.failureCode, 96) ||
        !(value.outcome === "Unavailable"
          ? UNAVAILABLE_FAILURES.has(value.failureCode)
          : REJECTION_FAILURES.has(value.failureCode))
      )
        return undefined;
      result = {
        version: 1,
        kind: "Result",
        outcome: value.outcome,
        failureCode: value.failureCode,
      };
    }
    return result !== undefined && encodeResult(result) === json
      ? result
      : undefined;
  } catch {
    return undefined;
  }
};

export const makeD4aUnavailableResultV1 =
  (): WindowsSandboxProcessHostResultV1 => ({
    version: 1,
    kind: "Result",
    outcome: "Unavailable",
    failureCode: "ProductionRunNotEnabled",
  });
