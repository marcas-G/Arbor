import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type OsEnforcedSandboxProcessPolicy,
  SandboxProcessPort,
  type SandboxProcessRequest,
} from "@arbor/ports";
import { Effect } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildBwrapPlan,
  buildSeatbeltProfile,
  type NativePosixProbe,
  NativePosixSandboxProcessPortLive,
  probeLinuxBwrap,
  probeMacOSSeatbelt,
} from "../src/index.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

const makeRoot = () => {
  const root = mkdtempSync(join(tmpdir(), "arbor-native-posix-test-"));
  roots.push(root);
  mkdirSync(join(root, "bin"));
  mkdirSync(join(root, "work"));
  return root;
};

const policyFor = (root: string): OsEnforcedSandboxProcessPolicy => ({
  kind: "OsEnforcedProcessPolicy",
  executionId: "exe_test" as OsEnforcedSandboxProcessPolicy["executionId"],
  episodeBinding: {
    _tag: "WorkEpisode",
    workId: "work_test" as never,
    targetWorkRevision: 1 as never,
  },
  sandboxHandleId: "sandbox_test",
  policyRevision: 1,
  profile: "WorkspaceWrite",
  providerId: "linux-bwrap",
  providerVersion: "experimental-v1",
  capabilityRevision: "experimental-v1",
  enforcementRuleSetDigest: "b".repeat(64),
  qualificationEvidenceRef: `blob:sha256:${"a".repeat(64)}`,
  boundary: "OsEnforced",
  networkPolicy: { version: 1, mode: "Disabled", destinations: [] },
  policyDigest: "a".repeat(64),
  admittedMounts: [
    { ref: "workspace", rootPath: realpathSync(root), access: "ReadWrite" },
  ],
  environmentAllowlist: ["PATH", "LANG"],
  limits: {
    wallTimeMs: 10_000,
    stdoutBytes: 1024,
    stderrBytes: 1024,
    processCount: 4,
    memoryBytes: 64 * 1024 * 1024,
    cpuTimeMs: 10_000,
  },
  auditRefs: [],
});

const handleFor = (root: string) => ({
  handleId: "sandbox_test",
  rootPath: realpathSync(root),
  mounts: [
    {
      ref: "workspace",
      rootPath: realpathSync(root),
      region: {} as never,
      access: "ReadWrite" as const,
    },
  ],
  writableRegions: [],
});

describe("native POSIX sandbox policy plans", () => {
  it("builds closed bwrap argv with private network, exact mount roots, scrubbed env and bounded cwd", () => {
    const root = makeRoot();
    writeFileSync(join(root, "bin", "tool"), "#!/bin/sh\nexit 0\n");
    const policy = policyFor(root);
    const plan = buildBwrapPlan({
      policy,
      handle: handleFor(root),
      executable: join(root, "bin", "tool"),
      args: ["--safe"],
      cwd: { mount: "workspace", path: "work" },
      ambientEnvironment: { PATH: "/host/bin", LANG: "C", SECRET_KEY: "never" },
    });
    expect(plan._tag).toBe("Ready");
    if (plan._tag !== "Ready") return;
    expect(plan.argv).toContain("--unshare-user");
    expect(plan.argv).toContain("--unshare-pid");
    expect(plan.argv).toContain("--unshare-net");
    expect(plan.argv).toContain("--bind");
    expect(plan.argv).not.toContain("--share-net");
    expect(plan.env).toEqual({ PATH: "/host/bin", LANG: "C" });
    expect(plan.requestedLimits).toEqual(policy.limits);
    expect(
      plan.argv.slice(
        plan.argv.indexOf("--chdir"),
        plan.argv.indexOf("--chdir") + 2,
      ),
    ).toEqual(["--chdir", "/arbor/mounts/workspace/work"]);
    expect(plan.argv.some((arg) => arg.includes("SECRET_KEY"))).toBe(false);
  });

  it.each(["../outside", "/etc", "work/../../etc"])(
    "rejects cwd escape %s",
    (path) => {
      const root = makeRoot();
      writeFileSync(join(root, "bin", "tool"), "#!/bin/sh\nexit 0\n");
      const plan = buildBwrapPlan({
        policy: policyFor(root),
        handle: handleFor(root),
        executable: join(root, "bin", "tool"),
        args: [],
        cwd: { mount: "workspace", path },
        ambientEnvironment: {},
      });
      expect(plan).toMatchObject({
        _tag: "Unavailable",
        failureCode: "PathOutsideAdmittedMount",
      });
    },
  );

  it("rejects symlinked cwd escapes after realpath resolution", () => {
    const root = makeRoot();
    writeFileSync(join(root, "bin", "tool"), "#!/bin/sh\nexit 0\n");
    const outside = mkdtempSync(join(tmpdir(), "arbor-native-posix-outside-"));
    roots.push(outside);
    symlinkSync(outside, join(root, "work", "escape"), "junction");
    const plan = buildBwrapPlan({
      policy: policyFor(root),
      handle: handleFor(root),
      executable: join(root, "bin", "tool"),
      args: [],
      cwd: { mount: "workspace", path: "work/escape" },
      ambientEnvironment: {},
    });
    expect(plan).toMatchObject({
      _tag: "Unavailable",
      failureCode: "PathOutsideAdmittedMount",
    });
  });

  it("builds deny-default Seatbelt profile with exact read/write roots and network denied", () => {
    const root = makeRoot();
    writeFileSync(join(root, "bin", "tool"), "#!/bin/sh\nexit 0\n");
    const profile = buildSeatbeltProfile({
      policy: { ...policyFor(root), providerId: "macos-seatbelt" },
      handle: handleFor(root),
      executable: join(root, "bin", "tool"),
    });
    expect(profile._tag).toBe("Ready");
    if (profile._tag !== "Ready") return;
    expect(profile.source).toContain("(deny default)");
    expect(profile.source).toContain('(allow file-read* (subpath "');
    expect(profile.source).toContain('(allow file-write* (subpath "');
    expect(profile.source).toContain("(deny network*)");
    expect(profile.source).not.toContain("allow network");
  });

  it("fails closed for unsupported runtime probes and never reports Supported", async () => {
    const missingBwrap = await probeLinuxBwrap({
      platform: "linux",
      run: async () => undefined,
      readFile: async () => undefined,
    });
    const linux = await probeLinuxBwrap({
      platform: "win32",
    });
    const hostWithoutProbe = await probeLinuxBwrap({ platform: "linux" });
    const mac = await probeMacOSSeatbelt({
      platform: "linux",
      exists: () => false,
    });
    expect(linux).toMatchObject({
      providerId: "linux-bwrap",
      status: "Experimental",
      profiles: [],
      networkModes: [],
      failureCode: "UnsupportedPlatform",
    });
    expect(mac).toMatchObject({
      providerId: "macos-seatbelt",
      status: "Experimental",
      profiles: [],
      networkModes: [],
      failureCode: "UnsupportedPlatform",
    });
    expect(missingBwrap).toMatchObject({
      providerId: "linux-bwrap",
      status: "Experimental",
      profiles: [],
      networkModes: [],
      failureCode: "RequiredPrerequisiteUnavailable",
    });
    expect(hostWithoutProbe).toMatchObject({
      status: "Experimental",
      profiles: [],
      networkModes: [],
      failureCode: "RequiredPrerequisiteUnavailable",
      prerequisites: { bwrapExecutable: "Unavailable" },
    });
    expect([linux.status, mac.status]).not.toContain("Supported");
  });

  it("records Seatbelt executable and API prerequisites without claiming controls", async () => {
    const unavailable = await probeMacOSSeatbelt({
      platform: "darwin",
      exists: (path) => path === "/usr/bin/sandbox-exec",
    });
    expect(unavailable).toMatchObject({
      status: "Experimental",
      failureCode: "RequiredPrerequisiteUnavailable",
      profiles: [],
      networkModes: [],
      prerequisites: {
        sandboxExecFile: "PrerequisiteDetected",
        processKillApi: "PrerequisiteDetected",
        rlimitHelperFile: "Unavailable",
        networkBrokerChannel: "Unavailable",
      },
    });
    const experimental = await probeMacOSSeatbelt({
      platform: "darwin",
      exists: () => true,
    });
    expect(experimental).toMatchObject({
      status: "Experimental",
      profiles: [],
      networkModes: [],
      failureCode: null,
    });
  });

  it("records Linux prerequisite presence without publishing profile or network tuples", async () => {
    const evidence: NativePosixProbe = {
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
      networkBrokerChannel: "Unavailable",
      processKillApi: "PrerequisiteDetected",
    };
    const result = await probeLinuxBwrap({
      platform: "linux",
      probe: evidence,
    });
    expect(result.status).toBe("Experimental");
    expect(result.profiles).toEqual([]);
    expect(result.networkModes).toEqual([]);
    expect(result.prerequisites).toMatchObject({
      cgroupPidsController: "PrerequisiteDetected",
      cgroupMemoryController: "PrerequisiteDetected",
      cgroupCpuController: "PrerequisiteDetected",
      processKillApi: "PrerequisiteDetected",
      networkBrokerChannel: "Unavailable",
    });
    expect(result.probeEvidenceRef).toMatch(/^sha256:[0-9a-f]{64}$/u);
    const missingCpu = await probeLinuxBwrap({
      platform: "linux",
      probe: { ...evidence, cgroupCpuController: "Unavailable" },
    });
    expect(missingCpu).toMatchObject({
      status: "Experimental",
      failureCode: "RequiredPrerequisiteUnavailable",
      profiles: [],
      networkModes: [],
    });
  });

  it("probes bwrap with the exact user, mount, PID and network namespace combinations", async () => {
    const calls: string[][] = [];
    const result = await probeLinuxBwrap({
      platform: "linux",
      run: async (_command, args) => {
        calls.push([...args]);
        if (args[0] === "--version") return "bubblewrap 0.8.0";
        if (args[0] === "--help") return "--seccomp";
        return "probe-ok";
      },
      readFile: async (path) =>
        path.endsWith("cgroup.controllers")
          ? "cpu memory pids"
          : "kill trap errno",
    });
    const namespaceCalls = calls.filter(
      (args) => args[0] === "--die-with-parent",
    );
    expect(namespaceCalls).toHaveLength(4);
    expect(namespaceCalls.some((args) => args.includes("--unshare-user"))).toBe(
      true,
    );
    expect(namespaceCalls.some((args) => args.includes("--unshare-pid"))).toBe(
      true,
    );
    expect(namespaceCalls.some((args) => args.includes("--unshare-net"))).toBe(
      true,
    );
    expect(result.prerequisites).toMatchObject({
      userNamespaceProbe: "PrerequisiteDetected",
      mountNamespaceProbe: "PrerequisiteDetected",
      pidNamespaceProbe: "PrerequisiteDetected",
      networkNamespaceProbe: "PrerequisiteDetected",
      cgroupPidsController: "PrerequisiteDetected",
      cgroupMemoryController: "PrerequisiteDetected",
      cgroupCpuController: "PrerequisiteDetected",
      seccompInterface: "PrerequisiteDetected",
      networkBrokerChannel: "Unavailable",
      processKillApi: "Unavailable",
    });
    expect(result).toMatchObject({
      status: "Experimental",
      profiles: [],
      networkModes: [],
    });
  });

  it("rejects Restricted networking without an installed broker", () => {
    const root = makeRoot();
    writeFileSync(join(root, "bin", "tool"), "#!/bin/sh\nexit 0\n");
    const policy = {
      ...policyFor(root),
      networkPolicy: {
        version: 1 as const,
        mode: "Restricted" as const,
        destinations: ["https://example.com:443"],
      },
    };
    expect(
      buildBwrapPlan({
        policy,
        handle: handleFor(root),
        executable: join(root, "bin", "tool"),
        args: [],
        cwd: { mount: "workspace", path: "work" },
        ambientEnvironment: {},
      }),
    ).toMatchObject({
      _tag: "Unavailable",
      failureCode: "NetworkBrokerUnavailable",
    });
  });

  it("drops environment variables outside the shared sandbox allowlist even when policy names them", () => {
    const root = makeRoot();
    writeFileSync(join(root, "bin", "tool"), "#!/bin/sh\nexit 0\n");
    const policy = {
      ...policyFor(root),
      environmentAllowlist: ["PATH", "AWS_SECRET_ACCESS_KEY"],
    };
    const plan = buildBwrapPlan({
      policy,
      handle: handleFor(root),
      executable: join(root, "bin", "tool"),
      args: [],
      cwd: { mount: "workspace", path: "work" },
      ambientEnvironment: {
        PATH: "/host/bin",
        AWS_SECRET_ACCESS_KEY: "secret",
      },
    });
    expect(plan).toMatchObject({ _tag: "Ready", env: { PATH: "/host/bin" } });
    if (plan._tag === "Ready")
      expect(plan.env).not.toHaveProperty("AWS_SECRET_ACCESS_KEY");
  });

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
});
