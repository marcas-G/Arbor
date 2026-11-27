import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "@effect/vitest";
import { Effect } from "effect";
import { describe, expect } from "vitest";
import { listExecutor } from "../src/index.js";
import { executeFsTool, fsToolSandbox } from "./fs-tool-harness.js";

const root = mkdtempSync(join(tmpdir(), "arbor-list-"));
writeFileSync(join(root, "a.txt"), "a");
const sandbox = fsToolSandbox(root, "ReadOnly");

const executeList = (argumentsJson: string) =>
  executeFsTool(
    listExecutor,
    { toolName: "list", toolVersion: "2", argumentsJson },
    sandbox,
  );

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
