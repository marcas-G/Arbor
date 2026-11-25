import { readFile } from "node:fs/promises";
import type { SandboxLinuxQualificationArtifactHashV2 } from "@arbor/domain";
import { LINUX_SANDBOX_EXECUTABLES } from "@arbor/sandbox-native-posix";
import { NETWORK_PROXY_HELPER_PATH } from "./transport/network-proxy-helper.js";

type ArtifactRole = SandboxLinuxQualificationArtifactHashV2["role"];

// The catalog is installer-owned. Neither a qualification manifest nor a
// project can supply a path. Resolve the adapter through this installation's
// package graph, so portable pnpm deployments use their own adapter files.
const adapterRuntime = new URL(
  import.meta.resolve("@arbor/sandbox-native-posix"),
);
const artifactFiles: Readonly<Record<ArtifactRole, URL | string>> =
  Object.freeze({
    "adapter-runtime": adapterRuntime,
    "adapter-source": new URL("../src/index.ts", adapterRuntime),
    bwrap: LINUX_SANDBOX_EXECUTABLES.bwrap,
    // setpriv installs the inherited command seccomp controls; those BPF bytes
    // are embedded in the adapter source/runtime, rather than an unhashed module.
    "qualification-control": LINUX_SANDBOX_EXECUTABLES.setpriv,
    // Relay JavaScript is both source and runtime; no generated copy is executed.
    "relay-runtime": NETWORK_PROXY_HELPER_PATH,
    "relay-source": NETWORK_PROXY_HELPER_PATH,
    systemctl: LINUX_SANDBOX_EXECUTABLES.systemctl,
    "systemd-run": LINUX_SANDBOX_EXECUTABLES.systemdRun,
  });

/** Full installed file bytes, re-read at every capability/effect admission.
 * Missing files (including absent audit sources in an incomplete installation)
 * never become a successful qualification. This does not issue authority. */
export const readInstalledLinuxQualificationArtifact = async (
  role: ArtifactRole,
): Promise<Uint8Array | undefined> => {
  if (!Object.hasOwn(artifactFiles, role)) return undefined;
  try {
    return await readFile(artifactFiles[role]);
  } catch {
    return undefined;
  }
};
