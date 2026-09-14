import { Context, Data, Effect } from "effect";
import type { ProjectId, WorkspaceId } from "../domain/ids.js";

// ---- tagged errors (EFFECT_TS_ARCHITECTURE error families)
export class GitError extends Data.TaggedError("GitError")<{
  readonly op: string;
  readonly message: string;
}> {}

export class DbError extends Data.TaggedError("DbError")<{
  readonly message: string;
}> {}

export class FsError extends Data.TaggedError("FsError")<{
  readonly op: string;
  readonly message: string;
}> {}

export class BootstrapError extends Data.TaggedError("BootstrapError")<{
  readonly reason:
    | "repo-not-found"
    | "not-a-git-repo"
    | "no-base-commit"
    | "duplicate-project"
    | "project-not-found"
    | "invalid-argument";
  readonly message: string;
}> {}

// ---- GitPort (P1-01B subset of EXECUTION_BASELINE §3; cat-file/show deferred to P1-08)
export interface GitPort {
  /** git -C <cwd> rev-parse --verify <ref> -> sha, or undefined if unresolvable */
  readonly revParse: (cwd: string, ref: string) => Effect.Effect<string | undefined, GitError>;
  /** git -C <cwd> init */
  readonly init: (cwd: string) => Effect.Effect<void, GitError>;
  /** stage all + commit with deterministic identity; returns HEAD sha */
  readonly commitAll: (cwd: string, message: string) => Effect.Effect<string, GitError>;
  /** git -C <cwd> update-ref <ref> <newSha> [expected] (CAS when expected given) */
  readonly updateRef: (
    cwd: string,
    ref: string,
    newSha: string,
    expected?: string,
  ) => Effect.Effect<void, GitError>;
  /** git -C <sourceRepo> worktree add <path> -b <branch> <base> */
  readonly worktreeAdd: (
    sourceRepo: string,
    path: string,
    branch: string,
    base: string,
  ) => Effect.Effect<void, GitError>;
}

export const GitPort = Context.Service<GitPort>("application/GitPort");

// ---- SqlitePort (open implies auto-migration, §7)
export interface DbHandle {
  readonly queryOne: (sql: string, ...params: unknown[]) => Effect.Effect<unknown | undefined, DbError>;
  readonly execute: (sql: string, ...params: unknown[]) => Effect.Effect<void, DbError>;
  readonly close: () => Effect.Effect<void, DbError>;
}

export interface SqlitePort {
  readonly open: (dbFile: string) => Effect.Effect<DbHandle, DbError>;
}

export const SqlitePort = Context.Service<SqlitePort>("application/SqlitePort");

// ---- FsPort
export interface FsPort {
  readonly mkdirp: (path: string) => Effect.Effect<void, FsError>;
  readonly writeFile: (path: string, content: string) => Effect.Effect<void, FsError>;
  readonly pathJoin: (...parts: string[]) => string;
  readonly pathResolve: (path: string) => string;
}

export const FsPort = Context.Service<FsPort>("application/FsPort");

// ---- ARBOR_HOME resolution (§4 precedence: --home > env > platform default)
export function resolveArborHome(cliHome: string | undefined, env: NodeJS.ProcessEnv): string {
  if (cliHome !== undefined && cliHome !== "") {
    return cliHome;
  }
  const fromEnv = env["ARBOR_HOME"];
  if (fromEnv !== undefined && fromEnv !== "") {
    return fromEnv;
  }
  const xdg = env["XDG_STATE_HOME"];
  if (xdg !== undefined && xdg !== "") {
    return `${xdg}/arbor`;
  }
  return `${env["HOME"] ?? "."}/.local/state/arbor`;
}

export function effectiveRefName(workspaceId: WorkspaceId): string {
  return `refs/arbor/effective/${workspaceId}`;
}

export const MANAGED_BRANCH = "arbor/root"; // §18.6
export const WORKTREE_DIR = "worktrees/root"; // §18.6

export interface ProjectDirs {
  readonly projectDir: string;
  readonly dbFile: string;
  readonly storeDir: string;
  readonly worktreeDir: string;
  readonly agentStateDir: string;
  readonly logsDir: string;
  readonly workspaceDir: string;
}

export function projectDirs(home: string, projectId: ProjectId): ProjectDirs {
  const projectDir = `${home}/projects/${projectId}`;
  const storeDir = `${projectDir}/workspace-store`;
  return {
    projectDir,
    dbFile: `${projectDir}/runtime.db`,
    storeDir,
    worktreeDir: `${projectDir}/${WORKTREE_DIR}`,
    agentStateDir: `${projectDir}/agent-state`,
    logsDir: `${projectDir}/logs`,
    workspaceDir: `${storeDir}/workspaces`,
  };
}
