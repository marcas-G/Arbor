import { execSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { afterAll, describe, expect, it } from "vitest";
import { parse as parseYaml, stringify as yamlStringify } from "yaml";
import type { ModelTurn } from "../../src/agent-runtime/provider.js";
import { runAgentSession } from "../../src/application/agent-runner.js";
import { createChild } from "../../src/application/child-creation.js";
import { effectiveRefName, projectDirs, SqlitePort } from "../../src/application/ports.js";
import { FakeProviderLive } from "../../src/infrastructure/fake-provider.js";
import { SqliteNodeLive } from "../../src/infrastructure/sqlite-node.js";
import { readTree, treeRefCommit } from "../../src/infrastructure/tree-store.js";
import { FakeRun } from "../integration/helpers/run-init.js";

const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "arbor-p2-"));
  dirs.push(d);
  return d;
};
afterAll(() => {
  for (const d of dirs) {
    rmSync(d, { recursive: true, force: true });
  }
});

const sql = await Effect.runPromise(SqlitePort.pipe(Effect.provide(SqliteNodeLive)));

const toolTurn = (id: string, name: string, args: object): ModelTurn => ({
  content: undefined,
  toolCalls: [{ id, name, arguments: JSON.stringify(args) }],
  finishReason: "tool-calls",
});
const stopTurn: ModelTurn = { content: "done", toolCalls: [], finishReason: "stop" };

describe("P2 acceptance: recursive workspace tree (D-041)", () => {
  it("create child → child agent works & activates in its own worktree → root untouched", async () => {
    const home = tmp();
    const repo = tmp();
    execSync(
      "git init -q && mkdir -p src/core docs && echo r > README.md && git add -A && git -c user.name=t -c user.email=t@t commit -qm base",
      { cwd: repo },
    );
    const init = await FakeRun.initProject(home, repo);
    const d = projectDirs(home, init.projectId);

    // --- create a child for src/core
    const c1 = await createChild(
      {
        projectId: init.projectId,
        home,
        parentWorkspaceId: init.workspaceId,
        intent: "own the core module",
        responsibility: "src/core implementation",
        deliverables: "working core",
        writablePrefixes: ["src/core"],
      },
      sql,
    );
    expect(c1.ok).toBe(true);
    if (!c1.ok) return;
    const childId = c1.childWorkspaceId;

    // tree is committed with CAS ref and contains both nodes
    const tree = await readTree(d.storeDir);
    expect(tree.nodes.map((n) => n.kind).sort()).toEqual(["child", "root"]);
    await expect(treeRefCommit(d.storeDir)).resolves.toBeDefined();
    expect(
      execSync(`git -C ${d.storeDir} rev-parse ${effectiveRefName(childId)}`, {
        encoding: "utf8",
      }).trim(),
    ).toBeDefined();

    // child worktree exists on its own branch, rooted at parent HEAD
    const childWorktree = join(d.projectDir, "worktrees", childId);
    expect(existsSync(join(childWorktree, "README.md"))).toBe(true);
    expect(
      execSync(`git -C ${childWorktree} branch --show-current`, { encoding: "utf8" }).trim(),
    ).toBe(`arbor/${childId}`);

    // db rows: one root + one child
    const kinds = execSync(`sqlite3 ${d.dbFile} "SELECT kind FROM workspaces ORDER BY kind;"`)
      .toString()
      .trim();
    expect(kinds).toBe("child\nroot");

    // --- child agent runs in the child worktree and activates the child ref
    const childRefBefore = execSync(`git -C ${d.storeDir} rev-parse ${effectiveRefName(childId)}`, {
      encoding: "utf8",
    }).trim();
    const rootRefBefore = execSync(
      `git -C ${d.storeDir} rev-parse ${effectiveRefName(init.workspaceId)}`,
      { encoding: "utf8" },
    ).trim();

    const r = await runAgentSession(
      {
        projectId: init.projectId,
        home,
        workspaceId: childId,
        providerLayer: FakeProviderLive.withScript([
          toolTurn("c1", "write_file", {
            path: "src/core/engine.ts",
            content: "export const engine = 1;",
          }),
          toolTurn("c2", "report_completion", { summary: "core engine" }),
          stopTurn,
        ]),
        task: "implement the engine",
        stepLimit: 10,
      },
      sql,
    );
    expect(r.finish).toBe("stop");

    // child file written inside the child worktree (not the root one)
    expect(readFileSync(join(childWorktree, "src/core/engine.ts"), "utf8")).toContain("engine");
    expect(existsSync(join(d.worktreeDir, "src/core/engine.ts"))).toBe(false);

    // child effective ref moved; root effective ref untouched (G1 isolation)
    const childRefAfter = execSync(`git -C ${d.storeDir} rev-parse ${effectiveRefName(childId)}`, {
      encoding: "utf8",
    }).trim();
    const rootRefAfter = execSync(
      `git -C ${d.storeDir} rev-parse ${effectiveRefName(init.workspaceId)}`,
      {
        encoding: "utf8",
      },
    ).trim();
    expect(childRefAfter).not.toBe(childRefBefore);
    expect(rootRefAfter).toBe(rootRefBefore);

    // agents are created lazily per workspace on first run: exactly one for the child here
    const agents = execSync(
      `sqlite3 ${d.dbFile} "SELECT COUNT(*) FROM agents WHERE workspace_id = '${childId}';"`,
    )
      .toString()
      .trim();
    expect(agents).toBe("1");
  });

  it("violation matrix: out-of-subset prefix, sibling overlap, ghost parent rejected", async () => {
    const home = tmp();
    const repo = tmp();
    execSync(
      "git init -q && mkdir -p src/a src/b && echo r > README.md && git add -A && git -c user.name=t -c user.email=t@t commit -qm base",
      { cwd: repo },
    );
    const init = await FakeRun.initProject(home, repo);

    // root's writable is "." (everything), so a legal path can never be
    // out-of-subset; the rejected case is a non-canonical prefix
    const outOfSubset = await createChild(
      {
        projectId: init.projectId,
        home,
        parentWorkspaceId: init.workspaceId,
        intent: "x",
        responsibility: "x",
        deliverables: "x",
        writablePrefixes: ["../escape"],
      },
      sql,
    );
    expect(outOfSubset.ok).toBe(false);
    if (!outOfSubset.ok) {
      expect(outOfSubset.detail).toContain("prefix-not-in-parent");
      expect(outOfSubset.reason).toBe("invalid");
    }

    const ok = await createChild(
      {
        projectId: init.projectId,
        home,
        parentWorkspaceId: init.workspaceId,
        intent: "a",
        responsibility: "a",
        deliverables: "a",
        writablePrefixes: ["src/a"],
      },
      sql,
    );
    expect(ok.ok).toBe(true);

    const overlap = await createChild(
      {
        projectId: init.projectId,
        home,
        parentWorkspaceId: init.workspaceId,
        intent: "b",
        responsibility: "b",
        deliverables: "b",
        writablePrefixes: ["src/a/sub"],
      },
      sql,
    );
    expect(overlap.ok).toBe(false);
    if (!overlap.ok) {
      expect(overlap.detail).toContain("sibling-overlap");
    }

    const ghost = await createChild(
      {
        projectId: init.projectId,
        home,
        parentWorkspaceId: "not-a-workspace",
        intent: "g",
        responsibility: "g",
        deliverables: "g",
        writablePrefixes: ["src/b"],
      },
      sql,
    );
    expect(ghost.ok).toBe(false);

    // nothing was committed for the rejected attempts: tree has exactly root + 1 child
    const tree = await readTree(projectDirs(home, init.projectId).storeDir);
    expect(tree.nodes.length).toBe(2);
  });

  it("agent-side request_create_child goes through governance validation", async () => {
    const home = tmp();
    const repo = tmp();
    execSync(
      "git init -q && mkdir -p docs && echo r > README.md && git add -A && git -c user.name=t -c user.email=t@t commit -qm base",
      { cwd: repo },
    );
    const init = await FakeRun.initProject(home, repo);

    // valid structural request via the agent tool
    const r = await runAgentSession(
      {
        projectId: init.projectId,
        home,
        providerLayer: FakeProviderLive.withScript([
          toolTurn("c1", "request_create_child", {
            intent: "own docs",
            responsibility: "documentation",
            deliverables: "docs site",
            writablePrefixes: ["docs"],
          }),
          stopTurn,
        ]),
        task: "delegate docs",
        stepLimit: 10,
      },
      sql,
    );
    expect(r.finish).toBe("stop");
    const tree = await readTree(projectDirs(home, init.projectId).storeDir);
    expect(tree.nodes.length).toBe(2);

    // invalid structural request (non-canonical prefix) is rejected with a reason the model can read
    const r2 = await runAgentSession(
      {
        projectId: init.projectId,
        home,
        providerLayer: FakeProviderLive.withScript([
          toolTurn("c1", "request_create_child", {
            intent: "bad",
            responsibility: "bad",
            deliverables: "bad",
            writablePrefixes: ["../nope"],
          }),
          stopTurn,
        ]),
        task: "delegate badly",
        stepLimit: 10,
      },
      sql,
    );
    expect(r2.finish).toBe("stop");
    const tree2 = await readTree(projectDirs(home, init.projectId).storeDir);
    expect(tree2.nodes.length).toBe(2); // unchanged
    // the rejection was recorded as a tool result the model saw
    const transcript2 = readFileSync(
      join(projectDirs(home, init.projectId).agentStateDir, r2.agentId, "transcript.jsonl"),
      "utf8",
    );
    expect(transcript2).toContain("CHILD REJECTED");
    void parseYaml;
    void yamlStringify;
  });
});
