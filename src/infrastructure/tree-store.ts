import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Schema } from "effect";
import {
  type EngineeringTree,
  EngineeringTreeSchema,
  type TreeNode,
} from "../domain/engineering-tree.js";

/** P2 (D-041 G2): engineering-tree.json in the workspace store under its own
 * CAS ref refs/arbor/tree — same atomic-ref pattern as activation. */

export const TREE_REF = "refs/arbor/tree";
export const EMPTY_TREE: EngineeringTree = { schemaVersion: 1, nodes: [] };

const git = (cwd: string, args: string[]): Promise<string> =>
  new Promise((resolve, reject) => {
    execFile("git", ["-C", cwd, ...args], { windowsHide: true }, (err, stdout, stderr) => {
      if (err !== null) {
        reject(new Error(`git ${args.join(" ")}: ${String(stderr || stdout || err.message)}`));
      } else {
        resolve(String(stdout).trim());
      }
    });
  });

const identity = ["-c", "user.name=arbor", "-c", "user.email=arbor@local"];

export async function readTree(storeDir: string): Promise<EngineeringTree> {
  try {
    const text = await readFile(join(storeDir, "engineering-tree.json"), "utf8");
    return Schema.decodeUnknownSync(EngineeringTreeSchema)(JSON.parse(text)) as EngineeringTree;
  } catch {
    return { ...EMPTY_TREE };
  }
}

/** Write nodes → store commit → CAS the tree ref from the expected prior
 * commit. Returns false on CAS conflict (someone else moved the tree). */
export async function commitTree(
  storeDir: string,
  nodes: ReadonlyArray<TreeNode>,
  expectedPriorCommit: string | undefined,
): Promise<{ ok: boolean; newCommit?: string }> {
  await writeFile(
    join(storeDir, "engineering-tree.json"),
    JSON.stringify({ schemaVersion: 1, nodes } satisfies EngineeringTree, null, 2),
    "utf8",
  );
  await git(storeDir, [...identity, "add", "-A"]);
  await git(storeDir, [...identity, "commit", "-m", `tree: ${nodes.length} node(s)`]);
  const newCommit = await git(storeDir, ["rev-parse", "HEAD"]);
  const cas = await new Promise<boolean>((resolve) => {
    execFile(
      "git",
      [
        "-C",
        storeDir,
        "update-ref",
        TREE_REF,
        newCommit,
        ...(expectedPriorCommit !== undefined ? [expectedPriorCommit] : []),
      ],
      { windowsHide: true },
      (err) => {
        resolve(err === null);
      },
    );
  });
  return cas ? { ok: true, newCommit } : { ok: false, newCommit };
}

export async function treeRefCommit(storeDir: string): Promise<string | undefined> {
  const out = await new Promise<string>((resolve) => {
    execFile(
      "git",
      ["-C", storeDir, "rev-parse", "--verify", "--quiet", `${TREE_REF}^{commit}`],
      { windowsHide: true },
      (err, stdout) => {
        // missing ref exits non-zero with empty output — that is "undefined", not an error
        resolve(err !== null ? "" : String(stdout).trim());
      },
    );
  });
  return out === "" ? undefined : out;
}
