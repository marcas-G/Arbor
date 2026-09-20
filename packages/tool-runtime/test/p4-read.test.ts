import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolExecutionContext, ToolIntent } from "@arbor/ports";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { readExecutor } from "../src/index.js";

const root = mkdtempSync(join(tmpdir(), "p4-read-"));
writeFileSync(join(root, "a.txt"), "hello world");

const intent = (argumentsJson: string): ToolIntent => ({
  callRef: "c",
  toolName: "read",
  toolVersion: "1",
  argumentsJson,
  invocationId: "tin_x" as never,
  approvalId: null,
});
const context = {} as ToolExecutionContext;
const sandbox = { handleId: "s", rootPath: root, writableRegions: [] };

describe("P4 read tool", () => {
  it("reads a bounded slice within the sandbox", async () => {
    const result = await Effect.runPromise(
      readExecutor.execute({
        intent: intent('{"path":{"path":"a.txt"},"limit":5}'),
        definition: {} as never,
        context,
        sandbox,
        regions: [],
      }),
    );
    expect(result.settlement._tag).toBe("Success");
    expect(JSON.parse(result.observation.text).text).toBe("hello");
  });

  it("rejects a path escaping the sandbox root", async () => {
    const exit = await Effect.runPromise(
      Effect.exit(
        readExecutor.execute({
          intent: intent('{"path":{"path":"../../etc/passwd"}}'),
          definition: {} as never,
          context,
          sandbox,
          regions: [],
        }),
      ),
    );
    expect(exit._tag).toBe("Failure");
  });
});
