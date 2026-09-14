import { execFile, spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";

/** P1-08 (D-038): Runtime-owned finalization — REPORT COMPLETION → PREPARE →
 * VERIFY → ACTIVATE (P1_EFFECTIVE_ACTIVATION_PROTOCOL). The agent never
 * activates anything itself; this module owns the whole deterministic flow. */

export type FinalizeStatus =
  | "pass"
  | "fail"
  | "inconclusive"
  | "no-changes"
  | "activation-conflict";

export interface FinalizeResult {
  readonly status: FinalizeStatus;
  readonly detail: string;
  readonly candidateCommit?: string | undefined;
  readonly resultId?: string | undefined;
  readonly storeCommit?: string | undefined;
}

interface VerificationCommand {
  readonly name?: string;
  readonly argv?: string[];
  readonly cwd?: string;
  readonly timeoutMs?: number;
}

interface WorkspaceYaml {
  readonly verification?: { readonly local?: { readonly commands?: VerificationCommand[] } };
}

const git = (cwd: string, args: string[]): Promise<string> =>
  new Promise((resolve, reject) => {
    execFile("git", ["-C", cwd, ...args], { windowsHide: true }, (err, stdout, stderr) => {
      if (err !== null) {
        reject(new Error(`git ${args.join(" ")}: ${String(stderr || err.message)}`));
      } else {
        resolve(String(stdout).trim());
      }
    });
  });

const runCommand = (argv: string[], cwd: string, timeoutMs: number) =>
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

/**
 * Verify + activate. PREPARE happens first (candidate commit in the caller).
 * Verification runs against the worktree whose HEAD *is* the immutable
 * candidate commit (committed before verify, worktree clean at that point).
 * PASS → write canonical Change/Verification/EffectiveResult records into the
 * Workspace Store, commit, then CAS-move refs/arbor/effective/<workspace-id>.
 */
export async function finalizeCompletion(input: {
  readonly worktreeDir: string;
  readonly storeDir: string;
  readonly workspaceId: string;
  readonly summary: string;
}): Promise<FinalizeResult> {
  const { worktreeDir, storeDir, workspaceId } = input;

  // --- PREPARE: nothing to commit?
  const status = await git(worktreeDir, ["status", "--porcelain"]);
  if (status === "") {
    return { status: "no-changes", detail: "working copy has no changes to commit" };
  }
  const candidate = await git(worktreeDir, [
    "-c",
    "user.name=arbor",
    "-c",
    "user.email=arbor@local",
    "add",
    "-A",
  ]).then(() =>
    git(worktreeDir, [
      "-c",
      "user.name=arbor",
      "-c",
      "user.email=arbor@local",
      "commit",
      "-m",
      `candidate: ${input.summary}`,
    ]),
  );
  const candidateCommit = await git(worktreeDir, ["rev-parse", "HEAD"]);

  // --- VERIFY: command-based local verification from workspace.yaml
  const wsDir = join(storeDir, "workspaces", workspaceId);
  const yamlText = await import("node:fs/promises").then((fs) =>
    fs.readFile(join(wsDir, "workspace.yaml"), "utf8"),
  );
  const commands = (parseYaml(yamlText) as WorkspaceYaml).verification?.local?.commands ?? [];
  const outcomes: Array<{ name: string; exit: string }> = [];
  let verdict: "pass" | "fail" | "inconclusive" = commands.length === 0 ? "pass" : "pass";
  for (const cmd of commands) {
    if (cmd.argv === undefined || cmd.argv.length === 0) {
      verdict = "inconclusive";
      outcomes.push({ name: cmd.name ?? "(unnamed)", exit: "misconfigured" });
      continue;
    }
    const r = await runCommand(
      [...cmd.argv],
      join(worktreeDir, cmd.cwd ?? "."),
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
  if (verdict !== "pass") {
    return {
      status: verdict,
      detail: outcomes.map((o) => `${o.name}: ${o.exit}`).join("; "),
      candidateCommit,
    };
  }

  // --- ACTIVATE: canonical records → store commit → CAS effective ref
  const changeId = crypto.randomUUID();
  const verificationId = crypto.randomUUID();
  const resultId = crypto.randomUUID();
  const expectedRef = await git(storeDir, [
    "rev-parse",
    "--verify",
    "--quiet",
    `refs/arbor/effective/${workspaceId}^{commit}`,
  ]);
  const priorRef = expectedRef === "" ? undefined : expectedRef;

  const writeJson = async (rel: string, body: object) => {
    const file = join(wsDir, rel);
    await mkdir(join(file, ".."), { recursive: true });
    await writeFile(file, JSON.stringify(body, null, 2), "utf8");
  };
  await writeJson(`history/changes/${changeId}.json`, {
    changeId,
    baseEffectiveResultId: null,
    summary: input.summary,
    projectCandidateCommit: candidateCommit,
  });
  await writeJson(`history/verifications/${verificationId}.json`, {
    verificationId,
    outcome: "PASS",
    commands: outcomes,
    verifiedCommit: candidateCommit,
  });
  await writeJson(`history/effective-results/${resultId}.json`, {
    resultId,
    producedByChangeId: changeId,
    projectCandidateCommit: candidateCommit,
    verifiedByVerificationId: verificationId,
  });

  await git(storeDir, ["-c", "user.name=arbor", "-c", "user.email=arbor@local", "add", "-A"]);
  await git(storeDir, [
    "-c",
    "user.name=arbor",
    "-c",
    "user.email=arbor@local",
    "commit",
    "-m",
    `activate ${resultId}`,
  ]);
  const storeCommit = await git(storeDir, ["rev-parse", "HEAD"]);

  // CAS: move ref from expected prior to the new store commit
  const cas = await new Promise<boolean>((resolve) => {
    execFile(
      "git",
      [
        "-C",
        storeDir,
        "update-ref",
        `refs/arbor/effective/${workspaceId}`,
        storeCommit,
        ...(priorRef !== undefined ? [priorRef] : []),
      ],
      { windowsHide: true },
      (err) => {
        resolve(err === null);
      },
    );
  });
  if (!cas) {
    return {
      status: "activation-conflict",
      detail: "effective ref moved during finalization (CAS failed); reconcile and retry",
      candidateCommit,
      resultId,
      storeCommit,
    };
  }
  return {
    status: "pass",
    detail: `activated ${resultId}`,
    candidateCommit,
    resultId,
    storeCommit,
  };
}
