import { execFile, spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";

/** P3-01 (D-042 H1): re-run a workspace's verification command set against an
 * arbitrary commit in an isolated detached worktree. */

export interface VerificationCommand {
  readonly name?: string;
  readonly argv?: string[];
  readonly cwd?: string;
  readonly timeoutMs?: number;
}

export type Verdict = "pass" | "fail" | "inconclusive";

export interface VerifyOutcome {
  readonly name: string;
  readonly exit: string;
}

export interface VerifyResult {
  readonly verdict: Verdict;
  readonly outcomes: VerifyOutcome[];
}

const git = (cwd: string, args: string[]): Promise<string> =>
  new Promise((resolve, reject) => {
    execFile("git", ["-C", cwd, ...args], { windowsHide: true }, (err, stdout, stderr) => {
      if (err !== null) {
        reject(new Error(String(stderr || stdout || err.message)));
      } else {
        resolve(String(stdout).trim());
      }
    });
  });

export function runCommands(
  commands: ReadonlyArray<VerificationCommand>,
  cwdBase: string,
): Promise<VerifyResult> {
  const runOne = (argv: string[], cwd: string, timeoutMs: number) =>
    new Promise<{ code: number | null; timedOut: boolean; started: boolean }>((resolve) => {
      const child = spawn(argv[0] as string, argv.slice(1), { cwd, windowsHide: true });
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGKILL");
      }, timeoutMs);
      child.on("error", () => {
        clearTimeout(timer);
        resolve({ code: null, timedOut: false, started: false });
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        resolve({ code, timedOut, started: true });
      });
    });

  return (async () => {
    const outcomes: VerifyOutcome[] = [];
    let verdict: Verdict = "pass";
    for (const cmd of commands) {
      if (cmd.argv === undefined || cmd.argv.length === 0) {
        verdict = "inconclusive";
        outcomes.push({ name: cmd.name ?? "(unnamed)", exit: "misconfigured" });
        continue;
      }
      const r = await runOne(
        [...cmd.argv],
        join(cwdBase, cmd.cwd ?? "."),
        cmd.timeoutMs ?? 120_000,
      );
      if (!r.started || r.timedOut) {
        verdict = "inconclusive";
        outcomes.push({
          name: cmd.name ?? cmd.argv[0] ?? "(unnamed)",
          exit: r.timedOut ? "timeout" : "not-startable",
        });
      } else if (r.code !== 0) {
        verdict = "fail";
        outcomes.push({ name: cmd.name ?? cmd.argv[0] ?? "(unnamed)", exit: `exit=${r.code}` });
      } else {
        outcomes.push({ name: cmd.name ?? cmd.argv[0] ?? "(unnamed)", exit: "exit=0" });
      }
    }
    return { verdict, outcomes };
  })();
}

export async function verifyCandidate(input: {
  readonly projectId: string;
  readonly home: string;
  readonly workspaceId: string;
  readonly storeDir: string;
  readonly worktreeDir: string;
  readonly candidateSha: string;
}): Promise<VerifyResult> {
  const wsYamlPath = join(input.storeDir, "workspaces", input.workspaceId, "workspace.yaml");
  const y = parseYaml(await readFile(wsYamlPath, "utf8")) as {
    verification?: { local?: { commands?: VerificationCommand[] } };
  };
  const commands = y.verification?.local?.commands ?? [];

  const tmp = mkdtempSync(join(tmpdir(), "arbor-verify-"));
  try {
    await git(input.worktreeDir, [
      "worktree",
      "add",
      "--quiet",
      "--detach",
      tmp,
      input.candidateSha,
    ]);
    try {
      return await runCommands(commands, tmp);
    } finally {
      await git(input.worktreeDir, ["worktree", "remove", "--force", tmp]).catch(() => undefined);
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}
