import { execSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { afterAll, describe, expect, it } from "vitest";
import { parse as parseYaml, stringify as yamlStringify } from "yaml";
import type { ModelTurn } from "../../src/agent-runtime/provider.js";
import { runAgentSession } from "../../src/application/agent-runner.js";
import { effectiveRefName, projectDirs, SqlitePort } from "../../src/application/ports.js";
import { FakeProviderLive } from "../../src/infrastructure/fake-provider.js";
import { SqliteNodeLive } from "../../src/infrastructure/sqlite-node.js";
import { FakeRun } from "../integration/helpers/run-init.js";

const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "arbor-act-"));
  dirs.push(d);
  return d;
};
afterAll(() => {
  for (const d of dirs) {
    rmSync(d, { recursive: true, force: true });
  }
});

describe("acceptance: report_completion → prepare → verify → activate (P1-07+08)", () => {
  it("agent completes, finalization activates, effective ref moves", async () => {
    const home = tmp();
    const repo = tmp();
    execSync(
      "git init -q && echo r > README.md && git add -A && git -c user.name=t -c user.email=t@t commit -qm base",
      {
        cwd: repo,
      },
    );
    const init = await FakeRun.initProject(home, repo);
    const d = projectDirs(home, init.projectId);
    // verification: a real command that passes
    const wsDir = join(d.storeDir, "workspaces", init.workspaceId);
    const y = parseYaml(readFileSync(join(wsDir, "workspace.yaml"), "utf8")) as Record<
      string,
      unknown
    >;
    y.verification = {
      local: {
        commands: [
          { name: "smoke", argv: [process.execPath, "-e", ""], cwd: ".", timeoutMs: 30000 },
        ],
      },
    };
    writeFileSync(join(wsDir, "workspace.yaml"), yamlStringify(y));

    const refBefore = execSync(
      `git -C ${d.storeDir} rev-parse ${effectiveRefName(init.workspaceId)}`,
      { encoding: "utf8" },
    ).trim();

    const writeThenComplete: ModelTurn = {
      content: undefined,
      toolCalls: [
        {
          id: "c1",
          name: "write_file",
          arguments: JSON.stringify({ path: "feature.txt", content: "the feature" }),
        },
      ],
      finishReason: "tool-calls",
    };
    const reportCompletion: ModelTurn = {
      content: undefined,
      toolCalls: [
        {
          id: "c2",
          name: "report_completion",
          arguments: JSON.stringify({ summary: "add feature.txt" }),
        },
      ],
      finishReason: "tool-calls",
    };
    const stop: ModelTurn = { content: "done", toolCalls: [], finishReason: "stop" };

    const sql = await Effect.runPromise(SqlitePort.pipe(Effect.provide(SqliteNodeLive)));
    const r = await runAgentSession(
      {
        projectId: init.projectId,
        home,
        providerLayer: FakeProviderLive.withScript([writeThenComplete, reportCompletion, stop]),
        task: "add the feature and report completion",
        stepLimit: 10,
      },
      sql,
    );
    expect(r.finish).toBe("stop");

    // activation happened: ref moved beyond E0
    const refAfter = execSync(
      `git -C ${d.storeDir} rev-parse ${effectiveRefName(init.workspaceId)}`,
      {
        encoding: "utf8",
      },
    ).trim();
    expect(refAfter).not.toBe(refBefore);
    // store log shows the activation commit
    const log = execSync(`git -C ${d.storeDir} log --oneline`, { encoding: "utf8" });
    expect(log).toMatch(/activate [0-9a-f-]+/);
    // worktree committed the feature
    const head = execSync(`git -C ${d.worktreeDir} rev-parse HEAD`, { encoding: "utf8" }).trim();
    const file = readFileSync(join(d.worktreeDir, "feature.txt"), "utf8");
    expect(file).toBe("the feature");
    // transcript recorded the workspace request
    const transcript = readFileSync(join(d.agentStateDir, r.agentId, "transcript.jsonl"), "utf8");
    expect(transcript).toContain('"workspace_request"');
    expect(transcript).toContain('"report_completion"');
    void head;
  });
});
