import { execFile } from "node:child_process";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";

/** P6 (D-044 K1/K3): approvals (K1) and milestone confirmation (K3).
 * Pending approvals live in the store; decisions are commits. A milestone is
 * a stage fixation — the project has NO terminal complete state. */

const git = (cwd: string, args: string[]): Promise<string> =>
  new Promise((resolve, reject) => {
    execFile("git", ["-C", cwd, ...args], { windowsHide: true }, (err, stdout, stderr) => {
      if (err !== null) {
        reject(new Error(String(stderr || err.message)));
      } else {
        resolve(String(stdout).trim());
      }
    });
  });

const identity = ["-c", "user.name=arbor", "-c", "user.email=arbor@local"];

export interface PendingApproval {
  readonly id: string;
  readonly kind: "acceptance";
  readonly childWorkspaceId: string;
  readonly boundaryVerdict: string;
  readonly materials: string;
  readonly createdAt: string;
  status?: "pending" | "approved" | "rejected";
  decidedAt?: string;
  note?: string;
}

export async function approvalRequired(
  storeDir: string,
  workspaceId: string,
): Promise<boolean> {
  try {
    const y = parseYaml(
      await readFile(join(storeDir, "workspaces", workspaceId, "workspace.yaml"), "utf8"),
    ) as { approval?: { required?: boolean } };
    return y.approval?.required === true;
  } catch {
    return false;
  }
}

export async function createPendingApproval(input: {
  readonly storeDir: string;
  readonly parentWorkspaceId: string;
  readonly childWorkspaceId: string;
  readonly boundaryVerdict: string;
  readonly materials: string;
}): Promise<string> {
  const id = crypto.randomUUID();
  const rec: PendingApproval = {
    id,
    kind: "acceptance",
    childWorkspaceId: input.childWorkspaceId,
    boundaryVerdict: input.boundaryVerdict,
    materials: input.materials,
    createdAt: new Date().toISOString(),
    status: "pending",
  };
  const dir = join(input.storeDir, "workspaces", input.parentWorkspaceId, "history", "pending-approvals");
  const { mkdir } = await import("node:fs/promises");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `${id}.json`), JSON.stringify(rec, null, 2), "utf8");
  await git(input.storeDir, [...identity, "add", "-A"]);
  await git(input.storeDir, [...identity, "commit", "-m", `approval requested: accept ${input.childWorkspaceId.slice(0, 8)}`]);
  return id;
}

export async function listApprovals(
  storeDir: string,
  parentWorkspaceId: string,
): Promise<PendingApproval[]> {
  const dir = join(storeDir, "workspaces", parentWorkspaceId, "history", "pending-approvals");
  let files: string[] = [];
  try {
    files = (await readdir(dir)).filter((f) => f.endsWith(".json")).sort();
  } catch {
    return [];
  }
  const out: PendingApproval[] = [];
  for (const f of files) {
    out.push(JSON.parse(await readFile(join(dir, f), "utf8")) as PendingApproval);
  }
  return out;
}

export async function decideApproval(input: {
  readonly storeDir: string;
  readonly parentWorkspaceId: string;
  readonly id: string;
  readonly approve: boolean;
  readonly note?: string;
}): Promise<PendingApproval | undefined> {
  const dir = join(input.storeDir, "workspaces", input.parentWorkspaceId, "history", "pending-approvals");
  const file = join(dir, `${input.id}.json`);
  const rec = JSON.parse(await readFile(file, "utf8")) as PendingApproval;
  const updated: PendingApproval = {
    ...rec,
    status: input.approve ? "approved" : "rejected",
    decidedAt: new Date().toISOString(),
    ...(input.note !== undefined ? { note: input.note } : {}),
  };
  await writeFile(file, JSON.stringify(updated, null, 2), "utf8");
  await git(input.storeDir, [...identity, "add", "-A"]);
  await git(input.storeDir, [
    ...identity,
    "commit",
    "-m",
    `approval ${updated.status}: ${input.id.slice(0, 8)}`,
  ]);
  return updated;
}

/** K3: milestone confirmation — a fixed stage, never a terminal state. */
export async function confirmMilestone(input: {
  readonly storeDir: string;
  readonly rootWorkspaceId: string;
  readonly rootCommit: string;
  readonly summary: string;
}): Promise<{ readonly n: number; readonly file: string }> {
  const dir = join(input.storeDir, "workspaces", input.rootWorkspaceId, "history", "milestones");
  const { mkdir } = await import("node:fs/promises");
  await mkdir(dir, { recursive: true });
  let n = 0;
  try {
    n = (await readdir(dir)).filter((f) => f.endsWith(".json")).length;
  } catch {
    n = 0;
  }
  n += 1;
  const file = join(dir, `${n.toString().padStart(4, "0")}.json`);
  await writeFile(
    file,
    JSON.stringify(
      {
        n,
        rootCommit: input.rootCommit,
        summary: input.summary,
        confirmedAt: new Date().toISOString(),
      },
      null,
      2,
    ),
    "utf8",
  );
  await git(input.storeDir, [...identity, "add", "-A"]);
  await git(input.storeDir, [...identity, "commit", "-m", `milestone ${n} fixed @ ${input.rootCommit.slice(0, 8)}`]);
  return { n, file };
}

export async function currentMilestone(
  storeDir: string,
  rootWorkspaceId: string,
): Promise<{ n: number; rootCommit: string; summary: string; confirmedAt: string } | undefined> {
  const dir = join(storeDir, "workspaces", rootWorkspaceId, "history", "milestones");
  let files: string[] = [];
  try {
    files = (await readdir(dir)).filter((f) => f.endsWith(".json")).sort();
  } catch {
    return undefined;
  }
  const last = files.at(-1);
  if (last === undefined) {
    return undefined;
  }
  return JSON.parse(await readFile(join(dir, last), "utf8"));
}
