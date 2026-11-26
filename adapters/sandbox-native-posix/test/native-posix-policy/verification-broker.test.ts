import { createHash } from "node:crypto";
import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { release, tmpdir } from "node:os";
import { join } from "node:path";
import {
  encodeVerificationSandboxBindingV1,
  networkBrokerControlsV2ForMode,
} from "@arbor/domain";
import type { SandboxProcessRequest } from "@arbor/ports";
import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";
import { makeNativePosixSandboxProcessPort } from "../../src/index.js";
import { handleFor, makeRoot, policyFor, roots } from "./support.js";

describe("native POSIX sandbox policy plans", () => {
  it("requires an independent qualification record to match the exact binding and mounts", async () => {
    const root = makeRoot();
    writeFileSync(join(root, "bin", "tool"), "#!/bin/sh\nexit 0\n");
    const base = policyFor(root);
    const { episodeBinding: _episodeBinding, ...policyBase } = base;
    const verificationBinding = {
      version: 1 as const,
      kind: "IndependentVerification" as const,
      projectId: "prj_00000000-0000-7000-8000-000000000001" as never,
      workspaceId: "ws_00000000-0000-7000-8000-000000000001" as never,
      executionId: "exe_00000000-0000-7000-8000-000000000001" as never,
      verificationId: "ver_00000000-0000-7000-8000-000000000001" as never,
      workId: "wrk_00000000-0000-7000-8000-000000000001" as never,
      targetWorkRevision: 1 as never,
      copySetId: "vcp_00000000-0000-7000-8000-000000000001",
      authorizationRevision: 1,
      sourceBasisDigest: "b".repeat(64),
      inputDigest: "c".repeat(64),
      inputManifestRef: `blob:sha256:${"d".repeat(64)}`,
      policyRevision: 1,
      issuedAt: "2026-11-19T12:00:00.000Z",
      expiresAt: "2026-11-19T13:00:00.000Z",
    };
    const policy = {
      ...policyBase,
      kind: "IndependentVerificationProcessPolicyV1" as const,
      networkBrokerControls: networkBrokerControlsV2ForMode("Disabled"),
      verificationBinding,
      verificationMountQualificationEvidenceRef: "" as string,
    };
    const evidence = (mountRef: string) =>
      JSON.stringify({
        version: 1,
        kind: "IndependentVerificationMountQualification",
        binding: JSON.parse(
          encodeVerificationSandboxBindingV1(verificationBinding),
        ),
        provider: {
          providerId: "linux-bwrap",
          providerVersion: base.providerVersion,
          capabilityRevision: base.capabilityRevision,
          osBuild: release(),
          profile: "WorkspaceWrite",
          networkMode: "Disabled",
          qualificationEvidenceRef: base.qualificationEvidenceRef,
        },
        mounts: [{ ref: mountRef, access: "ReadWrite" }],
      });
    let qualificationEvidence = evidence("workspace");
    const qualificationRef = () =>
      `blob:sha256:${createHash("sha256")
        .update(qualificationEvidence, "utf8")
        .digest("hex")}`;
    const execute = vi.fn(async () => ({
      _tag: "Completed" as const,
      exitCode: 0,
      stdout: "ok",
      stderr: "",
      timedOut: false,
      truncated: false,
    }));
    const provider = makeNativePosixSandboxProcessPort({
      platform: "linux",
      linuxProbe: async () => ({
        providerId: "linux-bwrap",
        providerVersion: base.providerVersion,
        capabilityRevision: base.capabilityRevision,
        probeEvidenceRef: "sha256:qualified",
        enforcementRuleSetDigest: base.enforcementRuleSetDigest,
        qualificationEvidenceRef: base.qualificationEvidenceRef,
        status: "Supported" as const,
        boundary: "OsEnforced" as const,
        profiles: ["WorkspaceWrite" as const],
        networkModes: ["Disabled" as const],
        failureCode: null,
        prerequisites: {},
        qualificationTuples: [
          {
            profile: "WorkspaceWrite" as const,
            networkMode: "Disabled" as const,
            qualificationEvidenceRef: base.qualificationEvidenceRef,
            validatedLimits: base.limits,
          },
        ],
      }),
      execute,
      readVerificationQualificationEvidence: async () => qualificationEvidence,
    });
    const request = {
      policy: {
        ...policy,
        verificationMountQualificationEvidenceRef: qualificationRef(),
      },
      handle: handleFor(root),
      executable: join(root, "bin", "tool"),
      args: [],
      cwd: { mount: "workspace", path: "work" },
      timeoutMs: 1000,
      ambientEnvironment: {},
    } as SandboxProcessRequest;
    await expect(
      Effect.runPromise(provider.run(request)),
    ).resolves.toMatchObject({ _tag: "Completed", exitCode: 0 });
    expect(execute).toHaveBeenCalledOnce();

    qualificationEvidence = evidence("other-mount");
    const rejected = await Effect.runPromise(
      provider.run({
        ...request,
        policy: {
          ...request.policy,
          verificationMountQualificationEvidenceRef: qualificationRef(),
        } as SandboxProcessRequest["policy"],
      }),
    );
    expect(rejected).toMatchObject({
      _tag: "Unavailable",
      failureCode: "VerificationQualificationEvidenceInvalid",
    });
    expect(execute).toHaveBeenCalledOnce();
  });

  it("opens the V2 broker for an independent verification policy", async () => {
    const root = makeRoot();
    writeFileSync(join(root, "bin", "tool"), "#!/bin/sh\nexit 0\n");
    const brokerRoot = mkdtempSync(join(tmpdir(), "arbor-native-v2-broker-"));
    roots.push(brokerRoot);
    writeFileSync(join(root, "helper.mjs"), "");
    const base = policyFor(root);
    const { episodeBinding: _episodeBinding, ...policyBase } = base;
    const verificationBinding = {
      version: 1 as const,
      kind: "IndependentVerification" as const,
      projectId: "prj_00000000-0000-7000-8000-000000000001" as never,
      workspaceId: "ws_00000000-0000-7000-8000-000000000001" as never,
      executionId: "exe_00000000-0000-7000-8000-000000000001" as never,
      verificationId: "ver_00000000-0000-7000-8000-000000000001" as never,
      workId: "wrk_00000000-0000-7000-8000-000000000001" as never,
      targetWorkRevision: 1 as never,
      copySetId: "vcp_00000000-0000-7000-8000-000000000001",
      authorizationRevision: 1,
      sourceBasisDigest: "b".repeat(64),
      inputDigest: "c".repeat(64),
      inputManifestRef: `blob:sha256:${"d".repeat(64)}`,
      policyRevision: 1,
      issuedAt: "2026-11-19T12:00:00.000Z",
      expiresAt: "2026-11-19T13:00:00.000Z",
    };
    const qualificationEvidence = JSON.stringify({
      version: 1,
      kind: "IndependentVerificationMountQualification",
      binding: JSON.parse(
        encodeVerificationSandboxBindingV1(verificationBinding),
      ),
      provider: {
        providerId: "linux-bwrap",
        providerVersion: base.providerVersion,
        capabilityRevision: base.capabilityRevision,
        osBuild: release(),
        profile: "WorkspaceWrite",
        networkMode: "Enabled",
        qualificationEvidenceRef: base.qualificationEvidenceRef,
      },
      mounts: [{ ref: "workspace", access: "ReadWrite" }],
    });
    const qualificationRef = `blob:sha256:${createHash("sha256")
      .update(qualificationEvidence, "utf8")
      .digest("hex")}` as `blob:sha256:${string}`;
    const policy = {
      ...policyBase,
      kind: "IndependentVerificationProcessPolicyV1" as const,
      networkPolicy: {
        version: 1 as const,
        mode: "Enabled" as const,
        destinations: [],
      },
      networkBrokerControls: networkBrokerControlsV2ForMode("Enabled"),
      verificationBinding,
      verificationMountQualificationEvidenceRef: qualificationRef,
    };
    const server = createServer();
    const socketPath = join(brokerRoot, "egress.sock");
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, resolve);
    });
    const networkBrokerFactory = vi.fn(async (_networkPolicy, protocol) => {
      expect(protocol).toBe("V2");
      return {
        protocol: "V2" as const,
        socketDirectory: realpathSync(brokerRoot),
        socketPath: realpathSync(socketPath),
        helperPath: realpathSync(join(root, "helper.mjs")),
        proxyPort: 3128,
        close: async () => {
          await new Promise<void>((resolve, reject) =>
            server.close((error) => (error ? reject(error) : resolve())),
          );
        },
      };
    });
    try {
      const provider = makeNativePosixSandboxProcessPort({
        platform: "linux",
        linuxProbe: async () => ({
          providerId: "linux-bwrap",
          providerVersion: base.providerVersion,
          capabilityRevision: base.capabilityRevision,
          probeEvidenceRef: "sha256:qualified",
          enforcementRuleSetDigest: base.enforcementRuleSetDigest,
          qualificationEvidenceRef: base.qualificationEvidenceRef,
          status: "Supported" as const,
          boundary: "OsEnforced" as const,
          profiles: ["WorkspaceWrite" as const],
          networkModes: ["Enabled" as const],
          failureCode: null,
          prerequisites: {},
          qualificationTuples: [
            {
              profile: "WorkspaceWrite" as const,
              networkMode: "Enabled" as const,
              qualificationEvidenceRef: base.qualificationEvidenceRef,
              validatedLimits: base.limits,
            },
          ],
        }),
        execute: async () => ({
          _tag: "Completed" as const,
          exitCode: 0,
          stdout: "ok",
          stderr: "",
          timedOut: false,
          truncated: false,
        }),
        networkBrokerFactory,
        readVerificationQualificationEvidence: async () =>
          qualificationEvidence,
      });
      const outcome = await Effect.runPromise(
        provider.run({
          policy,
          handle: handleFor(root),
          executable: join(root, "bin", "tool"),
          args: [],
          cwd: { mount: "workspace", path: "work" },
          timeoutMs: 1000,
          ambientEnvironment: {},
        }),
      );
      expect(outcome).toMatchObject({ _tag: "Completed", exitCode: 0 });
      expect(networkBrokerFactory).toHaveBeenCalledOnce();
    } finally {
      if (server.listening) {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    }
  });
});
