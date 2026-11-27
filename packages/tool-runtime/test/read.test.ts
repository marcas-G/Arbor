import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { it } from "@effect/vitest";
import { Effect } from "effect";
import { describe, expect } from "vitest";
import { readExecutor } from "../src/index.js";
import { executeFsTool, fsToolSandbox } from "./fs-tool-harness.js";

const root = mkdtempSync(join(tmpdir(), "arbor-read-"));
writeFileSync(join(root, "a.txt"), "hello world");
const sandbox = fsToolSandbox(root, "ReadOnly");

const executeRead = (argumentsJson: string) =>
  executeFsTool(
    readExecutor,
    { toolName: "read", toolVersion: "2", argumentsJson },
    sandbox,
  );

describe("read tool", () => {
  it.effect("reads a bounded slice within the sandbox", () =>
    Effect.gen(function* () {
      const result = yield* executeRead(
        '{"target":{"mount":"workspace","path":"a.txt"},"limit":5}',
      );
      expect(result.settlement._tag).toBe("Success");
      expect(JSON.parse(result.observation.text).text).toBe("hello");
    }),
  );

  it.effect("rejects a path escaping the sandbox root", () =>
    Effect.gen(function* () {
      const result = yield* executeRead(
        '{"target":{"mount":"workspace","path":"../../etc/passwd"}}',
      );
      expect(result.settlement._tag).toBe("ExpectedFailure");
    }),
  );

  it.effect(
    "rejects an adjacent directory that shares the root string prefix",
    () =>
      Effect.gen(function* () {
        const sibling = `${root}-escape`;
        mkdirSync(sibling, { recursive: true });
        writeFileSync(join(sibling, "secret.txt"), "secret");
        const result = yield* executeRead(
          JSON.stringify({
            target: {
              mount: "workspace",
              path: `../${basename(sibling)}/secret.txt`,
            },
          }),
        );
        expect(result.settlement._tag).toBe("ExpectedFailure");
      }),
  );

  it.effect("rejects a sandbox symlink or junction that resolves outside", () =>
    Effect.gen(function* () {
      const outside = mkdtempSync(join(tmpdir(), "arbor-read-outside-"));
      writeFileSync(join(outside, "secret.txt"), "secret");
      symlinkSync(
        outside,
        join(root, "outside-link"),
        process.platform === "win32" ? "junction" : "dir",
      );
      const result = yield* executeRead(
        '{"target":{"mount":"workspace","path":"outside-link/secret.txt"}}',
      );
      expect(result.settlement._tag).toBe("ExpectedFailure");
    }),
  );
});
