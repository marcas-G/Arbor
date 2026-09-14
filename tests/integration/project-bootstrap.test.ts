import { execSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer } from "effect";
import { afterAll, describe, expect, it } from "vitest";
import { ProjectBootstrap, ProjectBootstrapLive } from "../../src/application/project-bootstrap.js";
import { FsNodeLive } from "../../src/infrastructure/fs-node.js";
import { GitCliLive } from "../../src/infrastructure/git-cli.js";
import { SqliteNodeLive } from "../../src/infrastructure/sqlite-node.js";

const Layers = ProjectBootstrapLive.pipe(
  Layer.provideMerge(GitCliLive),
  Layer.provideMerge(FsNodeLive),
  Layer.provideMerge(SqliteNodeLive),
);

const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "arbor-bs-"));
  dirs.push(d);
  return d;
};
const makeSourceRepo = (): string => {
  const d = tmp();
  writeFileSync(join(d, "README.md"), "# src");
  execSync("git init -q && git add -A && git -c user.name=t -c user.email=t@t commit -qm base", {
    cwd: d,
  });
  return d;
};
afterAll(() => {
  for (const d of dirs) {
    rmSync(d, { recursive: true, force: true });
  }
});

const failureReason = (exit: { _tag: string }) =>
  exit._tag === "Failure" ? "has-failure" : "no-failure";

describe("project init", () => {
  it("creates full ARBOR_HOME layout, E0 + effective ref, worktree, db rows", async () => {
    const home = tmp();
    const repo = makeSourceRepo();
    await Effect.runPromise(
      Effect.gen(function* () {
        const bs = yield* ProjectBootstrap;
        const r = yield* bs.init({ repoPath: repo, home });
        expect(existsSync(join(home, "projects", r.projectId, "runtime.db"))).toBe(true);
        expect(
          existsSync(join(home, "projects", r.projectId, "worktrees", "root", "README.md")),
        ).toBe(true);
        const wsDir = join(
          home,
          "projects",
          r.projectId,
          "workspace-store",
          "workspaces",
          r.workspaceId,
        );
        expect(readFileSync(join(wsDir, "workspace.yaml"), "utf8")).toContain("schemaVersion: 1");
        expect(existsSync(join(wsDir, "WORKSPACE.md"))).toBe(true);
        expect(existsSync(join(wsDir, "SUMMARY.md"))).toBe(true);
        expect(existsSync(join(wsDir, "design", "OVERVIEW.md"))).toBe(true);
        expect(existsSync(join(wsDir, "design", "VERIFICATION.md"))).toBe(true);
        expect(existsSync(join(wsDir, "history", "changes"))).toBe(true);
        expect(existsSync(join(wsDir, "history", "verifications"))).toBe(true);
        expect(r.effectiveRefSha).toMatch(/^[0-9a-f]{40,64}$/);
      }).pipe(Effect.provide(Layers)),
    );
  });

  it("show after restart (fresh service, same home) returns same ids and ref", async () => {
    const home = tmp();
    const repo = makeSourceRepo();
    const init = await Effect.runPromise(
      Effect.gen(function* () {
        const bs = yield* ProjectBootstrap;
        return yield* bs.init({ repoPath: repo, home });
      }).pipe(Effect.provide(Layers)),
    );
    await Effect.runPromise(
      Effect.gen(function* () {
        const bs = yield* ProjectBootstrap;
        const shown = yield* bs.show({ projectId: init.projectId, home });
        expect(shown.projectId).toBe(init.projectId);
        expect(shown.workspaceId).toBe(init.workspaceId);
        expect(shown.sourceRepoPath).toBe(shown.sourceRepoPath);
        expect(shown.effectiveRefSha).toBe(init.effectiveRefSha);
      }).pipe(Effect.provide(Layers)),
    );
  });

  it("duplicate init for same source repo fails", async () => {
    const home = tmp();
    const repo = makeSourceRepo();
    const once = Effect.gen(function* () {
      const bs = yield* ProjectBootstrap;
      return yield* bs.init({ repoPath: repo, home });
    });
    await Effect.runPromise(once.pipe(Effect.provide(Layers)));
    const exit = await Effect.runPromiseExit(once.pipe(Effect.provide(Layers)));
    expect(failureReason(exit)).toBe("has-failure");
  });

  it("non-repo path fails", async () => {
    const home = tmp();
    const plain = tmp();
    const exit = await Effect.runPromiseExit(
      Effect.gen(function* () {
        const bs = yield* ProjectBootstrap;
        return yield* bs.init({ repoPath: plain, home });
      }).pipe(Effect.provide(Layers)),
    );
    expect(failureReason(exit)).toBe("has-failure");
  });

  it("repo without commits fails", async () => {
    const home = tmp();
    const empty = tmp();
    execSync("git init -q", { cwd: empty });
    const exit = await Effect.runPromiseExit(
      Effect.gen(function* () {
        const bs = yield* ProjectBootstrap;
        return yield* bs.init({ repoPath: empty, home });
      }).pipe(Effect.provide(Layers)),
    );
    expect(failureReason(exit)).toBe("has-failure");
  });

  it("show unknown project fails", async () => {
    const home = tmp();
    const exit = await Effect.runPromiseExit(
      Effect.gen(function* () {
        const bs = yield* ProjectBootstrap;
        return yield* bs.show({
          projectId: "00000000-0000-4000-8000-000000000000",
          home,
        });
      }).pipe(Effect.provide(Layers)),
    );
    expect(failureReason(exit)).toBe("has-failure");
  });
});
