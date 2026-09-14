import { execSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { makeEditFileTool } from "../../src/agent-runtime/tools/edit-file.js";
import { makeGitStatusTool } from "../../src/agent-runtime/tools/git-status.js";
import { makeReadFileTool } from "../../src/agent-runtime/tools/read-file.js";
import { makeRunCommandTool } from "../../src/agent-runtime/tools/run-command.js";
import { makeWriteFileTool } from "../../src/agent-runtime/tools/write-file.js";

const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "arbor-tools-"));
  dirs.push(d);
  return d;
};
afterAll(() => {
  for (const d of dirs) {
    rmSync(d, { recursive: true, force: true });
  }
});

describe("file tools", () => {
  it("write then read roundtrip", async () => {
    const root = tmp();
    const w = makeWriteFileTool(root);
    const r = makeReadFileTool(root);
    expect((await w.run({ path: "src/a.txt", content: "hello" })).ok).toBe(true);
    expect(await r.run({ path: "src/a.txt" })).toMatchObject({ ok: true, output: "hello" });
  });

  it("read missing file fails", async () => {
    const r = makeReadFileTool(tmp());
    expect((await r.run({ path: "nope.txt" })).ok).toBe(false);
  });

  it.each([["/abs/x"], ["../esc"], ["a/../b"], ["C:\\x"], ["src\\a"]])(
    "rejects non-canonical path %s",
    async (p) => {
      const r = makeReadFileTool(tmp());
      expect((await r.run({ path: p })).ok).toBe(false);
    },
  );

  it("edit with unique match succeeds; zero and double matches fail (B2)", async () => {
    const root = tmp();
    writeFileSync(join(root, "f.txt"), "aaa bbb aaa");
    const e = makeEditFileTool(root);
    expect((await e.run({ path: "f.txt", oldString: "bbb", newString: "ccc" })).ok).toBe(true);
    expect((await e.run({ path: "f.txt", oldString: "zzz", newString: "y" })).ok).toBe(false);
    expect((await e.run({ path: "f.txt", oldString: "aaa", newString: "x" })).ok).toBe(false);
    expect((await makeReadFileTool(root).run({ path: "f.txt" })).ok).toBe(true);
  });

  it("edit result is visible on disk", async () => {
    const root = tmp();
    writeFileSync(join(root, "g.txt"), "one two three");
    const e = makeEditFileTool(root);
    await e.run({ path: "g.txt", oldString: "two", newString: "TWO" });
    expect(await makeReadFileTool(root).run({ path: "g.txt" })).toMatchObject({
      ok: true,
      output: "one TWO three",
    });
  });
});

describe("run_command (B3)", () => {
  it("runs argv and captures stdout", async () => {
    const c = makeRunCommandTool(tmp());
    const r = await c.run({
      argv: [process.execPath, "-e", "console.log('out42')"],
      timeoutMs: 10000,
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.output).toContain("out42");
    }
  });

  it("non-zero exit fails with output included", async () => {
    const c = makeRunCommandTool(tmp());
    const r = await c.run({ argv: [process.execPath, "-e", "process.exit(3)"], timeoutMs: 10000 });
    expect(r.ok).toBe(false);
  });

  it("timeout kills the process", async () => {
    const c = makeRunCommandTool(tmp());
    const r = await c.run({
      argv: [process.execPath, "-e", "setTimeout(() => {}, 30000)"],
      timeoutMs: 1000,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toContain("timeout");
    }
  });

  it("rejects timeoutMs above the 120s cap", async () => {
    const c = makeRunCommandTool(tmp());
    expect((await c.run({ argv: ["true"], timeoutMs: 200000 })).ok).toBe(false);
  });

  it("default timeout applies when timeoutMs omitted", async () => {
    const c = makeRunCommandTool(tmp());
    const r = await c.run({ argv: [process.execPath, "-e", "console.log('ok')"] });
    expect(r.ok).toBe(true);
  });
});

describe("git_status", () => {
  it("reports porcelain status of the worktree", async () => {
    const root = tmp();
    execSync("git init -q && echo x > a.txt", { cwd: root });
    const g = makeGitStatusTool(root);
    const r = await g.run({});
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.output).toContain("a.txt");
    }
  });

  it("fails outside a git repo", async () => {
    const g = makeGitStatusTool(tmp());
    expect((await g.run({})).ok).toBe(false);
  });
});
