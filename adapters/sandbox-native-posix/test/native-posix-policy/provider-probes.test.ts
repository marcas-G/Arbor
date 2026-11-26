import { createHash } from "node:crypto";
import { release } from "node:os";
import {
  encodeSandboxEnforcementRuleSetV1,
  sandboxEnforcementRuleSetV1ForProvider,
} from "@arbor/domain";
import { describe, expect, it } from "vitest";
import {
  type NativePosixProbe,
  probeLinuxBwrap,
  probeMacOSSeatbelt,
} from "../../src/index.js";

describe("native POSIX sandbox policy plans", () => {
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
});
