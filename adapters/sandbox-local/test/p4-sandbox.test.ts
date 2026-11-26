import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type CanonicalResourceRegion,
  ExecutionId,
  parse,
} from "@arbor/domain";
import { SandboxPort } from "@arbor/ports";
import { it as itEffect } from "@effect/vitest";
import { Context, Effect, Layer } from "effect";
import { describe, expect, it } from "vitest";
import { SandboxPortLive } from "../src/index.js";

const executionId = parse(ExecutionId)(
  "exe_018f2b3c-4d5e-7abc-8def-0123456789a1",
);
const regions: ReadonlyArray<CanonicalResourceRegion> = [
  {
    resourceSpaceId: "filesystem",
    normalizedRegion: { kind: "FileTree", path: "/repo" },
  },
];

describe("P4 local sandbox", () => {
  itEffect.effect(
    "binds the admitted workspace root and never deletes it on close",
    () =>
      Effect.gen(function* () {
        const root = mkdtempSync(join(tmpdir(), "arbor-local-bind-"));
        const sandbox = yield* SandboxPort;
        const handle = yield* sandbox.open({
          executionId,
          workspaceId: "ws_x" as never,
          mounts: [
            {
              ref: "workspace",
              address: { _tag: "GitWorktree", path: root },
              region: regions[0] as CanonicalResourceRegion,
              access: "ReadWrite",
            },
          ],
        });
        const existed = existsSync(handle.rootPath);
        yield* sandbox.close(handle);
        expect(existed).toBe(true);
        expect(existsSync(handle.rootPath)).toBe(true);
        expect(handle.rootPath).toBe(root);
        expect(handle.mounts?.map((mount) => mount.ref)).toEqual(["workspace"]);
        expect(handle.writableRegions).toHaveLength(1);
      }).pipe(Effect.provide(SandboxPortLive)),
  );

  it("removes a legacy region root left open when the Layer scope closes", async () => {
    let rootPath: string | undefined;
    // Build and tear the Layer down manually: the release obligation is the
    // Layer's (E07), so scope close must remove an open legacy root.
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const context = yield* Layer.build(SandboxPortLive);
          const sandbox = Context.get(context, SandboxPort);
          const handle = yield* sandbox.open({
            executionId,
            workspaceId: "ws_x" as never,
            // No mounts: the legacy pre-EWB path owns a temporary root.
          });
          expect(handle.rootPath).toContain("arbor-sbx-");
          expect(existsSync(handle.rootPath)).toBe(true);
          rootPath = handle.rootPath;
          // The handle is deliberately never closed here.
        }),
      ),
    );
    expect(rootPath).toBeDefined();
    expect(existsSync(rootPath as string)).toBe(false);
  });
});
