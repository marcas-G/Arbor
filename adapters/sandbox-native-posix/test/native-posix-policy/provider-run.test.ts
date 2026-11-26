import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { SandboxProcessPort, type SandboxProcessRequest } from "@arbor/ports";
import { Cause, Effect, Fiber } from "effect";
import { describe, expect, it, vi } from "vitest";
import {
  makeNativePosixSandboxProcessPort,
  NativePosixSandboxProcessPortLive,
} from "../../src/index.js";
import {
  handleFor,
  makeRoot,
  policyFor,
  qualifiedLinuxProvider,
} from "./support.js";

describe("native POSIX sandbox policy plans", () => {
  it("keeps an Experimental provider tuple-free and returns Unavailable from run", async () => {
    const root = makeRoot();
    writeFileSync(join(root, "bin", "tool"), "#!/bin/sh\nexit 0\n");
    const provider = NativePosixSandboxProcessPortLive({
      platform: "linux",
      linuxProbe: async () => ({
        providerId: "linux-bwrap",
        providerVersion: "experimental-v1",
        capabilityRevision: "probe-test",
        probeEvidenceRef: "sha256:test",
        enforcementRuleSetDigest: null,
        qualificationEvidenceRef: null,
        status: "Experimental",
        boundary: "OsEnforced",
        profiles: [],
        networkModes: [],
        failureCode: null,
        prerequisites: {
          bwrapExecutable: "PrerequisiteDetected",
          cgroupPidsController: "PrerequisiteDetected",
          cgroupMemoryController: "PrerequisiteDetected",
          cgroupCpuController: "PrerequisiteDetected",
          processKillApi: "PrerequisiteDetected",
        },
      }),
      seatbeltProbe: async () => ({
        providerId: "macos-seatbelt",
        providerVersion: "experimental-v1",
        capabilityRevision: "probe-test",
        probeEvidenceRef: "sha256:test-mac",
        enforcementRuleSetDigest: null,
        qualificationEvidenceRef: null,
        status: "Experimental",
        boundary: "OsEnforced",
        profiles: [],
        networkModes: [],
        failureCode: "UnsupportedPlatform",
        prerequisites: { platform: "Unavailable" },
      }),
    });
    const request: SandboxProcessRequest = {
      policy: { ...policyFor(root), providerId: "linux-bwrap" },
      handle: handleFor(root),
      executable: join(root, "bin", "tool"),
      args: [],
      cwd: { mount: "workspace", path: "." },
      timeoutMs: 1000,
      ambientEnvironment: {},
    };
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const service = yield* SandboxProcessPort;
        const capabilities = yield* service.capabilities();
        const outcome = yield* service.run(request);
        return { capabilities, outcome };
      }).pipe(Effect.provide(provider)),
    );
    expect(
      result.capabilities.find(
        (capability) => capability.providerId === "linux-bwrap",
      ),
    ).toMatchObject({
      status: "Experimental",
      profiles: [],
      networkModes: [],
      prerequisites: { bwrapExecutable: "PrerequisiteDetected" },
    });
    expect(result.outcome).toMatchObject({
      _tag: "Unavailable",
      failureCode: "ExperimentalProviderExecutionDisabled",
      probeEvidenceRef: "sha256:test",
    });
  });

  it("routes a Supported tuple through the closed bwrap plan and returns its process result", async () => {
    const root = makeRoot();
    const request: SandboxProcessRequest = {
      policy: { ...policyFor(root), providerId: "linux-bwrap" },
      handle: handleFor(root),
      executable: join(root, "bin", "tool"),
      args: ["--safe"],
      cwd: { mount: "workspace", path: "work" },
      timeoutMs: 1000,
      ambientEnvironment: { SECRET: "must-not-reach-child" },
    };
    writeFileSync(join(root, "bin", "tool"), "#!/bin/sh\nexit 0\n");
    let sawPlan = false;
    const provider = makeNativePosixSandboxProcessPort({
      platform: "linux",
      linuxProbe: async () => ({
        providerId: "linux-bwrap",
        providerVersion: "qualified-v1",
        capabilityRevision: "qualified-v1",
        probeEvidenceRef: "sha256:qualified",
        enforcementRuleSetDigest: "b".repeat(64),
        qualificationEvidenceRef: `blob:sha256:${"a".repeat(64)}`,
        status: "Supported",
        boundary: "OsEnforced",
        profiles: ["WorkspaceWrite"],
        networkModes: ["Disabled"],
        failureCode: null,
        prerequisites: {},
      }),
      seatbeltProbe: async () => ({
        providerId: "macos-seatbelt",
        providerVersion: "experimental-v1",
        capabilityRevision: "test",
        probeEvidenceRef: null,
        enforcementRuleSetDigest: null,
        qualificationEvidenceRef: null,
        status: "Experimental",
        boundary: "OsEnforced",
        profiles: [],
        networkModes: [],
        failureCode: "UnsupportedPlatform",
        prerequisites: {},
      }),
      execute: async (plan) => {
        sawPlan =
          plan.argv.includes("--unshare-net") &&
          plan.argv.includes("--ro-bind") &&
          plan.env.SECRET === undefined;
        return {
          _tag: "Completed",
          exitCode: 0,
          stdout: "ok",
          stderr: "",
          timedOut: false,
          truncated: false,
        };
      },
    });
    const outcome = await Effect.runPromise(provider.run(request));
    expect(sawPlan).toBe(true);
    expect(outcome).toEqual({
      _tag: "Completed",
      exitCode: 0,
      stdout: "ok",
      stderr: "",
      timedOut: false,
      truncated: false,
    });
  });

  it.each([
    { providerId: "another-provider" },
    { providerVersion: "older-version" },
    { capabilityRevision: "older-revision" },
    { boundary: "TrustedLocal" as const },
    { enforcementRuleSetDigest: "c".repeat(64) },
    { enforcementRuleSetDigest: null },
    { qualificationEvidenceRef: `blob:sha256:${"c".repeat(64)}` },
    { qualificationEvidenceRef: null },
  ])(
    "rejects a Supported capability with a different execution binding: %j",
    async (changed) => {
      const root = makeRoot();
      writeFileSync(join(root, "bin", "tool"), "#!/bin/sh\nexit 0\n");
      const execute = vi.fn();
      const provider = makeNativePosixSandboxProcessPort({
        platform: "linux",
        linuxProbe: async () => ({
          providerId: "linux-bwrap",
          providerVersion: "qualified-v1",
          capabilityRevision: "qualified-v1",
          probeEvidenceRef: "sha256:qualified",
          enforcementRuleSetDigest: "b".repeat(64),
          qualificationEvidenceRef: `blob:sha256:${"a".repeat(64)}`,
          status: "Supported",
          boundary: "OsEnforced",
          profiles: ["WorkspaceWrite"],
          networkModes: ["Disabled"],
          failureCode: null,
          prerequisites: {},
          ...changed,
        }),
        execute,
      });
      const outcome = await Effect.runPromise(
        provider.run({
          policy: policyFor(root),
          handle: handleFor(root),
          executable: join(root, "bin", "tool"),
          args: [],
          cwd: { mount: "workspace", path: "work" },
          timeoutMs: 1000,
          ambientEnvironment: {},
        }),
      );
      expect(outcome).toMatchObject({
        _tag: "Unavailable",
        failureCode: "ProviderBindingMismatch",
      });
      expect(execute).not.toHaveBeenCalled();
    },
  );

  it("does not spawn when interrupted during capability acquisition", async () => {
    const root = makeRoot();
    const capabilities = await Effect.runPromise(
      qualifiedLinuxProvider().capabilities(),
    );
    const capability = capabilities.find(
      (value) => value.providerId === "linux-bwrap",
    );
    if (capability === undefined) throw new Error("test capability missing");
    let entered: () => void = () => {};
    let release: () => void = () => {};
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const proceed = new Promise<void>((resolve) => {
      release = resolve;
    });
    const execute = vi.fn();
    const provider = makeNativePosixSandboxProcessPort({
      linuxProbe: async () => {
        entered();
        await proceed;
        return { ...capability, failureCode: null, prerequisites: {} };
      },
      execute,
    });
    const fiber = Effect.runFork(
      provider.run({
        policy: policyFor(root),
        handle: handleFor(root),
        executable: "bash",
        args: [],
        cwd: { mount: "workspace", path: "work" },
        timeoutMs: 5000,
        ambientEnvironment: {},
      }),
    );
    await started;
    const interrupted = Effect.runPromise(Fiber.interrupt(fiber));
    release();
    await interrupted;
    expect(execute).not.toHaveBeenCalled();
  });

  it("does not convert failed broker cleanup to a no-effect Unavailable result", async () => {
    const root = makeRoot();
    const close = vi.fn(async () => {
      throw new Error("cleanup fixture failure");
    });
    const provider = qualifiedLinuxProvider({
      networkBrokerFactory: async () => ({
        socketDirectory: root,
        socketPath: join(root, "egress.sock"),
        certificatePath: join(root, "ca.pem"),
        helperPath: join(root, "helper.mjs"),
        proxyPort: 3128,
        close,
      }),
    });
    const result = await Effect.runPromiseExit(
      provider.run({
        policy: {
          ...policyFor(root),
          networkPolicy: { version: 1, mode: "Enabled", destinations: [] },
        },
        handle: handleFor(root),
        executable: "bash",
        args: [],
        cwd: { mount: "workspace", path: "work" },
        timeoutMs: 5000,
        ambientEnvironment: {},
      }),
    );
    expect(result._tag).toBe("Failure");
    if (result._tag === "Failure")
      expect(Cause.pretty(result.cause)).toContain(
        "network broker cleanup could not be confirmed",
      );
    expect(close).toHaveBeenCalledOnce();
  });
});
