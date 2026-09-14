import { execFile } from "node:child_process";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { isPathWithinPrefix, normalizeProjectPath } from "../domain/project-path.js";
import { readTree } from "../infrastructure/tree-store.js";

/** P5 (D-044 J1/J2): mechanical impact analysis + selective invalidation.
 * Criterion: diff file paths between the parent's previous and current
 * accepted merged commits ∩ child writablePrefixes. Invalidation marks the
 * VALIDITY of an acceptance stale — history is never deleted. */

export interface AffectedChild {
  readonly workspaceId: string;
  readonly overlappingPaths: string[];
}

const git = (cwd: string, args: string[]): Promise<string[]> =>
  new Promise((resolve, reject) => {
    execFile("git", ["-C", cwd, ...args], { windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err !== null) {
        reject(new Error(String(stderr || err.message)));
      } else {
        resolve(String(stdout).split("\n").map((l) => l.trim()).filter((l) => l.length > 0));
      }
    });
  });

/** The parent's accepted merged commits, oldest → newest (from store history
 * of the parent-accepted records across git versions; P5 reads the current
 * record per child plus the milestone/accept log kept in accept-log.json). */
async function acceptLog(
  storeDir: string,
  parentWorkspaceId: string,
): Promise<Array<{ child: string; mergedCommit: string; at: string }>> {
  const file = join(storeDir, "workspaces", parentWorkspaceId, "history", "accept-log.json");
  try {
    return JSON.parse(await readFile(file, "utf8")) as Array<{ child: string; mergedCommit: string; at: string }>;
  } catch {
    return [];
  }
}

export async function appendAcceptLog(
  storeDir: string,
  parentWorkspaceId: string,
  entry: { child: string; mergedCommit: string },
): Promise<void> {
  const file = join(storeDir, "workspaces", parentWorkspaceId, "history", "accept-log.json");
  const log = await acceptLog(storeDir, parentWorkspaceId);
  log.push({ ...entry, at: new Date().toISOString() });
  await writeFile(file, JSON.stringify(log, null, 2), "utf8");
}

/** Children whose writable prefixes intersect the diff (prevMerged..currentMerged).
 * The child being accepted right now is excluded — its own changes are the
 * point of this acceptance, not a reason to invalidate it. */
export async function analyzeImpact(input: {
  readonly storeDir: string;
  readonly projectWorktreeDir: string;
  readonly parentWorkspaceId: string;
  readonly prevMergedCommit: string | undefined;
  readonly currentMergedCommit: string;
  readonly excludeChildId?: string | undefined;
}): Promise<AffectedChild[]> {
  if (input.prevMergedCommit === undefined || input.prevMergedCommit === input.currentMergedCommit) {
    return [];
  }
  const changed = await git(input.projectWorktreeDir, [
    "diff",
    "--name-only",
    input.prevMergedCommit,
    input.currentMergedCommit,
  ]);
  const tree = await readTree(input.storeDir);
  const out: AffectedChild[] = [];
  for (const node of tree.nodes) {
    if (node.parentId !== input.parentWorkspaceId || node.workspaceId === input.excludeChildId) {
      continue;
    }
    const hits = changed.filter((p) =>
      node.writablePrefixes.some((prefix) => {
        const n = normalizeProjectPath(p);
        return n.kind === "ok" && isPathWithinPrefix({ value: prefix }, { value: n.value });
      }),
    );
    if (hits.length > 0) {
      out.push({ workspaceId: node.workspaceId, overlappingPaths: hits.slice(0, 20) });
    }
  }
  return out;
}

/** Mark affected children's acceptance stale (record rewrite + store commit). */
export async function invalidateAffected(input: {
  readonly storeDir: string;
  readonly parentWorkspaceId: string;
  readonly affected: ReadonlyArray<AffectedChild>;
}): Promise<string[]> {
  if (input.affected.length === 0) {
    return [];
  }
  const identity = ["-c", "user.name=arbor", "-c", "user.email=arbor@local"];
  const invalidated: string[] = [];
  for (const hit of input.affected) {
    const file = join(
      input.storeDir,
      "workspaces",
      input.parentWorkspaceId,
      "history",
      "parent-accepted",
      `${hit.workspaceId}.json`,
    );
    try {
      const rec = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
      rec.status = "stale";
      rec.staleReason = `parent state moved; overlapping paths: ${hit.overlappingPaths.join(", ")}`;
      rec.staleAt = new Date().toISOString();
      await writeFile(file, JSON.stringify(rec, null, 2), "utf8");
      invalidated.push(hit.workspaceId);
    } catch {
      // no acceptance record for this child — nothing to invalidate
    }
  }
  await git(input.storeDir, [...identity, "add", "-A"]);
  await git(input.storeDir, [...identity, "commit", "-m", `invalidate: ${invalidated.map((w) => w.slice(0, 8)).join(", ")}`]).catch(
    () => undefined,
  );
  return invalidated;
}

/** The parent's last accepted merged commit (for the prev pointer). */
export async function lastAcceptedCommit(
  storeDir: string,
  parentWorkspaceId: string,
): Promise<string | undefined> {
  const log = await acceptLog(storeDir, parentWorkspaceId);
  return log.at(-1)?.mergedCommit;
}

/** Child's current acceptance status (for its inspect projection). */
export async function acceptanceStatus(
  storeDir: string,
  parentWorkspaceId: string,
  childWorkspaceId: string,
): Promise<string> {
  const file = join(
    storeDir,
    "workspaces",
    parentWorkspaceId,
    "history",
    "parent-accepted",
    `${childWorkspaceId}.json`,
  );
  try {
    const rec = JSON.parse(await readFile(file, "utf8")) as {
      status?: string;
      staleReason?: string;
      childResultId: string;
    };
    return rec.status === "stale"
      ? `STALE — ${rec.staleReason ?? "parent state moved"}`
      : `current (result ${rec.childResultId.slice(0, 8)})`;
  } catch {
    return "never accepted";
  }
}

void readdir;
