import { readFileSync } from "node:fs";
import { chmod, mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { afterAll, describe, expect, it } from "vitest";
import { EnvironmentResolverLocalLive } from "../adapters/environment-resolver-local/src/index.js";
import {
  layer,
  P11_MIGRATIONS,
  runMigrations,
} from "../adapters/persistence-sqlite/src/index.js";
import type {
  ProjectId,
  ResourceAddress,
} from "../packages/domain/src/index.js";
import { EnvironmentResolverPort } from "../packages/ports/src/index.js";

const PROJECT_A =
  "prj_018f2b3c-4d5e-7abc-8def-0123456789d1" as never as ProjectId;
const PROJECT_NO_ANCHOR =
  "prj_018f2b3c-4d5e-7abc-8def-0123456789d2" as never as ProjectId;

// fresh :memory: database per run (mirrors tests/p11-record-change.test.ts)
const appLayer = () =>
  Layer.provideMerge(
    EnvironmentResolverLocalLive,
    layer({ filename: ":memory:" }),
  );

const run = <A, E>(
  program: Effect.Effect<A, E, EnvironmentResolverPort | SqlClient>,
): Promise<A> =>
  Effect.runPromise(Effect.scoped(Effect.provide(program, appLayer())));

const migrate = runMigrations(P11_MIGRATIONS);

describe("p11-resolver real environment resolver (observation-only)", () => {
  let root: string;

  afterAll(async () => {
    if (root !== undefined) {
      await chmod(join(root, "locked"), 0o755).catch(() => undefined);
      await rm(root, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it("FileTree probe: real stat on a tmp directory (exists:mtime); missing path => exists:false", async () => {
    root = await mkdtemp(join(tmpdir(), "p11-resolver-"));
    const dir = join(root, "tree");
    await mkdir(dir);
    const fixed = new Date(1_700_000_000_000);
    await utimes(dir, fixed, fixed);

    await run(
      Effect.gen(function* () {
        yield* migrate;
        const resolver = yield* EnvironmentResolverPort;
        const present = yield* resolver.observe(PROJECT_A, [
          { _tag: "FileTree", path: dir },
        ]);
        expect(present.entries).toHaveLength(1);
        expect(present.entries[0]?.probe).toEqual({
          kind: "FileTree",
          exists: true,
          mtime: fixed.toISOString(),
        });
        expect(present.entries[0]?.resolved).toEqual({
          resourceSpaceId: "fs",
          normalizedRegion: dir,
        });

        const absent = yield* resolver.observe(PROJECT_A, [
          { _tag: "FileTree", path: join(root, "no-such") },
        ]);
        expect(absent.entries[0]?.probe).toEqual({
          kind: "FileTree",
          exists: false,
        });
      }),
    );
  });

  it("GitWorktree probe: fabricated directory + .git/HEAD (exists/head/dirty)", async () => {
    const wt = join(root, "worktree");
    await mkdir(join(wt, ".git"), { recursive: true });
    await writeFile(join(wt, ".git", "HEAD"), "ref: refs/heads/main\n");

    await run(
      Effect.gen(function* () {
        yield* migrate;
        const resolver = yield* EnvironmentResolverPort;
        const observed = yield* resolver.observe(PROJECT_A, [
          { _tag: "GitWorktree", path: wt },
        ]);
        expect(observed.entries[0]?.probe).toEqual({
          kind: "GitWorktree",
          exists: true,
          head: "ref: refs/heads/main",
          dirty: false, // conservative (empirical)
        });
        expect(observed.entries[0]?.resolved).toEqual({
          resourceSpaceId: "fs", // C8: worktree -> filesystem subtree, same backing space
          normalizedRegion: wt,
        });

        const absent = yield* resolver.observe(PROJECT_A, [
          { _tag: "GitWorktree", path: join(root, "no-such-wt") },
        ]);
        expect(absent.entries[0]?.probe).toEqual({
          kind: "GitWorktree",
          exists: false,
        });
      }),
    );
  });

  it("deterministic: same addresses twice => same fingerprint; shuffled order => same fingerprint", async () => {
    const a = join(root, "tree");
    const b = join(root, "worktree");
    const addresses: ReadonlyArray<ResourceAddress> = [
      { _tag: "FileTree", path: a },
      { _tag: "GitWorktree", path: b },
    ];

    await run(
      Effect.gen(function* () {
        yield* migrate;
        const resolver = yield* EnvironmentResolverPort;
        const first = yield* resolver.observe(PROJECT_A, addresses);
        const second = yield* resolver.observe(PROJECT_A, addresses);
        expect(second.fingerprint).toEqual(first.fingerprint);
        expect(second.snapshotBlobRef).toBe(
          `blob:${second.fingerprint.digest}`,
        );

        const shuffled = yield* resolver.observe(PROJECT_A, [
          addresses[1] as ResourceAddress,
          addresses[0] as ResourceAddress,
        ]);
        expect(shuffled.fingerprint).toEqual(first.fingerprint);
        // canonical region order is stable regardless of input order
        expect(shuffled.changedRegions).toEqual(first.changedRegions);
      }),
    );
  });

  it("observedRevision: seeded anchor '1' => '1'; no anchor => '0' (read-only — CI-1)", async () => {
    await run(
      Effect.gen(function* () {
        yield* migrate;
        const sql = yield* SqlClient;
        // seed project + anchor '1' (FK-safe: circular FKs are DEFERRABLE,
        // so all inserts share one transaction — mirrors p11-record-change)
        yield* sql.withTransaction(
          Effect.gen(function* () {
            yield* sql.unsafe(
              "INSERT INTO sessions (session_id, binding_kind, workspace_id, execution_id, context_epoch, created_at) VALUES ('ses_r','WorkspacePrimary','ws_r',NULL,0,'t')",
            );
            yield* sql.unsafe(
              "INSERT INTO projects (project_id, name, root_workspace_id, project_policy, project_policy_revision, default_configuration, environment_ref, lifecycle, revision, created_at, updated_at) VALUES (?,'p','ws_r','{}',0,'{}','local','Open',0,'t','t')",
              [PROJECT_A],
            );
            yield* sql.unsafe(
              "INSERT INTO workspaces (workspace_id, project_id, parent_workspace_id, name, responsibility_definition, responsibility_revision, resource_boundary, resource_boundary_revision, agent_binding, primary_session_id, workspace_policy, workspace_policy_revision, revision, lifecycle, created_at, updated_at) VALUES ('ws_r',?,NULL,'root','{}',1,'{}',1,'{}','ses_r','{}',0,0,'Active','t','t')",
              [PROJECT_A],
            );
            yield* sql.unsafe(
              "INSERT INTO environment_revisions (project_id, revision, updated_at) VALUES (?, '1', 't')",
              [PROJECT_A],
            );
          }),
        );

        const resolver = yield* EnvironmentResolverPort;
        const anchored = yield* resolver.observe(PROJECT_A, [
          { _tag: "FileTree", path: join(root, "tree") },
        ]);
        expect(anchored.observedRevision).toBe("1");

        const unanchored = yield* resolver.observe(PROJECT_NO_ANCHOR, [
          { _tag: "FileTree", path: join(root, "tree") },
        ]);
        expect(unanchored.observedRevision).toBe("0");

        // the observation did NOT create or advance any anchor (CI-1)
        const rows = yield* sql.unsafe<{ project_id: string }>(
          "SELECT project_id FROM environment_revisions WHERE project_id = ?",
          [PROJECT_NO_ANCHOR],
        );
        expect(rows).toHaveLength(0);
      }),
    );
  });

  it("semantic change moves the fingerprint (mtime change / HEAD change)", async () => {
    const dir = join(root, "tree");
    const wtHead = join(root, "worktree", ".git", "HEAD");
    const addresses: ReadonlyArray<ResourceAddress> = [
      { _tag: "FileTree", path: dir },
      { _tag: "GitWorktree", path: join(root, "worktree") },
    ];

    const observeFingerprint = () =>
      run(
        Effect.gen(function* () {
          yield* migrate;
          const resolver = yield* EnvironmentResolverPort;
          return yield* resolver.observe(PROJECT_A, addresses);
        }),
      );

    const before = await observeFingerprint();

    const moved = new Date(1_700_000_000_001);
    await utimes(dir, moved, moved);
    await writeFile(wtHead, "ref: refs/heads/feature\n");

    const after = await observeFingerprint();
    expect(after.fingerprint).not.toEqual(before.fingerprint);
    expect(after.snapshotBlobRef).toBe(`blob:${after.fingerprint.digest}`);
  });

  it("probe failure is typed ProbeFailed (unreadable path under chmod 000 directory), never an empty result", async () => {
    const locked = join(root, "locked");
    await mkdir(locked);
    await writeFile(join(locked, "secret"), "x");
    await chmod(locked, 0o000);

    await run(
      Effect.gen(function* () {
        yield* migrate;
        const resolver = yield* EnvironmentResolverPort;
        const failure = yield* Effect.flip(
          resolver.observe(PROJECT_A, [
            { _tag: "FileTree", path: join(locked, "secret") },
          ]),
        );
        expect(failure._tag).toBe("ProbeFailed");
      }),
    );
  });

  it("architecture: resolver source imports no write seam and contains no write SQL (mechanical)", () => {
    const source = readFileSync(
      join(
        import.meta.dirname,
        "..",
        "adapters",
        "environment-resolver-local",
        "src",
        "index.ts",
      ),
      "utf8",
    );
    for (const forbidden of [
      "RecordEnvironmentChange",
      "EnvironmentRevisionStore",
      "advanceAnchor",
      "lazyInitAnchor",
      "TransactionScope",
      "INSERT INTO",
      "UPDATE ",
      "DELETE FROM",
    ]) {
      expect(source.includes(forbidden)).toBe(false);
    }
    expect(source.includes("SELECT revision FROM environment_revisions")).toBe(
      true,
    );
  });
});
