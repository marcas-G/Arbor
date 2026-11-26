import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type CanonicalResourceRegion,
  ExecutionId,
  parse,
} from "@arbor/domain";
import { SandboxPort } from "@arbor/ports";
import { it } from "@effect/vitest";
import { Effect } from "effect";
import { describe, expect } from "vitest";
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
  it.effect(
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
});
