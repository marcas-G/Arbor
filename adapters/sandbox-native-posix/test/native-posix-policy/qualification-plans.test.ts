import { createHash } from "node:crypto";
import { release } from "node:os";
import {
  encodeSandboxEnforcementRuleSetV2,
  encodeSandboxLinuxQualificationManifestV2,
  networkBrokerControlsV2ForMode,
  sandboxEnforcementRuleSetV2ForProvider,
} from "@arbor/domain";
import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";
import {
  makeNativePosixSandboxProcessPort,
  type NativePosixCapability,
  type NativePosixProbe,
  probeLinuxBwrap,
} from "../../src/index.js";
import { handleFor, makeRoot, policyFor } from "./support.js";

describe("native POSIX sandbox policy plans", () => {
  it.each([
    "tuple",
    "wallTimeMs",
    "stdoutBytes",
    "stderrBytes",
    "processCount",
    "memoryBytes",
    "cpuTimeMs",
  ] as const)(
    "rejects an unqualified V2 %s before opening a broker or executing",
    async (change) => {
      const root = makeRoot();
      const base = policyFor(root);
      const execute = vi.fn();
      const networkBrokerFactory = vi.fn();
      const capability: NativePosixCapability = {
        providerId: "linux-bwrap",
        providerVersion: base.providerVersion,
        capabilityRevision: base.capabilityRevision,
        probeEvidenceRef: "sha256:unit-fixture",
        enforcementRuleSetDigest: base.enforcementRuleSetDigest,
        qualificationEvidenceRef: base.qualificationEvidenceRef,
        qualificationEvidenceRefs: [
          base.qualificationEvidenceRef,
          `blob:sha256:${"c".repeat(64)}`,
        ],
        status: "Supported",
        boundary: "OsEnforced",
        profiles: ["ReadOnly", "WorkspaceWrite"],
        networkModes: ["Disabled", "Enabled"],
        failureCode: null,
        prerequisites: {},
        qualificationTuples: [
          {
            profile: "WorkspaceWrite",
            networkMode: "Disabled",
            qualificationEvidenceRef: base.qualificationEvidenceRef,
            validatedLimits: base.limits,
          },
          {
            profile: "ReadOnly",
            networkMode: "Enabled",
            qualificationEvidenceRef: `blob:sha256:${"c".repeat(64)}`,
            validatedLimits: base.limits,
          },
        ],
      };
      const mode = change === "tuple" ? "Enabled" : "Disabled";
      const provider = makeNativePosixSandboxProcessPort({
        platform: "linux",
        linuxProbe: async () => capability,
        execute,
        networkBrokerFactory,
      });
      const outcome = await Effect.runPromise(
        provider.run({
          policy: {
            ...base,
            kind: "OsEnforcedProcessPolicyV2",
            networkPolicy: { version: 1, mode, destinations: [] },
            networkBrokerControls: networkBrokerControlsV2ForMode(mode),
            limits:
              change === "tuple"
                ? base.limits
                : { ...base.limits, [change]: base.limits[change] + 1 },
          },
          handle: handleFor(root),
          executable: "bash",
          args: ["-c", "true"],
          cwd: { mount: "workspace", path: "." },
          timeoutMs: 1000,
          ambientEnvironment: {},
        }),
      );
      expect(outcome).toMatchObject({
        _tag: "Unavailable",
        failureCode:
          change === "tuple"
            ? "QualificationTupleMismatch"
            : "QualificationLimitsExceeded",
      });
      expect(execute).not.toHaveBeenCalled();
      expect(networkBrokerFactory).not.toHaveBeenCalled();
    },
  );

  it("qualifies the Linux V2 rule set only when the exact V2 digest is supplied", async () => {
    const ruleSet = sandboxEnforcementRuleSetV2ForProvider("linux-bwrap");
    if (ruleSet === undefined) throw new Error("missing V2 rule set");
    const digest = createHash("sha256")
      .update(encodeSandboxEnforcementRuleSetV2(ruleSet), "utf8")
      .digest("hex");
    const caseIds = [
      "artifact-drift",
      "cancel-before-spawn",
      "cancel-running-tree",
      "dns-mixed-denied",
      "dns-rebinding",
      "env-secret-absent",
      "file-outside-denied",
      "file-ro",
      "file-rw",
      "host-loopback-denied",
      "namespace-escape-denied",
      "output-bound",
      "private-target-denied",
      "process-limit",
      "public-https",
      "raw-network-denied",
      "readonly-sharing",
      "resource-cpu",
      "resource-memory",
      "same-namespace-tcp",
      "socket-outside-denied",
      "timeout-tree",
    ];
    const evidenceJson = encodeSandboxLinuxQualificationManifestV2({
      version: 2,
      providerId: "linux-bwrap",
      providerVersion: "qualified-v2",
      capabilityRevision: 2,
      osFamily: "Linux",
      osBuild: release(),
      profile: "WorkspaceWrite",
      networkMode: "Enabled",
      networkPolicyCodecVersion: 1,
      enforcementRuleSetDigest: digest,
      validatedLimits: {
        wallTimeMs: 10_000,
        stdoutBytes: 1024,
        stderrBytes: 1024,
        processCount: 4,
        memoryBytes: 64 * 1024 * 1024,
        cpuTimeMs: 10_000,
      },
      artifactHashes: (
        [
          "adapter-runtime",
          "adapter-source",
          "bwrap",
          "qualification-control",
          "relay-runtime",
          "relay-source",
          "systemctl",
          "systemd-run",
        ] as const
      ).map((role) => ({
        role,
        sha256: createHash("sha256")
          .update("qualification-artifact")
          .digest("hex"),
      })),
      cases: caseIds.map((caseId) => ({
        caseId,
        verdict: "PASS" as const,
        evidenceRef: `blob:sha256:${"c".repeat(64)}` as const,
      })),
    });
    const evidenceRef =
      `blob:sha256:${createHash("sha256").update(evidenceJson).digest("hex")}` as const;
    const probe: NativePosixProbe = {
      platform: "linux",
      bwrapExecutable: "PrerequisiteDetected",
      userNamespaceProbe: "PrerequisiteDetected",
      mountNamespaceProbe: "PrerequisiteDetected",
      pidNamespaceProbe: "PrerequisiteDetected",
      networkNamespaceProbe: "PrerequisiteDetected",
      cgroupV2Hierarchy: "PrerequisiteDetected",
      cgroupPidsController: "PrerequisiteDetected",
      cgroupMemoryController: "PrerequisiteDetected",
      cgroupCpuController: "PrerequisiteDetected",
      seccompInterface: "PrerequisiteDetected",
      networkBrokerChannel: "PrerequisiteDetected",
      processKillApi: "PrerequisiteDetected",
    };
    const input: Parameters<typeof probeLinuxBwrap>[0] = {
      platform: "linux",
      probe,
      enforcementRuleSetVersion: 2,
      qualificationRows: [
        {
          providerVersion: "qualified-v2",
          capabilityRevision: "2",
          osBuild: release(),
          profile: "WorkspaceWrite",
          networkMode: "Enabled",
          enforcementRuleSetDigest: digest,
          qualificationEvidenceRef: evidenceRef,
        },
      ],
      readQualificationEvidence: async () => evidenceJson,
      readQualificationArtifact: async () =>
        new TextEncoder().encode("qualification-artifact"),
    };
    const capability = await probeLinuxBwrap(input);
    expect(capability.status).toBe("Supported");
    expect(capability.enforcementRuleSetDigest).toBe(digest);
    for (const role of [
      "adapter-runtime",
      "adapter-source",
      "bwrap",
      "qualification-control",
      "relay-runtime",
      "relay-source",
      "systemctl",
      "systemd-run",
    ] as const) {
      for (const changedBytes of [
        undefined,
        new TextEncoder().encode("drifted"),
      ]) {
        const changed = await probeLinuxBwrap({
          ...input,
          readQualificationArtifact: async (requestedRole) =>
            requestedRole === role
              ? changedBytes
              : new TextEncoder().encode("qualification-artifact"),
        });
        expect(changed.status, `${role}: missing/drifted file`).not.toBe(
          "Supported",
        );
        expect(changed.failureCode).toBe("QualificationMaterialMismatch");
      }
    }
    const { readQualificationArtifact: _reader, ...withoutReader } = input;
    expect((await probeLinuxBwrap(withoutReader)).status).not.toBe("Supported");
  });
});
