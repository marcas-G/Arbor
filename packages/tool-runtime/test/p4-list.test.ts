import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolExecutionContext, ToolIntent } from "@arbor/ports";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { listExecutor } from "../src/index.js";

const root = mkdtempSync(join(tmpdir(), "p4-list-"));
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

describe("P4 list tool", () => {
  it("lists a relative target within the sandbox", async () => {
    const result = await Effect.runPromise(
      listExecutor.execute({
        intent: intent('{"target":{"mount":"workspace","path":"."},"depth":0}'),
        definition: {} as never,
        context,
        sandbox,
        regions: [],
      }),
    );

    expect(result.settlement._tag).toBe("Success");
    expect(JSON.parse(result.observation.text).entries).toContain("a.txt");
  });

  it("fails closed without a defect when v2 receives an absolute target path", async () => {
    const result = await Effect.runPromise(
      listExecutor.execute({
        intent: intent(
          JSON.stringify({ target: { mount: "workspace", path: root } }),
        ),
        definition: {} as never,
        context,
        sandbox,
        regions: [],
      }),
    );

    expect(result.settlement._tag).toBe("ExpectedFailure");
  });
});
