import type { Sha256 } from "./blocker.js";
import type { ExecutionEpisodeBinding } from "./execution.js";
import {
  decodeExecutionEpisodeBinding,
  encodeExecutionEpisodeBinding,
} from "./sandbox-policy.js";
import { compareUtf8BytesV1 } from "./sandbox-policy-producers.js";

export type SandboxPolicyCandidateV1 =
  | {
      readonly kind: "OsEnforced";
      readonly candidateId: string;
      readonly sandboxHandleBindingDigest: Sha256;
      readonly providerId: string;
      readonly providerVersion: string;
      readonly profile: "ReadOnly" | "WorkspaceWrite";
      readonly networkMode: "Disabled" | "Restricted" | "Enabled";
      readonly providerRegistryRevision: number;
      readonly providerRegistryDigest: Sha256;
    }
  | {
      readonly kind: "TrustedLocalUnconfinedV1";
      readonly candidateId: string;
      readonly sandboxHandleBindingDigest: Sha256;
    };

export interface SandboxPolicyCandidateCommonPreconditionsV1 {
  readonly expectedEpisodeRevision: number;
  readonly latestCommittedPolicyRevision: number;
  readonly episodeBinding: ExecutionEpisodeBinding;
  readonly workspaceRevision: number;
  readonly resourceBoundaryRevision: number;
  readonly authorityBundleRevision: number;
  readonly authorityBundleDigest: Sha256;
  readonly operatorConfigRevision: number;
  readonly operatorConfigDigest: Sha256;
}

export interface SandboxPolicyCandidateReadV1 {
  readonly reason: "InitialDecision" | "RefreshStaleCommittedPolicy";
  readonly commonPreconditions: SandboxPolicyCandidateCommonPreconditionsV1;
  readonly candidates: ReadonlyArray<SandboxPolicyCandidateV1>;
}

export type SandboxPolicyCandidateByteHasher = (preimage: Uint8Array) => string;

const DIGEST = /^[0-9a-f]{64}$/u;
const CANDIDATE_ID = /^spc2_[0-9a-f]{64}$/u;

const utf8Bytes = (value: string): Uint8Array => {
  const result: number[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const first = value.charCodeAt(index);
    let codePoint = first;
    if (first >= 0xd800 && first <= 0xdbff) {
      const second = value.charCodeAt(index + 1);
      if (second < 0xdc00 || second > 0xdfff) {
        throw new TypeError("candidate tuple contains a lone surrogate");
      }
      codePoint = ((first - 0xd800) << 10) + (second - 0xdc00) + 0x10000;
      index += 1;
    } else if (first >= 0xdc00 && first <= 0xdfff) {
      throw new TypeError("candidate tuple contains a lone surrogate");
    }

    if (codePoint <= 0x7f) {
      result.push(codePoint);
    } else if (codePoint <= 0x7ff) {
      result.push(0xc0 | (codePoint >> 6), 0x80 | (codePoint & 0x3f));
    } else if (codePoint <= 0xffff) {
      result.push(
        0xe0 | (codePoint >> 12),
        0x80 | ((codePoint >> 6) & 0x3f),
        0x80 | (codePoint & 0x3f),
      );
    } else {
      result.push(
        0xf0 | (codePoint >> 18),
        0x80 | ((codePoint >> 12) & 0x3f),
        0x80 | ((codePoint >> 6) & 0x3f),
        0x80 | (codePoint & 0x3f),
      );
    }
  }
  return Uint8Array.from(result);
};
const PREFIX = utf8Bytes("arbor:sandbox-policy-candidate:v2\0");

const u32be = (value: number): Uint8Array => {
  if (!Number.isSafeInteger(value) || value < 0 || value > 0xffff_ffff) {
    throw new RangeError("candidate tuple field is too large");
  }
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, value, false);
  return bytes;
};

const concatBytes = (parts: ReadonlyArray<Uint8Array>): Uint8Array => {
  const result = new Uint8Array(
    parts.reduce((total, part) => total + part.byteLength, 0),
  );
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.byteLength;
  }
  return result;
};

const encodedTupleString = (value: string): Uint8Array => {
  const bytes = utf8Bytes(value);
  return concatBytes([u32be(bytes.byteLength), bytes]);
};

/** Deterministic presentation identity. It is deliberately not a P1 CAS key. */
export const sandboxPolicyCandidateIdV2 = (
  candidate:
    | Omit<
        Extract<SandboxPolicyCandidateV1, { readonly kind: "OsEnforced" }>,
        "candidateId" | "sandboxHandleBindingDigest"
      >
    | { readonly kind: "TrustedLocalUnconfinedV1" },
  hashBytes: SandboxPolicyCandidateByteHasher,
): string => {
  const variant =
    candidate.kind === "OsEnforced"
      ? 0x01
      : candidate.kind === "TrustedLocalUnconfinedV1"
        ? 0x02
        : undefined;
  if (variant === undefined) throw new TypeError("unknown sandbox candidate");
  if (
    candidate.kind === "OsEnforced" &&
    (candidate.providerId.length === 0 ||
      candidate.providerVersion.length === 0 ||
      (candidate.profile !== "ReadOnly" &&
        candidate.profile !== "WorkspaceWrite") ||
      (candidate.networkMode !== "Disabled" &&
        candidate.networkMode !== "Restricted" &&
        candidate.networkMode !== "Enabled") ||
      !Number.isSafeInteger(candidate.providerRegistryRevision) ||
      candidate.providerRegistryRevision < 1 ||
      !DIGEST.test(candidate.providerRegistryDigest))
  ) {
    throw new TypeError("OsEnforced candidate tuple is invalid");
  }
  const tuple =
    candidate.kind === "OsEnforced"
      ? [
          candidate.providerId,
          candidate.providerVersion,
          candidate.profile,
          candidate.networkMode,
          String(candidate.providerRegistryRevision),
          candidate.providerRegistryDigest,
        ]
      : [];
  const preimage = concatBytes([
    PREFIX,
    new Uint8Array([variant]),
    ...tuple.map(encodedTupleString),
  ]);
  const digest = hashBytes(preimage);
  if (!DIGEST.test(digest)) {
    throw new TypeError("candidate hasher returned a non-SHA-256 digest");
  }
  return `spc2_${digest}`;
};

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const hasExactKeys = (
  value: Readonly<Record<string, unknown>>,
  keys: ReadonlyArray<string>,
): boolean =>
  Object.keys(value).length === keys.length &&
  keys.every((key) => Object.hasOwn(value, key));

const nonnegative = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

const positive = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0;

const digest = (value: unknown): value is Sha256 =>
  typeof value === "string" && DIGEST.test(value);

const decodeCandidate = (
  value: unknown,
  hashBytes: SandboxPolicyCandidateByteHasher,
): SandboxPolicyCandidateV1 | undefined => {
  if (!isRecord(value)) return undefined;
  if (value.kind === "TrustedLocalUnconfinedV1") {
    if (
      !hasExactKeys(value, [
        "kind",
        "candidateId",
        "sandboxHandleBindingDigest",
      ]) ||
      typeof value.candidateId !== "string" ||
      !CANDIDATE_ID.test(value.candidateId) ||
      !digest(value.sandboxHandleBindingDigest) ||
      sandboxPolicyCandidateIdV2(
        { kind: "TrustedLocalUnconfinedV1" },
        hashBytes,
      ) !== value.candidateId
    ) {
      return undefined;
    }
    return {
      kind: "TrustedLocalUnconfinedV1",
      candidateId: value.candidateId,
      sandboxHandleBindingDigest: value.sandboxHandleBindingDigest,
    };
  }
  if (
    value.kind !== "OsEnforced" ||
    !hasExactKeys(value, [
      "kind",
      "candidateId",
      "sandboxHandleBindingDigest",
      "providerId",
      "providerVersion",
      "profile",
      "networkMode",
      "providerRegistryRevision",
      "providerRegistryDigest",
    ]) ||
    typeof value.candidateId !== "string" ||
    !CANDIDATE_ID.test(value.candidateId) ||
    !digest(value.sandboxHandleBindingDigest) ||
    typeof value.providerId !== "string" ||
    value.providerId.length === 0 ||
    typeof value.providerVersion !== "string" ||
    value.providerVersion.length === 0 ||
    (value.profile !== "ReadOnly" && value.profile !== "WorkspaceWrite") ||
    (value.networkMode !== "Disabled" &&
      value.networkMode !== "Restricted" &&
      value.networkMode !== "Enabled") ||
    !positive(value.providerRegistryRevision) ||
    !digest(value.providerRegistryDigest)
  ) {
    return undefined;
  }
  const candidate = {
    kind: "OsEnforced" as const,
    sandboxHandleBindingDigest: value.sandboxHandleBindingDigest as Sha256,
    providerId: value.providerId,
    providerVersion: value.providerVersion,
    profile: value.profile as "ReadOnly" | "WorkspaceWrite",
    networkMode: value.networkMode as "Disabled" | "Restricted" | "Enabled",
    providerRegistryRevision: value.providerRegistryRevision,
    providerRegistryDigest: value.providerRegistryDigest as Sha256,
  };
  if (sandboxPolicyCandidateIdV2(candidate, hashBytes) !== value.candidateId) {
    return undefined;
  }
  return { ...candidate, candidateId: value.candidateId };
};

const compareOsCandidates = (
  left: Extract<SandboxPolicyCandidateV1, { readonly kind: "OsEnforced" }>,
  right: Extract<SandboxPolicyCandidateV1, { readonly kind: "OsEnforced" }>,
): number => {
  const leftTuple = [
    left.providerId,
    left.providerVersion,
    left.profile,
    left.networkMode,
    String(left.providerRegistryRevision),
    left.providerRegistryDigest,
  ];
  const rightTuple = [
    right.providerId,
    right.providerVersion,
    right.profile,
    right.networkMode,
    String(right.providerRegistryRevision),
    right.providerRegistryDigest,
  ];
  for (let index = 0; index < leftTuple.length; index += 1) {
    const comparison = compareUtf8BytesV1(
      leftTuple[index] ?? "",
      rightTuple[index] ?? "",
    );
    if (comparison !== 0) return comparison;
  }
  return 0;
};

const decodeCommonPreconditions = (
  value: unknown,
): SandboxPolicyCandidateCommonPreconditionsV1 | undefined => {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "expectedEpisodeRevision",
      "latestCommittedPolicyRevision",
      "episodeBinding",
      "workspaceRevision",
      "resourceBoundaryRevision",
      "authorityBundleRevision",
      "authorityBundleDigest",
      "operatorConfigRevision",
      "operatorConfigDigest",
    ]) ||
    !nonnegative(value.expectedEpisodeRevision) ||
    !nonnegative(value.latestCommittedPolicyRevision) ||
    !nonnegative(value.workspaceRevision) ||
    !nonnegative(value.resourceBoundaryRevision) ||
    !positive(value.authorityBundleRevision) ||
    !positive(value.operatorConfigRevision) ||
    !digest(value.authorityBundleDigest) ||
    !digest(value.operatorConfigDigest)
  ) {
    return undefined;
  }
  const episodeBinding = decodeExecutionEpisodeBinding(value.episodeBinding);
  if (episodeBinding === undefined) return undefined;
  return {
    expectedEpisodeRevision: value.expectedEpisodeRevision,
    latestCommittedPolicyRevision: value.latestCommittedPolicyRevision,
    episodeBinding,
    workspaceRevision: value.workspaceRevision,
    resourceBoundaryRevision: value.resourceBoundaryRevision,
    authorityBundleRevision: value.authorityBundleRevision,
    authorityBundleDigest: value.authorityBundleDigest,
    operatorConfigRevision: value.operatorConfigRevision,
    operatorConfigDigest: value.operatorConfigDigest,
  };
};

export const decodeSandboxPolicyCandidateReadV1 = (
  input: unknown,
  hashBytes: SandboxPolicyCandidateByteHasher,
): SandboxPolicyCandidateReadV1 | undefined => {
  if (
    !isRecord(input) ||
    !hasExactKeys(input, ["reason", "commonPreconditions", "candidates"]) ||
    (input.reason !== "InitialDecision" &&
      input.reason !== "RefreshStaleCommittedPolicy") ||
    !Array.isArray(input.candidates)
  ) {
    return undefined;
  }
  const commonPreconditions = decodeCommonPreconditions(
    input.commonPreconditions,
  );
  if (commonPreconditions === undefined) return undefined;
  const candidates: SandboxPolicyCandidateV1[] = [];
  for (const candidate of input.candidates) {
    let decoded: SandboxPolicyCandidateV1 | undefined;
    try {
      decoded = decodeCandidate(candidate, hashBytes);
    } catch {
      return undefined;
    }
    if (decoded === undefined) return undefined;
    candidates.push(decoded);
  }
  const trusted = candidates.filter(
    (candidate) => candidate.kind === "TrustedLocalUnconfinedV1",
  );
  const osCandidates = candidates.filter(
    (
      candidate,
    ): candidate is Extract<
      SandboxPolicyCandidateV1,
      { readonly kind: "OsEnforced" }
    > => candidate.kind === "OsEnforced",
  );
  if (
    trusted.length !== 1 ||
    candidates.at(-1)?.kind !== "TrustedLocalUnconfinedV1" ||
    osCandidates.some(
      (candidate, index) =>
        index > 0 &&
        compareOsCandidates(
          osCandidates[index - 1] as typeof candidate,
          candidate,
        ) >= 0,
    ) ||
    new Set(candidates.map((candidate) => candidate.candidateId)).size !==
      candidates.length
  ) {
    return undefined;
  }
  return {
    reason: input.reason,
    commonPreconditions,
    candidates,
  };
};

const encodeCandidate = (candidate: SandboxPolicyCandidateV1): string =>
  candidate.kind === "OsEnforced"
    ? `{"kind":"OsEnforced","candidateId":${JSON.stringify(candidate.candidateId)},"sandboxHandleBindingDigest":${JSON.stringify(candidate.sandboxHandleBindingDigest)},"providerId":${JSON.stringify(candidate.providerId)},"providerVersion":${JSON.stringify(candidate.providerVersion)},"profile":${JSON.stringify(candidate.profile)},"networkMode":${JSON.stringify(candidate.networkMode)},"providerRegistryRevision":${candidate.providerRegistryRevision},"providerRegistryDigest":${JSON.stringify(candidate.providerRegistryDigest)}}`
    : `{"kind":"TrustedLocalUnconfinedV1","candidateId":${JSON.stringify(candidate.candidateId)},"sandboxHandleBindingDigest":${JSON.stringify(candidate.sandboxHandleBindingDigest)}}`;

const encodeCommonPreconditions = (
  value: SandboxPolicyCandidateCommonPreconditionsV1,
): string =>
  `{"expectedEpisodeRevision":${value.expectedEpisodeRevision},"latestCommittedPolicyRevision":${value.latestCommittedPolicyRevision},"episodeBinding":${encodeExecutionEpisodeBinding(value.episodeBinding)},"workspaceRevision":${value.workspaceRevision},"resourceBoundaryRevision":${value.resourceBoundaryRevision},"authorityBundleRevision":${value.authorityBundleRevision},"authorityBundleDigest":${JSON.stringify(value.authorityBundleDigest)},"operatorConfigRevision":${value.operatorConfigRevision},"operatorConfigDigest":${JSON.stringify(value.operatorConfigDigest)}}`;

export const encodeSandboxPolicyCandidateReadV1 = (
  input: SandboxPolicyCandidateReadV1,
  hashBytes: SandboxPolicyCandidateByteHasher,
): string => {
  const normalized = decodeSandboxPolicyCandidateReadV1(input, hashBytes);
  if (normalized === undefined) {
    throw new TypeError("SandboxPolicyCandidateReadV1 has an invalid shape");
  }
  return `{"reason":${JSON.stringify(normalized.reason)},"commonPreconditions":${encodeCommonPreconditions(normalized.commonPreconditions)},"candidates":[${normalized.candidates.map(encodeCandidate).join(",")}]}`;
};

export const decodeCanonicalSandboxPolicyCandidateReadV1 = (
  json: string,
  hashBytes: SandboxPolicyCandidateByteHasher,
): SandboxPolicyCandidateReadV1 | undefined => {
  try {
    const decoded = decodeSandboxPolicyCandidateReadV1(
      JSON.parse(json),
      hashBytes,
    );
    return decoded !== undefined &&
      encodeSandboxPolicyCandidateReadV1(decoded, hashBytes) === json
      ? decoded
      : undefined;
  } catch {
    return undefined;
  }
};
