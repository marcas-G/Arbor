import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer, Option } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { afterAll, describe, expect, it } from "vitest";
import { ProjectEnvironmentPortLive } from "../adapters/environment-local/src/index.js";
import {
  EnvironmentResolverLocalLive,
  ProjectEnvironmentPortFromResolverLive,
} from "../adapters/environment-resolver-local/src/index.js";
import {
  ClockLive,
  DomainEventJournalLive,
  IdGeneratorLive,
  layer,
  P11_MIGRATIONS,
  RecordEnvironmentChangeLive,
  runMigrations,
  TransactionPortLive,
  WorkWaitStoreLive,
} from "../adapters/persistence-sqlite/src/index.js";
import { resolveSandboxWrite } from "../adapters/sandbox-worktree/src/index.js";
import { evaluateEnvironmentImpact } from "../packages/application/src/environment-impact.js";
import { verificationFreshness } from "../packages/application/src/environment-staleness.js";
import type {
  CanonicalResourceRegion,
  ProjectId,
  SnapshotProbe,
  SnapshotRegionEntry,
} from "../packages/domain/src/index.js";
import {
  canonicalRegionString,
  parseSnapshotBlob,
  snapshotBlobContent,
} from "../packages/domain/src/index.js";
import type {
  EnvironmentObservation,
  SandboxHandle,
} from "../packages/ports/src/index.js";
import {
  EnvironmentResolverPort,
  ProjectEnvironmentPort,
  RecordEnvironmentChange,
  TransactionPort,
} from "../packages/ports/src/index.js";

/**
 * P12 `09` (EC-10 / B1 / CI-7) — region-encoding convergence.
 *
 * Asserts the frozen object encoding at EVERY `CanonicalResourceRegion`
 * producer and that narrow invalidation is reachable end-to-end from the
 * REAL resolver output (no test-side re-wrapping).
 */

const PROJECT =
  "prj_018f2b3c-4d5e-7abc-8def-0123456789e1" as never as ProjectId;

const RESOURCE_SPACE_IDS: ReadonlySet<string> = new Set([
  "filesystem",
  "database",
  "external",
]);

const assertProducerRegion = (
  region: CanonicalResourceRegion,
  label: string,
): void => {
  expect(
    RESOURCE_SPACE_IDS.has(region.resourceSpaceId),
    `${label}: resourceSpaceId "${region.resourceSpaceId}" not in the frozen set`,
  ).toBe(true);
  expect(typeof region.normalizedRegion, `${label}: normalizedRegion`).toBe(
    "object",
  );
  expect(region.normalizedRegion, `${label}: normalizedRegion null`).not.toBe(
    null,
  );
};

const fileRegion = (path: string): CanonicalResourceRegion => ({
  resourceSpaceId: "filesystem",
  normalizedRegion: { kind: "FileTree", path },
});

const worktreeRegion = (path: string): CanonicalResourceRegion => ({
  resourceSpaceId: "filesystem",
  normalizedRegion: { kind: "GitWorktree", path },
});

// fresh :memory: database per run (mirrors tests/p11-resolver.test.ts)
const resolverAppLayer = () =>
  Layer.provideMerge(
    EnvironmentResolverLocalLive,
    layer({ filename: ":memory:" }),
  );

const runResolver = <A, E>(
  program: Effect.Effect<A, E, EnvironmentResolverPort | SqlClient>,
): Promise<A> =>
  Effect.runPromise(Effect.scoped(Effect.provide(program, resolverAppLayer())));

describe("p12-region-encoding frozen object encoding (EC-10 / B1)", () => {
  let root: string;

  afterAll(async () => {
    if (root !== undefined) {
      await rm(root, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it("resolver emits frozen object encoding; narrow invalidation reachable without re-wrapping (EC-10/B1)", async () => {
    root = await mkdtemp(join(tmpdir(), "p12-region-"));
    const dir = join(root, "tree");
    await mkdir(dir, { recursive: true });

    await runResolver(
      Effect.gen(function* () {
        yield* runMigrations(P11_MIGRATIONS);
        const resolver = yield* EnvironmentResolverPort;
        const observation = yield* resolver.observe(PROJECT, [
          { _tag: "FileTree", path: dir },
        ]);

        // resolver output IS the frozen object encoding (no raw path string)
        for (const entry of observation.entries) {
          assertProducerRegion(entry.resolved, "resolver entry");
          expect(entry.resolved.resourceSpaceId).toBe("filesystem");
          expect(entry.resolved.normalizedRegion).toEqual({
            kind: "FileTree",
            path: dir,
          });
        }
        for (const region of observation.changedRegions) {
          assertProducerRegion(region, "resolver changedRegions");
        }

        // NARROW invalidation against the RESOLVER OUTPUT directly — no
        // test-side re-wrap of a raw path into an object fixture.
        const changed = observation.changedRegions[0];
        if (changed === undefined) {
          throw new Error("resolver emitted no changed region");
        }
        const normalized = changed.normalizedRegion as { path: string };
        const boundInside: CanonicalResourceRegion = {
          resourceSpaceId: changed.resourceSpaceId,
          normalizedRegion: {
            kind: "FileTree",
            path: join(normalized.path, "module-1"),
          },
        };
        expect(
          verificationFreshness(
            {
              targetEnvironmentRevision: "1",
              boundRegions: [boundInside],
            },
            [{ toRevision: "2", changedRegions: observation.changedRegions }],
          ),
        ).toBe("STALE");

        // a disjoint bound region stays CURRENT (the narrow conjunct holds)
        expect(
          verificationFreshness(
            {
              targetEnvironmentRevision: "1",
              boundRegions: [fileRegion(join(root, "unrelated"))],
            },
            [{ toRevision: "2", changedRegions: observation.changedRegions }],
          ),
        ).toBe("CURRENT");

        // narrow impact evaluation consumes the same resolver regions
        const impact = evaluateEnvironmentImpact({
          changedRegions: observation.changedRegions,
          workspaces: [
            {
              workspaceId: "ws_018f2b3c-4d5e-7abc-8def-0123456789e1" as never,
              boundaryRegions: [boundInside],
            },
          ],
          works: [],
          activeClaims: [],
        });
        expect(impact.affectedWorkspaceIds).toHaveLength(1);
      }),
    );
  });

  it("canonicalRegionString: distinct paths -> distinct keys; FileTree/GitWorktree same path -> same key", () => {
    expect(canonicalRegionString(fileRegion("/a"))).not.toBe(
      canonicalRegionString(fileRegion("/b")),
    );
    expect(canonicalRegionString(fileRegion("/a"))).toBe(
      canonicalRegionString(worktreeRegion("/a")),
    );
    expect(canonicalRegionString(fileRegion("/a"))).toBe(
      canonicalRegionString(fileRegion("/a")),
    );
    // database/external branches key on their own field
    expect(
      canonicalRegionString({
        resourceSpaceId: "database",
        normalizedRegion: { kind: "DatabaseNamespace", namespace: "n1" },
      }),
    ).not.toBe(
      canonicalRegionString({
        resourceSpaceId: "database",
        normalizedRegion: { kind: "DatabaseNamespace", namespace: "n2" },
      }),
    );
  });

  it("alias collapse preserved: FileTree + GitWorktree at one path -> one filesystem region", async () => {
    const shared = join(root, "shared");
    await mkdir(shared, { recursive: true });
    await runResolver(
      Effect.gen(function* () {
        yield* runMigrations(P11_MIGRATIONS);
        const resolver = yield* EnvironmentResolverPort;
        const observation = yield* resolver.observe(PROJECT, [
          { _tag: "FileTree", path: shared },
          { _tag: "GitWorktree", path: shared },
        ]);
        expect(observation.entries).toHaveLength(1);
        expect(observation.entries[0]?.resolved).toEqual({
          resourceSpaceId: "filesystem",
          normalizedRegion: { kind: "FileTree", path: shared },
        });
      }),
    );
  });

  it("all producers emit object normalizedRegion + valid resourceSpaceId (CI-7)", async () => {
    root = root ?? (await mkdtemp(join(tmpdir(), "p12-region-")));
    const dir = join(root, "producer-tree");
    await mkdir(dir, { recursive: true });

    // -- 1. real resolver --
    const resolverObservation = await runResolver(
      Effect.gen(function* () {
        yield* runMigrations(P11_MIGRATIONS);
        const resolver = yield* EnvironmentResolverPort;
        return yield* resolver.observe(PROJECT, [
          { _tag: "FileTree", path: dir },
        ]);
      }),
    );
    for (const entry of resolverObservation.entries) {
      assertProducerRegion(entry.resolved, "resolver");
    }
    for (const region of resolverObservation.changedRegions) {
      assertProducerRegion(region, "resolver changedRegions");
    }

    // -- 2. fake environment-local (object-encoded fixtures) --
    const fakeRegions = await Effect.runPromise(
      Effect.gen(function* () {
        const environment = yield* ProjectEnvironmentPort;
        const resolved = yield* environment.resolve(PROJECT, [
          { _tag: "FileTree", path: dir },
          { _tag: "GitWorktree", path: dir },
          { _tag: "DatabaseNamespace", namespace: "n" },
          { _tag: "ExternalResource", address: "https://example.test" },
        ]);
        return resolved.regions;
      }).pipe(Effect.provide(ProjectEnvironmentPortLive)),
    );
    for (const region of fakeRegions) {
      assertProducerRegion(region, "environment-local fake");
    }
    expect(fakeRegions.map((region) => region.resourceSpaceId)).toEqual([
      "filesystem",
      "filesystem",
      "database",
      "external",
    ]);

    // -- 3. production projection: ProjectEnvironmentPort over the real resolver --
    const bridgeRegions = await Effect.runPromise(
      Effect.scoped(
        Effect.provide(
          Effect.gen(function* () {
            yield* runMigrations(P11_MIGRATIONS);
            const environment = yield* ProjectEnvironmentPort;
            const resolved = yield* environment.resolve(PROJECT, [
              { _tag: "FileTree", path: dir },
            ]);
            return resolved.regions;
          }),
          Layer.provideMerge(
            ProjectEnvironmentPortFromResolverLive,
            Layer.provideMerge(
              EnvironmentResolverLocalLive,
              layer({ filename: ":memory:" }),
            ),
          ),
        ),
      ),
    );
    for (const region of bridgeRegions) {
      assertProducerRegion(region, "project-environment bridge");
    }

    // -- 4. sandbox-worktree consumer: object guard + pathOfRegion --
    const handle: SandboxHandle = {
      handleId: "sbx_producer",
      rootPath: join(root, "sbx-root"),
      writableRegions: [fileRegion(dir)],
    };
    const resolvedWrite = resolveSandboxWrite(handle, join(dir, "file.txt"));
    expect(resolvedWrite._tag).toBe("Resolved");
    if (resolvedWrite._tag === "Resolved") {
      assertProducerRegion(resolvedWrite.region, "sandbox-worktree region");
    }
    const rawStringHandle: SandboxHandle = {
      ...handle,
      writableRegions: [
        {
          resourceSpaceId: "filesystem",
          normalizedRegion: dir as never,
        },
      ],
    };
    expect(
      resolveSandboxWrite(rawStringHandle, join(dir, "file.txt"))._tag,
    ).toBe("OutsideWritableRegions");

    // -- 5. snapshot-identity blob parse -> object region --
    const probe: SnapshotProbe = {
      kind: "FileTree",
      exists: true,
      mtime: "2026-01-01T00:00:00Z",
    };
    const entries: ReadonlyArray<SnapshotRegionEntry> = [
      {
        address: { _tag: "FileTree", path: dir },
        resolved: resolverObservation.entries[0]?.resolved ?? fileRegion(dir),
        probe,
      },
    ];
    const blob = snapshotBlobContent(PROJECT, entries);
    const parsed = parseSnapshotBlob(blob);
    for (const entry of parsed.regions) {
      assertProducerRegion(entry.resolved, "snapshot-identity blob");
    }

    // -- 6. REC changedRegions_json round-trip --
    const recRegions = await runRecRoundTrip(resolverObservation);
    for (const region of recRegions) {
      assertProducerRegion(region, "REC changedRegions_json");
    }

    // -- 7. ownership / tool-invocation JSON round-trips --
    for (const region of resolverObservation.changedRegions) {
      const roundTripped = JSON.parse(
        JSON.stringify(region),
      ) as CanonicalResourceRegion;
      assertProducerRegion(roundTripped, "ownership/tool JSON round-trip");
    }
  });

  it("deferred kinds -> typed CanonicalizationFailed (never a wrong space)", async () => {
    await runResolver(
      Effect.gen(function* () {
        yield* runMigrations(P11_MIGRATIONS);
        const resolver = yield* EnvironmentResolverPort;

        const database = yield* Effect.flip(
          resolver.observe(PROJECT, [
            { _tag: "DatabaseNamespace", namespace: "db-1" },
          ]),
        );
        expect(database._tag).toBe("CanonicalizationFailed");

        const external = yield* Effect.flip(
          resolver.observe(PROJECT, [
            { _tag: "ExternalResource", address: "https://example.test" },
          ]),
        );
        expect(external._tag).toBe("CanonicalizationFailed");
      }),
    );
  });

  it("production composition wires the real resolver, not the fake (EC-10)", () => {
    const source = readFileSync(
      join(
        import.meta.dirname,
        "..",
        "apps",
        "single-workspace",
        "src",
        "composition.ts",
      ),
      "utf8",
    );
    expect(source.includes("EnvironmentResolverLocalLive")).toBe(true);
    expect(source.includes("@arbor/environment-resolver-local")).toBe(true);
    expect(source.includes("ProjectEnvironmentPortLive")).toBe(false);
    expect(source.includes("@arbor/environment-local")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// REC changedRegions_json producer (real adapter, one :memory: database)
// ---------------------------------------------------------------------------

const recAppLayer = () => {
  const base = layer({ filename: ":memory:" });
  const infra = Layer.mergeAll(base, ClockLive, IdGeneratorLive);
  const tx = Layer.provide(TransactionPortLive, base);
  const journal = Layer.provide(DomainEventJournalLive, infra);
  const waits = Layer.provide(WorkWaitStoreLive, infra);
  const rec = Layer.provide(
    RecordEnvironmentChangeLive,
    Layer.mergeAll(journal, waits, base, IdGeneratorLive),
  );
  return Layer.provideMerge(Layer.mergeAll(rec, tx, base, infra), base);
};

const runRecRoundTrip = (
  observation: EnvironmentObservation,
): Promise<ReadonlyArray<CanonicalResourceRegion>> =>
  Effect.runPromise(
    Effect.scoped(
      Effect.provide(
        Effect.gen(function* () {
          yield* runMigrations(P11_MIGRATIONS);
          const sql = yield* SqlClient;
          const rec = yield* RecordEnvironmentChange;
          const tx = yield* TransactionPort;
          yield* tx.transact(
            Effect.gen(function* () {
              yield* sql.unsafe(
                "INSERT INTO sessions (session_id, binding_kind, workspace_id, execution_id, context_epoch, created_at) VALUES ('ses_re','WorkspacePrimary','ws_re',NULL,0,'t')",
              );
              yield* sql.unsafe(
                "INSERT INTO projects (project_id, name, root_workspace_id, project_policy, project_policy_revision, default_configuration, environment_ref, lifecycle, revision, created_at, updated_at) VALUES (?,'p','ws_re','{}',0,'{}','local','Open',0,'t','t')",
                [PROJECT],
              );
              yield* sql.unsafe(
                "INSERT INTO workspaces (workspace_id, project_id, parent_workspace_id, name, responsibility_definition, responsibility_revision, resource_boundary, resource_boundary_revision, agent_binding, primary_session_id, workspace_policy, workspace_policy_revision, revision, lifecycle, created_at, updated_at) VALUES ('ws_re',?,NULL,'root','{}',1,'{}',1,'{}','ses_re','{}',0,0,'Active','t','t')",
                [PROJECT],
              );
              yield* sql.unsafe(
                "INSERT INTO environment_revisions (project_id, revision, updated_at) VALUES (?, '1', 't')",
                [PROJECT],
              );
            }),
          );
          yield* tx.transact(
            rec.record(
              { ...observation, projectId: PROJECT, observedRevision: "1" },
              "Governance",
            ),
          );
          const latest = yield* tx.transact(rec.latestChange(PROJECT));
          return Option.isSome(latest) ? latest.value.changedRegions : [];
        }),
        recAppLayer(),
      ),
    ),
  );
