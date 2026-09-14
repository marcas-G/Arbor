import { execFile } from "node:child_process";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { readTree } from "../infrastructure/tree-store.js";

/** P4-02 (D-043 I1): mailbox communication between workspaces. Boxes live in
 * the store (no agent tool can reach it); the Runtime performs delivery and
 * commits every action as communication history. Routing is recorded via the
 * tree's lowest common ancestor. Communication never mutates engineering
 * state. */

export interface CommunicationRecord {
  readonly id: string;
  readonly from: string;
  readonly to: string;
  readonly question: string;
  readonly reason: string;
  readonly routingPath: string[];
  readonly createdAt: string;
  readonly answeredAt?: string;
  readonly answer?: string;
  readonly evidence?: string;
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

const identity = ["-c", "user.name=arbor", "-c", "user.email=arbor@local"];

async function commitStore(storeDir: string, message: string): Promise<void> {
  await git(storeDir, [...identity, "add", "-A"]);
  await git(storeDir, [...identity, "commit", "-m", message]).catch(async (e) => {
    // nothing to commit is fine (duplicate delivery)
    void e;
  });
}

/** LCA over the engineering tree (implicit root-only tree when absent). */
async function lowestCommonAncestor(storeDir: string, a: string, b: string): Promise<string[]> {
  const tree = await readTree(storeDir);
  const chain = (id: string): string[] => {
    const path: string[] = [id];
    let cur = tree.nodes.find((n) => n.workspaceId === id);
    while (cur !== undefined && cur.parentId !== undefined) {
      path.push(cur.parentId);
      cur = tree.nodes.find((n) => n.workspaceId === cur?.parentId);
    }
    return path;
  };
  if (tree.nodes.length === 0) {
    return [a, b]; // single-parent implicit tree: direct routing
  }
  const ca = chain(a);
  const cb = chain(b);
  const common = ca.find((id) => cb.includes(id));
  return common === undefined || common === b ? [a, b] : [a, common, b];
}

export async function sendInformation(input: {
  readonly storeDir: string;
  readonly from: string;
  readonly to: string;
  readonly question: string;
  readonly reason: string;
}): Promise<CommunicationRecord> {
  const routingPath = await lowestCommonAncestor(input.storeDir, input.from, input.to);
  const rec: CommunicationRecord = {
    id: crypto.randomUUID(),
    from: input.from,
    to: input.to,
    question: input.question,
    reason: input.reason,
    routingPath,
    createdAt: new Date().toISOString(),
  };
  const inboxDir = join(input.storeDir, "workspaces", input.to, "inbox");
  await mkdir(inboxDir, { recursive: true });
  await writeFile(join(inboxDir, `${rec.id}.json`), JSON.stringify(rec, null, 2), "utf8");
  await commitStore(input.storeDir, `comm: ${input.from.slice(0, 8)} asks ${input.to.slice(0, 8)}`);
  return rec;
}

export async function listInbox(
  storeDir: string,
  workspaceId: string,
): Promise<CommunicationRecord[]> {
  const dir = join(storeDir, "workspaces", workspaceId, "inbox");
  let files: string[] = [];
  try {
    files = (await readdir(dir)).filter((f) => f.endsWith(".json")).sort();
  } catch {
    return [];
  }
  const out: CommunicationRecord[] = [];
  for (const f of files) {
    out.push(JSON.parse(await readFile(join(dir, f), "utf8")) as CommunicationRecord);
  }
  return out;
}

export async function answerInformation(input: {
  readonly storeDir: string;
  readonly workspaceId: string;
  readonly id: string;
  readonly answer: string;
  readonly evidence: string;
}): Promise<CommunicationRecord> {
  const file = join(input.storeDir, "workspaces", input.workspaceId, "inbox", `${input.id}.json`);
  const rec = JSON.parse(await readFile(file, "utf8")) as CommunicationRecord;
  const updated: CommunicationRecord = {
    ...rec,
    answeredAt: new Date().toISOString(),
    answer: input.answer,
    evidence: input.evidence,
  };
  await writeFile(file, JSON.stringify(updated, null, 2), "utf8");
  await commitStore(
    input.storeDir,
    `comm: ${input.workspaceId.slice(0, 8)} answers ${input.id.slice(0, 8)}`,
  );
  return updated;
}
