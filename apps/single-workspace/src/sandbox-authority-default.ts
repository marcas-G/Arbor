import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { TrustedHostConfigurationSourceService } from "@arbor/ports";
import { Effect } from "effect";
import { makeSandboxAuthorityProvisioningFileStore } from "./sandbox-authority-provisioning-file-store.js";

export interface DefaultSandboxAuthorityPaths {
  readonly protectedRoot: string;
  readonly sourceFile: string;
  readonly highWaterFile: string;
  readonly forensicDirectory: string;
  readonly sourceIdentity: string;
}

/** The ordinary launcher uses this fixed per-user location. It is deliberately
 * independent from the project directory and application database so a
 * project cannot replace the host authority source. */
export const defaultSandboxAuthorityPaths =
  (): DefaultSandboxAuthorityPaths => {
    const dataHome =
      process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share");
    const protectedRoot = resolve(dataHome, "Arbor", "sandbox-authority");
    return {
      protectedRoot,
      sourceFile: join(protectedRoot, "authority-bundle.json"),
      highWaterFile: join(protectedRoot, "authority-high-water.json"),
      forensicDirectory: join(protectedRoot, "forensic"),
      sourceIdentity: "host:arbor-linux-user",
    };
  };

/**
 * Load the host-protected source when an operator has provisioned it. Missing
 * material is a normal first-install state and returns undefined, leaving all
 * native process execution fail-closed. Invalid material is also treated as
 * unavailable; the authoritative loader will report the typed reason once a
 * daemon is running.
 */
export const defaultSandboxAuthoritySource = ():
  | TrustedHostConfigurationSourceService
  | undefined => {
  const paths = defaultSandboxAuthorityPaths();
  if (
    !existsSync(paths.protectedRoot) ||
    !existsSync(paths.sourceFile) ||
    !existsSync(paths.highWaterFile) ||
    !existsSync(paths.forensicDirectory)
  )
    return undefined;
  try {
    return Effect.runSync(makeSandboxAuthorityProvisioningFileStore(paths));
  } catch {
    return undefined;
  }
};
