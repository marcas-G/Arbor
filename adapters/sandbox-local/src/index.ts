import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SandboxPort } from "@arbor/ports";
import { Effect, Layer } from "effect";

/** P4 `04`; DID v1.8 G3. Minimal local executor: a confined temp root per
 * execution. Advanced isolation (containers/namespaces/worktrees) is P11. */

/** P4 `04` §4 (debt repaid per P11 `12` §2): a sandboxed subprocess execFileSync
 * runs with an allow-listed projection of the ambient environment — secrets
 * and other ambient variables never reach it. */
export const SANDBOX_ENV_ALLOWLIST: ReadonlyArray<string> = [
  "HOME",
  "LANG",
  "LC_ALL",
  "PATH",
  "TMPDIR",
  "TZ",
];

export const sandboxEnvironment = (
  ambient: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv => {
  const projected: Record<string, string> = {};
  for (const key of SANDBOX_ENV_ALLOWLIST) {
    const value = ambient[key];
    if (value !== undefined) {
      projected[key] = value;
    }
  }
  return projected;
};

export const SandboxPortLive: Layer.Layer<SandboxPort> = Layer.effect(
  SandboxPort,
  Effect.sync(() => {
    const roots = new Map<string, string>();
    return SandboxPort.of({
      open: (input) =>
        Effect.sync(() => {
          const handleId = `sbx_${input.executionId}`;
          const rootPath = mkdtempSync(join(tmpdir(), "arbor-sbx-"));
          roots.set(handleId, rootPath);
          return {
            handleId,
            rootPath,
            writableRegions: input.regions,
          };
        }),
      close: (handle) =>
        Effect.sync(() => {
          roots.delete(handle.handleId);
          rmSync(handle.rootPath, { recursive: true, force: true });
        }),
    });
  }),
);
