import { Effect, Layer, Option } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { describe, expect, it } from "vitest";
import {
  ClockLive,
  DeliverableRepositoryLive,
  DomainEventJournalLive,
  EnvironmentRevisionStoreLive,
  EvidenceRepositoryLive,
  IdGeneratorLive,
  layer,
  P11_MIGRATIONS,
  RecordEnvironmentChangeLive,
  runMigrations,
  TransactionPortLive,
  VerificationRepositoryLive,
  WorkRepositoryLive,
  WorkWaitStoreLive,
} from "../adapters/persistence-sqlite/src/index.js";
import {
  type ConcludeVerificationPayload,
  makeConcludeVerificationHandler,
  makeRecordVerificationEvidenceHandler,
  type RecordVerificationEvidencePayload,
} from "../packages/application/src/commands/conclude-verification.js";
import {
  makeStartVerificationHandler,
  type StartVerificationPayload,
  type StartVerificationResult,
} from "../packages/application/src/commands/start-verification.js";
import {
  type EnvironmentChangeFact,
  verificationFreshness,
} from "../packages/application/src/environment-staleness.js";
import type {
  CommandOutcome,
  CommandResult,
  GatewayEnvelope,
} from "../packages/application/src/index.js";
import {
  Actor,
  type CanonicalResourceRegion,
  CommandId,
  EnvironmentFingerprint,
  EvidenceId,
  ExecutionId,
  Principal,
  type ProjectId,
  parse,
  VerificationId,
  type VerificationMission,
  WorkId,
  WorkRevision,
} from "../packages/domain/dist/index.js";
import {
  DeliverableRepository,
  type DeliverableRepositoryError,
  type EnvironmentObservation,
  EnvironmentReProbePort,
  EnvironmentRevisionStore,
  EvidenceRepository,
  RecordEnvironmentChange,
  TransactionPort,
  VerificationRepository,
  WorkRepository,
} from "../packages/ports/src/index.js";

// P11 `13` (GQ4): P8 verdict binding consumed under the REAL (moving)
// anchor counter. The fixture wires the P8 command handlers onto the same
// sqlite connection as EnvironmentRevisionStore + RecordEnvironmentChange,
// so StartVerification binds the counter REC actually advances — no
// `record(projectId, "env-1")` raw writes anywhere (P11-002 is the sole
// advancement authority).

const PROJECT =
  "prj_018f2b3c-4d5e-7abc-8def-0123456789d1" as never as ProjectId;
const WS = "ws_vc-root";
const SES = "ses_vc-root";
const WORK_1 = parse(WorkId)("wrk_00000000-0000-7000-8000-000000000001");
const WORK_2 = parse(WorkId)("wrk_00000000-0000-7000-8000-000000000002");
const EXE_1 = parse(ExecutionId)("exe_00000000-0000-7000-8000-000000000001");
const actor = parse(Actor)("user:gov");
const verifierPrincipal = parse(Principal)("agent:verifier");
const VER = (suffix: string) =>
  parse(VerificationId)(`ver_00000000-0000-7000-8000-00000000${suffix}`);
const CMD = (suffix: string) =>
  parse(CommandId)(`cmd_018f2b3c-4d5e-7abc-8def-${suffix}`);
const EVD = (suffix: string) =>
  parse(EvidenceId)(`evd_00000000-0000-7000-8000-00000000${suffix}`);

const externalContext = {
  _tag: "External",
  principal: parse(Principal)("user:gov"),
} as const;

const executionContext = {
  _tag: "ExecutionOrigin",
  principal: verifierPrincipal,
  executionId: EXE_1,
  fencingGeneration: 0 as never,
} as const;

// No re-probe is ever expected here (observations always match the anchor);
// a failing seam makes an unexpected conflict loud instead of silent.
const reprobeUnavailable = Layer.succeed(EnvironmentReProbePort, {
  reprobe: () =>
    Effect.fail({
      _tag: "ReProbeFailed" as const,
      cause: "re-probe not wired in p11-verdict-consumer fixture",
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
    Layer.mergeAll(journal, waits, base, IdGeneratorLive, reprobeUnavailable),
  );
  return Layer.mergeAll(
    base,
    tx,
    journal,
    waits,
    rec,
    Layer.provide(EnvironmentRevisionStoreLive, infra),
    Layer.provide(WorkRepositoryLive, infra),
    Layer.provide(VerificationRepositoryLive, base),
    Layer.provide(EvidenceRepositoryLive, base),
    Layer.provide(DeliverableRepositoryLive, base),
  );
};

type AppEnv =
  | SqlClient
  | TransactionPort
  | RecordEnvironmentChange
  | EnvironmentRevisionStore
  | WorkRepository
  | VerificationRepository
  | EvidenceRepository
  | DeliverableRepository;

const run = <A, E>(program: Effect.Effect<A, E, AppEnv>): Promise<A> =>
  Effect.runPromise(Effect.scoped(Effect.provide(program, appLayer())));

// FK-safe order: sessions -> projects -> workspaces -> works
// (p11-record-change withEnv pattern).
const seed = Effect.gen(function* () {
  yield* runMigrations(P11_MIGRATIONS);
  const sql = yield* SqlClient;
  const tx = yield* TransactionPort;
  yield* tx.transact(
    Effect.gen(function* () {
      yield* sql.unsafe(
        "INSERT INTO sessions (session_id, binding_kind, workspace_id, execution_id, context_epoch, created_at) VALUES (?,'WorkspacePrimary',?,NULL,0,'t')",
        [SES, WS],
      );
      yield* sql.unsafe(
        "INSERT INTO projects (project_id, name, root_workspace_id, project_policy, project_policy_revision, default_configuration, environment_ref, lifecycle, revision, created_at, updated_at) VALUES (?,'p',?,'{}',0,'{}','local','Open',0,'t','t')",
        [PROJECT, WS],
      );
      yield* sql.unsafe(
        "INSERT INTO workspaces (workspace_id, project_id, parent_workspace_id, name, responsibility_definition, responsibility_revision, resource_boundary, resource_boundary_revision, agent_binding, primary_session_id, workspace_policy, workspace_policy_revision, revision, lifecycle, created_at, updated_at) VALUES (?,?,NULL,'root','{}',1,'{}',1,'{}',?,'{}',0,0,'Active','t','t')",
        [WS, PROJECT, SES],
      );
      const work = (id: WorkId) =>
        sql.unsafe(
          "INSERT INTO works (work_id, project_id, workspace_id, objective, why, constraints, completion_expectation, verification_mission, provenance, revision, lifecycle, created_at, updated_at) VALUES (?,?,?,'o','w','[]','c','{}','{}',0,'Open','t','t')",
          [id, PROJECT, WS],
        );
      yield* work(WORK_1);
      yield* work(WORK_2);
    }),
  );
});

const missionOf = (
  overrides: Partial<VerificationMission> = {},
): VerificationMission => ({
  goal: "verify the outcome",
  criteria: [
    { criterionId: "c1", requirement: "tests pass", required: true },
    { criterionId: "c2", requirement: "lint clean", required: false },
  ],
  riskRequirements: [],
  ...overrides,
});

const makeHandlers = Effect.gen(function* () {
  const works = yield* WorkRepository;
  const verifications = yield* VerificationRepository;
  const evidence = yield* EvidenceRepository;
  const deliverableService = yield* DeliverableRepository;
  const environmentRevisions = yield* EnvironmentRevisionStore;
  const sql = yield* SqlClient;
  return {
    start: makeStartVerificationHandler({
      works,
      verifications,
      environmentRevisions,
      deliverables: {
        ...deliverableService,
        listArtifacts: (deliverableId) =>
          sql
            .unsafe<{ readonly role: string; readonly artifact_id: string }>(
              "SELECT role, artifact_id FROM deliverable_artifacts WHERE deliverable_id = ?",
              [deliverableId],
            )
            .pipe(
              Effect.map((rows) =>
                rows.map((row) => ({
                  role: row.role,
                  artifactId: row.artifact_id as never,
                })),
              ),
              Effect.mapError(
                (cause) =>
                  ({
                    _tag: "DeliverableRepositoryFailure",
                    cause,
                  }) as DeliverableRepositoryError,
              ),
            ),
      },
    }),
    recordEvidence: makeRecordVerificationEvidenceHandler({
      verifications,
      evidence,
    }),
    conclude: makeConcludeVerificationHandler({
      verifications,
      evidence,
      works,
    }),
  };
});

const payloadOf = (
  overrides: Partial<StartVerificationPayload> = {},
): StartVerificationPayload => ({
  verificationId: VER("0001"),
  workId: WORK_1,
  observedWorkRevision: parse(WorkRevision)(0),
  missionSnapshot: missionOf(),
  verifierExecutionId: EXE_1,
  executableMission: false,
  ...overrides,
});

const envelopeOf = <P>(
  commandType: string,
  commandId: CommandId,
  payload: P,
): GatewayEnvelope<P> => ({
  commandType,
  commandId,
  projectId: PROJECT,
  actor,
  issuedAt: "t",
  payload,
});

type StartOutcome = CommandResult<CommandOutcome<StartVerificationResult>>;

const expectRejected = (outcome: StartOutcome, tag: string) => {
  expect(outcome.ok).toBe(false);
  if (!outcome.ok) {
    expect(outcome.error._tag).toBe(tag);
  }
};

const region = (
  path: string,
  resourceSpaceId = "space-fs",
): CanonicalResourceRegion => ({
  resourceSpaceId,
  normalizedRegion: { kind: "FileTree", path },
});

// The mission's resolved canonical regions (P11-006 narrow input) —
// what the executable verification actually reads.
const boundRegions: ReadonlyArray<CanonicalResourceRegion> = [
  region("/pkg-a/module-1"),
];

const observation = (
  observedRevision: string,
  digest: string,
  changedRegions: ReadonlyArray<CanonicalResourceRegion>,
): EnvironmentObservation => ({
  projectId: PROJECT,
  observedRevision,
  fingerprint: EnvironmentFingerprint.of(digest),
  snapshotBlobRef: `blob:${digest}`,
  changedRegions,
});

const changeFacts = (sql: SqlClient) =>
  sql
    .unsafe<{ to_revision: string; changed_regions_json: string }>(
      "SELECT to_revision, changed_regions_json FROM environment_changes WHERE project_id = ? ORDER BY to_revision",
      [PROJECT],
    )
    .pipe(
      Effect.map(
        (rows): ReadonlyArray<EnvironmentChangeFact> =>
          rows.map((row) => ({
            toRevision: row.to_revision,
            changedRegions: JSON.parse(
              row.changed_regions_json,
            ) as CanonicalResourceRegion[],
          })),
      ),
    );

const evidencePayload = (
  verificationId: VerificationId,
  evidenceId: EvidenceId,
  criterionId: string,
  observedRevision: string,
): RecordVerificationEvidencePayload => ({
  verificationId,
  evidence: {
    evidenceId,
    criterionId,
    kind: "ToolObservation",
    observedEnvironmentRevision: observedRevision,
    recordedAt: "t1",
  },
});

const concludePassPayload = (
  verificationId: VerificationId,
  evidenceIds: ReadonlyArray<EvidenceId>,
): ConcludeVerificationPayload => ({
  verificationId,
  verdict: "Pass",
  criteriaResults: [
    {
      criterionId: "c1",
      requirement: "tests pass",
      required: true,
      verdict: "Pass",
      evidenceRefs: [evidenceIds[0]!],
    },
    {
      criterionId: "c2",
      requirement: "lint clean",
      required: false,
      verdict: "Pass",
      evidenceRefs: [evidenceIds[1]!],
    },
  ],
  summaryRef: "blob:summary",
});

const concludeOrphanedPayload = (
  verificationId: VerificationId,
): ConcludeVerificationPayload => ({
  verificationId,
  verdict: "Unknown",
  conclusionReason: "Orphaned",
  criteriaResults: [],
  summaryRef: "orphan",
});

/** Full concluded-Pass lifecycle at the current counter: start (bind) →
 * evidence (observed = bound revision) → conclude. The caller asserts via
 * the repositories. */
const concludePassAtCurrentRevision = (
  verificationId: VerificationId,
  startCommandId: CommandId,
  concludeCommandId: CommandId,
  evidenceIds: ReadonlyArray<EvidenceId>,
  evidenceCommandBase: string,
) =>
  Effect.gen(function* () {
    const tx = yield* TransactionPort;
    const handlers = yield* makeHandlers;
    const store = yield* EnvironmentRevisionStore;
    const current = yield* tx.transact(store.current(PROJECT));
    const bound = Option.getOrThrow(current);
    const started = yield* tx.transact(
      handlers.start.execute(
        envelopeOf(
          "StartVerification",
          startCommandId,
          payloadOf({ verificationId, executableMission: true }),
        ),
        externalContext,
      ),
    );
    expect(started.ok).toBe(true);
    let index = 0;
    for (const criterionId of ["c1", "c2"] as const) {
      const outcome = yield* tx.transact(
        handlers.recordEvidence.execute(
          envelopeOf(
            "RecordVerificationEvidence",
            CMD(`${evidenceCommandBase}${index}`),
            evidencePayload(
              verificationId,
              evidenceIds[index]!,
              criterionId,
              bound,
            ),
          ),
          executionContext,
        ),
      );
      expect(outcome.ok).toBe(true);
      index += 1;
    }
    const concluded = yield* tx.transact(
      handlers.conclude.execute(
        envelopeOf(
          "ConcludeVerification",
          concludeCommandId,
          concludePassPayload(verificationId, evidenceIds),
        ),
        externalContext,
      ),
    );
    expect(concluded.ok).toBe(true);
  });

describe("p11-verdict-consumer (P11-013: P8 binding under the real moving revision)", () => {
  it("scenario 1 — executable mission binds the lazy-init anchor '1' exactly (P8 `01` §1 fields frozen)", async () => {
    await run(
      Effect.gen(function* () {
        yield* seed;
        const tx = yield* TransactionPort;
        const handlers = yield* makeHandlers;
        const store = yield* EnvironmentRevisionStore;
        yield* tx.transact(store.lazyInitAnchor(PROJECT));
        expect(yield* tx.transact(store.current(PROJECT))).toEqual(
          Option.some("1"),
        );

        const outcome = yield* tx.transact(
          handlers.start.execute(
            envelopeOf(
              "StartVerification",
              CMD("0123456789d1"),
              payloadOf({
                verificationId: VER("0001"),
                executableMission: true,
              }),
            ),
            externalContext,
          ),
        );
        expect(outcome.ok).toBe(true);
        if (outcome.ok) {
          expect(outcome.value.result).toEqual({
            verificationId: VER("0001"),
            workId: WORK_1,
            targetWorkRevision: 0,
            ownerWorkspaceId: WS,
            state: "Open",
            verifierExecutionId: EXE_1,
          });
          expect(outcome.value.events).toHaveLength(1);
          const event = outcome.value.events[0]!;
          expect(event.eventType).toBe("VerificationStarted");
          expect(event.aggregateRef).toBe(VER("0001"));
          expect(event.payload).toEqual({
            verificationId: VER("0001"),
            workId: WORK_1,
            targetWorkRevision: 0,
            missionDigest: "verify the outcome [criteria=2 required=1]",
          });
        }

        const repos = yield* VerificationRepository;
        const stored = yield* tx.transact(repos.findById(VER("0001")));
        expect(Option.isSome(stored)).toBe(true);
        if (Option.isSome(stored)) {
          expect(stored.value.state).toEqual({ status: "Open" });
          expect(stored.value.targetEnvironmentRevision).toBe("1");
          expect(stored.value.environmentSnapshotRef).toBeNull();
          expect(stored.value.missionSnapshot).toEqual(missionOf());
          expect(stored.value.verificationExecutionIds).toEqual([EXE_1]);
          expect(stored.value.targetDeliverables).toEqual([]);
          expect(stored.value.targetArtifactVersions).toEqual([]);
        }

        // Consumption never advances the counter (non-mutating read).
        expect(yield* tx.transact(store.current(PROJECT))).toEqual(
          Option.some("1"),
        );
        const evidence = yield* EvidenceRepository;
        expect(
          yield* tx.transact(evidence.listByVerification(VER("0001"))),
        ).toEqual([]);
      }),
    );
  });

  it("scenario 2 — REC advances the real counter 1→2: different revision, different P8 binding", async () => {
    await run(
      Effect.gen(function* () {
        yield* seed;
        const tx = yield* TransactionPort;
        const handlers = yield* makeHandlers;
        const store = yield* EnvironmentRevisionStore;
        const rec = yield* RecordEnvironmentChange;
        yield* tx.transact(store.lazyInitAnchor(PROJECT));

        const first = yield* tx.transact(
          handlers.start.execute(
            envelopeOf(
              "StartVerification",
              CMD("0123456789d2"),
              payloadOf({
                verificationId: VER("0002"),
                executableMission: true,
              }),
            ),
            externalContext,
          ),
        );
        expect(first.ok).toBe(true);

        // Real advancement through the observation flow (p11-record-change
        // path) — the sole advancement authority.
        const advanced = yield* tx.transact(
          rec.record(
            observation("1", "fp-move-1", [region("/pkg-q")]),
            "ExternalDrift",
          ),
        );
        expect(advanced._tag).toBe("Advanced");
        if (advanced._tag === "Advanced") {
          expect(advanced.fromRevision).toBe("1");
          expect(advanced.toRevision).toBe("2");
        }
        expect(yield* tx.transact(store.current(PROJECT))).toEqual(
          Option.some("2"),
        );

        const second = yield* tx.transact(
          handlers.start.execute(
            envelopeOf(
              "StartVerification",
              CMD("0123456789d3"),
              payloadOf({
                verificationId: VER("0003"),
                workId: WORK_2,
                executableMission: true,
              }),
            ),
            externalContext,
          ),
        );
        expect(second.ok).toBe(true);
        if (second.ok) {
          expect(second.value.result.targetWorkRevision).toBe(0);
          expect(second.value.result.state).toBe("Open");
        }

        const repos = yield* VerificationRepository;
        const v1 = yield* tx.transact(repos.findById(VER("0002")));
        const v2 = yield* tx.transact(repos.findById(VER("0003")));
        expect(Option.isSome(v1)).toBe(true);
        expect(Option.isSome(v2)).toBe(true);
        if (Option.isSome(v1) && Option.isSome(v2)) {
          // P8 binding is frozen at start time — the moved counter never
          // retargets an existing verification, and the new one binds "2".
          expect(v1.value.targetEnvironmentRevision).toBe("1");
          expect(v2.value.targetEnvironmentRevision).toBe("2");
          expect(v1.value.state).toEqual({ status: "Open" });
          expect(v2.value.state).toEqual({ status: "Open" });
        }
      }),
    );
  });

  it("scenario 3a — concluded Pass bound '1' + overlapping change to '2' → STALE overlay; verdict + evidence observed unchanged; re-Start rides the new revision", async () => {
    await run(
      Effect.gen(function* () {
        yield* seed;
        const tx = yield* TransactionPort;
        const store = yield* EnvironmentRevisionStore;
        const rec = yield* RecordEnvironmentChange;
        const sql = yield* SqlClient;
        yield* tx.transact(store.lazyInitAnchor(PROJECT));

        yield* concludePassAtCurrentRevision(
          VER("0011"),
          CMD("0123456789e0"),
          CMD("0123456789e1"),
          [EVD("0011"), EVD("0012")],
          "0123456789f",
        );

        // Post-conclusion change overlapping the bound regions.
        const advanced = yield* tx.transact(
          rec.record(
            observation("1", "fp-stale-1", [region("/pkg-a")]),
            "ExternalDrift",
          ),
        );
        expect(advanced._tag).toBe("Advanced");
        if (advanced._tag === "Advanced") {
          expect(advanced.toRevision).toBe("2");
        }

        const repos = yield* VerificationRepository;
        const stored = yield* tx.transact(repos.findById(VER("0011")));
        expect(Option.isSome(stored)).toBe(true);
        if (Option.isSome(stored)) {
          // Freshness input is the STORED P8 binding — not a test constant.
          expect(stored.value.targetEnvironmentRevision).toBe("1");
          expect(
            verificationFreshness(
              {
                targetEnvironmentRevision:
                  stored.value.targetEnvironmentRevision,
                boundRegions,
              },
              yield* changeFacts(sql),
            ),
          ).toBe("STALE");
          // The overlay never mutates the verdict (CI-5).
          expect(stored.value.state).toEqual({
            status: "Concluded",
            verdict: "Pass",
          });
        }

        // EvidenceRecord.observedEnvironmentRevision is frozen at record
        // time — the advanced counter rewrites nothing.
        const evidence = yield* EvidenceRepository;
        expect(
          yield* tx.transact(evidence.listByVerification(VER("0011"))),
        ).toEqual([
          {
            evidenceId: EVD("0011"),
            verificationId: VER("0011"),
            criterionId: "c1",
            kind: "ToolObservation",
            artifactRef: null,
            observedEnvironmentRevision: "1",
            recordedByExecutionId: EXE_1,
            recordedAt: "t1",
          },
          {
            evidenceId: EVD("0012"),
            verificationId: VER("0011"),
            criterionId: "c2",
            kind: "ToolObservation",
            artifactRef: null,
            observedEnvironmentRevision: "1",
            recordedByExecutionId: EXE_1,
            recordedAt: "t1",
          },
        ]);

        // Re-verify is a NEW StartVerification identity (P8 `13` §2): old
        // Concluded → allowed; the new verification binds the moved
        // counter "2", never the stale "1".
        const handlers = yield* makeHandlers;
        const reStart = yield* tx.transact(
          handlers.start.execute(
            envelopeOf(
              "StartVerification",
              CMD("0123456789e2"),
              payloadOf({
                verificationId: VER("0013"),
                executableMission: true,
              }),
            ),
            externalContext,
          ),
        );
        expect(reStart.ok).toBe(true);
        const reStored = yield* tx.transact(repos.findById(VER("0013")));
        expect(Option.isSome(reStored)).toBe(true);
        if (Option.isSome(reStored)) {
          expect(reStored.value.state).toEqual({ status: "Open" });
          expect(reStored.value.targetEnvironmentRevision).toBe("2");
        }
      }),
    );
  });

  it("scenario 3b — concluded Pass bound '1' + non-overlapping changes → CURRENT (narrow rule)", async () => {
    await run(
      Effect.gen(function* () {
        yield* seed;
        const tx = yield* TransactionPort;
        const store = yield* EnvironmentRevisionStore;
        const rec = yield* RecordEnvironmentChange;
        const sql = yield* SqlClient;
        yield* tx.transact(store.lazyInitAnchor(PROJECT));

        yield* concludePassAtCurrentRevision(
          VER("0021"),
          CMD("0000000000b0"),
          CMD("0000000000b1"),
          [EVD("0021"), EVD("0022")],
          "0000000000b",
        );

        // Advance to "2" with regions DISJOINT from the bound regions
        // (different path), then to "3" on the same path but a different
        // canonical space — neither overlaps.
        const first = yield* tx.transact(
          rec.record(
            observation("1", "fp-clean-1", [region("/pkg-z")]),
            "ExternalDrift",
          ),
        );
        expect(first._tag).toBe("Advanced");
        const second = yield* tx.transact(
          rec.record(
            observation("2", "fp-clean-2", [
              region("/pkg-a/module-1", "space-git"),
            ]),
            "Governance",
          ),
        );
        expect(second._tag).toBe("Advanced");
        expect(yield* tx.transact(store.current(PROJECT))).toEqual(
          Option.some("3"),
        );

        const repos = yield* VerificationRepository;
        const stored = yield* tx.transact(repos.findById(VER("0021")));
        expect(Option.isSome(stored)).toBe(true);
        if (Option.isSome(stored)) {
          expect(stored.value.targetEnvironmentRevision).toBe("1");
          const facts = yield* changeFacts(sql);
          expect(facts.map((fact) => fact.toRevision)).toEqual(["2", "3"]);
          expect(
            verificationFreshness(
              {
                targetEnvironmentRevision:
                  stored.value.targetEnvironmentRevision,
                boundRegions,
              },
              facts,
            ),
          ).toBe("CURRENT");
          expect(stored.value.state).toEqual({
            status: "Concluded",
            verdict: "Pass",
          });
        }

        // Evidence observed stays "1" — non-overlapping or not, recorded
        // facts never move.
        const evidence = yield* EvidenceRepository;
        const rows = yield* tx.transact(
          evidence.listByVerification(VER("0021")),
        );
        expect(rows).toHaveLength(2);
        for (const row of rows) {
          expect(row.observedEnvironmentRevision).toBe("1");
          expect(row.recordedByExecutionId).toBe(EXE_1);
        }
      }),
    );
  });

  it("scenario 3c — one-Open: Open blocks re-Start; Unknown(Orphaned) is the explicit path that re-enables it", async () => {
    await run(
      Effect.gen(function* () {
        yield* seed;
        const tx = yield* TransactionPort;
        const handlers = yield* makeHandlers;
        const store = yield* EnvironmentRevisionStore;
        const rec = yield* RecordEnvironmentChange;
        yield* tx.transact(store.lazyInitAnchor(PROJECT));

        const first = yield* tx.transact(
          handlers.start.execute(
            envelopeOf(
              "StartVerification",
              CMD("0000000000c1"),
              payloadOf({
                verificationId: VER("0031"),
                executableMission: true,
              }),
            ),
            externalContext,
          ),
        );
        expect(first.ok).toBe(true);

        // one-Open per (workId, targetWorkRevision): the Open row blocks.
        const blocked = yield* tx.transact(
          handlers.start.execute(
            envelopeOf(
              "StartVerification",
              CMD("0000000000c2"),
              payloadOf({
                verificationId: VER("0032"),
                executableMission: true,
              }),
            ),
            externalContext,
          ),
        );
        expectRejected(blocked, "VerificationAlreadyOpen");

        // The counter keeps moving under an Open verification (REC is not
        // blocked by verification state).
        const advanced = yield* tx.transact(
          rec.record(
            observation("1", "fp-orphan-1", [region("/pkg-a")]),
            "Governance",
          ),
        );
        expect(advanced._tag).toBe("Advanced");
        if (advanced._tag === "Advanced") {
          expect(advanced.toRevision).toBe("2");
        }

        // Unknown(Orphaned) — the explicit governance conclusion (G5):
        // waives evidence, concludes the Open row.
        const orphaned = yield* tx.transact(
          handlers.conclude.execute(
            envelopeOf(
              "ConcludeVerification",
              CMD("0000000000c3"),
              concludeOrphanedPayload(VER("0031")),
            ),
            externalContext,
          ),
        );
        expect(orphaned.ok).toBe(true);
        if (orphaned.ok) {
          expect(orphaned.value.result.verdict).toBe("Unknown");
          expect(orphaned.value.result.conclusionReason).toBe("Orphaned");
        }

        const repos = yield* VerificationRepository;
        const storedOld = yield* tx.transact(repos.findById(VER("0031")));
        expect(Option.isSome(storedOld)).toBe(true);
        if (Option.isSome(storedOld)) {
          expect(storedOld.value.state).toEqual({
            status: "Concluded",
            verdict: "Unknown",
            conclusionReason: "Orphaned",
          });
        }

        // Re-Start now succeeds and binds the current counter "2".
        const reStart = yield* tx.transact(
          handlers.start.execute(
            envelopeOf(
              "StartVerification",
              CMD("0000000000c4"),
              payloadOf({
                verificationId: VER("0032"),
                executableMission: true,
              }),
            ),
            externalContext,
          ),
        );
        expect(reStart.ok).toBe(true);
        if (reStart.ok) {
          expect(reStart.value.result.state).toBe("Open");
        }
        const storedNew = yield* tx.transact(repos.findById(VER("0032")));
        expect(Option.isSome(storedNew)).toBe(true);
        if (Option.isSome(storedNew)) {
          expect(storedNew.value.state).toEqual({ status: "Open" });
          expect(storedNew.value.targetEnvironmentRevision).toBe("2");
        }
      }),
    );
  });

  it("scenario 4 — static mission (targetEnvironmentRevision null) is forever CURRENT", async () => {
    await run(
      Effect.gen(function* () {
        yield* seed;
        const tx = yield* TransactionPort;
        const handlers = yield* makeHandlers;
        const store = yield* EnvironmentRevisionStore;
        const rec = yield* RecordEnvironmentChange;
        const sql = yield* SqlClient;

        // No anchor exists and none is needed — a purely static review
        // binds no environment revision (P8 B-7).
        const outcome = yield* tx.transact(
          handlers.start.execute(
            envelopeOf(
              "StartVerification",
              CMD("0000000000d1"),
              payloadOf({ verificationId: VER("0041") }),
            ),
            externalContext,
          ),
        );
        expect(outcome.ok).toBe(true);
        if (outcome.ok) {
          expect(outcome.value.result).toEqual({
            verificationId: VER("0041"),
            workId: WORK_1,
            targetWorkRevision: 0,
            ownerWorkspaceId: WS,
            state: "Open",
            verifierExecutionId: EXE_1,
          });
        }
        const repos = yield* VerificationRepository;
        const stored = yield* tx.transact(repos.findById(VER("0041")));
        expect(Option.isSome(stored)).toBe(true);
        if (Option.isSome(stored)) {
          expect(stored.value.targetEnvironmentRevision).toBeNull();
        }

        // The environment moves — even overlapping changes cannot drift a
        // null bound revision.
        yield* tx.transact(store.lazyInitAnchor(PROJECT));
        const advanced = yield* tx.transact(
          rec.record(
            observation("1", "fp-static-1", [region("/pkg-a")]),
            "ExternalDrift",
          ),
        );
        expect(advanced._tag).toBe("Advanced");
        const second = yield* tx.transact(
          rec.record(
            observation("2", "fp-static-2", [region("/pkg-a/module-1")]),
            "Governance",
          ),
        );
        expect(second._tag).toBe("Advanced");
        expect(yield* tx.transact(store.current(PROJECT))).toEqual(
          Option.some("3"),
        );

        const facts = yield* changeFacts(sql);
        expect(facts.map((fact) => fact.toRevision)).toEqual(["2", "3"]);
        if (Option.isSome(stored)) {
          expect(
            verificationFreshness(
              {
                targetEnvironmentRevision:
                  stored.value.targetEnvironmentRevision,
                boundRegions,
              },
              facts,
            ),
          ).toBe("CURRENT");
          // Unresolvable regions change nothing for a static review.
          expect(
            verificationFreshness(
              {
                targetEnvironmentRevision:
                  stored.value.targetEnvironmentRevision,
              },
              facts,
            ),
          ).toBe("CURRENT");
        }
      }),
    );
  });
});
