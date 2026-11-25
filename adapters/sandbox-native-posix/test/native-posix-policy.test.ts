import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { release, tmpdir } from "node:os";
import { join } from "node:path";
import {
  encodeSandboxEnforcementRuleSetV1,
  encodeSandboxEnforcementRuleSetV2,
  encodeSandboxLinuxQualificationManifestV2,
  encodeVerificationSandboxBindingV1,
  networkBrokerControlsV2ForMode,
  sandboxEnforcementRuleSetV1ForProvider,
  sandboxEnforcementRuleSetV2ForProvider,
} from "@arbor/domain";
import {
  type OsEnforcedSandboxProcessPolicy,
  SandboxProcessPort,
  type SandboxProcessRequest,
} from "@arbor/ports";
import { Cause, Effect, Fiber } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildBwrapPlan,
  buildSeatbeltProfile,
  makeNativePosixSandboxProcessPort,
  type NativePosixCapability,
  type NativePosixProbe,
  type NativePosixSandboxOptions,
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
  providerVersion: "qualified-v1",
  capabilityRevision: "qualified-v1",
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

const qualifiedLinuxProvider = (
  options: Pick<NativePosixSandboxOptions, "networkBrokerFactory"> = {},
) =>
  makeNativePosixSandboxProcessPort({
    ...options,
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
      networkModes: ["Disabled", "Enabled"],
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
  });

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
    if (existsSync("/etc/ssl")) {
      const sslIndex = plan.argv.indexOf("/etc/ssl");
      expect(plan.argv.slice(sslIndex - 1, sslIndex + 2)).toEqual([
        "--ro-bind",
        "/etc/ssl",
        "/etc/ssl",
      ]);
    }
    expect(plan.env).toEqual({
      PATH: "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
      LANG: "C",
      HOME: "/tmp",
      TMPDIR: "/tmp",
    });
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

  it("rejects a qualification row whose rule digest is not the Linux provider rule set", async () => {
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
      networkBrokerChannel: "PrerequisiteDetected",
      processKillApi: "PrerequisiteDetected",
    };
    const ruleSet = sandboxEnforcementRuleSetV1ForProvider("linux-bwrap");
    if (ruleSet === undefined) throw new Error("Linux rule set missing");
    const expectedDigest = createHash("sha256")
      .update(encodeSandboxEnforcementRuleSetV1(ruleSet), "utf8")
      .digest("hex");
    const result = await probeLinuxBwrap({
      platform: "linux",
      probe: evidence,
      qualificationRows: [
        {
          providerVersion: "qualified-v1",
          capabilityRevision: "1",
          osBuild: process.platform === "linux" ? release() : "",
          profile: "WorkspaceWrite",
          networkMode: "Enabled",
          enforcementRuleSetDigest: `${expectedDigest.slice(0, -1)}0`,
          qualificationEvidenceRef: `blob:sha256:${"a".repeat(64)}`,
        },
      ],
    });
    expect(result).toMatchObject({
      status: "Experimental",
      profiles: [],
      networkModes: [],
      failureCode: "QualificationMaterialMismatch",
    });
  });

  it("probes bwrap with the exact user, mount, PID and network namespace combinations", async () => {
    const calls: string[][] = [];
    const commands: string[] = [];
    const result = await probeLinuxBwrap({
      platform: "linux",
      run: async (command, args) => {
        calls.push([...args]);
        commands.push(command);
        if (args[0] === "--version") return "bubblewrap 0.8.0";
        if (args[0] === "--help")
          return command === "/usr/bin/setpriv"
            ? "--seccomp-filter"
            : "--seccomp --disable-userns --assert-userns-disabled";
        return "probe-ok";
      },
      readFile: async (path) =>
        path.endsWith("cgroup.controllers")
          ? "cpu memory pids"
          : "kill trap errno",
    });
    expect(new Set(commands)).toEqual(
      new Set(["/usr/bin/bwrap", "/usr/bin/setpriv"]),
    );
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
      processKillApi: "PrerequisiteDetected",
    });
    expect(result).toMatchObject({
      status: "Experimental",
      profiles: [],
      networkModes: [],
    });
  });

  it("records the production broker channel when the composition provides it", async () => {
    const result = await probeLinuxBwrap({
      platform: "linux",
      networkBrokerChannel: "PrerequisiteDetected",
      run: async (_command, args) =>
        args[0] === "--version" ? "bubblewrap 0.12.0" : "--seccomp probe-ok",
      readFile: async (path) =>
        path.endsWith("cgroup.controllers")
          ? "cpu memory pids"
          : "kill_process log errno trace trap",
    });
    expect(result.prerequisites.networkBrokerChannel).toBe(
      "PrerequisiteDetected",
    );
  });

  it.each([
    { version: 2, mode: "Disabled", destinations: [] },
    { version: 1, mode: "Disabled", destinations: ["https://example.com"] },
    { version: 1, mode: "Restricted", destinations: [] },
    {
      version: 1,
      mode: "Restricted",
      destinations: ["https://example.com:443"],
    },
  ])(
    "rejects malformed network policy before planning: %j",
    (networkPolicy) => {
      const root = makeRoot();
      expect(
        buildBwrapPlan({
          policy: { ...policyFor(root), networkPolicy: networkPolicy as never },
          handle: handleFor(root),
          executable: "bash",
          args: [],
          cwd: { mount: "workspace", path: "work" },
          ambientEnvironment: {},
        }),
      ).toMatchObject({
        _tag: "Unavailable",
        failureCode: "InvalidNetworkPolicy",
      });
    },
  );

  it("rejects Restricted networking without an installed broker", () => {
    const root = makeRoot();
    writeFileSync(join(root, "bin", "tool"), "#!/bin/sh\nexit 0\n");
    const policy = {
      ...policyFor(root),
      networkPolicy: {
        version: 1 as const,
        mode: "Restricted" as const,
        destinations: ["https://example.com"],
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

  it("rejects a regular file masquerading as the broker socket", () => {
    const root = makeRoot();
    writeFileSync(join(root, "bin", "tool"), "#!/bin/sh\nexit 0\n");
    const brokerDirectory = mkdtempSync(
      join(tmpdir(), "arbor-native-network-binding-"),
    );
    roots.push(brokerDirectory);
    const socketPath = join(brokerDirectory, "egress.sock");
    writeFileSync(socketPath, "not a socket");
    const certificatePath = join(root, "authority.pem");
    writeFileSync(certificatePath, "certificate");
    const plan = buildBwrapPlan({
      policy: {
        ...policyFor(root),
        networkPolicy: {
          version: 1,
          mode: "Enabled",
          destinations: [],
        },
      },
      handle: handleFor(root),
      executable: join(root, "bin", "tool"),
      args: [],
      cwd: { mount: "workspace", path: "work" },
      ambientEnvironment: {},
      networkBroker: {
        socketDirectory: realpathSync(brokerDirectory),
        socketPath: realpathSync(socketPath),
        certificatePath: realpathSync(certificatePath),
        helperPath: realpathSync(certificatePath),
        proxyPort: 3128,
        close: async () => undefined,
      },
    });
    expect(plan).toMatchObject({
      _tag: "Unavailable",
      failureCode: "NetworkBrokerBindingInvalid",
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
    expect(plan).toMatchObject({
      _tag: "Ready",
      env: { PATH: "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin" },
    });
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

  it.skipIf(process.platform !== "linux")(
    "resolves the shell executor's bare bash name without using ambient PATH",
    () => {
      const root = makeRoot();
      writeFileSync(join(root, "bin", "bash"), "#!/bin/sh\nexit 42\n");
      const plan = buildBwrapPlan({
        policy: policyFor(root),
        handle: handleFor(root),
        executable: "bash",
        args: ["-lc", "printf bare-shell-ok"],
        cwd: { mount: "workspace", path: "work" },
        ambientEnvironment: { PATH: join(root, "bin") },
      });
      expect(plan._tag).toBe("Ready");
      if (plan._tag !== "Ready") return;
      expect(plan.argv.slice(-3)).toEqual([
        realpathSync("/usr/bin/bash"),
        "-lc",
        "printf bare-shell-ok",
      ]);
    },
  );

  it.skipIf(process.env.ARBOR_RUN_NATIVE_POSIX !== "1")(
    "stops the process tree before returning a failed output-overflow result",
    async () => {
      const root = makeRoot();
      const base = policyFor(root);
      const result = await Effect.runPromise(
        qualifiedLinuxProvider().run({
          policy: {
            ...base,
            limits: { ...base.limits, stdoutBytes: 128, processCount: 8 },
          },
          handle: handleFor(root),
          executable: "bash",
          args: [
            "-lc",
            "dd if=/dev/zero bs=100000 count=1 status=none; sleep 1; printf orphaned > after-return.txt",
          ],
          cwd: { mount: "workspace", path: "work" },
          timeoutMs: 5000,
          ambientEnvironment: {},
        }),
      );
      expect(result).toMatchObject({ _tag: "Completed", truncated: true });
      if (result._tag !== "Completed") return;
      // A truncated capture of a normally completed command can be successful.
      // Here the supervisor client was killed by maxBuffer before shell exit.
      expect(result.exitCode).not.toBe(0);
      await new Promise((resolveWait) => setTimeout(resolveWait, 1500));
      expect(existsSync(join(root, "work", "after-return.txt"))).toBe(false);
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

  it.skipIf(process.env.ARBOR_RUN_NATIVE_POSIX !== "1")(
    "interrupting a native invocation stops descendants before interruption finishes",
    async () => {
      const root = makeRoot();
      const base = policyFor(root);
      const fiber = Effect.runFork(
        qualifiedLinuxProvider().run({
          policy: { ...base, limits: { ...base.limits, processCount: 8 } },
          handle: handleFor(root),
          executable: "bash",
          args: [
            "-lc",
            "cat /proc/self/cgroup > group.txt; (sleep 1; printf orphaned > after-interrupt.txt) & printf ready > ready.txt; wait",
          ],
          cwd: { mount: "workspace", path: "work" },
          timeoutMs: 5000,
          ambientEnvironment: {},
        }),
      );
      try {
        await vi.waitFor(
          () => expect(existsSync(join(root, "work", "ready.txt"))).toBe(true),
          { timeout: 4000, interval: 20 },
        );
        await Effect.runPromise(Fiber.interrupt(fiber));
        const group = readFileSync(join(root, "work", "group.txt"), "utf8")
          .trim()
          .split("0::")[1];
        expect(group).toContain("arbor-sandbox-");
        const events = `/sys/fs/cgroup${group}/cgroup.events`;
        if (existsSync(events))
          expect(readFileSync(events, "utf8")).toContain("populated 0");
        await new Promise((resolveWait) => setTimeout(resolveWait, 1250));
        expect(existsSync(join(root, "work", "after-interrupt.txt"))).toBe(
          false,
        );
      } finally {
        await Effect.runPromise(Fiber.interrupt(fiber));
      }
    },
  );

  it.skipIf(process.env.ARBOR_RUN_NATIVE_POSIX !== "1")(
    "interrupts A without stopping a simultaneous isolated invocation B",
    async () => {
      const first = makeRoot();
      const second = makeRoot();
      const provider = qualifiedLinuxProvider();
      const run = (root: string) => {
        const base = policyFor(root);
        return Effect.runFork(
          provider.run({
            policy: { ...base, limits: { ...base.limits, processCount: 8 } },
            handle: handleFor(root),
            executable: "bash",
            args: [
              "-lc",
              "printf ready > ready.txt; sleep 2; printf finished > finished.txt",
            ],
            cwd: { mount: "workspace", path: "work" },
            timeoutMs: 5000,
            ambientEnvironment: {},
          }),
        );
      };
      const a = run(first);
      const b = run(second);
      try {
        await vi.waitFor(
          () => {
            expect(existsSync(join(first, "work", "ready.txt"))).toBe(true);
            expect(existsSync(join(second, "work", "ready.txt"))).toBe(true);
          },
          { timeout: 4000, interval: 20 },
        );
        await Effect.runPromise(Fiber.interrupt(a));
        expect(await Effect.runPromise(Fiber.join(b))).toMatchObject({
          _tag: "Completed",
          exitCode: 0,
        });
        expect(readFileSync(join(second, "work", "finished.txt"), "utf8")).toBe(
          "finished",
        );
        expect(existsSync(join(first, "work", "finished.txt"))).toBe(false);
      } finally {
        await Effect.runPromise(Fiber.interrupt(a));
        await Effect.runPromise(Fiber.interrupt(b));
      }
    },
  );

  it.skipIf(process.env.ARBOR_RUN_NATIVE_POSIX !== "1")(
    "executes a real disabled-network process under systemd and bubblewrap",
    async () => {
      const root = makeRoot();
      const request: SandboxProcessRequest = {
        policy: { ...policyFor(root), providerId: "linux-bwrap" },
        handle: handleFor(root),
        executable: "bash",
        args: [
          "-lc",
          "printf native-ok; printf created > created.txt; test -f created.txt",
        ],
        cwd: { mount: "workspace", path: "work" },
        timeoutMs: 5000,
        ambientEnvironment: process.env,
      };
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
      });
      const outcome = await Effect.runPromise(provider.run(request));
      expect(outcome).toMatchObject({ _tag: "Completed", exitCode: 0 });
      expect(outcome).toMatchObject({ stdout: "native-ok" });
      expect(readFileSync(join(root, "work", "created.txt"), "utf8")).toBe(
        "created",
      );
    },
  );

  it.skipIf(process.env.ARBOR_RUN_NATIVE_POSIX !== "1")(
    "keeps host data, network and ambient secrets outside the real process boundary",
    async () => {
      const root = makeRoot();
      const hostOnly = join(
        process.env.HOME ?? "/home",
        `.arbor-native-host-only-${process.pid}`,
      );
      writeFileSync(hostOnly, "host-only");
      try {
        const request: SandboxProcessRequest = {
          policy: { ...policyFor(root), providerId: "linux-bwrap" },
          handle: handleFor(root),
          executable: "/bin/bash",
          args: [
            "-lc",
            'test ! -r /etc/passwd && test ! -r "$1" && test -z "$ARBOR_NATIVE_SECRET" && if (exec 3<>/dev/tcp/1.1.1.1/80); then exit 41; else exit 0; fi',
            "arbor-native-boundary",
            hostOnly,
          ],
          cwd: { mount: "workspace", path: "work" },
          timeoutMs: 5000,
          ambientEnvironment: {
            ...process.env,
            ARBOR_NATIVE_HOST_ONLY: hostOnly,
            ARBOR_NATIVE_SECRET: "must-not-reach-child",
          },
        };
        const outcome = await Effect.runPromise(
          qualifiedLinuxProvider().run(request),
        );
        expect(outcome).toMatchObject({ _tag: "Completed", exitCode: 0 });
      } finally {
        rmSync(hostOnly, { force: true });
      }
    },
  );

  it.skipIf(process.env.ARBOR_RUN_NATIVE_POSIX !== "1")(
    "enforces output and wall-time limits through the real process supervisor",
    async () => {
      const root = makeRoot();
      const basePolicy = policyFor(root);
      const outputRequest: SandboxProcessRequest = {
        policy: {
          ...basePolicy,
          providerId: "linux-bwrap",
          limits: { ...basePolicy.limits, stdoutBytes: 128 },
        },
        handle: handleFor(root),
        executable: "/bin/bash",
        args: ["-lc", "head -c 10000 /dev/zero | tr '\\0' x"],
        cwd: { mount: "workspace", path: "work" },
        timeoutMs: 5000,
        ambientEnvironment: process.env,
      };
      const output = await Effect.runPromise(
        qualifiedLinuxProvider().run(outputRequest),
      );
      expect(output, JSON.stringify(output)).toMatchObject({
        _tag: "Completed",
        truncated: true,
      });
      if (output._tag === "Completed")
        expect(output.stdout.length).toBeLessThanOrEqual(128);

      const timeoutRequest: SandboxProcessRequest = {
        ...outputRequest,
        policy: {
          ...outputRequest.policy,
          limits: { ...outputRequest.policy.limits, wallTimeMs: 1000 },
        },
        args: ["-lc", "sleep 30"],
        timeoutMs: 1000,
      };
      const timeout = await Effect.runPromise(
        qualifiedLinuxProvider().run(timeoutRequest),
      );
      expect(timeout).toMatchObject({ _tag: "Completed", timedOut: true });
    },
  );
});
