import { execSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { afterAll, describe, expect, it } from "vitest";
import type { ModelTurn } from "../../src/agent-runtime/provider.js";
import { runAgentSession } from "../../src/application/agent-runner.js";
import { SqlitePort } from "../../src/application/ports.js";
import { FakeProviderLive } from "../../src/infrastructure/fake-provider.js";
import { SqliteNodeLive } from "../../src/infrastructure/sqlite-node.js";
import { FakeRun } from "./helpers/run-init.js";

const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "arbor-sess-"));
  dirs.push(d);
  return d;
};
afterAll(() => {
  for (const d of dirs) {
    rmSync(d, { recursive: true, force: true });
  }
});

const writeTurn: ModelTurn = {
  content: undefined,
  toolCalls: [
    {
      id: "c1",
      name: "write_file",
      arguments: JSON.stringify({ path: "notes.txt", content: "step one done" }),
    },
  ],
  finishReason: "tool-calls",
};
const stopTurn: ModelTurn = { content: "all done", toolCalls: [], finishReason: "stop" };

describe("agent session: pause → resume (PHASE1 P1-05 acceptance)", () => {
  it("pauses mid-run, then a second session resumes and finishes", async () => {
    const home = tmp();
    const repo = tmp();
    execSync(
      "git init -q && echo r > README.md && git add -A && git -c user.name=t -c user.email=t@t commit -qm base",
      {
        cwd: repo,
      },
    );
    const init = await FakeRun.initProject(home, repo);
    const sql = await Effect.runPromise(SqlitePort.pipe(Effect.provide(SqliteNodeLive)));

    // --- run 1: pauses after the first completed step (simulated SIGINT)
    const r1 = await runAgentSession(
      {
        projectId: init.projectId,
        home,
        providerLayer: FakeProviderLive.withScript([writeTurn, writeTurn]),
        task: "write notes.txt",
        stepLimit: 10,
        pauseAfterFirstStep: true,
      },
      sql,
    );
    expect(r1.finish).toBe("paused");
    expect(r1.resumed).toBe(false);
    const worktree = join(home, "projects", init.projectId, "worktrees", "root");
    expect(readFileSync(join(worktree, "notes.txt"), "utf8")).toBe("step one done");

    const transcriptFile = join(
      home,
      "projects",
      init.projectId,
      "agent-state",
      r1.agentId,
      "transcript.jsonl",
    );
    const lines1 = readFileSync(transcriptFile, "utf8").trim().split("\n");
    const types1 = lines1.map((l) => (JSON.parse(l) as { type: string }).type);
    expect(types1).toContain("session_started");
    expect(types1).toContain("tool_result");
    expect(types1.at(-1)).toBe("pause_marker");

    // --- run 2: resume (no task) — replayed history + continue to stop
    const r2 = await runAgentSession(
      {
        projectId: init.projectId,
        home,
        providerLayer: FakeProviderLive.withScript([stopTurn]),
        stepLimit: 10,
      },
      sql,
    );
    expect(r2.resumed).toBe(true);
    expect(r2.finish).toBe("stop");
    expect(r2.agentId).toBe(r1.agentId); // persistent primary agent

    const types2 = readFileSync(transcriptFile, "utf8")
      .trim()
      .split("\n")
      .map((l) => (JSON.parse(l) as { type: string }).type);
    expect(types2).toContain("resume_marker");
    expect(types2.at(-1)).toBe("run_finished");
    // append-only: run-1 events are all still present
    for (const t of types1) {
      expect(types2).toContain(t);
    }

    // --- db rows: one agent, two runs
    const dbFile = join(home, "projects", init.projectId, "runtime.db");
    const agents = execSync(`sqlite3 ${dbFile} "SELECT COUNT(*) FROM agents;"`).toString().trim();
    const runs = execSync(`sqlite3 ${dbFile} "SELECT COUNT(*) FROM agent_runs;"`).toString().trim();
    expect(agents).toBe("1");
    expect(runs).toBe("2");
    const lastFinish = execSync(
      `sqlite3 ${dbFile} "SELECT finish_reason FROM agent_runs ORDER BY started_at DESC LIMIT 1;"`,
    )
      .toString()
      .trim();
    expect(lastFinish).toBe("stop");
  });

  it("fresh run without task and nothing resumable → error", async () => {
    const home = tmp();
    const repo = tmp();
    execSync(
      "git init -q && echo r > README.md && git add -A && git -c user.name=t -c user.email=t@t commit -qm base",
      {
        cwd: repo,
      },
    );
    const init = await FakeRun.initProject(home, repo);
    const sql = await Effect.runPromise(SqlitePort.pipe(Effect.provide(SqliteNodeLive)));
    await expect(
      runAgentSession(
        {
          projectId: init.projectId,
          home,
          providerLayer: FakeProviderLive.withScript([]),
          stepLimit: 5,
        },
        sql,
      ),
    ).rejects.toThrow(/--task/);
    expect(existsSync(home)).toBe(true);
  });
});
