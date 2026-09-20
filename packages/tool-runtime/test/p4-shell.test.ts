import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolExecutionContext, ToolIntent } from "@arbor/ports";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { shellExecutor, shellPolicy } from "../src/index.js";

const root = mkdtempSync(join(tmpdir(), "p4-shell-"));
const intent = (command: string): ToolIntent => ({
  callRef: "c",
  toolName: "shell",
  toolVersion: "1",
  argumentsJson: JSON.stringify({ command, cwd: { path: "." } }),
  invocationId: "tin_x" as never,
  approvalId: null,
});
const context = {} as ToolExecutionContext;
const sandbox = { handleId: "s", rootPath: root, writableRegions: [] };

describe("P4 shell tool + policy", () => {
  it("classifies commands deterministically", () => {
    expect(shellPolicy("ls -la")).toBe("Allow");
    expect(shellPolicy("rm file.txt")).toBe("RequireApproval");
    expect(shellPolicy("sudo rm -rf /")).toBe("Deny");
  });

  it("requires approval for a destructive command", () => {
    expect(shellExecutor.requiresApproval(intent("rm x"))).toBe(true);
    expect(shellExecutor.requiresApproval(intent("ls"))).toBe(false);
  });

  it("denies a policy-denied command and runs an allowed one", async () => {
    const denied = await Effect.runPromise(
      shellExecutor.execute({
        intent: intent("sudo rm -rf /"),
        definition: {} as never,
        context,
        sandbox,
        regions: [],
      }),
    );
    expect(denied.settlement._tag).toBe("ExpectedFailure");
    const ran = await Effect.runPromise(
      shellExecutor.execute({
        intent: intent("echo hi"),
        definition: {} as never,
        context,
        sandbox,
        regions: [],
      }),
    );
    expect(ran.settlement._tag).toBe("Success");
    expect(JSON.parse(ran.observation.text).exitCode).toBe(0);
  });
});
