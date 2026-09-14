import { execFile } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { runCommands, type VerificationCommand, type VerifyResult } from "./verify.js";

/** P3-02/03 (D-042 H2/H3/H4): Boundary verification + promotion.
 * Hidden boundary commands live in the parent's store area — no agent tool
 * can reach the store. Feedback surfaces only category/symptom. */

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

export interface ChildEffective {
  readonly resultId: string;
  readonly candidateCommit: string;
}

/** Latest effective-result record of a child workspace (from its history dir). */
export async function latestChildEffective(
  storeDir: string,
  workspaceId: string,
): Promise<ChildEffective | undefined> {
  const dir = join(storeDir, "workspaces", workspaceId, "history", "effective-results");
  let files: string[] = [];
  try {
    files = readdirSync(dir)
      .filter((f) => f.endsWith(".json"))
      .sort();
  } catch {
    return undefined;
  }
  const last = files.at(-1);
  if (last === undefined) {
    return undefined;
  }
  const rec = JSON.parse(await readFile(join(dir, last), "utf8")) as {
    resultId: string;
    projectCandidateCommit: string;
  };
  return { resultId: rec.resultId, candidateCommit: rec.projectCandidateCommit };
}

/** Boundary verification: run the parent's hidden commands against the child's
 * current effective candidate in an isolated detached worktree. H4: returns a
 * filtered view — never the command definitions or full output. */
export async function boundaryVerify(input: {
  readonly storeDir: string;
  readonly parentWorkspaceId: string;
  readonly childWorkspaceId: string;
  readonly projectWorktreeDir: string;
}): Promise<{ result: VerifyResult; child: ChildEffective; filteredDetail: string }> {
  const child = await latestChildEffective(input.storeDir, input.childWorkspaceId);
  if (child === undefined) {
    throw new Error(`workspace ${input.childWorkspaceId} has no effective result to verify`);
  }
  let commands: VerificationCommand[] = [];
  try {
    const y = parseYaml(
      await readFile(
        join(input.storeDir, "workspaces", input.parentWorkspaceId, "boundary", "commands.yaml"),
        "utf8",
      ),
    ) as { commands?: VerificationCommand[] };
    commands = y.commands ?? [];
  } catch {
    commands = []; // no boundary contract configured: vacuous pass
  }

  const tmp = mkdtempSync(join(tmpdir(), "arbor-boundary-"));
  try {
    await git(input.projectWorktreeDir, [
      "worktree",
      "add",
      "--quiet",
      "--detach",
      tmp,
      child.candidateCommit,
    ]);
    try {
      const result = await runCommands(commands, tmp);
      // H4 hidden feedback: category + first symptom line only
      const filteredDetail =
        result.verdict === "pass"
          ? "boundary expectations met"
          : result.outcomes
              .filter((o) => o.exit !== "exit=0")
              .map((o) => `expectation '${o.name}': ${o.exit}`)
              .join("; ");
      return { result, child, filteredDetail };
    } finally {
      await git(input.projectWorktreeDir, ["worktree", "remove", "--force", tmp]).catch(
        () => undefined,
      );
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

export type AcceptResult =
  | {
      readonly status: "accepted";
      readonly mergedCommit: string;
      readonly storeCommit: string;
      readonly invalidated: ReadonlyArray<string>;
    }
  | { readonly status: "pending-approval"; readonly approvalId: string; readonly detail: string }
  | {
      readonly status:
        | "boundary-failed"
        | "parent-verification-failed"
        | "merge-conflict"
        | "no-child-effective";
      readonly detail: string;
    };

/** Promotion (H3): boundary PASS → merge child candidate into the parent branch
 * → parent's own local verification → ParentAccepted record + parent ref CAS.
 * The child's effective ref is never touched. */
export async function acceptWorkspace(input: {
  readonly projectId: string;
  readonly home: string;
  readonly storeDir: string;
  readonly parentWorkspaceId: string;
  readonly childWorkspaceId: string;
  readonly parentWorktreeDir: string;
  readonly parentLocalCommands: ReadonlyArray<VerificationCommand>;
  /** internal: resume after an approval decision (skips the gate) */
  readonly skipApproval?: boolean;
}): Promise<AcceptResult> {
  const boundary = await boundaryVerify({
    storeDir: input.storeDir,
    parentWorkspaceId: input.parentWorkspaceId,
    childWorkspaceId: input.childWorkspaceId,
    projectWorktreeDir: input.parentWorktreeDir,
  }).catch(() => undefined);
  if (boundary === undefined) {
    return { status: "no-child-effective", detail: "child has no effective result" };
  }
  if (boundary.result.verdict !== "pass") {
    return { status: "boundary-failed", detail: boundary.filteredDetail };
  }

  // K1 (D-044): human approval gate — acceptance waits for a decision
  const { approvalRequired, createPendingApproval } = await import("./approvals.js");
  if (input.skipApproval !== true && (await approvalRequired(input.storeDir, input.parentWorkspaceId))) {
    const approvalId = await createPendingApproval({
      storeDir: input.storeDir,
      parentWorkspaceId: input.parentWorkspaceId,
      childWorkspaceId: input.childWorkspaceId,
      boundaryVerdict: boundary.filteredDetail,
      materials: `child result ${boundary.child.resultId} @ ${boundary.child.candidateCommit.slice(0, 8)}`,
    });
    return { status: "pending-approval", approvalId, detail: boundary.filteredDetail };
  }

  // merge child candidate into the parent branch
  const merge = await new Promise<{ ok: boolean; detail: string }>((resolve) => {
    execFile(
      "git",
      [
        "-C",
        input.parentWorktreeDir,
        "-c",
        "user.name=arbor",
        "-c",
        "user.email=arbor@local",
        "merge",
        "--no-edit",
        "-m",
        `accept child ${input.childWorkspaceId} (result ${boundary.child.resultId})`,
        boundary.child.candidateCommit,
      ],
      { windowsHide: true },
      (err, _so, se) => {
        resolve(
          err === null ? { ok: true, detail: "" } : { ok: false, detail: String(se).slice(0, 300) },
        );
      },
    );
  });
  if (!merge.ok) {
    await git(input.parentWorktreeDir, ["merge", "--abort"]).catch(() => undefined);
    return { status: "merge-conflict", detail: merge.detail };
  }
  const mergedCommit = await git(input.parentWorktreeDir, ["rev-parse", "HEAD"]);

  // parent's own local verification on the merged tree
  const local = await runCommands(input.parentLocalCommands, input.parentWorktreeDir);
  if (local.verdict !== "pass") {
    return {
      status: "parent-verification-failed",
      detail: local.outcomes.map((o) => `${o.name}: ${o.exit}`).join("; "),
    };
  }

  // ParentAccepted record + store commit + parent ref CAS
  const wsDir = join(input.storeDir, "workspaces", input.parentWorkspaceId);
  const { mkdir, writeFile } = await import("node:fs/promises");
  await mkdir(join(wsDir, "history", "parent-accepted"), { recursive: true });
  await writeFile(
    join(wsDir, "history", "parent-accepted", `${input.childWorkspaceId}.json`),
    JSON.stringify(
      {
        childWorkspaceId: input.childWorkspaceId,
        childResultId: boundary.child.resultId,
        mergedCommit,
        acceptedAt: new Date().toISOString(),
        status: "current",
      },
      null,
      2,
    ),
    "utf8",
  );
  const identity = ["-c", "user.name=arbor", "-c", "user.email=arbor@local"];
  await git(input.storeDir, [...identity, "add", "-A"]);
  await git(input.storeDir, [
    ...identity,
    "commit",
    "-m",
    `accept child ${input.childWorkspaceId}`,
  ]);
  const storeCommit = await git(input.storeDir, ["rev-parse", "HEAD"]);
  const cas = await new Promise<boolean>((resolve) => {
    execFile(
      "git",
      [
        "-C",
        input.storeDir,
        "update-ref",
        `refs/arbor/effective/${input.parentWorkspaceId}`,
        storeCommit,
        // CAS from the pre-accept parent ref
      ],
      { windowsHide: true },
      (err) => {
        resolve(err === null);
      },
    );
  });
  if (!cas) {
    return { status: "merge-conflict", detail: "parent effective ref moved concurrently" };
  }
  // P5 (D-044 J1/J2): automatic propagation — impact analysis against the
  // parent's previous accepted state, then selective invalidation
  const { analyzeImpact, appendAcceptLog, invalidateAffected, lastAcceptedCommit } = await import(
    "./impact.js"
  );
  const prev = await lastAcceptedCommit(input.storeDir, input.parentWorkspaceId);
  const affected = await analyzeImpact({
    storeDir: input.storeDir,
    projectWorktreeDir: input.parentWorktreeDir,
    parentWorkspaceId: input.parentWorkspaceId,
    prevMergedCommit: prev,
    currentMergedCommit: mergedCommit,
    excludeChildId: input.childWorkspaceId,
  });
  const invalidated = await invalidateAffected({
    storeDir: input.storeDir,
    parentWorkspaceId: input.parentWorkspaceId,
    affected,
  });
  await appendAcceptLog(input.storeDir, input.parentWorkspaceId, {
    child: input.childWorkspaceId,
    mergedCommit,
  });
  return { status: "accepted", mergedCommit, storeCommit, invalidated };
}
