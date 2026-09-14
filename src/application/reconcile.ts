import { execFile } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { Effect } from "effect";
import { readTranscript } from "../infrastructure/transcript-store.js";
import { effectiveRefName, projectDirs, resolveArborHome, type SqlitePort } from "./ports.js";

/** P1-09 (D-039): deterministic reconciliation. Authority order (frozen):
 * Workspace Store effective ref > Runtime SQLite > agent memory. A missing DB
 * is rebuilt from the ARBOR_HOME layout; unclosed runs whose transcript ends
 * without a terminal marker are marked crashed; the ref is only inspected,
 * never invented. */

export interface ReconcileReport {
  readonly repairs: string[];
  readonly effectiveRef: string | undefined;
  readonly refOk: boolean;
  readonly warnings: string[];
}

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

export async function reconcileProject(
  input: { readonly projectId: string; readonly home: string },
  sql: SqlitePort,
): Promise<ReconcileReport> {
  const homeAbs = resolveArborHome(input.home, process.env);
  const dirs = projectDirs(homeAbs, input.projectId as never);
  const repairs: string[] = [];
  const warnings: string[] = [];

  // a lost DB file is rebuilt by open+migrations; rows are restored from layout
  const dbExisted = existsSync(dirs.dbFile);
  const db = await Effect.runPromise(sql.open(dirs.dbFile));

  const projectRow = await Effect.runPromise(
    db.queryOne("SELECT project_id FROM projects WHERE project_id = ?", input.projectId),
  );
  if (projectRow === undefined) {
    await Effect.runPromise(
      db.execute(
        "INSERT INTO projects (project_id, source_repo_path, runtime_dir, created_at) VALUES (?, ?, ?, ?)",
        input.projectId,
        "(recovered — source repo path not in canonical store)", // repo path lives only in the DB; flagged, never invented
        dirs.projectDir,
        new Date().toISOString(),
      ),
    );
    repairs.push("projects row rebuilt (source repo path flagged as lost)");
  }

  // workspaces from store layout
  const wsDirRoot = join(dirs.storeDir, "workspaces");
  if (existsSync(wsDirRoot)) {
    for (const wsId of readdirSync(wsDirRoot)) {
      const row = await Effect.runPromise(
        db.queryOne("SELECT workspace_id FROM workspaces WHERE workspace_id = ?", wsId),
      );
      if (row === undefined) {
        await Effect.runPromise(
          db.execute(
            "INSERT INTO workspaces (workspace_id, project_id, store_rel_path, kind, created_at) VALUES (?, ?, ?, ?, ?)",
            wsId,
            input.projectId,
            `workspaces/${wsId}`,
            "root",
            new Date().toISOString(),
          ),
        );
        repairs.push(`workspaces row rebuilt for ${wsId}`);
      }
    }
  }

  // agents from agent-state layout
  if (existsSync(dirs.agentStateDir)) {
    for (const agentId of readdirSync(dirs.agentStateDir)) {
      const row = await Effect.runPromise(
        db.queryOne("SELECT agent_id FROM agents WHERE agent_id = ?", agentId),
      );
      if (row === undefined) {
        await Effect.runPromise(
          db.execute(
            "INSERT INTO agents (agent_id, project_id, created_at) VALUES (?, ?, ?)",
            agentId,
            input.projectId,
            new Date().toISOString(),
          ),
        );
        repairs.push(`agents row rebuilt for ${agentId}`);
      }
    }
  }

  // unclosed runs: crash consistency — no terminal marker in transcript ⇒ crashed
  const openRuns = (await Effect.runPromise(
    db.queryMany
      ? db.queryMany("SELECT run_id, agent_id FROM agent_runs WHERE finished_at IS NULL")
      : (undefined as never),
  )) as Array<{ run_id: string; agent_id: string }> | undefined;
  if (openRuns !== undefined) {
    for (const run of openRuns) {
      const transcriptFile = join(dirs.agentStateDir, run.agent_id, "transcript.jsonl");
      const events = await Effect.runPromise(
        readTranscript(transcriptFile).pipe(Effect.catchCause(() => Effect.succeed([]))),
      );
      const last = events.at(-1)?.type;
      if (last !== "pause_marker" && last !== "run_finished") {
        await Effect.runPromise(
          db.execute(
            "UPDATE agent_runs SET finished_at = ?, finish_reason = ? WHERE run_id = ?",
            new Date().toISOString(),
            "crashed",
            run.run_id,
          ),
        );
        repairs.push(`run ${run.run_id} marked crashed (no terminal transcript marker)`);
      }
    }
  } else {
    warnings.push("queryMany unavailable on this port; run crash-marking skipped");
  }

  // effective ref: inspect only — the ref is the authority, never repaired from the DB
  let effectiveRef: string | undefined;
  let refOk = false;
  try {
    const wsIds = existsSync(wsDirRoot) ? readdirSync(wsDirRoot) : [];
    if (wsIds.length === 1) {
      effectiveRef =
        (await git(dirs.storeDir, [
          "rev-parse",
          "--verify",
          "--quiet",
          `${effectiveRefName(wsIds[0] as never)}^{commit}`,
        ])) || undefined;
      refOk = effectiveRef !== undefined;
      if (!refOk) {
        warnings.push("effective ref missing for workspace");
      }
    } else {
      warnings.push(`expected exactly one root workspace, found ${wsIds.length}`);
    }
  } catch (e) {
    warnings.push(`ref inspection failed: ${String(e)}`);
  }

  await Effect.runPromise(db.close());
  if (!dbExisted) {
    repairs.unshift("runtime db recreated from migrations");
  }
  return { repairs, effectiveRef, refOk, warnings };
}
