import { execFile } from "node:child_process";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { Effect, type Layer } from "effect";
import { parse as parseYaml } from "yaml";
import type { ModelPort } from "../agent-runtime/provider.js";
import { runVerifierAgent } from "../agent-runtime/verifier.js";
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
    /** P4-04: provider layer for the experimental LLM governance verifier. */
    readonly providerLayer?: Layer.Layer<ModelPort> | undefined;
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

    // --- H5 (D-042): optional semantic governance gate — the proposal JSON
    // goes to a configured command's stdin; a fresh independent process
    // (isolated verifier) decides. Non-zero exit rejects with its first line.
    const govConfig = (
      parentYaml as {
        governance?: {
          commands?: Array<{ name?: string; argv?: string[]; timeoutMs?: number }>;
          llm?: { enabled?: boolean };
        };
      }
    ).governance;
    const gov = govConfig?.commands ?? [];

    // P4-04 (D-043 I4, experimental): same-kernel verifier agent judges the
    // proposal semantically; inconclusive blocks (never a silent pass).
    if (govConfig?.llm?.enabled === true) {
      if (input.providerLayer === undefined) {
        return { ok: false, reason: "error", detail: "governance.llm requires a provider layer" };
      }
      const verdict = await runVerifierAgent({
        providerLayer: input.providerLayer,
        worktreeRoot: dirs.worktreeDir,
        task: [
          "Judge whether this workspace decomposition is sound (sufficiently independent, complete, clear ownership).",
          `Parent writable: ${parentWritable.join(", ")}`,
          `Proposal: ${JSON.stringify(
            {
              intent: input.intent,
              responsibility: input.responsibility,
              deliverables: input.deliverables,
              writablePrefixes: input.writablePrefixes,
            },
            null,
            2,
          )}`,
          "Investigate the workspace with your read-only tools, then emit the verdict JSON.",
        ].join("\n"),
      });
      if (verdict.verdict !== "pass") {
        return {
          ok: false,
          reason: "invalid",
          detail: `governance (verifier agent): ${verdict.verdict} — ${verdict.reason}`,
        };
      }
    }
    if (gov.length > 0) {
      const proposal = JSON.stringify(
        {
          parentWorkspaceId: input.parentWorkspaceId,
          intent: input.intent,
          responsibility: input.responsibility,
          deliverables: input.deliverables,
          writablePrefixes: input.writablePrefixes,
        },
        null,
        2,
      );
      for (const cmd of gov) {
        if (cmd.argv === undefined || cmd.argv.length === 0) {
          return { ok: false, reason: "invalid", detail: "governance command misconfigured" };
        }
        const verdict = await new Promise<{ pass: boolean; reason: string }>((resolve) => {
          const child = execFile(
            cmd.argv?.[0] as string,
            cmd.argv?.slice(1) ?? [],
            { windowsHide: true, timeout: cmd.timeoutMs ?? 60_000 },
            (err, stdout) => {
              if (err === null) {
                resolve({ pass: true, reason: "governance pass" });
              } else {
                const first =
                  String(stdout)
                    .split("\n")
                    .find((l) => l.trim().length > 0) ?? "rejected by governance";
                resolve({ pass: false, reason: first.slice(0, 200) });
              }
            },
          );
          child.stdin?.end(proposal, "utf8");
        });
        if (!verdict.pass) {
          return { ok: false, reason: "invalid", detail: `governance: ${verdict.reason}` };
        }
      }
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
