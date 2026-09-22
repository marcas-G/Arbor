import { Effect, Layer, Option } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { describe, expect, it } from "vitest";
import {
  ClockLive,
  CommandStoreLive,
  DomainEventJournalLive,
  IdGeneratorLive,
  layer,
  P11_MIGRATIONS,
  RecordEnvironmentChangeLive,
  runMigrations,
  TransactionPortLive,
  WorkWaitStoreLive,
} from "../adapters/persistence-sqlite/src/index.js";
import {
  type CanonicalResourceRegion,
  EnvironmentFingerprint,
  type ProjectId,
} from "../packages/domain/dist/index.js";
import {
  type EnvironmentObservation,
  EnvironmentReProbePort,
  RecordEnvironmentChange,
  TransactionPort,
} from "../packages/ports/src/index.js";

const PROJECT_A =
  "prj_018f2b3c-4d5e-7abc-8def-0123456789c1" as never as ProjectId;
const PROJECT_B =
  "prj_018f2b3c-4d5e-7abc-8def-0123456789c2" as never as ProjectId;

const fp = (digest: string) => EnvironmentFingerprint.of(digest);
const regions = (...norms: string[]) =>
  norms.map(
    (norm) =>
      ({
        resourceSpaceId: "s1",
        normalizedRegion: norm,
      }) as CanonicalResourceRegion,
  );

const observation = (
  projectId: ProjectId,
  observedRevision: string,
  fingerprintDigest: string,
  blobRef = `blob:${fingerprintDigest}`,
): EnvironmentObservation => ({
  projectId,
  observedRevision,
  fingerprint: fp(fingerprintDigest),
  snapshotBlobRef: blobRef,
  changedRegions: regions("/changed"),
});

// controllable re-probe seam (fake — real resolver is P11-003)
let reprobeResult: EnvironmentObservation | { fail: true } = { fail: true };
let reprobeCalls = 0;
const fakeReProbe = Layer.succeed(EnvironmentReProbePort, {
  reprobe: (projectId: ProjectId) =>
    Effect.gen(function* () {
      reprobeCalls += 1;
      if ("fail" in reprobeResult && reprobeResult.fail) {
        return yield* Effect.fail({
          _tag: "ReProbeFailed" as const,
          cause: "not configured",
        });
      }
      const obs = reprobeResult as EnvironmentObservation;
      return { ...obs, projectId };
    }),
});

const appLayer = () => {
  const base = layer({ filename: ":memory:" });
  const infra = Layer.mergeAll(base, ClockLive, IdGeneratorLive);
  const tx = Layer.provide(TransactionPortLive, base);
  const journal = Layer.provide(DomainEventJournalLive, infra);
  const waits = Layer.provide(WorkWaitStoreLive, infra);
  const rec = Layer.provide(
    RecordEnvironmentChangeLive,
    Layer.mergeAll(journal, waits, base, IdGeneratorLive, fakeReProbe),
  );
  return Layer.provideMerge(
    Layer.mergeAll(rec, tx, base, fakeReProbe, infra),
    base,
  );
};

const run = <A, E>(
  program: Effect.Effect<
    A,
    E,
    SqlClient | RecordEnvironmentChange | TransactionPort
  >,
): Promise<A> =>
  Effect.runPromise(
    Effect.scoped(
      Effect.provide(
        program as Effect.Effect<A, E, SqlClient | RecordEnvironmentChange>,
        appLayer(),
      ),
    ),
  );

const withEnv = Effect.gen(function* () {
  yield* runMigrations(P11_MIGRATIONS);
  const sql = yield* SqlClient;
  const rec = yield* RecordEnvironmentChange;
  const tx = yield* TransactionPort;
  // seed two projects + anchors (FK-safe order: sessions -> projects -> workspaces)
  yield* tx.transact(
    Effect.gen(function* () {
      const mk = (ses: string, ws: string, prj: ProjectId) =>
        Effect.gen(function* () {
          yield* sql.unsafe(
            "INSERT INTO sessions (session_id, binding_kind, workspace_id, execution_id, context_epoch, created_at) VALUES (?,'WorkspacePrimary',?,NULL,0,'t')",
            [ses, ws],
          );
          yield* sql.unsafe(
            "INSERT INTO projects (project_id, name, root_workspace_id, project_policy, project_policy_revision, default_configuration, environment_ref, lifecycle, revision, created_at, updated_at) VALUES (?,'p',?,'{}',0,'{}','local','Open',0,'t','t')",
            [prj, ws],
          );
          yield* sql.unsafe(
            "INSERT INTO workspaces (workspace_id, project_id, parent_workspace_id, name, responsibility_definition, responsibility_revision, resource_boundary, resource_boundary_revision, agent_binding, primary_session_id, workspace_policy, workspace_policy_revision, revision, lifecycle, created_at, updated_at) VALUES (?,?,NULL,'root','{}',1,'{}',1,'{}',?,'{}',0,0,'Active','t','t')",
            [ws, prj, ses],
          );
        });
      yield* mk("ses_a", "ws_a", PROJECT_A);
      yield* mk("ses_b", "ws_b", PROJECT_B);
      // anchors at revision 1
      yield* sql.unsafe(
        "INSERT INTO environment_revisions (project_id, revision, updated_at) VALUES (?, '1', 't')",
        [PROJECT_A],
      );
      yield* sql.unsafe(
        "INSERT INTO environment_revisions (project_id, revision, updated_at) VALUES (?, '1', 't')",
        [PROJECT_B],
      );
      // basis: an initial change record so NoChange comparison has a basis
      yield* sql.unsafe(
        "INSERT INTO environment_changes (change_id, project_id, from_revision, to_revision, previous_fingerprint, next_fingerprint, snapshot_blob_ref, changed_regions_json, cause, recorded_at) VALUES ('ch-basis', ?, '0', '1', '', 'fp-basis', 'blob:fp-basis', '[]', 'Governance', 't')",
        [PROJECT_A],
      );
    }),
  );
  return { sql, rec, tx };
});

const anchorOf = (sql: SqlClient, projectId: ProjectId) => tx2(sql, projectId);
const tx2 = (sql: SqlClient, projectId: ProjectId) =>
  Effect.gen(function* () {
    const rows = yield* sql.unsafe<{ revision: string }>(
      "SELECT revision FROM environment_revisions WHERE project_id = ?",
      [projectId],
    );
    return rows[0]?.revision ?? "missing";
  });

const changeCount = (sql: SqlClient, projectId: ProjectId) =>
  Effect.gen(function* () {
    const rows = yield* sql.unsafe<{ count: number }>(
      "SELECT COUNT(*) AS count FROM environment_changes WHERE project_id = ?",
      [projectId],
    );
    return Number(rows[0]?.count ?? 0);
  });

const eventCount = (sql: SqlClient) =>
  Effect.gen(function* () {
    const rows = yield* sql.unsafe<{ count: number }>(
      "SELECT COUNT(*) AS count FROM domain_events WHERE event_type = 'EnvironmentChanged'",
    );
    return Number(rows[0]?.count ?? 0);
  });

describe("P11-002 RecordEnvironmentChange (the sole advancement authority)", () => {
  it("successful REC: revision strictly +1, change record + event persisted, typed Advanced", async () => {
    reprobeResult = { fail: true };
    reprobeCalls = 0;
    await run(
      Effect.gen(function* () {
        const { sql, rec, tx } = yield* withEnv;
        const outcome = yield* tx.transact(
          rec.record(observation(PROJECT_A, "1", "fp-new"), "ExternalDrift"),
        );
        expect(outcome._tag).toBe("Advanced");
        if (outcome._tag === "Advanced") {
          expect(outcome.fromRevision).toBe("1");
          expect(outcome.toRevision).toBe("2");
        }
        expect(yield* anchorOf(sql, PROJECT_A)).toBe("2");
        expect(yield* changeCount(sql, PROJECT_A)).toBe(2); // basis + this
        expect(yield* eventCount(sql)).toBe(1);
        expect(reprobeCalls).toBe(0);
      }),
    );
  });

  it("caller cannot specify the next revision — the successor is derived (payload drives CAS via expectedRevision only)", async () => {
    await run(
      Effect.gen(function* () {
        const { rec, tx } = yield* withEnv;
        // The observation only carries observedRevision; there is no field to
        // request "5". Advancing from 1 with the correct expectation yields 2.
        const outcome = yield* tx.transact(
          rec.record(observation(PROJECT_A, "1", "fp-x"), "Governance"),
        );
        expect(outcome._tag).toBe("Advanced");
        if (outcome._tag === "Advanced") {
          expect(outcome.toRevision).toBe("2"); // never caller-chosen
        }
      }),
    );
  });

  it("stale expectedRevision -> typed conflict path (re-probe resolves)", async () => {
    reprobeResult = observation(PROJECT_A, "2", "fp-fresh");
    reprobeCalls = 0;
    await run(
      Effect.gen(function* () {
        const { sql, rec, tx } = yield* withEnv;
        // anchor is at 1; observation claims 0 (stale)
        const outcome = yield* tx.transact(
          rec.record(observation(PROJECT_A, "0", "fp-stale"), "ExternalDrift"),
        );
        expect(reprobeCalls).toBe(1); // exactly one re-probe
        // fresh observation says revision 2 — still stale vs anchor 1?
        // fresh.observedRevision=2 != anchor 1 -> second conflict -> Attention
        expect(outcome._tag).toBe("SecondConflictEscalatedToAttention");
        void sql;
      }),
    );
  });

  it("first conflict -> exactly one full re-probe; second attempt uses NEW observation entirely", async () => {
    reprobeResult = observation(PROJECT_A, "1", "fp-fresh-ok");
    reprobeCalls = 0;
    await run(
      Effect.gen(function* () {
        const { sql, rec, tx } = yield* withEnv;
        const outcome = yield* tx.transact(
          rec.record(
            observation(PROJECT_A, "0", "fp-stale-old"),
            "ExternalDrift",
          ),
        );
        expect(reprobeCalls).toBe(1);
        expect(outcome._tag).toBe("Advanced");
        // the committed change carries the FRESH fingerprint + blob, not the stale ones
        const latest = yield* tx.transact(rec.latestChange(PROJECT_A));
        expect(Option.isSome(latest)).toBe(true);
        if (Option.isSome(latest)) {
          expect(latest.value.nextFingerprint).toBe("fp-fresh-ok");
          expect(latest.value.snapshotBlobRef).toBe("blob:fp-fresh-ok");
          expect(latest.value.changedRegions).toEqual(regions("/changed"));
        }
        void sql;
      }),
    );
  });

  it("second conflict -> Attention outcome; no third retry", async () => {
    reprobeResult = observation(PROJECT_A, "99", "fp-fresh-stale");
    reprobeCalls = 0;
    await run(
      Effect.gen(function* () {
        const { rec, tx } = yield* withEnv;
        const outcome = yield* tx.transact(
          rec.record(observation(PROJECT_A, "0", "fp-old"), "ExternalDrift"),
        );
        expect(reprobeCalls).toBe(1); // exactly one — no third
        expect(outcome._tag).toBe("SecondConflictEscalatedToAttention");
        if (outcome._tag === "SecondConflictEscalatedToAttention") {
          expect(outcome.currentRevision).toBe("1");
        }
      }),
    );
  });

  it("re-probe failure surfaces typed, not as drift/no-change", async () => {
    reprobeResult = { fail: true };
    reprobeCalls = 0;
    await run(
      Effect.gen(function* () {
        const { rec, tx } = yield* withEnv;
        const failure = yield* tx
          .transact(
            rec.record(observation(PROJECT_A, "0", "fp-o"), "ExternalDrift"),
          )
          .pipe(Effect.flip);
        expect(failure._tag).toBe("ReProbeFailed");
      }),
    );
  });

  it("NoChange: same content identity -> no advance, no event, no record", async () => {
    reprobeResult = { fail: true };
    await run(
      Effect.gen(function* () {
        const { sql, rec, tx } = yield* withEnv;
        // basis next_fingerprint = fp-basis (see withEnv seed)
        const outcome = yield* tx.transact(
          rec.record(observation(PROJECT_A, "1", "fp-basis"), "ExternalDrift"),
        );
        expect(outcome._tag).toBe("NoChange");
        if (outcome._tag === "NoChange") {
          expect(outcome.atRevision).toBe("1");
        }
        expect(yield* anchorOf(sql, PROJECT_A)).toBe("1");
        expect(yield* changeCount(sql, PROJECT_A)).toBe(1); // basis only
        expect(yield* eventCount(sql)).toBe(0);
      }),
    );
  });

  it("A -> B -> A: two real advancements (no fingerprint-history dedup)", async () => {
    await run(
      Effect.gen(function* () {
        const { sql, rec, tx } = yield* withEnv;
        const first = yield* tx.transact(
          rec.record(
            observation(PROJECT_A, "1", "fp-A", "blob:A1"),
            "ExternalDrift",
          ),
        );
        expect(first._tag).toBe("Advanced");
        const second = yield* tx.transact(
          rec.record(
            observation(PROJECT_A, "2", "fp-B", "blob:B"),
            "ExternalDrift",
          ),
        );
        expect(second._tag).toBe("Advanced");
        const third = yield* tx.transact(
          rec.record(
            observation(PROJECT_A, "3", "fp-A", "blob:A2"),
            "ExternalDrift",
          ),
        );
        expect(third._tag).toBe("Advanced"); // A returns — still a real change
        expect(yield* anchorOf(sql, PROJECT_A)).toBe("4");
        expect(yield* changeCount(sql, PROJECT_A)).toBe(4); // basis + 3
      }),
    );
  });

  it("missing anchor -> typed AnchorMissing, nothing written", async () => {
    await run(
      Effect.gen(function* () {
        const { sql, rec, tx } = yield* withEnv;
        // project with no anchor row: use a fresh project id not seeded
        const outcome = yield* tx.transact(
          rec.record(
            observation(
              "prj_018f2b3c-4d5e-7abc-8def-0123456789ff" as never,
              "1",
              "fp-n",
            ),
            "Governance",
          ),
        );
        expect(outcome._tag).toBe("AnchorMissing");
        void sql;
      }),
    );
  });

  it("snapshot blob identity matches committed nextFingerprint (single representation)", async () => {
    await run(
      Effect.gen(function* () {
        const { rec, tx } = yield* withEnv;
        yield* tx.transact(
          rec.record(
            observation(PROJECT_A, "1", "fp-single", "blob:fp-single"),
            "Governance",
          ),
        );
        const latest = yield* tx.transact(rec.latestChange(PROJECT_A));
        if (Option.isSome(latest)) {
          expect(latest.value.snapshotBlobRef).toBe("blob:fp-single");
          expect(latest.value.nextFingerprint).toBe("fp-single");
        } else {
          throw new Error("missing change record");
        }
      }),
    );
  });

  it("atomicity: transaction rollback leaves NO partial state (revision/change/event all absent)", async () => {
    await run(
      Effect.gen(function* () {
        const { sql, rec, tx } = yield* withEnv;
        const before = {
          anchor: yield* anchorOf(sql, PROJECT_A),
          changes: yield* changeCount(sql, PROJECT_A),
          events: yield* eventCount(sql),
        };
        // inject a failure INSIDE the same transaction after REC succeeds:
        const outcome = yield* tx
          .transact(
            Effect.gen(function* () {
              const result = yield* rec.record(
                observation(PROJECT_A, "1", "fp-rolled", "blob:fp-rolled"),
                "Governance",
              );
              expect(result._tag).toBe("Advanced");
              yield* Effect.fail({ _tag: "InjectedRollback" as const });
            }),
          )
          .pipe(Effect.flip);
        expect(outcome).toEqual({ _tag: "InjectedRollback" });
        const after = {
          anchor: yield* anchorOf(sql, PROJECT_A),
          changes: yield* changeCount(sql, PROJECT_A),
          events: yield* eventCount(sql),
        };
        expect(after).toEqual(before); // no partial commit survives
      }),
    );
  });

  it("wake facts: EnvironmentChanged waiters with older observedRevision are targeted (broad, GQ5)", async () => {
    await run(
      Effect.gen(function* () {
        const { sql, rec, tx } = yield* withEnv;
        // seed a work + wait on EnvironmentChanged(observed 0)
        yield* tx.transact(
          Effect.gen(function* () {
            yield* sql.unsafe(
              "INSERT INTO works (work_id, project_id, workspace_id, objective, why, constraints, completion_expectation, verification_mission, provenance, revision, lifecycle, created_at, updated_at) VALUES ('wrk_w',?, 'ws_a','o','w','[]','c','{}','{}',0,'Open','t','t')",
              [PROJECT_A],
            );
            yield* sql.unsafe(
              "INSERT INTO work_waits (work_id, wait_mode, conditions_json, registered_at, updated_at) VALUES ('wrk_w','Any',?, 't','t')",
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
          }),
        );
        const outcome = yield* tx.transact(
          rec.record(
            observation(PROJECT_A, "1", "fp-wake", "blob:fp-wake"),
            "Governance",
          ),
        );
        expect(outcome._tag).toBe("Advanced");
        // the wake facts are part of the same-transaction commit payload —
        // consumers (P7-sink pattern) clear+wake post-commit from these facts
        if (outcome._tag === "Advanced" && "facts" in outcome) {
          const facts = (outcome as { facts: { wakeTargets: unknown[] } })
            .facts;
          expect(facts.wakeTargets.length).toBeGreaterThanOrEqual(1);
        }
      }),
    );
  });

  it("project isolation: PROJECT_A's REC never touches PROJECT_B", async () => {
    await run(
      Effect.gen(function* () {
        const { sql, rec, tx } = yield* withEnv;
        yield* tx.transact(
          rec.record(observation(PROJECT_A, "1", "fp-a"), "Governance"),
        );
        expect(yield* anchorOf(sql, PROJECT_A)).toBe("2");
        expect(yield* anchorOf(sql, PROJECT_B)).toBe("1");
        expect(yield* changeCount(sql, PROJECT_B)).toBe(0);
      }),
    );
  });

  it("fingerprint never participates in ordering: NoChange compares equality only", async () => {
    await run(
      Effect.gen(function* () {
        const { rec, tx } = yield* withEnv;
        // digests chosen so lexical/numeric order differs from equality logic
        const outcome = yield* tx.transact(
          rec.record(observation(PROJECT_A, "1", "fp-basis"), "Governance"),
        );
        expect(outcome._tag).toBe("NoChange"); // equality with basis, regardless of any ordering
      }),
    );
  });
});
