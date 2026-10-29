import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  CommandId,
  decodeCanonicalSandboxPolicyDecisionCommittedInternalV1,
  decodeCanonicalSandboxPolicyDecisionCommittedViewV1,
  decodeCanonicalSandboxPolicyPreconditionsV1,
  decodeCanonicalSandboxPolicyStatusViewV1,
  decodeSandboxPolicyStatusViewV1,
  ExecutionId,
  encodeEffectivePolicySummaryV1,
  encodeNetworkPolicyV1,
  encodeSandboxPolicyDecisionCommittedInternalV1,
  encodeSandboxPolicyDecisionCommittedViewV1,
  encodeSandboxPolicyPreconditionsV1,
  encodeSandboxPolicyStatusViewV1,
  networkBrokerControlsV1ForMode,
  ProjectId,
  parse,
  sandboxPolicyCommittedViewOf,
  WorkspaceId,
} from "../src/index.js";
import type {
  EffectivePolicySummaryV1,
  SandboxPolicyDecisionCommittedInternalV1,
} from "../src/sandbox-policy-result.js";

const hash = (value: string) =>
  createHash("sha256").update(value, "utf8").digest("hex");
const projectId = parse(ProjectId)("prj_018f2b3c-4d5e-7abc-8def-0123456789a1");
const workspaceId = parse(WorkspaceId)(
  "ws_018f2b3c-4d5e-7abc-8def-0123456789a1",
);
const executionId = parse(ExecutionId)(
  "exe_018f2b3c-4d5e-7abc-8def-0123456789a1",
);
const commandId = parse(CommandId)("cmd_018f2b3c-4d5e-7abc-8def-0123456789a1");
const episodeBinding = {
  _tag: "InboxEpisode" as const,
  entryKey: "entry:one",
  inputKind: "HumanMessage",
};
const limits = {
  wallTimeMs: 60_000,
  stdoutBytes: 1024,
  stderrBytes: 1024,
  processCount: 8,
  memoryBytes: 64 * 1024 * 1024,
  cpuTimeMs: 30_000,
};
const networkPolicy = {
  version: 1 as const,
  mode: "Disabled" as const,
  destinations: [],
};
const controls = {
  ...networkBrokerControlsV1ForMode("Disabled"),
};
const common = {
  version: 1 as const,
  projectId,
  workspaceId,
  executionId,
  episodeBinding,
  workspaceRevision: 4,
  resourceBoundaryRevision: 2,
  resourceBoundaryDigest: "a".repeat(64),
  sandboxEnvironmentBasisDigest: "b".repeat(64),
  policyRevision: 1,
  expiresAt: "2026-10-20T00:00:00.000Z",
  sandboxHandleBindingDigest: "c".repeat(64),
  mounts: [
    {
      mountId: "mount_workspace",
      targetRef: {
        version: 1 as const,
        kind: "RegionDigest" as const,
        resourceSpace: "filesystem" as const,
        regionIdentityDigest: "9".repeat(64),
      },
      targetIdentityDigest: "d".repeat(64),
      access: "ReadOnly" as const,
    },
  ],
  environmentAllowlist: ["HOME", "PATH"],
  limits,
  auditRefs: ["audit:decision"],
  authorityBundleRevision: 3,
  authorityBundleDigest: "e".repeat(64),
  operatorConfigRevision: 2,
  operatorConfigDigest: "f".repeat(64),
};

const osSnapshot: EffectivePolicySummaryV1 = {
  ...common,
  kind: "OsEnforced",
  profile: "ReadOnly",
  providerId: "bwrap",
  providerVersion: "0.8.0",
  capabilityRevision: 1,
  osFamily: "Linux",
  osBuild: "linux-6.8",
  qualificationEvidenceRef: `blob:sha256:${"1".repeat(64)}`,
  networkPolicy,
  networkPolicyDigest: hash(encodeNetworkPolicyV1(networkPolicy)),
  networkBrokerControls: controls,
  providerRegistryRevision: 5,
  providerRegistryDigest: "2".repeat(64),
};
const trustedSnapshot: EffectivePolicySummaryV1 = {
  ...common,
  kind: "TrustedLocalUnconfinedV1",
  trustedRuntimeIdentity: "TrustedLocal",
  trustedRuntimeVersion: "builtin-v1",
  profile: "FullAccess",
  networkBoundary: "Unconfined",
};

const makeResult = (
  effectivePolicySnapshot: EffectivePolicySummaryV1,
): SandboxPolicyDecisionCommittedInternalV1 => ({
  version: 1,
  commandId,
  projectId,
  workspaceId,
  executionId,
  episodeBinding,
  policyRevision: 1,
  policyDigest: hash(encodeEffectivePolicySummaryV1(effectivePolicySnapshot)),
  effectivePolicySnapshot,
});

describe("SandboxPolicyDecision result and DTO codecs", () => {
  it.each([osSnapshot, trustedSnapshot])(
    "round-trips a strict policy snapshot and result of kind %s",
    (snapshot) => {
      const result = makeResult(snapshot);
      const bytes = encodeSandboxPolicyDecisionCommittedInternalV1(result);
      expect(
        decodeCanonicalSandboxPolicyDecisionCommittedInternalV1(bytes, hash),
      ).toEqual(result);
      expect(
        decodeCanonicalSandboxPolicyDecisionCommittedInternalV1(
          bytes.replace(result.policyDigest, "0".repeat(64)),
          hash,
        ),
      ).toBeUndefined();
      expect(
        decodeCanonicalSandboxPolicyDecisionCommittedInternalV1(
          `${bytes}${" ".repeat(65_537)}`,
          hash,
        ),
      ).toBeUndefined();
      const view = sandboxPolicyCommittedViewOf(result);
      const viewBytes = encodeSandboxPolicyDecisionCommittedViewV1(view);
      expect(
        decodeCanonicalSandboxPolicyDecisionCommittedViewV1(viewBytes),
      ).toEqual(view);
      expect(viewBytes).not.toContain("Digest");
    },
  );

  it("keeps the preconditions union closed and status projections path-free", () => {
    const osPreconditions = {
      expectedEpisodeRevision: 1,
      latestCommittedPolicyRevision: 0,
      episodeBinding,
      workspaceRevision: 4,
      resourceBoundaryRevision: 2,
      sandboxHandleBindingDigest: "c".repeat(64),
      authorityBundleRevision: 3,
      authorityBundleDigest: "e".repeat(64),
      operatorConfigRevision: 2,
      operatorConfigDigest: "f".repeat(64),
      providerRegistryRevision: 5,
      providerRegistryDigest: "2".repeat(64),
    };
    const encoded = encodeSandboxPolicyPreconditionsV1({
      ...osPreconditions,
      kind: "OsEnforced",
    });
    expect(decodeCanonicalSandboxPolicyPreconditionsV1(encoded)).toMatchObject({
      kind: "OsEnforced",
      expectedEpisodeRevision: 1,
      providerRegistryRevision: 5,
    });
    expect(
      decodeSandboxPolicyStatusViewV1({
        ...sandboxPolicyCommittedViewOf(makeResult(osSnapshot)),
        status: "Unavailable",
      }),
    ).toMatchObject({ kind: "OsEnforced", status: "Unavailable" });
    const status = {
      ...sandboxPolicyCommittedViewOf(makeResult(trustedSnapshot)),
      status: "NeedsDecision" as const,
    };
    expect(
      decodeCanonicalSandboxPolicyStatusViewV1(
        encodeSandboxPolicyStatusViewV1(status),
      ),
    ).toEqual(status);
  });
});
