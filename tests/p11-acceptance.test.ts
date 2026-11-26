import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { mkdir, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { afterAll, describe, expect, it } from "vitest";
import { EnvironmentResolverLocalLive } from "../adapters/environment-resolver-local/src/index.js";
import {
  ClockLive,
  DomainEventJournalLive,
  EnvironmentRevisionStoreLive,
  IdGeneratorLive,
  layer,
  P16_MIGRATIONS,
  RecordEnvironmentChangeLive,
  RuntimeClockLive,
  runMigrations,
  TransactionPortLive,
  WorkWaitStoreLive,
} from "../adapters/persistence-sqlite/src/index.js";
import {
  type DriftReport,
  type EnvironmentDriftDeps,
  probeDrift,
} from "../packages/application/src/environment-drift.js";
import {
  type DriftSubmissionFace,
  startupDriftProbe,
} from "../packages/application/src/environment-drift-startup.js";
import { verificationFreshness } from "../packages/application/src/environment-staleness.js";
import {
  Actor,
  concludeVerification,
  Principal,
  type ProjectId,
  parse,
  startVerification,
  type Verification,
  VerificationId,
  type VerificationVerdict,
  WorkId,
  type WorkRevision,
  WorkspaceId,
} from "../packages/domain/dist/index.js";
import {
  type EnvironmentObservation,
  EnvironmentReProbePort,
  EnvironmentResolverPort,
  type EnvironmentResolverService,
  EnvironmentRevisionStore,
  type EnvironmentRevisionStoreService,
  RecordEnvironmentChange,
  type RecordEnvironmentChangeService,
  TransactionPort,
  type TransactionPortService,
} from "../packages/ports/src/index.js";
import { ensureLegacyProjectResourceSourceFixture } from "./support/legacy-project-resource-source.js";

// P11-012 acceptance: one story per closure invariant CI-1..CI-5 (P11 `00`
// §Five closure invariants) + the end-to-end environment story + the
// P5–P10 regression guard reference. Mechanical evidence only.
//
// Suite-slimming (no guard-strength loss — each invariant stays covered by
// its dedicated suite, which carries the stronger assertions):
// - CI-2 (ControlBasis DecisionStale) → tests/p11-controlbasis.test.ts
//   (verbatim scenario, plus the anchor-uninitialized case).
// - CI-3 (worktree terminal closure) → gateway half in
//   tests/p11-worktree.test.ts (release-first precondition with full-error
//   toEqual + the WorktreeRetired event payload); sandbox ephemeral half
//   in tests/p11-sandbox-handoff.test.ts (B3c: same retire chain asserted
//   plus the written-back file contents). The release call site itself is
//   proven live in tests/p11-ownership-wiring.test.ts (releaseClaimsInRegions).
// - CI-5 (verdict immutability + staleness prohibitions) →
//   tests/p11-staleness.test.ts (the mirrored original, stronger: it also
//   covers narrow-overlap CURRENT, null-target CURRENT, staleAttentionRow).

// ---------------------------------------------------------------------------
// shared identities / fixtures
// ---------------------------------------------------------------------------

const PROJECT =
  "prj_018f2b3c-4d5e-7abc-8def-0123456789aa" as never as ProjectId;
const WS = parse(WorkspaceId)("ws_018f2b3c-4d5e-7abc-8def-0123456789aa");
const _OPERATOR = parse(Principal)("user:operator");
const _ACTOR = parse(Actor)("user:operator");

const suiteTmp = mkdtempSync(join(tmpdir(), "p11-acceptance-"));
afterAll(() => {
  rmSync(suiteTmp, { recursive: true, force: true });
});

const seedProjectRows = (sql: SqlClient) =>
  sql.withTransaction(
    Effect.gen(function* () {
      yield* sql.unsafe(
        "INSERT INTO sessions (session_id, binding_kind, workspace_id, execution_id, context_epoch, created_at) VALUES ('ses_acc','WorkspacePrimary',?,NULL,0,'t')",
        [WS],
      );
      yield* sql.unsafe(
        "INSERT INTO projects (project_id, name, root_workspace_id, project_policy, project_policy_revision, default_configuration, environment_ref, lifecycle, revision, created_at, updated_at) VALUES (?,'p',?,'{}',0,'{}','local','Open',0,'t','t')",
        [PROJECT, WS],
      );
      yield* ensureLegacyProjectResourceSourceFixture();
      yield* sql.unsafe(
        "INSERT INTO workspaces (workspace_id, project_id, parent_workspace_id, name, responsibility_definition, responsibility_revision, resource_boundary, resource_boundary_revision, agent_binding, primary_session_id, workspace_policy, workspace_policy_revision, revision, lifecycle, created_at, updated_at) VALUES (?,?,NULL,'root','{}',1,'{}',1,'{}',?,'{}',0,0,'Active','t','t')",
        [WS, PROJECT, "ses_acc"],
      );
    }),
  );

const seedAnchorAndBasis = (
  sql: SqlClient,
  basis: { readonly digest: string },
) =>
  sql.unsafe(
    "INSERT INTO environment_changes (change_id, project_id, from_revision, to_revision, previous_fingerprint, next_fingerprint, snapshot_blob_ref, changed_regions_json, cause, recorded_at) VALUES ('ch-basis', ?, '0', '1', '', ?, ?, '[]', 'Governance', 't')",
    [PROJECT, basis.digest, `blob:${basis.digest}`],
  );

const seedAnchorRow = (sql: SqlClient) =>
  sql.unsafe(
    "INSERT INTO environment_revisions (project_id, revision, updated_at) VALUES (?, '1', 't')",
    [PROJECT],
  );

const anchorOf = (sql: SqlClient) =>
  Effect.gen(function* () {
    const rows = yield* sql.unsafe<{ revision: string | null }>(
      "SELECT revision FROM environment_revisions WHERE project_id = ?",
      [PROJECT],
    );
    return rows[0]?.revision ?? null;
  });

const eventCountOf = (sql: SqlClient) =>
  Effect.gen(function* () {
    const rows = yield* sql.unsafe<{ count: number }>(
      "SELECT COUNT(*) AS count FROM domain_events WHERE event_type = 'EnvironmentChanged'",
    );
    return Number(rows[0]?.count ?? 0);
  });

const observationFromReport = (
  report: DriftReport & { _tag: "Drift" },
): EnvironmentObservation => ({
  projectId: PROJECT,
  observedRevision: report.candidateRevision,
  fingerprint: report.candidateFingerprint,
  snapshotBlobRef: report.candidateSnapshotBlobRef,
  changedRegions: report.changedRegions,
});

/** Recording double for the governed submission face (startup seam). */
const makeRecFace = () => {
  const calls: Array<{
    observation: EnvironmentObservation;
    cause: string;
  }> = [];
  const face: DriftSubmissionFace = {
    record: (observation, cause) =>
      Effect.suspend(() => {
        calls.push({ observation, cause });
        return Effect.succeed({
          _tag: "Advanced" as const,
          fromRevision: "1",
          toRevision: "2",
        });
      }),
  };
  return { face, calls };
};

/** The full drift→REC stack against one :memory: database: the REAL
 * resolver adapter, the REAL RecordEnvironmentChange adapter, and the
 * transaction-wrapped read faces the drift probe consumes. */
type DriftAppEnv =
  | SqlClient
  | TransactionPort
  | RecordEnvironmentChange
  | EnvironmentResolverPort
  | EnvironmentRevisionStore;

const driftAppLayer = (
  reprobe?: Layer.Layer<EnvironmentReProbePort>,
): Layer.Layer<DriftAppEnv> => {
  const base = layer({ filename: ":memory:" });
  const infra = Layer.mergeAll(
    base,
    ClockLive,
    RuntimeClockLive,
    IdGeneratorLive,
  );
  const tx = Layer.provide(TransactionPortLive, base);
  const journal = Layer.provide(DomainEventJournalLive, infra);
  const waits = Layer.provide(WorkWaitStoreLive, infra);
  const recDeps = Layer.mergeAll(
    journal,
    waits,
    base,
    IdGeneratorLive,
    ...(reprobe === undefined ? ([] as const) : [reprobe]),
  );
  const rec = Layer.provide(RecordEnvironmentChangeLive, recDeps);
  const revisions = Layer.provide(EnvironmentRevisionStoreLive, infra);
  const resolver = Layer.provide(EnvironmentResolverLocalLive, base);
  return Layer.mergeAll(
    base,
    tx,
    rec,
    revisions,
    resolver,
  ) as Layer.Layer<DriftAppEnv>;
};

const runDriftApp = <A, E>(
  program: Effect.Effect<A, E, DriftAppEnv>,
  reprobe?: Layer.Layer<EnvironmentReProbePort>,
): Promise<A> =>
  Effect.runPromise(
    Effect.scoped(Effect.provide(program, driftAppLayer(reprobe))),
  );

const makeDriftDeps = (
  resolver: EnvironmentResolverService,
  rec: RecordEnvironmentChangeService,
  revisions: EnvironmentRevisionStoreService,
  tx: TransactionPortService,
): EnvironmentDriftDeps => ({
  resolver,
  changes: {
    latestChange: (projectId) =>
      Effect.mapError(
        tx.transact(rec.latestChange(projectId)),
        (
          cause,
        ): { readonly _tag: "ChangeReadFailure"; readonly cause: unknown } => ({
          _tag: "ChangeReadFailure",
          cause,
        }),
      ),
  },
  revisions: {
    current: (projectId) =>
      Effect.mapError(
        tx.transact(revisions.current(projectId)),
        (
          cause,
        ): {
          readonly _tag: "RevisionReadFailure";
          readonly cause: unknown;
        } => ({
          _tag: "RevisionReadFailure",
          cause,
        }),
      ),
  },
});

const concludedVerification = (
  verdict: VerificationVerdict,
  targetEnvironmentRevision: string | null,
): Verification => {
  const started = startVerification({
    verificationId: parse(VerificationId)(
      "ver_018f2b3c-4d5e-7abc-8def-0123456789e1",
    ),
    workId: parse(WorkId)("wrk_018f2b3c-4d5e-7abc-8def-0123456789e1"),
    targetWorkRevision: 1 as WorkRevision,
    missionSnapshot: {
      goal: "verify the outcome",
      criteria: [
        { criterionId: "c1", requirement: "must hold", required: true },
      ],
      riskRequirements: [],
    },
    targetEnvironmentRevision,
  });
  const result = concludeVerification(
    started,
    verdict,
    "summary:test",
    undefined,
    [
      {
        criterionId: "c1",
        requirement: "must hold",
        required: true,
        verdict,
        evidenceRefs: [],
      },
    ],
  );
  if (!result.ok) {
    throw new Error(`concludeVerification failed: ${result.error._tag}`);
  }
  return result.value;
};

// ---------------------------------------------------------------------------
// the suite
// ---------------------------------------------------------------------------

describe("p11-acceptance (P11 00 CI-1..CI-5 + end-to-end story)", () => {
  it("CI-1 single advancement path — observation-only sources (mechanical) + observe 100x moves nothing; only governed REC advances 1 -> 2", async () => {
    // Mechanical half: the four observation-only sources carry no
    // advancement capability (extends the tests/p11-resolver.test.ts
    // architecture assertion to drift/startup/sandbox).
    for (const relative of [
      "adapters/environment-resolver-local/src/index.ts",
      "packages/application/src/environment-drift.ts",
      "packages/application/src/environment-drift-startup.ts",
      "adapters/sandbox-worktree/src/index.ts",
    ]) {
      const source = readFileSync(
        join(import.meta.dirname, "..", relative),
        "utf8",
      );
      for (const token of [
        "advanceAnchor",
        "lazyInitAnchor",
        "EnvironmentRevisionStoreLive",
        "EnvironmentRevisionStore.",
        "store.record(",
      ]) {
        expect(source.includes(token), `${relative}: ${token}`).toBe(false);
      }
    }

    // End-to-end half: real fs + real sqlite.
    const dir = join(suiteTmp, "ci1-tree");
    await mkdir(dir, { recursive: true });
    const addresses = [{ _tag: "FileTree" as const, path: dir }];

    await runDriftApp(
      Effect.gen(function* () {
        yield* runMigrations(P16_MIGRATIONS);
        const sql = yield* SqlClient;
        const resolver = yield* EnvironmentResolverPort;
        const rec = yield* RecordEnvironmentChange;
        const revisions = yield* EnvironmentRevisionStore;
        const tx = yield* TransactionPort;

        // basis = the pristine observation (for a clean Drift later)
        const pristine = yield* resolver.observe(PROJECT, addresses);
        yield* seedProjectRows(sql);
        yield* seedAnchorRow(sql);
        yield* seedAnchorAndBasis(sql, pristine.fingerprint);

        // THE uniqueness assertion: 100 observations never move the counter.
        for (let i = 0; i < 100; i += 1) {
          const observed = yield* resolver.observe(PROJECT, addresses);
          expect(observed.observedRevision).toBe("1");
        }
        expect(yield* anchorOf(sql)).toBe("1");

        // external mutation -> drift REPORT (still no advancement)
        const moved = new Date(1_700_000_000_000);
        yield* Effect.promise(() => utimes(dir, moved, moved));
        const deps = makeDriftDeps(resolver, rec, revisions, tx);
        const report = yield* probeDrift(PROJECT, addresses, deps);
        expect(report._tag).toBe("Drift");
        expect(yield* anchorOf(sql)).toBe("1"); // a report advances nothing

        // governance confirmation -> the ONE legal path moves 1 -> 2
        if (report._tag !== "Drift") {
          throw new Error("expected Drift");
        }
        const outcome = yield* tx.transact(
          rec.record(observationFromReport(report), "Governance"),
        );
        expect(outcome._tag).toBe("Advanced");
        expect(yield* anchorOf(sql)).toBe("2");
      }),
    );
  });

  // CI-2 SLIMMED: covered by tests/p11-controlbasis.test.ts (verbatim
  // scenario, stronger: it adds the anchor-uninitialized '0' case and the
  // hardcoded-'env' grep as its own dedicated test).

  // CI-3 SLIMMED: covered by tests/p11-worktree.test.ts (gateway half —
  // "RetireWorktree precondition (P11 09 §3 / CI-3, §1.4A release-first)"
  // asserts the same refusal/release/commit closure with the full
  // ActiveClaimsExist error payload via toEqual) and
  // tests/p11-sandbox-handoff.test.ts (sandbox half — B3c ephemeral retire
  // at close asserts the same Governance write-back + retire chain plus
  // the persisted write-back file contents).

  it("CI-4 drift convergence — probe -> Drift -> governed REC -> NoDrift; NoDrift never submits; a second conflict stops at Attention", async () => {
    const dir = join(suiteTmp, "ci4-tree");
    await mkdir(dir, { recursive: true });
    const addresses = [{ _tag: "FileTree" as const, path: dir }];

    // controllable re-probe seam (B4): a fresh observation that still
    // misses the anchor drives the second-conflict stop
    let reprobeObservation: EnvironmentObservation | undefined;
    const reprobeLayer = Layer.succeed(EnvironmentReProbePort, {
      reprobe: (_projectId: ProjectId) =>
        reprobeObservation === undefined
          ? Effect.fail({
              _tag: "ReProbeFailed" as const,
              cause: "not configured",
            })
          : Effect.succeed(reprobeObservation),
    });

    await runDriftApp(
      Effect.gen(function* () {
        yield* runMigrations(P16_MIGRATIONS);
        const sql = yield* SqlClient;
        const resolver = yield* EnvironmentResolverPort;
        const rec = yield* RecordEnvironmentChange;
        const revisions = yield* EnvironmentRevisionStore;
        const tx = yield* TransactionPort;

        const pristine = yield* resolver.observe(PROJECT, addresses);
        yield* seedProjectRows(sql);
        yield* seedAnchorRow(sql);
        yield* seedAnchorAndBasis(sql, pristine.fingerprint);
        const deps = makeDriftDeps(resolver, rec, revisions, tx);

        // NoDrift -> never submitted (startup seam, autoSubmit default off)
        const recFace = makeRecFace();
        const quiet = yield* startupDriftProbe(PROJECT, addresses, {
          ...deps,
          rec: recFace.face,
        });
        expect(quiet.report._tag).toBe("NoDrift");
        expect(quiet.submission).toEqual({ _tag: "NotRequired" });
        expect(recFace.calls).toHaveLength(0);

        // external mutation -> Drift REPORT; default startup keeps it a
        // proposal (governance confirmation is the convergence path)
        const moved = new Date(1_700_000_000_000);
        yield* Effect.promise(() => utimes(dir, moved, moved));
        const proposal = yield* startupDriftProbe(PROJECT, addresses, {
          ...deps,
          rec: recFace.face,
        });
        expect(proposal.report._tag).toBe("Drift");
        expect(proposal.submission).toEqual({ _tag: "NotRequired" });
        expect(recFace.calls).toHaveLength(0);
        if (proposal.report._tag !== "Drift") {
          throw new Error("expected Drift");
        }

        // governance confirmation -> convergence
        const outcome = yield* tx.transact(
          rec.record(observationFromReport(proposal.report), "Governance"),
        );
        expect(outcome._tag).toBe("Advanced");
        expect(yield* anchorOf(sql)).toBe("2");

        const reconverged = yield* probeDrift(PROJECT, addresses, deps);
        expect(reconverged).toEqual({ _tag: "NoDrift", atRevision: "2" });

        // second conflict -> Attention, no third retry (B4 bounded loop)
        reprobeObservation = {
          projectId: PROJECT,
          observedRevision: "99",
          fingerprint: pristine.fingerprint,
          snapshotBlobRef: pristine.snapshotBlobRef,
          changedRegions: pristine.changedRegions,
        };
        const conflicted = yield* tx.transact(
          rec.record(
            {
              projectId: PROJECT,
              observedRevision: "0",
              fingerprint: pristine.fingerprint,
              snapshotBlobRef: pristine.snapshotBlobRef,
              changedRegions: pristine.changedRegions,
            },
            "ExternalDrift",
          ),
        );
        expect(conflicted._tag).toBe("SecondConflictEscalatedToAttention");
        expect(yield* anchorOf(sql)).toBe("2"); // nothing advanced
      }),
      reprobeLayer,
    );
  });

  // CI-5 SLIMMED: covered by tests/p11-staleness.test.ts — this test was
  // a verbatim mirror of its "four states" + "three prohibitions" tests
  // (the file's own comment said "mirrored from tests/p11-staleness.test.ts");
  // the original also covers narrow-overlap CURRENT, null-target CURRENT
  // and staleAttentionRow on top.

  it("Story A — real fs tmp tree: observe -> external mtime change -> Drift -> governed REC -> EnvironmentChanged event + wake target + STALE overlay; zero verdict mutation throughout", async () => {
    const dir = join(suiteTmp, "story-a-tree");
    await mkdir(dir, { recursive: true });
    const addresses = [{ _tag: "FileTree" as const, path: dir }];

    await runDriftApp(
      Effect.gen(function* () {
        yield* runMigrations(P16_MIGRATIONS);
        const sql = yield* SqlClient;
        const resolver = yield* EnvironmentResolverPort;
        const rec = yield* RecordEnvironmentChange;
        const revisions = yield* EnvironmentRevisionStore;
        const tx = yield* TransactionPort;

        // observe the pristine tree and anchor the basis on it
        const pristine = yield* resolver.observe(PROJECT, addresses);
        yield* seedProjectRows(sql);
        yield* seedAnchorRow(sql);
        yield* seedAnchorAndBasis(sql, pristine.fingerprint);
        // a work waiting on EnvironmentChanged(observed 0) — the wake target
        yield* sql.unsafe(
          "INSERT INTO works (work_id, project_id, workspace_id, objective, why, constraints, completion_expectation, verification_mission, provenance, revision, lifecycle, created_at, updated_at) VALUES ('wrk_acc_w',?, ?,'o','w','[]','c','{}','{}',0,'Open','t','t')",
          [PROJECT, WS],
        );
        yield* sql.unsafe(
          "INSERT INTO work_waits (work_id, wait_mode, conditions_json, registered_at, updated_at) VALUES ('wrk_acc_w','Any',?, 't','t')",
          [
            JSON.stringify([
              {
                _tag: "EnvironmentChanged",
                environmentRef: "local",
                observedRevision: "0",
              },
            ]),
          ],
        );
        expect(yield* eventCountOf(sql)).toBe(0);

        // external mutation (outside Arbor) -> drift detection
        const moved = new Date(1_700_000_000_000);
        yield* Effect.promise(() => utimes(dir, moved, moved));
        const deps = makeDriftDeps(resolver, rec, revisions, tx);
        const report = yield* probeDrift(PROJECT, addresses, deps);
        expect(report._tag).toBe("Drift");
        if (report._tag !== "Drift") {
          throw new Error("expected Drift");
        }
        // zero verdict mutation baseline: a concluded PASS at revision 1
        const verification = concludedVerification("Pass", "1");
        const verificationBefore = structuredClone(verification);

        // governance-confirmed REC: event + wake target + advancement
        const outcome = yield* tx.transact(
          rec.record(observationFromReport(report), "Governance"),
        );
        expect(outcome._tag).toBe("Advanced");
        expect(yield* anchorOf(sql)).toBe("2");
        expect(yield* eventCountOf(sql)).toBe(1);
        const eventRows = yield* sql.unsafe<{ payload_json: string }>(
          "SELECT payload_json FROM domain_events WHERE event_type = 'EnvironmentChanged'",
        );
        const payload = JSON.parse(eventRows[0]?.payload_json ?? "{}");
        expect(payload.fromRevision).toBe("1");
        expect(payload.toRevision).toBe("2");
        expect(payload.cause).toBe("Governance");
        if (outcome._tag === "Advanced" && "facts" in outcome) {
          const facts = (
            outcome as unknown as {
              facts: {
                wakeTargets: ReadonlyArray<{
                  workId: string;
                  workspaceId: string;
                  fromRevision: string;
                  toRevision: string;
                }>;
              };
            }
          ).facts;
          expect(facts.wakeTargets).toEqual([
            {
              workId: "wrk_acc_w",
              workspaceId: "wrk_acc_w",
              fromRevision: "1",
              toRevision: "2",
            },
          ]);
        }

        // freshness: the SAME stored verdict renders STALE over the change.
        // P12 `09` §3: narrow invalidation is asserted against the RESOLVER
        // OUTPUT (`report.changedRegions`, object-encoded) — no test-side
        // re-wrap of a raw path. The mission bound a subpath inside it
        // (narrow overlap).
        const changed = report.changedRegions[0];
        if (changed === undefined) {
          throw new Error("expected a changed region");
        }
        const changedPath = (changed.normalizedRegion as { path: string }).path;
        const freshness = verificationFreshness(
          {
            targetEnvironmentRevision: verification.targetEnvironmentRevision,
            boundRegions: [
              {
                resourceSpaceId: changed.resourceSpaceId,
                normalizedRegion: {
                  kind: "FileTree",
                  path: join(changedPath, "module-1"),
                },
              },
            ],
          },
          [{ toRevision: "2", changedRegions: report.changedRegions }],
        );
        expect(freshness).toBe("STALE");
        expect(verification).toEqual(verificationBefore); // zero mutation
      }),
    );
  });

  it("P5–P10 regression guard reference — the guard suites are on the vitest include path and present per phase", () => {
    const config = readFileSync(
      join(import.meta.dirname, "..", "vitest.config.ts"),
      "utf8",
    );
    expect(config.includes('"tests/**/*.test.ts"')).toBe(true);
    expect(config.includes('"apps/*/test/**/*.test.ts"')).toBe(true);

    // per-phase representative suites exist (P5..P10 stay wired in)
    const representatives: ReadonlyArray<[string, string]> = [
      ["P5", "apps/single-workspace/test/p5-slice-acceptance.test.ts"],
      ["P6", "tests/p6/story-a.test.ts"],
      ["P7", "tests/p7-acceptance.test.ts"],
      ["P8", "tests/p8/story-a.test.ts"],
      ["P9", "tests/p9/p9-story-a.test.ts"],
      ["P10", "tests/p10/actions.test.ts"],
    ];
    for (const [phase, relative] of representatives) {
      expect(existsSync(join(import.meta.dirname, "..", relative)), phase).toBe(
        true,
      );
    }
    // per-phase architecture guards exist
    for (const phase of ["p5", "p6", "p7", "p8", "p9", "p10"]) {
      expect(
        existsSync(
          join(
            import.meta.dirname,
            "architecture",
            `${phase}-architecture.test.ts`,
          ),
        ),
        phase,
      ).toBe(true);
    }
    // the DAG edge table (with the declared P11 whitelist edges) is present
    const dag = readFileSync(
      join(import.meta.dirname, "architecture", "package-dag.ts"),
      "utf8",
    );
    expect(dag.includes('"sandbox-worktree"')).toBe(true);
    expect(dag.includes('"environment-resolver-local"')).toBe(true);
  });
});
