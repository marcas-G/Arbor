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

export interface NativePosixProbe {
  readonly platform: string;
  readonly bwrap: boolean;
  readonly userNamespace: boolean;
  readonly mountNamespace: boolean;
  readonly pidNamespace: boolean;
  readonly networkNamespace: boolean;
  readonly cgroupV2: boolean;
  readonly cgroupPids: boolean;
  readonly cgroupMemory: boolean;
  readonly cgroupCpu: boolean;
  readonly seccomp: boolean;
  readonly brokerChannel: boolean;
  readonly processTreeCleanup: boolean;
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
  readonly primitives: Readonly<Record<string, unknown>>;
}

export type PolicyPlan =
  | {
      readonly _tag: "Ready";
      readonly argv: ReadonlyArray<string>;
      readonly cwd: string;
      readonly env: NodeJS.ProcessEnv;
      readonly limits: SandboxProcessPolicy["limits"];
    }
  | { readonly _tag: "Unavailable"; readonly failureCode: string };

export type SeatbeltProfile =
  | {
      readonly _tag: "Ready";
      readonly source: string;
      readonly limits: SandboxProcessPolicy["limits"];
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
    limits: input.policy.limits,
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
    limits: policy.limits,
  };
};

const evidenceRef = (probe: unknown): string =>
  `sha256:${createHash("sha256").update(JSON.stringify(probe)).digest("hex")}`;

const linuxBaseControls = (probe: NativePosixProbe) => ({
  bwrap: probe.bwrap,
  userNamespace: probe.userNamespace,
  mountNamespace: probe.mountNamespace,
  pidNamespace: probe.pidNamespace,
  networkNamespace: probe.networkNamespace,
  cgroupV2: probe.cgroupV2,
  cgroupPids: probe.cgroupPids,
  cgroupMemory: probe.cgroupMemory,
  cgroupCpu: probe.cgroupCpu,
  processTreeCleanup: probe.processTreeCleanup,
});

const unavailableLinuxProbe = (platform: string): NativePosixProbe => ({
  platform,
  bwrap: false,
  userNamespace: false,
  mountNamespace: false,
  pidNamespace: false,
  networkNamespace: false,
  cgroupV2: false,
  cgroupPids: false,
  cgroupMemory: false,
  cgroupCpu: false,
  seccomp: false,
  brokerChannel: false,
  processTreeCleanup: false,
});

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

/** Probe Linux primitives without creating cgroups or installing system packages. */
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
      bwrap: version !== undefined && help !== undefined,
      userNamespace: await namespace(["--unshare-user"]),
      mountNamespace: await namespace(["--unshare-user"]),
      pidNamespace: await namespace(["--unshare-user", "--unshare-pid"]),
      networkNamespace: await namespace(["--unshare-user", "--unshare-net"]),
      cgroupV2: controllers !== undefined,
      cgroupPids: controllers?.split(/\s+/u).includes("pids") ?? false,
      cgroupMemory: controllers?.split(/\s+/u).includes("memory") ?? false,
      cgroupCpu: controllers?.split(/\s+/u).includes("cpu") ?? false,
      seccomp: seccomp !== undefined && help?.includes("--seccomp") === true,
      brokerChannel: false,
      processTreeCleanup:
        process.platform === "linux" && typeof process.kill === "function",
    };
  }
  probe ??= unavailableLinuxProbe(input.platform);
  const controls = linuxBaseControls(probe);
  const ready =
    input.platform === "linux" && Object.values(controls).every(Boolean);
  const failureCode =
    input.platform !== "linux"
      ? "UnsupportedPlatform"
      : ready
        ? null
        : "RequiredPrimitiveUnavailable";
  return {
    providerId: LINUX_BWRAP_PROVIDER_ID,
    providerVersion: EXPERIMENTAL_VERSION,
    capabilityRevision: "linux-bwrap-probe-v1",
    probeEvidenceRef: evidenceRef(probe),
    status: ready ? "Experimental" : "Unavailable",
    boundary: "OsEnforced",
    profiles: ready ? ["ReadOnly", "WorkspaceWrite", "FullAccess"] : [],
    networkModes: ready ? ["Disabled"] : [],
    failureCode,
    primitives: { ...probe, brokerChannel: probe.brokerChannel },
  };
};

export interface SeatbeltProbe {
  readonly platform: string;
  readonly sandboxExec: boolean;
  readonly processGroupCleanup: boolean;
  readonly rlimitWrapper: boolean;
  readonly brokerChannel: boolean;
}

export const probeMacOSSeatbelt = async (
  input: SeatbeltProbeInput,
): Promise<NativePosixCapability> => {
  const exists = input.exists ?? existsSync;
  const probe: SeatbeltProbe = {
    platform: input.platform,
    sandboxExec: input.platform === "darwin" && exists("/usr/bin/sandbox-exec"),
    processGroupCleanup:
      input.platform === "darwin" && typeof process.kill === "function",
    rlimitWrapper: input.platform === "darwin" && exists("/usr/bin/prlimit"),
    brokerChannel: false,
  };
  const ready =
    input.platform === "darwin" &&
    probe.sandboxExec &&
    probe.processGroupCleanup &&
    probe.rlimitWrapper;
  const failureCode =
    input.platform !== "darwin"
      ? "UnsupportedPlatform"
      : ready
        ? null
        : "RequiredPrimitiveUnavailable";
  return {
    providerId: MACOS_SEATBELT_PROVIDER_ID,
    providerVersion: EXPERIMENTAL_VERSION,
    capabilityRevision: "macos-seatbelt-probe-v1",
    probeEvidenceRef: evidenceRef(probe),
    status: ready ? "Experimental" : "Unavailable",
    boundary: "OsEnforced",
    profiles: ready ? ["ReadOnly", "WorkspaceWrite", "FullAccess"] : [],
    networkModes: ready ? ["Disabled"] : [],
    failureCode,
    primitives: { ...probe },
  };
};

export interface NativePosixSandboxOptions {
  readonly platform?: string;
  readonly linuxProbe?: () => Promise<NativePosixCapability>;
  readonly seatbeltProbe?: () => Promise<NativePosixCapability>;
}

export const NativePosixSandboxProcessPortLive = (
  options: NativePosixSandboxOptions = {},
): Layer.Layer<SandboxProcessPort> => {
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
          if (capability.status === "Unavailable")
            return unavailable(
              request.policy,
              capability.failureCode ?? "RequiredPrimitiveUnavailable",
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
  return Layer.succeed(SandboxProcessPort, service);
};

const unavailableCapability = (
  providerId: string,
  failureCode: string,
): NativePosixCapability => ({
  providerId,
  providerVersion: EXPERIMENTAL_VERSION,
  capabilityRevision: "probe-failed-v1",
  probeEvidenceRef: null,
  status: "Unavailable",
  boundary: "OsEnforced",
  profiles: [],
  networkModes: [],
  failureCode,
  primitives: {},
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
