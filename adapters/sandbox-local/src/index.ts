import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SandboxPort } from "@arbor/ports";
import { Effect, Layer } from "effect";

/** P4 `04`; DID v1.8 G3. Minimal local executor: a confined temp root per
 * execution. Advanced isolation (containers/namespaces/worktrees) is P11. */
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
