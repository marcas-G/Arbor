import { execFile } from "node:child_process";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { Effect } from "effect";
import { parse as parseYaml } from "yaml";
import { type TreeNode, validateAddChild } from "../domain/engineering-tree.js";
import { newWorkspaceId } from "../domain/ids.js";
import { commitTree, readTree, treeRefCommit } from "../infrastructure/tree-store.js";
import { effectiveRefName, projectDirs, resolveArborHome, type SqlitePort } from "./ports.js";
import {
  renderOverviewMd,
  renderSummaryMd,
  renderVerificationMd,
  renderWorkspaceMd,
  renderWorkspaceYaml,
} from "./workspace-templates.js";

/** P2-02 (D-041 G4/G5): Runtime-owned child creation — structural request →
 * deterministic structural validation → skeleton → single store commit →
 * tree-ref CAS + child effective ref → child worktree → db row. */

export type CreateChildResult =
  | {
      readonly ok: true;
      readonly childWorkspaceId: string;
      readonly branch: string;
      readonly detail: string;
    }
  | {
      readonly ok: false;
      readonly reason: "invalid" | "conflict" | "error";
      readonly detail: string;
    };

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

export async function createChild(
  input: {
    readonly projectId: string;
    readonly home: string;
    readonly parentWorkspaceId: string;
    readonly intent: string;
    readonly responsibility: string;
    readonly deliverables: string;
    readonly writablePrefixes: ReadonlyArray<string>;
  },
  sql: SqlitePort,
): Promise<CreateChildResult> {
  const dirs = projectDirs(resolveArborHome(input.home, process.env), input.projectId as never);
  const storeDir = dirs.storeDir;
  try {
    // --- read the parent's formal writable set (workspace.yaml)
    const parentYaml = parseYaml(
      await readFile(
        join(storeDir, "workspaces", input.parentWorkspaceId, "workspace.yaml"),
        "utf8",
      ),
    ) as { resources?: { writable?: string[] } };
    const parentWritable = parentYaml.resources?.writable ?? ["."];

    // --- current tree (implicit root-only when the tree file is absent)
    const tree = await readTree(storeDir);
    const nodes: TreeNode[] =
      tree.nodes.length > 0
        ? [...tree.nodes]
        : [
            {
              workspaceId: input.parentWorkspaceId,
              kind: "root",
              writablePrefixes: parentWritable,
            },
          ];

    // --- G4 deterministic structural validation
    const childWorkspaceId = newWorkspaceId();
    const candidate: TreeNode = {
      workspaceId: childWorkspaceId,
      parentId: input.parentWorkspaceId,
      kind: "child",
      writablePrefixes: [...input.writablePrefixes],
    };
    const errors = validateAddChild(nodes, candidate);
    if (errors.length > 0) {
      return {
        ok: false,
        reason: "invalid",
        detail: errors.map((e) => `${e.code}: ${e.detail}`).join("; "),
      };
    }

    // --- child skeleton in the store (P1-01B templates, child resource set)
    const wsDir = join(storeDir, "workspaces", childWorkspaceId);
    await mkdir(join(wsDir, "design"), { recursive: true });
    await mkdir(join(wsDir, "history", "changes"), { recursive: true });
    await mkdir(join(wsDir, "history", "verifications"), { recursive: true });
    await mkdir(join(wsDir, "history", "effective-results"), { recursive: true });
    const files: Array<[string, string]> = [
      [
        "workspace.yaml",
        renderWorkspaceYaml({ projectId: input.projectId, workspaceId: childWorkspaceId }).replace(
          'writable:\n    - "."',
          `writable:\n${input.writablePrefixes.map((p) => `    - "${p}"`).join("\n")}`,
        ),
      ],
      ["WORKSPACE.md", renderWorkspaceMd()],
      ["SUMMARY.md", renderSummaryMd()],
      ["design/OVERVIEW.md", renderOverviewMd()],
      ["design/VERIFICATION.md", renderVerificationMd()],
      // the child's formal contract fields land in WORKSPACE.md sections via the request
      [
        "CONTRACT.md",
        [
          `# Child Contract (from ${input.parentWorkspaceId})`,
          "",
          `## Intent`,
          input.intent,
          "",
          `## Responsibility`,
          input.responsibility,
          "",
          `## Expected Deliverables`,
          input.deliverables,
          "",
        ].join("\n"),
      ],
    ];
    const { writeFile } = await import("node:fs/promises");
    for (const [rel, content] of files) {
      await writeFile(join(wsDir, rel), content, "utf8");
    }

    // --- single store commit: skeleton + tree.json
    const expectedTree = await treeRefCommit(storeDir);
    const cas = await commitTree(storeDir, [...nodes, candidate], expectedTree);
    if (!cas.ok) {
      return { ok: false, reason: "conflict", detail: "tree ref moved concurrently (CAS failed)" };
    }
    const storeCommit = cas.newCommit as string;

    // --- child effective ref → this store commit (its E0)
    await git(storeDir, ["update-ref", effectiveRefName(childWorkspaceId), storeCommit]);

    // --- child worktree from the parent's current worktree HEAD
    const parentHead = await git(dirs.worktreeDir, ["rev-parse", "HEAD"]);
    const branch = `arbor/${childWorkspaceId}`;
    await git(dirs.worktreeDir, [
      ...identity,
      "worktree",
      "add",
      "--quiet",
      join(dirs.projectDir, "worktrees", childWorkspaceId),
      "-b",
      branch,
      parentHead,
    ]);

    // --- db row
    await Effect.runPromise(
      Effect.gen(function* () {
        const db = yield* sql.open(dirs.dbFile);
        yield* db.execute(
          "INSERT INTO workspaces (workspace_id, project_id, store_rel_path, kind, created_at) VALUES (?, ?, ?, ?, ?)",
          childWorkspaceId,
          input.projectId,
          `workspaces/${childWorkspaceId}`,
          "child",
          new Date().toISOString(),
        );
        yield* db.close();
      }),
    );
    return {
      ok: true,
      childWorkspaceId,
      branch,
      detail: `child workspace created (writable: ${input.writablePrefixes.join(", ")})`,
    };
  } catch (e) {
    return { ok: false, reason: "error", detail: String(e) };
  }
}
