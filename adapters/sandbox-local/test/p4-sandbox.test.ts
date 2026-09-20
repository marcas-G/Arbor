import { existsSync } from "node:fs";
import {
  type CanonicalResourceRegion,
  ExecutionId,
  parse,
} from "@arbor/domain";
import { SandboxPort } from "@arbor/ports";
import { Effect } from "effect";
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
  it("opens a confined root and releases it on close", async () => {
    const result = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const sandbox = yield* SandboxPort;
          const handle = yield* sandbox.open({
            executionId,
            workspaceId: "ws_x" as never,
            regions,
          });
          const existed = existsSync(handle.rootPath);
          yield* sandbox.close(handle);
          return {
            existed,
            after: existsSync(handle.rootPath),
            regions: handle.writableRegions,
          };
        }),
        SandboxPortLive,
      ),
    );
    expect(result.existed).toBe(true);
    expect(result.after).toBe(false);
    expect(result.regions).toHaveLength(1);
  });
});
