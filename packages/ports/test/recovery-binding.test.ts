import type {
  ExecutionId,
  ProviderTurnId,
  ToolInvocationId,
} from "@arbor/domain";
import { describe, expect, it } from "vitest";
import {
  approvalTargetDigestV1,
  canonicalizeRecoveryBindingV1,
  type RecoveryBindingV1,
  recoveryBindingV1Digest,
  targetResourceIdentityDigestV1,
  verifyRecoveryBindingV1,
} from "../src/recovery-binding.js";

const binding = (): RecoveryBindingV1 => ({
  bindingVersion: 1,
  digestAlgorithm: "SHA-256",
  executionId: "exe_00000000-0000-7000-8000-000000000001" as ExecutionId,
  invocationId: "tin_00000000-0000-7000-8000-000000000002" as ToolInvocationId,
  providerTurnId: "ptn_00000000-0000-7000-8000-000000000003" as ProviderTurnId,
  logicalStepNo: 0,
  repairAttempt: 0,
  logicalActionId: "action-1",
  actionIndex: 0,
  callRef: "call-1",
  toolName: "patch",
  toolVersion: "1",
  toolDefinitionHash: "a".repeat(64),
  sideEffectSemantics: "Idempotent",
  canonicalArgumentsDigest: "b".repeat(64),
  targetResourceIdentityDigest: "c".repeat(64),
  resourceBoundaryRevision: 2,
  environmentRevision: "0",
  authoritySourceRevision: "authority-source",
  principalId: "user-1",
  capability: ["fs:write"],
  permissionGrantRevisions: [["pgr_1", 3]],
  workspacePolicyRevision: 4,
  projectPolicyRevision: 5,
  controlBasisDigest: "d".repeat(64),
  approvalId: null,
  approvalSubject: null,
  approvalPreConsumeRevision: null,
  approvalConsumedRevision: null,
  approvalExpiresAt: null,
  approvalTargetDigest: null,
  approvalActionDigest: null,
  approvalConsumedBy: null,
  profileId: null,
  profileVersion: null,
  profileHash: null,
  profileProtocol: null,
  effectKey: null,
});

describe("RecoveryBindingV1 canonical bytes and target projections", () => {
  it("uses a closed, key-sorted canonical JSON object and verifies its digest", () => {
    const value = binding();
    const canonical = canonicalizeRecoveryBindingV1(value);
    expect(
      canonical.startsWith('{"actionIndex":0,"approvalActionDigest":null'),
    ).toBe(true);
    const verified = verifyRecoveryBindingV1({
      invocationId: value.invocationId,
      canonicalJson: canonical,
      bindingSha256: recoveryBindingV1Digest(value),
    });
    expect(verified?.value).toEqual(value);
  });

  it("rejects noncanonical bytes, wrong keys, and a mismatched invocation", () => {
    const value = binding();
    const canonical = canonicalizeRecoveryBindingV1(value);
    const digest = recoveryBindingV1Digest(value);
    expect(
      verifyRecoveryBindingV1({
        invocationId: value.invocationId,
        canonicalJson: ` ${canonical}`,
        bindingSha256: digest,
      }),
    ).toBeNull();
    expect(
      verifyRecoveryBindingV1({
        invocationId: value.invocationId,
        canonicalJson: canonical.replace(
          '"effectKey":null',
          '"unexpected":null',
        ),
        bindingSha256: digest,
      }),
    ).toBeNull();
    expect(
      verifyRecoveryBindingV1({
        invocationId:
          "tin_00000000-0000-7000-8000-000000000004" as ToolInvocationId,
        canonicalJson: canonical,
        bindingSha256: digest,
      }),
    ).toBeNull();
  });

  it("preserves approval target order and duplicate occurrences", () => {
    const forward = approvalTargetDigestV1(["space-a", "space-b"]);
    expect(forward).not.toBe(approvalTargetDigestV1(["space-b", "space-a"]));
    expect(forward).not.toBe(
      approvalTargetDigestV1(["space-a", "space-a", "space-b"]),
    );
    expect(approvalTargetDigestV1([])).not.toBe(forward);
  });

  it("hashes the resolver region array only while full binding includes revisions", () => {
    const regions = [
      {
        resourceSpaceId: "filesystem",
        normalizedRegion: { kind: "FileTree", path: "C:\\repo\\src" },
      },
    ] as const;
    const regionIdentity = targetResourceIdentityDigestV1(regions);
    const original = binding();
    const changedBoundary = {
      ...original,
      resourceBoundaryRevision: original.resourceBoundaryRevision + 1,
    };
    const changedEnvironment = {
      ...original,
      environmentRevision: "1",
    };
    expect(recoveryBindingV1Digest(changedBoundary)).not.toBe(
      recoveryBindingV1Digest(original),
    );
    expect(recoveryBindingV1Digest(changedEnvironment)).not.toBe(
      recoveryBindingV1Digest(original),
    );
    expect(regionIdentity).toBe(targetResourceIdentityDigestV1(regions));
  });
});
