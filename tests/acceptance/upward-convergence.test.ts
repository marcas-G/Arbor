import { execSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { afterAll, describe, expect, it } from "vitest";
import { parse as parseYaml, stringify as yamlStringify } from "yaml";
import type { ModelTurn } from "../../src/agent-runtime/provider.js";
import { runAgentSession } from "../../src/application/agent-runner.js";
import { acceptWorkspace, boundaryVerify } from "../../src/application/boundary.js";
import { createChild } from "../../src/application/child-creation.js";
import { effectiveRefName, projectDirs, SqlitePort } from "../../src/application/ports.js";
import { verifyCandidate } from "../../src/application/verify.js";
import { FakeProviderLive } from "../../src/infrastructure/fake-provider.js";
import { SqliteNodeLive } from "../../src/infrastructure/sqlite-node.js";
import { FakeRun } from "../integration/helpers/run-init.js";

const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "arbor-p3-"));
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

const setCommands = (wsDir: string, commands: Array<Record<string, unknown>>) => {
  const yamlPath = join(wsDir, "workspace.yaml");
  const y = parseYaml(readFileSync(yamlPath, "utf8")) as Record<string, unknown>;
  y.verification = { local: { commands } };
  writeFileSync(yamlPath, yamlStringify(y));
};

describe("P3 acceptance: upward convergence (D-042)", () => {
  it("child completes → boundary → accept → parent ref moves, child ref untouched", async () => {
    const home = tmp();
    const repo = tmp();
    execSync(
      "git init -q && mkdir -p src/core && echo r > README.md && git add -A && git -c user.name=t -c user.email=t@t commit -qm base",
      { cwd: repo },
    );
    const init = await FakeRun.initProject(home, repo);
    const d = projectDirs(home, init.projectId);
    const parentWsDir = join(d.storeDir, "workspaces", init.workspaceId);

    // parent local verification: trivially pass
    setCommands(parentWsDir, [
      { name: "root-smoke", argv: [process.execPath, "-e", ""], cwd: ".", timeoutMs: 30000 },
    ]);

    // create child for src/core
    const child = await createChild(
      {
        projectId: init.projectId,
        home,
        parentWorkspaceId: init.workspaceId,
        intent: "core module",
        responsibility: "implement core",
        deliverables: "engine",
        writablePrefixes: ["src/core"],
      },
      sql,
    );
    expect(child.ok).toBe(true);
    if (!child.ok) return;
    const childId = child.childWorkspaceId;

    // child works + activates
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
          toolTurn("c2", "report_completion", { summary: "engine" }),
          stopTurn,
        ]),
        task: "build engine",
        stepLimit: 10,
      },
      sql,
    );
    expect(r.finish).toBe("stop");

    const childRefBefore = execSync(`git -C ${d.storeDir} rev-parse ${effectiveRefName(childId)}`, {
      encoding: "utf8",
    }).trim();
    const parentRefBefore = execSync(
      `git -C ${d.storeDir} rev-parse ${effectiveRefName(init.workspaceId)}`,
      { encoding: "utf8" },
    ).trim();

    // --- boundary: no hidden commands configured yet → vacuous pass
    let bv = await boundaryVerify({
      storeDir: d.storeDir,
      parentWorkspaceId: init.workspaceId,
      childWorkspaceId: childId,
      projectWorktreeDir: d.worktreeDir,
    });
    expect(bv.result.verdict).toBe("pass");

    // --- boundary with a hidden failing command → fail with filtered detail
    const boundaryDir = join(parentWsDir, "boundary");
    execSync(`mkdir -p ${boundaryDir}`);
    writeFileSync(
      join(boundaryDir, "commands.yaml"),
      yamlStringify({
        commands: [
          {
            name: "hidden-api-check",
            argv: [process.execPath, "-e", "process.exit(1)"],
            cwd: ".",
            timeoutMs: 30000,
          },
        ],
      }),
    );
    bv = await boundaryVerify({
      storeDir: d.storeDir,
      parentWorkspaceId: init.workspaceId,
      childWorkspaceId: childId,
      projectWorktreeDir: d.worktreeDir,
    });
    expect(bv.result.verdict).toBe("fail");
    expect(bv.filteredDetail).toContain("hidden-api-check");
    expect(bv.filteredDetail).not.toContain("argv"); // command definitions never leak

    // --- accept is blocked by boundary failure
    const blocked = await acceptWorkspace({
      projectId: init.projectId,
      home,
      storeDir: d.storeDir,
      parentWorkspaceId: init.workspaceId,
      childWorkspaceId: childId,
      parentWorktreeDir: d.worktreeDir,
      parentLocalCommands: [],
    });
    expect(blocked.status).toBe("boundary-failed");

    // --- fix the hidden expectation → accept path works end to end
    writeFileSync(
      join(boundaryDir, "commands.yaml"),
      yamlStringify({
        commands: [
          {
            name: "hidden-api-check",
            argv: [process.execPath, "-e", ""],
            cwd: ".",
            timeoutMs: 30000,
          },
        ],
      }),
    );
    const accepted = await acceptWorkspace({
      projectId: init.projectId,
      home,
      storeDir: d.storeDir,
      parentWorkspaceId: init.workspaceId,
      childWorkspaceId: childId,
      parentWorktreeDir: d.worktreeDir,
      parentLocalCommands: [],
    });
    expect(accepted.status).toBe("accepted");
    if (accepted.status !== "accepted") return;

    // parent ref moved; child ref untouched (Local Effective ≠ Parent Accepted)
    const parentRefAfter = execSync(
      `git -C ${d.storeDir} rev-parse ${effectiveRefName(init.workspaceId)}`,
      { encoding: "utf8" },
    ).trim();
    const childRefAfter = execSync(`git -C ${d.storeDir} rev-parse ${effectiveRefName(childId)}`, {
      encoding: "utf8",
    }).trim();
    expect(parentRefAfter).not.toBe(parentRefBefore);
    expect(childRefAfter).toBe(childRefBefore);

    // the child's work is now in the parent's branch
    expect(readFileSync(join(d.worktreeDir, "src/core/engine.ts"), "utf8")).toContain("engine");
    // ParentAccepted record exists
    expect(
      join(
        d.storeDir,
        "workspaces",
        init.workspaceId,
        "history",
        "parent-accepted",
        `${childId}.json`,
      ),
    ).toBeTruthy();
  });

  it("frozen verification: record carries the command snapshot; verify reruns any candidate", async () => {
    const home = tmp();
    const repo = tmp();
    execSync(
      "git init -q && echo r > README.md && git add -A && git -c user.name=t -c user.email=t@t commit -qm base",
      { cwd: repo },
    );
    const init = await FakeRun.initProject(home, repo);
    const d = projectDirs(home, init.projectId);
    const wsDir = join(d.storeDir, "workspaces", init.workspaceId);
    setCommands(wsDir, [
      { name: "smoke", argv: [process.execPath, "-e", ""], cwd: ".", timeoutMs: 30000 },
    ]);

    const r = await runAgentSession(
      {
        projectId: init.projectId,
        home,
        providerLayer: FakeProviderLive.withScript([
          toolTurn("c1", "write_file", { path: "feature.txt", content: "f" }),
          toolTurn("c2", "report_completion", { summary: "f" }),
          stopTurn,
        ]),
        task: "add feature",
        stepLimit: 10,
      },
      sql,
    );
    expect(r.finish).toBe("stop");

    // verification record carries the frozen command definitions
    const vFiles = execSync(`ls ${wsDir}/history/verifications`).toString().trim().split("\n");
    const rec = JSON.parse(
      readFileSync(join(wsDir, "history/verifications", vFiles[0] as string), "utf8"),
    ) as {
      commandsSnapshot: Array<{ name?: string; argv?: string[] }>;
    };
    expect(rec.commandsSnapshot[0]?.name).toBe("smoke");
    expect(rec.commandsSnapshot[0]?.argv).toEqual([process.execPath, "-e", ""]);

    // verify reruns against the activated candidate
    const head = execSync(`git -C ${d.worktreeDir} rev-parse HEAD`).toString().trim();
    const vr = await verifyCandidate({
      projectId: init.projectId,
      home,
      workspaceId: init.workspaceId,
      storeDir: d.storeDir,
      worktreeDir: d.worktreeDir,
      candidateSha: head,
    });
    expect(vr.verdict).toBe("pass");
    expect(vr.outcomes[0]?.name).toBe("smoke");
  });

  it("governance gate: configured command receives the proposal on stdin and can reject", async () => {
    const home = tmp();
    const repo = tmp();
    execSync(
      "git init -q && mkdir -p docs && echo r > README.md && git add -A && git -c user.name=t -c user.email=t@t commit -qm base",
      { cwd: repo },
    );
    const init = await FakeRun.initProject(home, repo);
    const d = projectDirs(home, init.projectId);
    const wsDir = join(d.storeDir, "workspaces", init.workspaceId);
    // governance: accept only proposals whose stdin contains "docs"
    const y = parseYaml(readFileSync(join(wsDir, "workspace.yaml"), "utf8")) as Record<
      string,
      unknown
    >;
    y.governance = {
      commands: [
        {
          name: "scope-judge",
          argv: [
            process.execPath,
            "-e",
            "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{process.exit(d.includes('docs')?0:1)})",
          ],
          timeoutMs: 30000,
        },
      ],
    };
    writeFileSync(join(wsDir, "workspace.yaml"), yamlStringify(y));

    const reject = await createChild(
      {
        projectId: init.projectId,
        home,
        parentWorkspaceId: init.workspaceId,
        intent: "api layer",
        responsibility: "api",
        deliverables: "api",
        writablePrefixes: ["src"],
      },
      sql,
    );
    expect(reject.ok).toBe(false);
    if (!reject.ok) {
      expect(reject.detail).toContain("governance");
    }

    const accept = await createChild(
      {
        projectId: init.projectId,
        home,
        parentWorkspaceId: init.workspaceId,
        intent: "documentation for docs/",
        responsibility: "docs",
        deliverables: "docs",
        writablePrefixes: ["docs"],
      },
      sql,
    );
    expect(accept.ok).toBe(true);
  });
});
