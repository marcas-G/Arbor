import { execSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { afterAll, describe, expect, it } from "vitest";
import type { ModelTurn } from "../../src/agent-runtime/provider.js";
import { runAgentSession } from "../../src/application/agent-runner.js";
import { acceptWorkspace } from "../../src/application/boundary.js";
import { createChild } from "../../src/application/child-creation.js";
import {
  confirmMilestone,
  currentMilestone,
  decideApproval,
  listApprovals,
} from "../../src/application/approvals.js";
import { acceptanceStatus } from "../../src/application/impact.js";
import { effectiveRefName, projectDirs, SqlitePort } from "../../src/application/ports.js";
import { FakeProviderLive } from "../../src/infrastructure/fake-provider.js";
import { SqliteNodeLive } from "../../src/infrastructure/sqlite-node.js";
import { startDashboard } from "../../src/entrypoints/dashboard.js";
import { FakeRun } from "../integration/helpers/run-init.js";

const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "arbor-p56-"));
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

describe("P5+P6 acceptance (D-044)", () => {
  it("J1/J2/J3: second accept invalidates the first child whose prefix the merge touched", async () => {
    const home = tmp();
    const repo = tmp();
    execSync(
      "git init -q && mkdir -p src/a src/b && echo r > README.md && git add -A && git -c user.name=t -c user.email=t@t commit -qm base",
      { cwd: repo },
    );
    const init = await FakeRun.initProject(home, repo);
    const d = projectDirs(home, init.projectId);
    const mk = async (prefixes: string[]) =>
      (
        await createChild(
          { projectId: init.projectId, home, parentWorkspaceId: init.workspaceId, intent: "x", responsibility: "x", deliverables: "x", writablePrefixes: prefixes },
          sql,
        )
      ).ok;
    expect(await mk(["src/a"])).toBe(true);
    expect(await mk(["src/b"])).toBe(true);
    const kids = execSync(`ls ${d.storeDir}/workspaces`).toString().trim().split("\n");
    const childA = kids.find((k) => k !== init.workspaceId && k.length === 36) as string;
    const childB = kids.filter((k) => k !== init.workspaceId && k !== childA)[0] as string;

    // both children activate independently
    const activate = async (ws: string, file: string) => {
      const r = await runAgentSession(
        {
          projectId: init.projectId,
          home,
          workspaceId: ws,
          providerLayer: FakeProviderLive.withScript([
            toolTurn("c1", "write_file", { path: file, content: "v" }),
            toolTurn("c2", "report_completion", { summary: file }),
            stopTurn,
          ]),
          task: "do it",
          stepLimit: 10,
        },
        sql,
      );
      expect(r.finish).toBe("stop");
    };
    await activate(childA, "src/a/mod.ts");
    await activate(childB, "src/b/mod.ts");

    const acc = async (child: string) =>
      acceptWorkspace({
        projectId: init.projectId,
        home,
        storeDir: d.storeDir,
        parentWorkspaceId: init.workspaceId,
        childWorkspaceId: child,
        parentWorktreeDir: d.worktreeDir,
        parentLocalCommands: [],
      });

    // first accept: nothing to invalidate
    const r1 = await acc(childA);
    expect(r1.status).toBe("accepted");
    if (r1.status === "accepted") expect(r1.invalidated).toEqual([]);

    // second accept (B) touches src/b only — A must NOT be invalidated
    const r2 = await acc(childB);
    expect(r2.status).toBe("accepted");
    if (r2.status === "accepted") {
      expect(r2.invalidated).toEqual([]); // no overlap with A's prefixes
    }
    expect(await acceptanceStatus(d.storeDir, init.workspaceId, childA)).toContain("current");

    // now the ROOT itself activates a change touching src/a → next accept of A
    // re-runs against a parent state that moved into A's territory
    execSync(`echo rootchange > ${join(d.worktreeDir, "src/a/from-root.txt")}`);
    const r3 = await runAgentSession(
      {
        projectId: init.projectId,
        home,
        providerLayer: FakeProviderLive.withScript([
          toolTurn("c1", "report_completion", { summary: "root touches src/a" }),
          stopTurn,
        ]),
        task: "root change",
        stepLimit: 5,
      },
      sql,
    );
    expect(r3.finish).toBe("stop");

    // re-accept B (whose diff window now spans the root's src/a change) → A goes stale
    const r4 = await acc(childB);
    expect(r4.status).toBe("accepted");
    if (r4.status === "accepted") {
      expect(r4.invalidated).toContain(childA);
    }
    const aStatus = await acceptanceStatus(d.storeDir, init.workspaceId, childA);
    expect(aStatus).toContain("STALE");
    expect(aStatus).toContain("src/a/from-root.txt");
  });

  it("K1: approval gate holds acceptance until decided; K3: milestones fix stages", async () => {
    const home = tmp();
    const repo = tmp();
    execSync(
      "git init -q && mkdir -p docs && echo r > README.md && git add -A && git -c user.name=t -c user.email=t@t commit -qm base",
      { cwd: repo },
    );
    const init = await FakeRun.initProject(home, repo);
    const d = projectDirs(home, init.projectId);
    // enable approval on the root
    execSync(
      `cd ${join(d.storeDir, "workspaces", init.workspaceId)} && yaml_set() { :; }; python3 - <<'EOF'
import yaml,io
p="workspace.yaml"
d=yaml.safe_load(open(p))
d["approval"]={"required":True}
open(p,"w").write(yaml.dump(d,sort_keys=False))
EOF`,
      { shell: "/bin/bash" },
    );

    const child = await createChild(
      { projectId: init.projectId, home, parentWorkspaceId: init.workspaceId, intent: "docs", responsibility: "docs", deliverables: "docs", writablePrefixes: ["docs"] },
      sql,
    );
    expect(child.ok).toBe(true);
    if (!child.ok) return;

    await runAgentSession(
      {
        projectId: init.projectId,
        home,
        workspaceId: child.childWorkspaceId,
        providerLayer: FakeProviderLive.withScript([
          toolTurn("c1", "write_file", { path: "docs/x.md", content: "x" }),
          toolTurn("c2", "report_completion", { summary: "docs" }),
          stopTurn,
        ]),
        task: "t",
        stepLimit: 8,
      },
      sql,
    );

    const pending = await acceptWorkspace({
      projectId: init.projectId,
      home,
      storeDir: d.storeDir,
      parentWorkspaceId: init.workspaceId,
      childWorkspaceId: child.childWorkspaceId,
      parentWorktreeDir: d.worktreeDir,
      parentLocalCommands: [],
    });
    expect(pending.status).toBe("pending-approval");
    const list = await listApprovals(d.storeDir, init.workspaceId);
    expect(list.filter((a) => a.status === "pending").length).toBe(1);
    const approvalId = list.find((a) => a.status === "pending")?.id as string;

    // rejection keeps the child unaccepted
    await decideApproval({ storeDir: d.storeDir, parentWorkspaceId: init.workspaceId, id: approvalId, approve: false });
    expect(await acceptanceStatus(d.storeDir, init.workspaceId, child.childWorkspaceId)).toBe("never accepted");

    // K3: fix a milestone on the current root commit (no terminal completion)
    const rootCommit = execSync(`git -C ${d.worktreeDir} rev-parse HEAD`).toString().trim();
    const m1 = await confirmMilestone({ storeDir: d.storeDir, rootWorkspaceId: init.workspaceId, rootCommit, summary: "stage one" });
    expect(m1.n).toBe(1);
    const cur = await currentMilestone(d.storeDir, init.workspaceId);
    expect(cur?.n).toBe(1);
    expect(cur?.summary).toBe("stage one");
    const m2 = await confirmMilestone({ storeDir: d.storeDir, rootWorkspaceId: init.workspaceId, rootCommit, summary: "stage two" });
    expect(m2.n).toBe(2); // stages accumulate — never a terminal state
  });

  it("K2: dashboard serves live tree snapshot", async () => {
    const home = tmp();
    const repo = tmp();
    execSync("git init -q && echo r > README.md && git add -A && git -c user.name=t -c user.email=t@t commit -qm base", { cwd: repo });
    const init = await FakeRun.initProject(home, repo);
    const dash = await startDashboard({ projectId: init.projectId, home });
    try {
      const res = await fetch(`${dash.url}/api/tree`);
      const body = (await res.json()) as {
        nodes: Array<{ id: string; kind: string; effective: string }>;
        milestone: unknown;
      };
      expect(res.status).toBe(200);
      expect(body.nodes.some((n) => n.kind === "root")).toBe(true);
      const page = await (await fetch(dash.url)).text();
      expect(page).toContain("arbor");
      expect(page).toContain("setInterval");
    } finally {
      dash.close();
    }
  });
});
