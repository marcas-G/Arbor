import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  decodeCanonicalSandboxPolicyCandidateReadV1,
  decodeSandboxPolicyCandidateReadV1,
  encodeSandboxPolicyCandidateReadV1,
  type SandboxPolicyCandidateReadV1,
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
const candidateRead: SandboxPolicyCandidateReadV1 = {
  reason: "RefreshStaleCommittedPolicy",
  commonPreconditions: {
    expectedEpisodeRevision: 3,
    latestCommittedPolicyRevision: 4,
    episodeBinding,
    workspaceRevision: 9,
    resourceBoundaryRevision: 2,
    sandboxHandleBindingDigest: "a".repeat(64) as never,
    authorityBundleRevision: 5,
    authorityBundleDigest: "b".repeat(64) as never,
    operatorConfigRevision: 2,
    operatorConfigDigest: "c".repeat(64) as never,
  },
  candidates: [
    { kind: "TrustedLocalUnconfinedV1", candidateId: trustedCandidateId },
  ],
};

describe("SandboxPolicyCandidateReadV1", () => {
  it("matches the accepted TrustedLocal candidate-id golden vector", () => {
    expect(
      sandboxPolicyCandidateIdV2(
        { kind: "TrustedLocalUnconfinedV1" },
        sha256Bytes,
      ),
    ).toBe(trustedCandidateId);
  });

  it("round-trips the closed candidate DTO in canonical owner order", () => {
    const json = encodeSandboxPolicyCandidateReadV1(candidateRead, sha256Bytes);
    expect(
      decodeCanonicalSandboxPolicyCandidateReadV1(json, sha256Bytes),
    ).toEqual(candidateRead);
  });

  it("accepts sorted OS tuples before the unique TrustedLocal choice", () => {
    const osCandidate = {
      kind: "OsEnforced" as const,
      providerId: "bwrap",
      providerVersion: "1.2.0",
      profile: "WorkspaceWrite" as const,
      networkMode: "Disabled" as const,
      providerRegistryRevision: 5,
      providerRegistryDigest: "d".repeat(64) as never,
    };
    const osCandidateWithId = {
      ...osCandidate,
      candidateId: sandboxPolicyCandidateIdV2(osCandidate, sha256Bytes),
    };
    const trustedCandidate = candidateRead.candidates[0];
    if (trustedCandidate === undefined) {
      throw new Error("fixture requires the TrustedLocal candidate");
    }
    const read = {
      ...candidateRead,
      candidates: [osCandidateWithId, trustedCandidate],
    };
    const json = encodeSandboxPolicyCandidateReadV1(read, sha256Bytes);
    expect(
      decodeCanonicalSandboxPolicyCandidateReadV1(json, sha256Bytes),
    ).toEqual(read);
    expect(
      decodeSandboxPolicyCandidateReadV1(
        { ...read, candidates: [...read.candidates].reverse() },
        sha256Bytes,
      ),
    ).toBeUndefined();
  });

  it("rejects unknown fields, candidate-id mismatch, and a missing TrustedLocal choice", () => {
    const json = encodeSandboxPolicyCandidateReadV1(candidateRead, sha256Bytes);
    expect(
      decodeCanonicalSandboxPolicyCandidateReadV1(
        json.replace(
          '"reason":"RefreshStaleCommittedPolicy"',
          '"reason":"RefreshStaleCommittedPolicy","extra":true',
        ),
        sha256Bytes,
      ),
    ).toBeUndefined();
    expect(
      decodeCanonicalSandboxPolicyCandidateReadV1(
        json.replace(trustedCandidateId, `spc2_${"0".repeat(64)}`),
        sha256Bytes,
      ),
    ).toBeUndefined();
    const withoutTrustedLocal = {
      ...candidateRead,
      candidates: [],
    } as never;
    expect(() =>
      encodeSandboxPolicyCandidateReadV1(withoutTrustedLocal, sha256Bytes),
    ).toThrow();
  });
});
