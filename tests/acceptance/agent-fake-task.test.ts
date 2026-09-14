import { execSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { runAgent } from "../../src/agent-runtime/agent-loop.js";
import type { ModelTurn } from "../../src/agent-runtime/provider.js";
import { makeEditFileTool } from "../../src/agent-runtime/tools/edit-file.js";
import { makeGitStatusTool } from "../../src/agent-runtime/tools/git-status.js";
import { makeReadFileTool } from "../../src/agent-runtime/tools/read-file.js";
import { makeRunCommandTool } from "../../src/agent-runtime/tools/run-command.js";
import { makeWriteFileTool } from "../../src/agent-runtime/tools/write-file.js";
import { FakeProviderLive } from "../../src/infrastructure/fake-provider.js";

const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "arbor-e2e-"));
  dirs.push(d);
  return d;
};
afterAll(() => {
  for (const d of dirs) {
    rmSync(d, { recursive: true, force: true });
  }
});

const call = (id: string, name: string, args: object): ModelTurn => ({
  content: undefined,
  toolCalls: [{ id, name, arguments: JSON.stringify(args) }],
  finishReason: "tool-calls",
});

describe("acceptance: fake-scripted agent task (all five tools, real worktree)", () => {
  it("read → write → edit → run_command → git_status → stop", async () => {
    const root = tmp();
    execSync("git init -q", { cwd: root });
    writeFileSync(join(root, "notes.md"), "# Notes\n\nversion one\n");

    const r = await runAgent({
      providerLayer: FakeProviderLive.withScript([
        call("c1", "read_file", { path: "notes.md" }),
        call("c2", "write_file", { path: "out/gen.txt", content: "generated" }),
        call("c3", "edit_file", {
          path: "notes.md",
          oldString: "version one",
          newString: "version two",
        }),
        call("c4", "run_command", { argv: [process.execPath, "-e", "console.log('tool-ran')"] }),
        call("c5", "git_status", {}),
        { content: "task complete", toolCalls: [], finishReason: "stop" },
      ]),
      tools: [
        makeReadFileTool(root),
        makeWriteFileTool(root),
        makeEditFileTool(root),
        makeRunCommandTool(root),
        makeGitStatusTool(root),
      ],
      system: "You are the Arbor primary agent (fake script).",
      task: "Update notes, generate output, verify.",
      stepLimit: 25,
    });

    expect(r.finish).toBe("stop");
    expect(r.steps).toBe(6);
    expect(readFileSync(join(root, "notes.md"), "utf8")).toContain("version two");
    expect(readFileSync(join(root, "out/gen.txt"), "utf8")).toBe("generated");
    const toolMsgs = r.messages.filter((m) => m.role === "tool");
    expect(toolMsgs.length).toBe(5);
    expect(toolMsgs.every((m) => !m.content.startsWith("ERROR:"))).toBe(true);
  });
});
