import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  decodeCanonicalSandboxPolicyCandidateReadV2,
  decodeSandboxPolicyCandidateReadV2,
  encodeSandboxPolicyCandidateReadV2,
  type SandboxPolicyCandidateReadV2,
  sandboxPolicyCandidateIdV2,
} from "../src/sandbox-policy-candidate.js";

const sha256Bytes = (bytes: Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex");

const trustedCandidateId =
  "spc2_5ed13734a81314c653c0487eea6a454283c800b71f9c0a2bed72f4a6d49cc98d";
const episodeBinding = {
  _tag: "WorkEpisode" as const,
  workId: "wrk_018f2b3c-4d5e-7abc-8def-0123456789a1" as never,
  targetWorkRevision: 7 as never,
};
const candidateRead: SandboxPolicyCandidateReadV2 = {
  reason: "RefreshStaleCommittedPolicy",
  commonPreconditions: {
    expectedEpisodeRevision: 3,
    latestCommittedPolicyRevision: 4,
    episodeBinding,
    workspaceRevision: 9,
    resourceBoundaryRevision: 2,
    authorityBundleRevision: 5,
    authorityBundleDigest: "b".repeat(64) as never,
    operatorConfigRevision: 2,
    operatorConfigDigest: "c".repeat(64) as never,
  },
  candidates: [
    {
      kind: "TrustedLocalUnconfinedV1",
      candidateId: trustedCandidateId,
      sandboxHandleBindingDigest: "a".repeat(64) as never,
    },
  ],
};

describe("SandboxPolicyCandidateReadV2", () => {
  it("matches the accepted TrustedLocal candidate-id golden vector", () => {
    expect(
      sandboxPolicyCandidateIdV2(
        { kind: "TrustedLocalUnconfinedV1" },
        sha256Bytes,
      ),
    ).toBe(trustedCandidateId);
  });

  it("binds capabilityRevision into the accepted OsEnforced V2 candidate ID", () => {
    const candidate = {
      kind: "OsEnforced" as const,
      providerId: "sandbox.provider.test",
      providerVersion: "1.0.0",
      capabilityRevision: 7,
      profile: "ReadOnly" as const,
      networkMode: "Disabled" as const,
      providerRegistryRevision: 3,
      providerRegistryDigest: "a".repeat(64) as never,
    };
    expect(sandboxPolicyCandidateIdV2(candidate as never, sha256Bytes)).toBe(
      "spc2_fe70c74f7f7674ad4b09b636e21dabc47ae99af2080a6a7a68d15960a8603094",
    );
  });

  it("round-trips the closed candidate DTO in canonical owner order", () => {
    const json = encodeSandboxPolicyCandidateReadV2(candidateRead, sha256Bytes);
    const decoded = JSON.parse(json) as {
      readonly candidates: ReadonlyArray<Record<string, unknown>>;
      readonly commonPreconditions: Record<string, unknown>;
    };
    expect(Object.keys(decoded.commonPreconditions)).toEqual([
      "expectedEpisodeRevision",
      "latestCommittedPolicyRevision",
      "episodeBinding",
      "workspaceRevision",
      "resourceBoundaryRevision",
      "authorityBundleRevision",
      "authorityBundleDigest",
      "operatorConfigRevision",
      "operatorConfigDigest",
    ]);
    expect(Object.keys(decoded.candidates[0] ?? {})).toEqual([
      "kind",
      "candidateId",
      "sandboxHandleBindingDigest",
    ]);
    expect(
      decodeCanonicalSandboxPolicyCandidateReadV2(json, sha256Bytes),
    ).toEqual(candidateRead);
  });

  it("distinguishes capability revisions and sorts them before TrustedLocal", () => {
    const osCandidate = {
      kind: "OsEnforced" as const,
      providerId: "bwrap",
      providerVersion: "1.2.0",
      capabilityRevision: 7,
      profile: "WorkspaceWrite" as const,
      networkMode: "Disabled" as const,
      providerRegistryRevision: 5,
      providerRegistryDigest: "d".repeat(64) as never,
      sandboxHandleBindingDigest: "e".repeat(64) as never,
    };
    const osCandidateWithId = {
      ...osCandidate,
      candidateId: sandboxPolicyCandidateIdV2(osCandidate, sha256Bytes),
    };
    const nextCapability = {
      ...osCandidate,
      capabilityRevision: 8,
    };
    const nextCapabilityWithId = {
      ...nextCapability,
      candidateId: sandboxPolicyCandidateIdV2(nextCapability, sha256Bytes),
    };
    expect(nextCapabilityWithId.candidateId).not.toBe(
      osCandidateWithId.candidateId,
    );
    const trustedCandidate = candidateRead.candidates[0];
    if (trustedCandidate === undefined) {
      throw new Error("fixture requires the TrustedLocal candidate");
    }
    const read = {
      ...candidateRead,
      candidates: [osCandidateWithId, nextCapabilityWithId, trustedCandidate],
    };
    const json = encodeSandboxPolicyCandidateReadV2(read, sha256Bytes);
    const decoded = JSON.parse(json) as {
      readonly candidates: ReadonlyArray<Record<string, unknown>>;
    };
    expect(Object.keys(decoded.candidates[0] ?? {})).toEqual([
      "kind",
      "candidateId",
      "sandboxHandleBindingDigest",
      "providerId",
      "providerVersion",
      "capabilityRevision",
      "profile",
      "networkMode",
      "providerRegistryRevision",
      "providerRegistryDigest",
    ]);
    expect(
      decodeCanonicalSandboxPolicyCandidateReadV2(json, sha256Bytes),
    ).toEqual(read);
    expect(
      decodeSandboxPolicyCandidateReadV2(
        { ...read, candidates: [...read.candidates].reverse() },
        sha256Bytes,
      ),
    ).toBeUndefined();
    const oldOsShape = JSON.parse(json) as {
      candidates: Array<Record<string, unknown>>;
    };
    delete oldOsShape.candidates[0]?.capabilityRevision;
    expect(
      decodeSandboxPolicyCandidateReadV2(oldOsShape, sha256Bytes),
    ).toBeUndefined();
  });

  it("rejects unknown fields, candidate-id mismatch, and a missing TrustedLocal choice", () => {
    const json = encodeSandboxPolicyCandidateReadV2(candidateRead, sha256Bytes);
    expect(
      decodeCanonicalSandboxPolicyCandidateReadV2(
        json.replace(
          '"reason":"RefreshStaleCommittedPolicy"',
          '"reason":"RefreshStaleCommittedPolicy","extra":true',
        ),
        sha256Bytes,
      ),
    ).toBeUndefined();
    expect(
      decodeCanonicalSandboxPolicyCandidateReadV2(
        json.replace(trustedCandidateId, `spc2_${"0".repeat(64)}`),
        sha256Bytes,
      ),
    ).toBeUndefined();
    const withoutTrustedLocal = {
      ...candidateRead,
      candidates: [],
    } as never;
    expect(() =>
      encodeSandboxPolicyCandidateReadV2(withoutTrustedLocal, sha256Bytes),
    ).toThrow();
  });

  it("rejects the legacy common digest and malformed per-candidate digests", () => {
    const json = encodeSandboxPolicyCandidateReadV2(candidateRead, sha256Bytes);
    const legacyCommon = json.replace(
      '"resourceBoundaryRevision":2,"authorityBundleRevision":5',
      `"resourceBoundaryRevision":2,"sandboxHandleBindingDigest":"${"a".repeat(64)}","authorityBundleRevision":5`,
    );
    expect(
      decodeCanonicalSandboxPolicyCandidateReadV2(legacyCommon, sha256Bytes),
    ).toBeUndefined();
    expect(
      decodeSandboxPolicyCandidateReadV2(
        {
          ...candidateRead,
          candidates: [
            {
              ...candidateRead.candidates[0],
              sandboxHandleBindingDigest: "A".repeat(64),
            },
          ],
        },
        sha256Bytes,
      ),
    ).toBeUndefined();
    const missingCandidateDigest = JSON.parse(json) as {
      candidates: Array<Record<string, unknown>>;
    };
    delete missingCandidateDigest.candidates[0]?.sandboxHandleBindingDigest;
    expect(
      decodeSandboxPolicyCandidateReadV2(missingCandidateDigest, sha256Bytes),
    ).toBeUndefined();
  });
});
