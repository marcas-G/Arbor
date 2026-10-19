import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AttentionProjectionStore as AttentionProjectionStorePort,
  DomainEventJournal,
  SandboxProviderUnavailableAttentionQueue as SandboxQueuePort,
  SandboxProviderUnavailableStore as SandboxStorePort,
  TransactionPort,
} from "@arbor/ports";
import { Effect, Layer } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { describe, expect, it } from "vitest";
import {
  AttentionProjectionStoreLive,
  DomainEventJournalLive,
  IdGeneratorLive,
  layer,
  makeProjectAttentionProjectionStore,
  P50_SANDBOX_PROVIDER_UNAVAILABLE_FACT_MIGRATION,
  SandboxProviderUnavailableAttentionQueueLive,
  SandboxProviderUnavailableStoreLive,
  splitStatements,
  TransactionPortLive,
} from "../src/index.js";

const projectId = "prj_018f2b3c-4d5e-7abc-8def-0123456789a1" as never;
const workspaceId = "ws_018f2b3c-4d5e-7abc-8def-0123456789a1" as never;
const executionId = "exe_018f2b3c-4d5e-7abc-8def-0123456789a1" as never;
const workspaceId2 = "ws_018f2b3c-4d5e-7abc-8def-0123456789a2" as never;
const executionId2 = "exe_018f2b3c-4d5e-7abc-8def-0123456789a2" as never;
const workerId = "worker-p50";
const workerIncarnationId = "inc-p50";
const now = "2026-10-19T10:00:00.000Z";
const episodeBinding = {
  _tag: "WorkEpisode" as const,
  workId: "wrk_018f2b3c-4d5e-7abc-8def-0123456789a1" as never,
  targetWorkRevision: 1 as never,
};
const episodeJson = JSON.stringify(episodeBinding);
const episodeBinding2 = {
  _tag: "WorkEpisode" as const,
  workId: "wrk_018f2b3c-4d5e-7abc-8def-0123456789a2" as never,
  targetWorkRevision: 1 as never,
};
const episodeJson2 = JSON.stringify(episodeBinding2);
const policyDigest = "a".repeat(64);

const setupSql = `
CREATE TABLE executions (
  execution_id TEXT NOT NULL, project_id TEXT NOT NULL, workspace_id TEXT NOT NULL,
  settled_at TEXT, stop_requested_at TEXT,
  UNIQUE(execution_id, project_id, workspace_id)
);
CREATE TABLE execution_leases (
  execution_id TEXT PRIMARY KEY, worker_id TEXT NOT NULL,
  worker_incarnation_id TEXT NOT NULL, generation INTEGER NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE TABLE agent_execution_state (
  execution_id TEXT PRIMARY KEY, episode_json TEXT NOT NULL
);
CREATE TABLE sandbox_policy_decisions (
  project_id TEXT NOT NULL, workspace_id TEXT NOT NULL, execution_id TEXT NOT NULL,
  episode_binding_json TEXT NOT NULL, policy_revision INTEGER NOT NULL,
  policy_digest TEXT NOT NULL, profile_id TEXT NOT NULL, provider_id TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  PRIMARY KEY(project_id, workspace_id, execution_id, episode_binding_json, policy_revision),
  UNIQUE(execution_id, policy_revision)
);
CREATE TABLE project_event_sequences (project_id TEXT PRIMARY KEY, last_sequence INTEGER NOT NULL);
CREATE TABLE domain_events (
  event_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, sequence INTEGER NOT NULL,
  event_type TEXT NOT NULL, event_version INTEGER NOT NULL, occurred_at TEXT NOT NULL,
  aggregate_ref TEXT NOT NULL, actor TEXT NOT NULL, caused_by_command_id TEXT,
  caused_by_event_id TEXT, correlation_ref TEXT, payload_json TEXT NOT NULL,
  UNIQUE(project_id, sequence)
);
CREATE TABLE attention_projection_rows (
  project_id TEXT NOT NULL, dedup_key TEXT NOT NULL, PRIMARY KEY(project_id, dedup_key)
);
CREATE TABLE deliver_replay_attention_facts (
  attention_fact_id TEXT NOT NULL, project_id TEXT NOT NULL,
  execution_id TEXT NOT NULL, target_workspace_id TEXT NOT NULL
);
CREATE TABLE deliver_replay_attention_rows (
  project_id TEXT NOT NULL, attention_fact_id TEXT NOT NULL
);
`;

const makeApp = (filename = ":memory:") => {
  const sqlite = layer({ filename });
  const journal = Layer.provide(
    DomainEventJournalLive,
    Layer.merge(sqlite, IdGeneratorLive),
  );
  const store = Layer.provide(
    SandboxProviderUnavailableStoreLive,
    Layer.mergeAll(sqlite, journal, IdGeneratorLive),
  );
  const queue = Layer.provide(
    SandboxProviderUnavailableAttentionQueueLive,
    Layer.merge(sqlite, IdGeneratorLive),
  );
  return Layer.mergeAll(
    sqlite,
    IdGeneratorLive,
    journal,
    Layer.provide(TransactionPortLive, sqlite),
    store,
    queue,
    Layer.provide(AttentionProjectionStoreLive, sqlite),
  );
};

const seed = Effect.gen(function* () {
  const sql = yield* SqlClient;
  const tx = yield* TransactionPort;
  const statements = splitStatements(setupSql);
  for (const statement of statements) yield* sql.unsafe(statement);
  for (const statement of splitStatements(
    P50_SANDBOX_PROVIDER_UNAVAILABLE_FACT_MIGRATION.sql,
  )) {
    yield* sql.unsafe(statement);
  }
  yield* sql.unsafe(
    `CREATE TRIGGER sandbox_provider_unavailable_wake_requires_sources
       BEFORE INSERT ON domain_events
       WHEN NEW.event_type = 'SandboxProviderUnavailable'
        AND (
          NOT EXISTS (
            SELECT 1 FROM sandbox_provider_unavailable_facts
             WHERE attention_fact_id = json_extract(NEW.payload_json, '$.attentionFactId')
          )
          OR NOT EXISTS (
            SELECT 1 FROM sandbox_provider_unavailable_attention_queue
             WHERE attention_fact_id = json_extract(NEW.payload_json, '$.attentionFactId')
          )
        )
       BEGIN SELECT RAISE(ABORT, 'wake must follow fact and queue'); END`,
  );
  yield* sql.unsafe(`INSERT INTO executions VALUES (?, ?, ?, NULL, NULL)`, [
    executionId,
    projectId,
    workspaceId,
  ]);
  yield* sql.unsafe(
    `INSERT INTO execution_leases VALUES (?, ?, ?, 1, '2099-01-01T00:00:00.000Z')`,
    [executionId, workerId, workerIncarnationId],
  );
  yield* sql.unsafe(`INSERT INTO agent_execution_state VALUES (?, ?)`, [
    executionId,
    episodeJson,
  ]);
  yield* sql.unsafe(
    `INSERT INTO sandbox_policy_decisions VALUES (?, ?, ?, ?, 1, ?, 'ReadOnly', 'bwrap', '2099-01-01T00:00:00.000Z')`,
    [projectId, workspaceId, executionId, episodeJson, policyDigest],
  );
  yield* sql.unsafe(`INSERT INTO executions VALUES (?, ?, ?, NULL, NULL)`, [
    executionId2,
    projectId,
    workspaceId2,
  ]);
  yield* sql.unsafe(
    `INSERT INTO execution_leases VALUES (?, ?, ?, 1, '2099-01-01T00:00:00.000Z')`,
    [executionId2, workerId, workerIncarnationId],
  );
  yield* sql.unsafe(`INSERT INTO agent_execution_state VALUES (?, ?)`, [
    executionId2,
    episodeJson2,
  ]);
  yield* sql.unsafe(
    `INSERT INTO sandbox_policy_decisions VALUES (?, ?, ?, ?, 1, ?, 'ReadOnly', 'bwrap', '2099-01-01T00:00:00.000Z')`,
    [projectId, workspaceId2, executionId2, episodeJson2, policyDigest],
  );
  yield* tx.transact(Effect.void);
});

const factInput = (failureCode = "ProviderUnavailable") => ({
  outcome: {
    _tag: "SandboxProviderUnavailable" as const,
    projectId,
    workspaceId,
    executionId,
    episodeBinding,
    policyRevision: 1,
    policyDigest,
    profileId: "ReadOnly" as const,
    providerId: "bwrap",
    providerVersion: "bwrap-v1",
    probeEvidenceRef: `probe:sha256:${"b".repeat(64)}`,
    failureCode,
  },
  fence: {
    executionId,
    workerId,
    workerIncarnationId,
    fencingGeneration: 1 as never,
  },
  firstDetectedAt: now,
});

const factInput2 = () => ({
  ...factInput(),
  outcome: {
    ...factInput().outcome,
    executionId: executionId2,
    workspaceId: workspaceId2,
    episodeBinding: episodeBinding2,
  },
  fence: { ...factInput().fence, executionId: executionId2 },
});

describe("P50 sandbox provider-unavailable fact and Attention queue", () => {
  it("commits one fenced fact, queue row and wake event; exact retry reuses them", async () => {
    await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          yield* seed;
          const tx = yield* TransactionPort;
          const facts = yield* SandboxStorePort;
          const journal = yield* DomainEventJournal;
          const sql = yield* SqlClient;
          const first = yield* tx.transact(facts.record(factInput()));
          const retry = yield* tx.transact(
            facts.record({
              ...factInput(),
              firstDetectedAt: "2026-10-19T10:01:00.000Z",
            }),
          );
          expect(retry).toEqual(first);
          expect(yield* tx.transact(facts.list(projectId))).toEqual([first]);
          const events = yield* tx.transact(
            journal.readAfter(projectId, 0, 10),
          );
          expect(events).toHaveLength(1);
          expect(events[0]).toMatchObject({
            eventType: "SandboxProviderUnavailable",
            eventVersion: 1,
            projectId,
            aggregateRef: executionId,
            actor: "system:recovery",
            correlationRef: first.attentionFactId,
            payload: {
              attentionFactId: first.attentionFactId,
              executionId,
              workspaceId,
              policyRevision: 1,
            },
          });
          expect(Object.keys(events[0]?.payload as object).sort()).toEqual([
            "attentionFactId",
            "executionId",
            "policyRevision",
            "workspaceId",
          ]);
          expect(
            yield* sql.unsafe<{
              readonly state: string;
              readonly attempt_count: number;
            }>(
              `SELECT state, attempt_count FROM sandbox_provider_unavailable_attention_queue
                WHERE project_id = ? AND attention_fact_id = ?`,
              [projectId, first.attentionFactId],
            ),
          ).toEqual([{ state: "Pending", attempt_count: 0 }]);
        }),
        makeApp(),
      ),
    );
  });

  it("rejects stale fences and non-identical retries without appending another wake", async () => {
    await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          yield* seed;
          const tx = yield* TransactionPort;
          const facts = yield* SandboxStorePort;
          const journal = yield* DomainEventJournal;
          yield* tx.transact(facts.record(factInput()));
          const conflict = yield* Effect.result(
            tx.transact(facts.record(factInput("DifferentFailure"))),
          );
          expect(conflict._tag).toBe("Failure");
          if (conflict._tag === "Failure") {
            expect(conflict.failure).toMatchObject({
              _tag: "SandboxProviderUnavailableFactInvariantConflict",
            });
          }
          const stale = yield* Effect.result(
            tx.transact(
              facts.record({
                ...factInput("SecondPolicyAttempt"),
                outcome: { ...factInput().outcome, policyRevision: 2 },
                fence: { ...factInput().fence, fencingGeneration: 0 as never },
              }),
            ),
          );
          expect(stale._tag).toBe("Failure");
          if (stale._tag === "Failure") {
            expect(stale.failure).toMatchObject({
              _tag: "LeaseFencingRejected",
              generation: 0,
            });
          }
          expect(
            yield* tx.transact(journal.readAfter(projectId, 0, 10)),
          ).toHaveLength(1);
          expect(yield* tx.transact(facts.list(projectId))).toHaveLength(1);
        }),
        makeApp(),
      ),
    );
  });

  it("serializes concurrent claims from independent SQLite connections", async () => {
    const directory = await mkdtemp(join(tmpdir(), "arbor-p50-queue-"));
    const filename = join(directory, "queue.sqlite");
    try {
      const prepare = Effect.gen(function* () {
        yield* seed;
        const tx = yield* TransactionPort;
        const facts = yield* SandboxStorePort;
        yield* tx.transact(facts.record(factInput()));
      });
      await Effect.runPromise(
        Effect.scoped(Effect.provide(prepare, makeApp(filename))),
      );
      const claimOnce = (app: ReturnType<typeof makeApp>) =>
        Effect.runPromise(
          Effect.scoped(
            Effect.provide(
              Effect.gen(function* () {
                const tx = yield* TransactionPort;
                const queue = yield* SandboxQueuePort;
                return yield* tx.transact(
                  queue.claimBatch({
                    projectId,
                    now,
                    claimTtlMs: 30_000,
                    limit: 1,
                  }),
                );
              }),
              app,
            ),
          ),
        );
      const [left, right] = await Promise.all([
        claimOnce(makeApp(filename)),
        claimOnce(makeApp(filename)),
      ]);
      expect(left.length + right.length).toBe(1);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("honors a bounded batch size and leaves later facts pending", async () => {
    await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          yield* seed;
          const tx = yield* TransactionPort;
          const facts = yield* SandboxStorePort;
          const queue = yield* SandboxQueuePort;
          const firstFact = yield* tx.transact(facts.record(factInput()));
          const secondFact = yield* tx.transact(facts.record(factInput2()));
          const firstBatch = yield* tx.transact(
            queue.claimBatch({ projectId, now, claimTtlMs: 30_000, limit: 1 }),
          );
          expect(firstBatch).toHaveLength(1);
          const secondBatch = yield* tx.transact(
            queue.claimBatch({ projectId, now, claimTtlMs: 30_000, limit: 1 }),
          );
          expect(secondBatch).toHaveLength(1);
          expect(
            new Set([
              firstBatch[0]?.attentionFactId,
              secondBatch[0]?.attentionFactId,
            ]),
          ).toEqual(
            new Set([firstFact.attentionFactId, secondFact.attentionFactId]),
          );
        }),
        makeApp(),
      ),
    );
  });

  it("reclaims expired claims, consumes only the current claim, and re-arms after rebuild", async () => {
    await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          yield* seed;
          const tx = yield* TransactionPort;
          const facts = yield* SandboxStorePort;
          const queue = yield* SandboxQueuePort;
          const projection = yield* AttentionProjectionStorePort;
          const fact = yield* tx.transact(facts.record(factInput()));
          const claims = yield* tx.transact(
            queue.claimBatch({
              projectId,
              now,
              claimTtlMs: 30_000,
              limit: 1,
            }),
          );
          expect(claims).toHaveLength(1);
          const claim = claims[0];
          if (claim === undefined)
            throw new Error("queue did not return a claim");
          expect(claim.attemptCount).toBe(1);
          const reclaimTime = "2026-10-19T10:00:31.000Z";
          const reclaimed = yield* tx.transact(
            queue.claimBatch({
              projectId,
              now: reclaimTime,
              claimTtlMs: 30_000,
              limit: 1,
            }),
          );
          const activeClaim = reclaimed[0];
          if (activeClaim === undefined) {
            throw new Error("expired queue claim was not reclaimed");
          }
          expect(activeClaim.attemptCount).toBe(2);
          expect(activeClaim.claimId).not.toBe(claim.claimId);
          expect(
            yield* tx.transact(queue.consume({ claim, now: reclaimTime })),
          ).toBeUndefined();
          expect(
            yield* tx.transact(
              queue.consume({ claim: activeClaim, now: reclaimTime }),
            ),
          ).toEqual(fact);
          expect(
            yield* tx.transact(
              queue.consume({ claim: activeClaim, now: reclaimTime }),
            ),
          ).toBeUndefined();
          expect(
            yield* tx.transact(
              projection.listProjectedSandboxProviderUnavailableFailures(
                projectId,
                now,
              ),
            ),
          ).toMatchObject([
            {
              projectId,
              attentionFactId: fact.attentionFactId,
              executionId,
              workspaceId,
              policyRevision: 1,
              firstDetectedAt: now,
            },
          ]);

          const rebuildStore = makeProjectAttentionProjectionStore(
            projectId,
            {
              listDeliverReplayFailures: () => Effect.succeed([]),
              listPendingDeliverReplayAttention: () => Effect.succeed([]),
              acknowledgePendingDeliverReplayAttention: () => Effect.void,
            } as never,
            {
              ...projection,
              listLegacyAdoptionFailures: undefined,
              putLegacyAdoptionFailure: undefined,
              reconcileStaleWorkRevisionRows: () => Effect.void,
            },
            undefined,
            undefined,
            facts,
            queue,
          );
          yield* tx.transact(rebuildStore.reset());
          const rearmed = yield* sqlQueueState(projectId, fact.attentionFactId);
          expect(rearmed).toMatchObject({ state: "Pending", attempt_count: 2 });
          expect(rearmed?.enqueued_at).toBe(now);
          expect(
            yield* tx.transact(sqlMarkerCount(projectId, fact.attentionFactId)),
          ).toBe(0);
          const second = yield* tx.transact(
            queue.claimBatch({
              projectId,
              now: "2026-10-19T10:00:32.000Z",
              claimTtlMs: 30_000,
              limit: 1,
            }),
          );
          expect(second[0]?.attemptCount).toBe(3);
          const secondClaim = second[0];
          if (secondClaim === undefined) {
            throw new Error("re-armed queue row was not claimable");
          }
          expect(
            yield* tx.transact(
              queue.consume({
                claim: secondClaim,
                now: "2026-10-19T10:00:32.000Z",
              }),
            ),
          ).toEqual(fact);
          expect(
            yield* tx.transact(sqlMarkerCount(projectId, fact.attentionFactId)),
          ).toBe(1);
        }),
        makeApp(),
      ),
    );
  });
});

const sqlQueueState = (projectId: unknown, attentionFactId: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    const rows = yield* sql.unsafe<{
      readonly state: string;
      readonly attempt_count: number;
      readonly enqueued_at: string;
    }>(
      `SELECT state, attempt_count, enqueued_at
         FROM sandbox_provider_unavailable_attention_queue
        WHERE project_id = ? AND attention_fact_id = ?`,
      [projectId, attentionFactId],
    );
    return rows[0];
  });

const sqlMarkerCount = (projectId: unknown, attentionFactId: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    const rows = yield* sql.unsafe<{ readonly count: number }>(
      `SELECT COUNT(*) AS count FROM sandbox_provider_unavailable_attention_rows
        WHERE project_id = ? AND attention_fact_id = ?`,
      [projectId, attentionFactId],
    );
    return rows[0]?.count ?? 0;
  });
