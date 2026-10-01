import {
  existsSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SANDBOX_ENV_ALLOWLIST,
  SandboxPort,
  sandboxEnvironment,
} from "@arbor/ports";
import { Effect, Layer } from "effect";

/** DID v1.25 EWB: trusted-local binding. It binds admitted filesystem roots
 * directly and is deliberately not an OS process-isolation boundary. */

/** P4 `04` §4 (debt repaid per P11 `12` §2; shared mechanism per P12 `03` §3):
 * a sandboxed subprocess runs with an allow-listed projection of the ambient
 * environment — secrets and other ambient variables never reach it. The
 * allow-list + projection live in `@arbor/ports` so every sandbox adapter
 * inherits the same requirement. */
export { SANDBOX_ENV_ALLOWLIST, sandboxEnvironment };

export const SandboxPortLive: Layer.Layer<SandboxPort> = Layer.effect(
  SandboxPort,
  Effect.sync(() => {
    const handles = new Set<string>();
    const legacyRoots = new Set<string>();
    return SandboxPort.of({
      open: (input) =>
        Effect.sync(() => {
          const handleId = `sbx_${input.executionId}`;
          if (input.mounts === undefined) {
            const rootPath = mkdtempSync(join(tmpdir(), "arbor-sbx-"));
            handles.add(handleId);
            legacyRoots.add(rootPath);
            return {
              handleId,
              rootPath,
              writableRegions: input.regions ?? [],
            };
          }
          if (input.mounts.length === 0) {
            throw new Error("sandbox requires at least one mount");
          }
          const refs = new Set(input.mounts.map((mount) => mount.ref));
          if (refs.size !== input.mounts.length || !refs.has("workspace")) {
            throw new Error("sandbox mounts require one unique workspace ref");
          }
          const mounts = input.mounts.map((mount) => {
            const path = mount.address.path;
            if (!existsSync(path) || !statSync(path).isDirectory()) {
              throw new Error(
                `sandbox mount is not an existing directory: ${mount.ref}`,
              );
            }
            return {
              ref: mount.ref,
              rootPath: realpathSync(path),
              region: mount.region,
              access: mount.access,
            };
          });
          const workspace = mounts.find((mount) => mount.ref === "workspace");
          if (workspace === undefined) {
            throw new Error("workspace mount not found");
          }
          handles.add(handleId);
          return {
            handleId,
            rootPath: workspace.rootPath,
            mounts,
            writableRegions: mounts
              .filter((mount) => mount.access === "ReadWrite")
              .map((mount) => mount.region),
          };
        }),
      close: (handle) =>
        Effect.sync(() => {
          handles.delete(handle.handleId);
          if (legacyRoots.delete(handle.rootPath)) {
            rmSync(handle.rootPath, { recursive: true, force: true });
          }
        }),
    });
  }),
);
