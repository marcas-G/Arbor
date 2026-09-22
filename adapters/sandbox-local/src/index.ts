import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SANDBOX_ENV_ALLOWLIST,
  SandboxPort,
  sandboxEnvironment,
} from "@arbor/ports";
import { Effect, Layer } from "effect";

/** P4 `04`; DID v1.8 G3. Minimal local executor: a confined temp root per
 * execution. Advanced isolation (containers/namespaces/worktrees) is P11. */

/** P4 `04` §4 (debt repaid per P11 `12` §2; shared mechanism per P12 `03` §3):
 * a sandboxed subprocess runs with an allow-listed projection of the ambient
 * environment — secrets and other ambient variables never reach it. The
 * allow-list + projection live in `@arbor/ports` so every sandbox adapter
 * inherits the same requirement. */
export { SANDBOX_ENV_ALLOWLIST, sandboxEnvironment };

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
