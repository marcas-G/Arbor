import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type {
  SandboxProviderCapability,
  SandboxProviderId,
} from "@arbor/domain";
import {
  projectSandboxEnvironment,
  SANDBOX_ENV_ALLOWLIST,
  type SandboxHandle,
  type SandboxProcessPolicy,
  SandboxProcessPort,
  type SandboxProcessPortService,
  type SandboxProcessProviderOutcome,
  type SandboxProcessRequest,
  sandboxEnvironment,
} from "@arbor/ports";
import { Effect, Layer } from "effect";

export const LINUX_BWRAP_PROVIDER_ID = "linux-bwrap";
export const MACOS_SEATBELT_PROVIDER_ID = "macos-seatbelt";
const EXPERIMENTAL_VERSION = "experimental-v1";

export { SANDBOX_ENV_ALLOWLIST, sandboxEnvironment };

export type PrerequisiteStatus = "PrerequisiteDetected" | "Unavailable";

export interface NativePosixProbe {
  readonly platform: string;
  readonly bwrapExecutable: PrerequisiteStatus;
  readonly userNamespaceProbe: PrerequisiteStatus;
  readonly mountNamespaceProbe: PrerequisiteStatus;
  readonly pidNamespaceProbe: PrerequisiteStatus;
  readonly networkNamespaceProbe: PrerequisiteStatus;
  readonly cgroupV2Hierarchy: PrerequisiteStatus;
  readonly cgroupPidsController: PrerequisiteStatus;
  readonly cgroupMemoryController: PrerequisiteStatus;
  readonly cgroupCpuController: PrerequisiteStatus;
  readonly seccompInterface: PrerequisiteStatus;
  readonly networkBrokerChannel: PrerequisiteStatus;
  readonly processKillApi: PrerequisiteStatus;
}

export interface LinuxProbeInput {
  readonly platform: string;
  readonly probe?: NativePosixProbe;
  readonly run?: (
    command: string,
    args: ReadonlyArray<string>,
  ) => Promise<string | undefined>;
  readonly readFile?: (path: string) => Promise<string | undefined>;
}

export interface SeatbeltProbeInput {
  readonly platform: string;
  readonly exists?: (path: string) => boolean;
}

export interface NativePosixCapability extends SandboxProviderCapability {
  readonly failureCode: string | null;
  readonly prerequisites: Readonly<Record<string, PrerequisiteStatus>>;
}

export type PolicyPlan =
  | {
      readonly _tag: "Ready";
      readonly argv: ReadonlyArray<string>;
      readonly cwd: string;
      readonly env: NodeJS.ProcessEnv;
      readonly requestedLimits: SandboxProcessPolicy["limits"];
    }
  | { readonly _tag: "Unavailable"; readonly failureCode: string };

export type SeatbeltProfile =
  | {
      readonly _tag: "Ready";
      readonly source: string;
      readonly requestedLimits: SandboxProcessPolicy["limits"];
    }
  | { readonly _tag: "Unavailable"; readonly failureCode: string };

interface PlanInput {
  readonly policy: SandboxProcessPolicy;
  readonly handle: SandboxHandle;
  readonly executable: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd: { readonly mount: string; readonly path: string };
  readonly ambientEnvironment: NodeJS.ProcessEnv;
}

const safeRef = /^[a-z][a-z0-9_-]{0,63}$/u;
const safeEnvName = /^[A-Za-z_][A-Za-z0-9_]*$/u;

const within = (root: string, candidate: string): boolean => {
  const path = relative(root, candidate);
  return (
    path === "" ||
    (!path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path))
  );
};

const canonicalRoots = (
  policy: SandboxProcessPolicy,
  handle: SandboxHandle,
):
  | ReadonlyArray<{
      readonly ref: string;
      readonly root: string;
      readonly access: "ReadOnly" | "ReadWrite";
    }>
  | undefined => {
  const boundMounts = handle.mounts;
  if (
    boundMounts === undefined ||
    boundMounts.length === 0 ||
    policy.admittedMounts.length !== boundMounts.length
  )
    return undefined;
  const roots: Array<{
    ref: string;
    root: string;
    access: "ReadOnly" | "ReadWrite";
  }> = [];
  for (const mount of policy.admittedMounts) {
    if (!safeRef.test(mount.ref) || !isAbsolute(mount.rootPath))
      return undefined;
    const bound = boundMounts.find((candidate) => candidate.ref === mount.ref);
    if (bound === undefined || bound.access !== mount.access) return undefined;
    let root: string;
    let boundRoot: string;
    try {
      root = realpathSync.native(mount.rootPath);
      boundRoot = realpathSync.native(bound.rootPath);
    } catch {
      return undefined;
    }
    if (root !== mount.rootPath || boundRoot !== root) return undefined;
    if (policy.profile === "ReadOnly" && mount.access !== "ReadOnly")
      return undefined;
    roots.push({ ref: mount.ref, root, access: mount.access });
  }
  if (new Set(roots.map((mount) => mount.ref)).size !== roots.length)
    return undefined;
  return roots;
};

const resolveInMount = (
  root: string,
  relativePath: string,
): string | undefined => {
  if (
    relativePath.length === 0 ||
    relativePath.includes("\0") ||
    isAbsolute(relativePath)
  )
    return undefined;
  const segments = relativePath.split(/[\\/]/u);
  if (segments.some((segment) => segment === "..")) return undefined;
  const candidate = resolve(root, relativePath);
  try {
    const canonical = realpathSync.native(candidate);
    return within(root, canonical) ? canonical : undefined;
  } catch {
    return undefined;
  }
};

const mappedPath = (
  roots: ReadonlyArray<{ readonly ref: string; readonly root: string }>,
  hostPath: string,
): string | undefined => {
  if (!isAbsolute(hostPath)) return undefined;
  let canonical: string;
  try {
    canonical = realpathSync.native(hostPath);
  } catch {
    return undefined;
  }
  const root = roots.find((candidate) => within(candidate.root, canonical));
  if (root === undefined) return undefined;
  const subpath = relative(root.root, canonical).split(sep).join("/");
  return subpath.length === 0
    ? `/arbor/mounts/${root.ref}`
    : `/arbor/mounts/${root.ref}/${subpath}`;
};

const validatePlanInput = (input: PlanInput) => {
  if (input.policy.providerId !== LINUX_BWRAP_PROVIDER_ID)
    return {
      _tag: "Unavailable" as const,
      failureCode: "ProviderBindingMismatch",
    };
  if (input.policy.sandboxHandleId !== input.handle.handleId)
    return {
      _tag: "Unavailable" as const,
      failureCode: "HandleBindingMismatch",
    };
  if (
    !Object.values(input.policy.limits).every(
      (value) => Number.isSafeInteger(value) && value > 0,
    )
  )
    return { _tag: "Unavailable" as const, failureCode: "InvalidLimits" };
  const roots = canonicalRoots(input.policy, input.handle);
  if (roots === undefined)
    return { _tag: "Unavailable" as const, failureCode: "MountBindingInvalid" };
  if (input.policy.networkPolicy.mode !== "Disabled")
    return {
      _tag: "Unavailable" as const,
      failureCode: "NetworkBrokerUnavailable",
    };
  if (input.policy.networkPolicy.destinations.length !== 0)
    return {
      _tag: "Unavailable" as const,
      failureCode: "InvalidNetworkPolicy",
    };
  if (input.args.some((arg) => arg.includes("\0")))
    return { _tag: "Unavailable" as const, failureCode: "InvalidArgument" };
  const cwdMount = roots.find((mount) => mount.ref === input.cwd.mount);
  if (cwdMount === undefined)
    return { _tag: "Unavailable" as const, failureCode: "CwdMountNotAdmitted" };
  const cwd = resolveInMount(cwdMount.root, input.cwd.path);
  if (cwd === undefined)
    return {
      _tag: "Unavailable" as const,
      failureCode: "PathOutsideAdmittedMount",
    };
  const mappedCwd = mappedPath(roots, cwd);
  const mappedExecutable = mappedPath(roots, input.executable);
  if (mappedCwd === undefined || mappedExecutable === undefined)
    return {
      _tag: "Unavailable" as const,
      failureCode: "ExecutableOutsideAdmittedMount",
    };
  const env = projectSandboxEnvironment(
    sandboxEnvironment(input.ambientEnvironment),
    input.policy.environmentAllowlist.filter((name) =>
      SANDBOX_ENV_ALLOWLIST.includes(name),
    ),
  );
  if (Object.values(env).some((value) => value?.includes("\0")))
    return {
      _tag: "Unavailable" as const,
      failureCode: "InvalidEnvironmentValue",
    };
  if (input.policy.environmentAllowlist.some((name) => !safeEnvName.test(name)))
    return {
      _tag: "Unavailable" as const,
      failureCode: "InvalidEnvironmentAllowlist",
    };
  return {
    _tag: "Ready" as const,
    roots,
    cwd: mappedCwd,
    executable: mappedExecutable,
    env,
  };
};

/** Build the closed argv for a bubblewrap disabled-network policy. It never spawns. */
export const buildBwrapPlan = (input: PlanInput): PolicyPlan => {
  const validated = validatePlanInput(input);
  if (validated._tag !== "Ready") return validated;
  const argv = [
    "--die-with-parent",
    "--new-session",
    "--unshare-user",
    "--unshare-pid",
    "--unshare-ipc",
    "--unshare-uts",
    "--unshare-net",
    "--clearenv",
    "--tmpfs",
    "/",
    "--dir",
    "/arbor",
    "--dir",
    "/arbor/mounts",
    "--proc",
    "/proc",
    "--dev",
    "/dev",
    "--tmpfs",
    "/tmp",
  ];
  for (const mount of validated.roots) {
    argv.push(
      mount.access === "ReadWrite" ? "--bind" : "--ro-bind",
      mount.root,
      `/arbor/mounts/${mount.ref}`,
    );
  }
  for (const [key, value] of Object.entries(validated.env)) {
    if (value !== undefined) argv.push("--setenv", key, value);
  }
  argv.push(
    "--chdir",
    validated.cwd,
    "--",
    validated.executable,
    ...input.args,
  );
  return {
    _tag: "Ready",
    argv,
    cwd: "/",
    env: validated.env,
    requestedLimits: input.policy.limits,
  };
};

const seatbeltQuote = (value: string): string | undefined => {
  if (!isAbsolute(value) || value.includes("\0") || /[\r\n]/u.test(value))
    return undefined;
  return JSON.stringify(value);
};

/** Generate a deny-default macOS Seatbelt profile for the exact admitted roots. */
export const buildSeatbeltProfile = (input: {
  readonly policy: SandboxProcessPolicy;
  readonly handle: SandboxHandle;
  readonly executable: string;
}): SeatbeltProfile => {
  const policy = input.policy;
  if (policy.providerId !== MACOS_SEATBELT_PROVIDER_ID)
    return { _tag: "Unavailable", failureCode: "ProviderBindingMismatch" };
  if (policy.sandboxHandleId !== input.handle.handleId)
    return { _tag: "Unavailable", failureCode: "HandleBindingMismatch" };
  if (
    !Object.values(policy.limits).every(
      (value) => Number.isSafeInteger(value) && value > 0,
    )
  )
    return { _tag: "Unavailable", failureCode: "InvalidLimits" };
  if (policy.networkPolicy.mode !== "Disabled")
    return { _tag: "Unavailable", failureCode: "NetworkBrokerUnavailable" };
  if (policy.networkPolicy.destinations.length !== 0)
    return { _tag: "Unavailable", failureCode: "InvalidNetworkPolicy" };
  const roots = canonicalRoots(policy, input.handle);
  if (roots === undefined)
    return { _tag: "Unavailable", failureCode: "MountBindingInvalid" };
  const executable = mappedPath(roots, input.executable);
  if (executable === undefined)
    return {
      _tag: "Unavailable",
      failureCode: "ExecutableOutsideAdmittedMount",
    };
  const quotedExecutable = seatbeltQuote(realpathSync.native(input.executable));
  if (quotedExecutable === undefined)
    return { _tag: "Unavailable", failureCode: "InvalidExecutablePath" };
  const lines = [
    "(version 1)",
    "(deny default)",
    "(allow process-fork)",
    `(allow process-exec (literal ${quotedExecutable}))`,
  ];
  for (const mount of roots) {
    const quoted = seatbeltQuote(mount.root);
    if (quoted === undefined)
      return { _tag: "Unavailable", failureCode: "InvalidMountPath" };
    lines.push(`(allow file-read* (subpath ${quoted}))`);
    if (mount.access === "ReadWrite")
      lines.push(`(allow file-write* (subpath ${quoted}))`);
  }
  lines.push("(deny network*)");
  return {
    _tag: "Ready",
    source: `${lines.join("\n")}\n`,
    requestedLimits: policy.limits,
  };
};

const prerequisiteDetectionRef = (prerequisites: unknown): string =>
  `sha256:${createHash("sha256").update(JSON.stringify(prerequisites)).digest("hex")}`;

const linuxRequiredPrerequisites = (probe: NativePosixProbe) => ({
  bwrapExecutable: probe.bwrapExecutable,
  userNamespaceProbe: probe.userNamespaceProbe,
  mountNamespaceProbe: probe.mountNamespaceProbe,
  pidNamespaceProbe: probe.pidNamespaceProbe,
  networkNamespaceProbe: probe.networkNamespaceProbe,
  cgroupV2Hierarchy: probe.cgroupV2Hierarchy,
  cgroupPidsController: probe.cgroupPidsController,
  cgroupMemoryController: probe.cgroupMemoryController,
  cgroupCpuController: probe.cgroupCpuController,
  processKillApi: probe.processKillApi,
});

const linuxPrerequisiteStatuses = (probe: NativePosixProbe) => ({
  ...linuxRequiredPrerequisites(probe),
  seccompInterface: probe.seccompInterface,
  networkBrokerChannel: probe.networkBrokerChannel,
});

const unavailableLinuxProbe = (platform: string): NativePosixProbe => ({
  platform,
  bwrapExecutable: "Unavailable",
  userNamespaceProbe: "Unavailable",
  mountNamespaceProbe: "Unavailable",
  pidNamespaceProbe: "Unavailable",
  networkNamespaceProbe: "Unavailable",
  cgroupV2Hierarchy: "Unavailable",
  cgroupPidsController: "Unavailable",
  cgroupMemoryController: "Unavailable",
  cgroupCpuController: "Unavailable",
  seccompInterface: "Unavailable",
  networkBrokerChannel: "Unavailable",
  processKillApi: "Unavailable",
});

const prerequisiteStatus = (available: boolean): PrerequisiteStatus =>
  available ? "PrerequisiteDetected" : "Unavailable";

const hostReadFile = async (path: string) => {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
};

const hostRun = async (command: string, args: ReadonlyArray<string>) => {
  const result = spawnSync(command, [...args], {
    encoding: "utf8",
    timeout: 2_000,
    windowsHide: true,
  });
  return result.error === undefined && result.status === 0
    ? `${result.stdout}${result.stderr}`
    : undefined;
};

/** Detect Linux prerequisites without creating cgroups or installing packages. */
export const probeLinuxBwrap = async (
  input: LinuxProbeInput,
): Promise<NativePosixCapability> => {
  let probe = input.probe;
  if (probe === undefined && input.platform === "linux") {
    const probeCommand = input.run ?? hostRun;
    const readFile = input.readFile ?? hostReadFile;
    const version = await probeCommand("bwrap", ["--version"]);
    const help = await probeCommand("bwrap", ["--help"]);
    const controllers = await readFile("/sys/fs/cgroup/cgroup.controllers");
    const seccomp = await readFile("/proc/sys/kernel/seccomp/actions_avail");
    const namespace = async (flags: ReadonlyArray<string>) =>
      (await probeCommand("bwrap", [
        "--die-with-parent",
        ...flags,
        "--ro-bind",
        "/",
        "/",
        "--proc",
        "/proc",
        "--",
        "/bin/true",
      ])) !== undefined;
    probe = {
      platform: input.platform,
      bwrapExecutable: prerequisiteStatus(
        version !== undefined && help !== undefined,
      ),
      userNamespaceProbe: prerequisiteStatus(
        await namespace(["--unshare-user"]),
      ),
      mountNamespaceProbe: prerequisiteStatus(
        await namespace(["--unshare-user"]),
      ),
      pidNamespaceProbe: prerequisiteStatus(
        await namespace(["--unshare-user", "--unshare-pid"]),
      ),
      networkNamespaceProbe: prerequisiteStatus(
        await namespace(["--unshare-user", "--unshare-net"]),
      ),
      cgroupV2Hierarchy: prerequisiteStatus(controllers !== undefined),
      cgroupPidsController: prerequisiteStatus(
        controllers?.split(/\s+/u).includes("pids") ?? false,
      ),
      cgroupMemoryController: prerequisiteStatus(
        controllers?.split(/\s+/u).includes("memory") ?? false,
      ),
      cgroupCpuController: prerequisiteStatus(
        controllers?.split(/\s+/u).includes("cpu") ?? false,
      ),
      seccompInterface: prerequisiteStatus(
        seccomp !== undefined && help?.includes("--seccomp") === true,
      ),
      networkBrokerChannel: "Unavailable",
      processKillApi: prerequisiteStatus(
        process.platform === "linux" && typeof process.kill === "function",
      ),
    };
  }
  probe ??= unavailableLinuxProbe(input.platform);
  const prerequisites = linuxRequiredPrerequisites(probe);
  const allDetected = Object.values(prerequisites).every(
    (status) => status === "PrerequisiteDetected",
  );
  const failureCode =
    input.platform !== "linux"
      ? "UnsupportedPlatform"
      : allDetected
        ? null
        : "RequiredPrerequisiteUnavailable";
  return {
    providerId: LINUX_BWRAP_PROVIDER_ID,
    providerVersion: EXPERIMENTAL_VERSION,
    capabilityRevision: "linux-bwrap-probe-v1",
    probeEvidenceRef: prerequisiteDetectionRef(probe),
    status: "Experimental",
    boundary: "OsEnforced",
    profiles: [],
    networkModes: [],
    failureCode,
    prerequisites: linuxPrerequisiteStatuses(probe),
  };
};

export interface SeatbeltProbe {
  readonly platform: string;
  readonly sandboxExecFile: PrerequisiteStatus;
  readonly processKillApi: PrerequisiteStatus;
  readonly rlimitHelperFile: PrerequisiteStatus;
  readonly networkBrokerChannel: PrerequisiteStatus;
}

export const probeMacOSSeatbelt = async (
  input: SeatbeltProbeInput,
): Promise<NativePosixCapability> => {
  const exists = input.exists ?? existsSync;
  const probe: SeatbeltProbe = {
    platform: input.platform,
    sandboxExecFile: prerequisiteStatus(
      input.platform === "darwin" && exists("/usr/bin/sandbox-exec"),
    ),
    processKillApi: prerequisiteStatus(
      input.platform === "darwin" && typeof process.kill === "function",
    ),
    rlimitHelperFile: prerequisiteStatus(
      input.platform === "darwin" && exists("/usr/bin/prlimit"),
    ),
    networkBrokerChannel: "Unavailable",
  };
  const allDetected =
    input.platform === "darwin" &&
    probe.sandboxExecFile === "PrerequisiteDetected" &&
    probe.processKillApi === "PrerequisiteDetected" &&
    probe.rlimitHelperFile === "PrerequisiteDetected";
  const failureCode =
    input.platform !== "darwin"
      ? "UnsupportedPlatform"
      : allDetected
        ? null
        : "RequiredPrerequisiteUnavailable";
  return {
    providerId: MACOS_SEATBELT_PROVIDER_ID,
    providerVersion: EXPERIMENTAL_VERSION,
    capabilityRevision: "macos-seatbelt-probe-v1",
    probeEvidenceRef: prerequisiteDetectionRef(probe),
    status: "Experimental",
    boundary: "OsEnforced",
    profiles: [],
    networkModes: [],
    failureCode,
    prerequisites: {
      sandboxExecFile: probe.sandboxExecFile,
      processKillApi: probe.processKillApi,
      rlimitHelperFile: probe.rlimitHelperFile,
      networkBrokerChannel: probe.networkBrokerChannel,
    },
  };
};

export interface NativePosixSandboxOptions {
  readonly platform?: string;
  readonly linuxProbe?: () => Promise<NativePosixCapability>;
  readonly seatbeltProbe?: () => Promise<NativePosixCapability>;
}

export const makeNativePosixSandboxProcessPort = (
  options: NativePosixSandboxOptions = {},
): SandboxProcessPortService => {
  const platform = options.platform ?? process.platform;
  const linuxProbe =
    options.linuxProbe ?? (() => probeLinuxBwrap({ platform }));
  const seatbeltProbe =
    options.seatbeltProbe ?? (() => probeMacOSSeatbelt({ platform }));
  const probes: Readonly<Record<string, () => Promise<NativePosixCapability>>> =
    {
      [LINUX_BWRAP_PROVIDER_ID]: linuxProbe,
      [MACOS_SEATBELT_PROVIDER_ID]: seatbeltProbe,
    };
  const service: SandboxProcessPortService = {
    capabilities: () =>
      Effect.promise(() =>
        Promise.all(
          Object.entries(probes).map(async ([providerId, probe]) => {
            try {
              return await probe();
            } catch {
              return unavailableCapability(providerId, "CapabilityProbeFailed");
            }
          }),
        ),
      ),
    run: (
      request: SandboxProcessRequest,
    ): Effect.Effect<SandboxProcessProviderOutcome> =>
      Effect.tryPromise({
        try: async () => {
          const probe = probes[request.policy.providerId];
          if (probe === undefined)
            return unavailable(request.policy, "ProviderNotFound", null);
          const capability = await probe();
          if (capability.failureCode !== null)
            return unavailable(
              request.policy,
              capability.failureCode,
              capability.probeEvidenceRef,
            );
          return unavailable(
            request.policy,
            "ExperimentalProviderExecutionDisabled",
            capability.probeEvidenceRef,
          );
        },
        catch: () => unavailable(request.policy, "CapabilityProbeFailed", null),
      }).pipe(
        Effect.orElseSucceed(() =>
          unavailable(request.policy, "CapabilityProbeFailed", null),
        ),
      ),
  };
  return service;
};

export const NativePosixSandboxProcessPortLive = (
  options: NativePosixSandboxOptions = {},
): Layer.Layer<SandboxProcessPort> =>
  Layer.succeed(SandboxProcessPort, makeNativePosixSandboxProcessPort(options));

const unavailableCapability = (
  providerId: string,
  failureCode: string,
): NativePosixCapability => ({
  providerId,
  providerVersion: EXPERIMENTAL_VERSION,
  capabilityRevision: "probe-failed-v1",
  probeEvidenceRef: null,
  status: "Experimental",
  boundary: "OsEnforced",
  profiles: [],
  networkModes: [],
  failureCode,
  prerequisites: { capabilityProbe: "Unavailable" },
});

const unavailable = (
  policy: SandboxProcessPolicy,
  failureCode: string,
  probeEvidenceRef: string | null,
): SandboxProcessProviderOutcome => ({
  _tag: "Unavailable",
  providerId: policy.providerId as SandboxProviderId,
  providerVersion: policy.providerVersion,
  probeEvidenceRef,
  failureCode,
});

export const nativePosixProviderIds = [
  LINUX_BWRAP_PROVIDER_ID,
  MACOS_SEATBELT_PROVIDER_ID,
] as const;
