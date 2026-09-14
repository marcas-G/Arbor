import { execSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { afterAll, describe, expect, it } from "vitest";
import type { ModelTurn } from "../../src/agent-runtime/provider.js";
import { runAgentSession } from "../../src/application/agent-runner.js";
import { effectiveRefName, projectDirs, SqlitePort } from "../../src/application/ports.js";
import { reconcileProject } from "../../src/application/reconcile.js";
import { FakeProviderLive } from "../../src/infrastructure/fake-provider.js";
import { SqliteNodeLive } from "../../src/infrastructure/sqlite-node.js";
import { FakeRun } from "./helpers/run-init.js";

const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "arbor-rec-"));
  dirs.push(d);
  return d;
};
afterAll(() => {
  for (const d of dirs) {
    rmSync(d, { recursive: true, force: true });
  }
});

const sql = await Effect.runPromise(SqlitePort.pipe(Effect.provide(SqliteNodeLive)));

const setup = async () => {
  const home = tmp();
  const repo = tmp();
  execSync(
    "git init -q && echo r > README.md && git add -A && git -c user.name=t -c user.email=t@t commit -qm base",
    {
      cwd: repo,
    },
  );
  const init = await FakeRun.initProject(home, repo);
  return { home, repo, ...init, d: projectDirs(home, init.projectId) };
};

const writeTurn: ModelTurn = {
  content: undefined,
  toolCalls: [
    { id: "c1", name: "write_file", arguments: JSON.stringify({ path: "x.txt", content: "v" }) },
  ],
  finishReason: "tool-calls",
};

describe("reconcile (D-039, P1-09 fault matrix)", () => {
  it("crashed run (SIGKILL-like: no terminal marker) is marked crashed", async () => {
    const env = await setup();
    // run that pauses gracefully first (to get an agent + run rows)
    const r1 = await runAgentSession(
      {
        projectId: env.projectId,
        home: env.home,
        providerLayer: FakeProviderLive.withScript([writeTurn, writeTurn]),
        task: "t",
        stepLimit: 10,
        pauseAfterFirstStep: true,
      },
      sql,
    );
    // simulate crash: strip the trailing pause_marker from the transcript and reopen the run row
    const tr = join(env.d.agentStateDir, r1.agentId, "transcript.jsonl");
    const lines = readAll(tr).trim().split("\n");
    if ((JSON.parse(lines.at(-1) ?? "{}") as { type: string }).type === "pause_marker") {
      writeFileSync(tr, `${lines.slice(0, -1).join("\n")}\n`);
    }
    execSync(
      `sqlite3 ${env.d.dbFile} "UPDATE agent_runs SET finished_at = NULL, finish_reason = NULL WHERE run_id = '${r1.runId}';"`,
    );

    const report = await reconcileProject({ projectId: env.projectId, home: env.home }, sql);
    expect(report.repairs.some((x) => x.includes("marked crashed"))).toBe(true);
    expect(report.refOk).toBe(true);
  });

  it("lost runtime db is rebuilt from layout; repo path flagged, not invented", async () => {
    const env = await setup();
    const refBefore = execSync(
      `git -C ${env.d.storeDir} rev-parse ${effectiveRefName(env.workspaceId)}`,
      { encoding: "utf8" },
    ).trim();
    rmSync(env.d.dbFile);

    const report = await reconcileProject({ projectId: env.projectId, home: env.home }, sql);
    expect(report.repairs.some((x) => x.includes("recreated"))).toBe(true);
    expect(report.repairs.some((x) => x.includes("projects row rebuilt"))).toBe(true);
    expect(report.repairs.some((x) => x.includes("workspaces row rebuilt"))).toBe(true);
    // canonical truth untouched
    expect(
      execSync(`git -C ${env.d.storeDir} rev-parse ${effectiveRefName(env.workspaceId)}`, {
        encoding: "utf8",
      }).trim(),
    ).toBe(refBefore);
    // the rebuilt db actually works for queries
    const projects = execSync(`sqlite3 ${env.d.dbFile} "SELECT COUNT(*) FROM projects;"`)
      .toString()
      .trim();
    expect(projects).toBe("1");
  });

  it("store commit without ref move stays unactivated (idempotent, no side effects)", async () => {
    const env = await setup();
    const before = execSync(
      `git -C ${env.d.storeDir} rev-parse ${effectiveRefName(env.workspaceId)}`,
      { encoding: "utf8" },
    ).trim();
    execSync(
      `git -C ${env.d.storeDir} -c user.name=x -c user.email=x@x commit --allow-empty -qm orphan`,
    );
    const report = await reconcileProject({ projectId: env.projectId, home: env.home }, sql);
    const after = execSync(
      `git -C ${env.d.storeDir} rev-parse ${effectiveRefName(env.workspaceId)}`,
      { encoding: "utf8" },
    ).trim();
    expect(after).toBe(before); // an orphan commit never becomes effective by reconciliation
    expect(report.repairs).toEqual([]);
  });

  it("externally moved ref is reported as the authority (db never overrides it)", async () => {
    const env = await setup();
    execSync(
      `git -C ${env.d.storeDir} -c user.name=x -c user.email=x@x commit --allow-empty -qm foreign`,
    );
    const foreign = execSync(`git -C ${env.d.storeDir} rev-parse HEAD`, {
      encoding: "utf8",
    }).trim();
    execSync(`git -C ${env.d.storeDir} update-ref ${effectiveRefName(env.workspaceId)} ${foreign}`);
    const report = await reconcileProject({ projectId: env.projectId, home: env.home }, sql);
    expect(report.effectiveRef).toBe(foreign);
    expect(report.refOk).toBe(true);
  });
});

function readAll(p: string): string {
  return execSync(`cat ${p}`, { encoding: "utf8" });
}
void existsSync;
