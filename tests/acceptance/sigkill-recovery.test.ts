import { execSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { effectiveRefName, projectDirs } from "../../src/application/ports.js";
import { FakeRun } from "../integration/helpers/run-init.js";

const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "arbor-sig-"));
  dirs.push(d);
  return d;
};
afterAll(() => {
  for (const d of dirs) {
    rmSync(d, { recursive: true, force: true });
  }
});

const MAIN = join("dist", "entrypoints", "main.js");

const writeTurn = (path: string, content: string, id: string) => ({
  content: undefined,
  toolCalls: [{ id, name: "write_file", arguments: JSON.stringify({ path, content }) }],
  finishReason: "tool-calls",
});
const stopTurn = { content: "done", toolSteps: undefined, toolCalls: [], finishReason: "stop" };

interface Proc {
  exit: Promise<number | null>;
  killed: () => boolean;
}

const startAgentRun = (
  home: string,
  projectId: string,
  scriptFile: string,
  task: string | undefined,
): { child: ReturnType<typeof spawn>; proc: Proc } => {
  const child = spawn(
    process.execPath,
    [
      MAIN,
      "agent",
      "run",
      "--project",
      projectId,
      "--home",
      home,
      ...(task !== undefined ? ["--task", task] : []),
    ],
    {
      env: {
        ...process.env,
        OPENAI_API_STYLE: "fake",
        ARBOR_FAKE_SCRIPT: scriptFile,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let out = "";
  child.stdout?.on("data", (c: Buffer) => {
    out += c;
  });
  child.stderr?.on("data", (c: Buffer) => {
    out += c;
  });
  return {
    child,
    proc: {
      exit: new Promise((resolve) => {
        child.on("close", (code) => {
          resolve(code);
        });
      }),
      killed: () => out.length > 0,
    },
  };
};

const waitFor = async (f: () => boolean, ms: number): Promise<boolean> => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (f()) {
      return true;
    }
    await new Promise((r) => {
      setTimeout(r, 50);
    });
  }
  return f();
};

describe("acceptance: real SIGKILL mid-run → restart → resume (P1-05/09)", () => {
  it("survives kill -9 and resumes to completion in a fresh process", async () => {
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
    const worktree = d.worktreeDir;
    const marker = join(worktree, "progress-1.txt");

    // long script: many steps so we have a kill window after the first tool lands
    const longScript = [
      writeTurn("progress-1.txt", "step one done", "c1"),
      writeTurn("progress-2.txt", "step two", "c2"),
      writeTurn("progress-3.txt", "step three", "c3"),
      writeTurn("progress-4.txt", "step four", "c4"),
      writeTurn("progress-5.txt", "step five", "c5"),
    ];
    const scriptA = join(home, "script-a.json");
    writeFileSync(scriptA, JSON.stringify(longScript));
    const scriptB = join(home, "script-b.json");
    writeFileSync(scriptB, JSON.stringify([stopTurn]));

    // --- run 1: real process, killed hard once the first tool result is on disk
    const r1 = startAgentRun(home, init.projectId, scriptA, "do the five steps");
    const landed = await waitFor(() => existsSync(marker), 15_000);
    expect(landed).toBe(true); // first tool completed → transcript has durable events
    r1.child.kill("SIGKILL");
    const code1 = await r1.proc.exit;
    expect(code1).not.toBe(0); // hard-killed

    // transcript has NO terminal marker; db run row is unclosed
    const agentDir = join(d.agentStateDir);
    const agentId = execSync(`ls ${agentDir}`).toString().trim();
    const transcriptFile = join(agentDir, agentId, "transcript.jsonl");
    const types1 = readFileSync(transcriptFile, "utf8")
      .trim()
      .split("\n")
      .map((l) => (JSON.parse(l) as { type: string }).type);
    expect(types1.at(-1)).not.toBe("run_finished");
    expect(types1.at(-1)).not.toBe("pause_marker"); // SIGKILL leaves no graceful marker
    const unclosed = execSync(
      `sqlite3 ${d.dbFile} "SELECT COUNT(*) FROM agent_runs WHERE finished_at IS NULL;"`,
    )
      .toString()
      .trim();
    expect(unclosed).toBe("1");

    // --- run 2: fresh process resumes (no task) and finishes
    const r2 = startAgentRun(home, init.projectId, scriptB, undefined);
    const code2 = await r2.proc.exit;
    expect(code2).toBe(0);

    const types2 = readFileSync(transcriptFile, "utf8")
      .trim()
      .split("\n")
      .map((l) => (JSON.parse(l) as { type: string }).type);
    expect(types2).toContain("resume_marker");
    expect(types2.at(-1)).toBe("run_finished");
    // append-only across the kill
    for (const t of types1) {
      expect(types2).toContain(t);
    }
    // canonical state untouched by the kill
    expect(
      execSync(`git -C ${d.storeDir} rev-parse ${effectiveRefName(init.workspaceId)}`, {
        encoding: "utf8",
      }).trim(),
    ).toBe(init.effectiveRefSha);
  }, 60_000);
});
