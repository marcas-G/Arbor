import { Context, Effect, Layer } from "effect";
import {
  asProjectId,
  newProjectId,
  newWorkspaceId,
  type ProjectId,
  type WorkspaceId,
} from "../domain/ids.js";
import {
  BootstrapError,
  effectiveRefName,
  FsPort,
  GitPort,
  MANAGED_BRANCH,
  projectDirs,
  resolveArborHome,
  SqlitePort,
} from "./ports.js";
import {
  renderOverviewMd,
  renderSummaryMd,
  renderVerificationMd,
  renderWorkspaceMd,
  renderWorkspaceYaml,
} from "./workspace-templates.js";

export interface InitInput {
  readonly repoPath: string;
  readonly home: string;
}

export interface InitResult {
  readonly projectId: ProjectId;
  readonly workspaceId: WorkspaceId;
  readonly effectiveRefSha: string;
}

export interface ShowInput {
  readonly projectId: string;
  readonly home: string;
}

export interface ShowResult {
  readonly projectId: string;
  readonly workspaceId: string;
  readonly sourceRepoPath: string;
  readonly effectiveRefSha: string;
}

export interface ProjectBootstrap {
  readonly init: (input: InitInput) => Effect.Effect<InitResult, BootstrapError>;
  readonly show: (input: ShowInput) => Effect.Effect<ShowResult, BootstrapError>;
}

export const ProjectBootstrap = Context.Service<ProjectBootstrap>("application/ProjectBootstrap");

const now = () => new Date().toISOString();
const die = (reason: BootstrapError["reason"], message: string) =>
  new BootstrapError({ reason, message });
const mapGit = (context: string) => (e: { message: string }) =>
  die("invalid-argument", `${context}: ${e.message}`);

export const ProjectBootstrapLive = Layer.effect(
  ProjectBootstrap,
  Effect.gen(function* () {
    const git = yield* GitPort;
    const fs = yield* FsPort;
    const sql = yield* SqlitePort;
    return {
      init: ({ repoPath, home }: InitInput) =>
        Effect.gen(function* () {
          const homeAbs = resolveArborHome(home, process.env);
          const repoAbs = fs.pathResolve(repoPath);
          // §6: source repo must exist, be a git repo, and have a resolvable base commit
          const head = yield* git
            .revParse(repoAbs, "HEAD")
            .pipe(Effect.mapError(() => die("not-a-git-repo", `not a git repository: ${repoAbs}`)));
          if (head === undefined) {
            return yield* die("no-base-commit", `no resolvable HEAD in ${repoAbs}`);
          }
          const projectId = newProjectId();
          const workspaceId = newWorkspaceId();
          const dirs = projectDirs(homeAbs, projectId);
          const wsDir = `${dirs.workspaceDir}/${workspaceId}`;

          for (const d of [
            wsDir,
            `${wsDir}/design`,
            `${wsDir}/history/changes`,
            `${wsDir}/history/verifications`,
            dirs.agentStateDir,
            dirs.logsDir,
          ]) {
            yield* fs.mkdirp(d).pipe(Effect.mapError(mapGit("mkdir")));
          }

          // workspace-store E0 (§18.1 / §18.2)
          const write = (p: string, c: string) =>
            fs.writeFile(p, c).pipe(Effect.mapError(mapGit("write")));
          yield* write(`${wsDir}/workspace.yaml`, renderWorkspaceYaml({ projectId, workspaceId }));
          yield* write(`${wsDir}/WORKSPACE.md`, renderWorkspaceMd());
          yield* write(`${wsDir}/SUMMARY.md`, renderSummaryMd());
          yield* write(`${wsDir}/design/OVERVIEW.md`, renderOverviewMd());
          yield* write(`${wsDir}/design/VERIFICATION.md`, renderVerificationMd());
          yield* git.init(dirs.storeDir).pipe(Effect.mapError(mapGit("store init")));
          const e0 = yield* git
            .commitAll(dirs.storeDir, "E0: workspace bootstrap")
            .pipe(Effect.mapError(mapGit("store E0 commit")));

          // runtime db AFTER store E0
          const db = yield* sql
            .open(dirs.dbFile)
            .pipe(Effect.mapError((e) => die("invalid-argument", `open db: ${e.message}`)));
          const dup = yield* db
            .queryOne("SELECT project_id FROM projects WHERE source_repo_path = ?", repoAbs)
            .pipe(Effect.mapError((e) => die("invalid-argument", `dup check: ${e.message}`)));
          const close = () =>
            db
              .close()
              .pipe(Effect.mapError((e) => die("invalid-argument", `db close: ${e.message}`)));
          if (dup !== undefined) {
            yield* close();
            return yield* die(
              "duplicate-project",
              `source repo ${repoAbs} already has project ${JSON.stringify(dup)}`,
            );
          }
          const exec = (sql: string, ...params: unknown[]) =>
            db
              .execute(sql, ...params)
              .pipe(Effect.mapError((e) => die("invalid-argument", `db: ${e.message}`)));
          yield* exec(
            "INSERT INTO projects (project_id, source_repo_path, runtime_dir, created_at) VALUES (?, ?, ?, ?)",
            projectId,
            repoAbs,
            dirs.projectDir,
            now(),
          );
          yield* exec(
            "INSERT INTO workspaces (workspace_id, project_id, store_rel_path, kind, created_at) VALUES (?, ?, ?, ?, ?)",
            workspaceId,
            projectId,
            `workspaces/${workspaceId}`,
            "root",
            now(),
          );

          // persistent worktree (§18.6)
          yield* git
            .worktreeAdd(repoAbs, dirs.worktreeDir, MANAGED_BRANCH, head)
            .pipe(Effect.mapError(mapGit("worktree add")));

          // effective ref -> E0 (§18.2)
          yield* git
            .updateRef(dirs.storeDir, effectiveRefName(workspaceId), e0)
            .pipe(Effect.mapError(mapGit("effective ref")));
          yield* close();
          return { projectId, workspaceId, effectiveRefSha: e0 };
        }),

      show: ({ projectId: pidRaw, home }: ShowInput) =>
        Effect.gen(function* () {
          const homeAbs = resolveArborHome(home, process.env);
          const pid = asProjectId(pidRaw);
          if (pid === undefined) {
            return yield* die("invalid-argument", `bad project id: ${pidRaw}`);
          }
          const dirs = projectDirs(homeAbs, pid);
          const db = yield* sql
            .open(dirs.dbFile)
            .pipe(Effect.mapError(() => die("project-not-found", `no runtime db for ${pidRaw}`)));
          const close = () =>
            db
              .close()
              .pipe(Effect.mapError((e) => die("project-not-found", `db close: ${e.message}`)));
          const q = (sql: string, ...params: unknown[]) =>
            db
              .queryOne(sql, ...params)
              .pipe(Effect.mapError((e) => die("project-not-found", `query: ${e.message}`)));
          const proj = (yield* q(
            "SELECT project_id, source_repo_path FROM projects WHERE project_id = ?",
            pid,
          )) as { project_id: string; source_repo_path: string } | undefined;
          if (proj === undefined) {
            yield* close();
            return yield* die("project-not-found", `unknown project ${pidRaw}`);
          }
          const ws = (yield* q(
            "SELECT workspace_id FROM workspaces WHERE project_id = ? AND kind = 'root'",
            pid,
          )) as { workspace_id: string } | undefined;
          if (ws === undefined) {
            yield* close();
            return yield* die("project-not-found", "root workspace missing");
          }
          const sha = yield* git
            .revParse(dirs.storeDir, effectiveRefName(ws.workspace_id as WorkspaceId))
            .pipe(Effect.mapError((e) => die("project-not-found", `effective ref: ${e.message}`)));
          yield* close();
          return {
            projectId: proj.project_id,
            workspaceId: ws.workspace_id,
            sourceRepoPath: proj.source_repo_path,
            effectiveRefSha: sha ?? "(ref missing)",
          };
        }),
    };
  }),
);
