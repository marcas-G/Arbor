import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolExecutionContext, ToolIntent } from "@arbor/ports";
import { it } from "@effect/vitest";
import { Effect } from "effect";
import { describe, expect } from "vitest";
import { listExecutor } from "../src/index.js";

const root = mkdtempSync(join(tmpdir(), "arbor-list-"));
writeFileSync(join(root, "a.txt"), "a");

const intent = (argumentsJson: string): ToolIntent => ({
  callRef: "c",
  toolName: "list",
  toolVersion: "2",
  argumentsJson,
  invocationId: "tin_x" as never,
  approvalId: null,
});
const context = {} as ToolExecutionContext;
const sandbox = {
  handleId: "s",
  rootPath: root,
  mounts: [
    {
      ref: "workspace",
      rootPath: root,
      region: { resourceSpaceId: "filesystem", normalizedRegion: {} },
      access: "ReadOnly" as const,
    },
  ],
  writableRegions: [],
};

const executeList = (argumentsJson: string) =>
  listExecutor.execute({
    intent: intent(argumentsJson),
    definition: {} as never,
    context,
    sandbox,
    regions: [],
  });

describe("list tool", () => {
  it.effect("lists a relative target within the sandbox", () =>
    Effect.gen(function* () {
      const result = yield* executeList(
        '{"target":{"mount":"workspace","path":"."},"depth":0}',
      );
      expect(result.settlement._tag).toBe("Success");
      expect(JSON.parse(result.observation.text).entries).toContain("a.txt");
    }),
  );

  it.effect(
    "fails closed without a defect when v2 receives an absolute target path",
    () =>
      Effect.gen(function* () {
        const result = yield* executeList(
          JSON.stringify({ target: { mount: "workspace", path: root } }),
        );
        expect(result.settlement._tag).toBe("ExpectedFailure");
      }),
  );
});
