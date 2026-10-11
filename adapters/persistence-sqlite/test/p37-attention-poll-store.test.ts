import {
  AttentionPollStore,
  TransactionPort,
} from "@arbor/ports";
import { Effect, Layer } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { describe, expect, it } from "vitest";
import {
  AttentionPollStoreLive,
  layer,
  TransactionPortLive,
} from "../src/index.js";
import { runMigrations } from "../src/migrate.js";
import { P37_MIGRATIONS } from "../src/migrations.js";

const makeApp = () => {
  const sqlite = layer({ filename: ":memory:" });
  return Layer.mergeAll(
    sqlite,
    Layer.provide(AttentionPollStoreLive, sqlite),
    Layer.provide(TransactionPortLive, sqlite),
  );
};

const runDb = <A>(
  program: Effect.Effect<
    A,
    unknown,
    SqlClient | AttentionPollStore | TransactionPort
  >,
) => Effect.runPromise(Effect.scoped(Effect.provide(program, makeApp())));

describe("P37 Attention poll claim store", () => {
  it("returns non-mutating NoClaim while another valid global lease is active", () =>
    runDb(
      Effect.gen(function* () {
        const sql = yield* SqlClient;
        const poll = yield* AttentionPollStore;
        const transactions = yield* TransactionPort;
        yield* runMigrations(P37_MIGRATIONS);
        yield* sql.unsafe(
          `UPDATE p10_attention_dispatch_state
              SET active_project_id = 'prj_active', lease_owner = 'owner-a',
                  lease_generation = 7, claim_started_at = '2026-10-11T00:00:00.000Z',
                  lease_expires_at = '2026-10-11T00:01:00.000Z'
            WHERE singleton = 1`,
        );
        const before = yield* sql.unsafe(
          "SELECT * FROM p10_attention_dispatch_state WHERE singleton = 1",
        );
        const result = yield* transactions.transact(
          poll.tryClaim({
            leaseOwner: "owner-b",
            now: "2026-10-11T00:00:10.000Z",
            leaseTtlMs: 30_000,
            baseBackoffMs: 1_000,
            maxBackoffMs: 60_000,
            backoffExponentCap: 5,
          }),
        );
        const after = yield* sql.unsafe(
          "SELECT * FROM p10_attention_dispatch_state WHERE singleton = 1",
        );
        expect(result).toEqual({ _tag: "NoClaim" });
        expect(after).toEqual(before);
      }),
    ),
  );

  it("does not let a stale generation persist failure or release a newer claim", () =>
    runDb(
      Effect.gen(function* () {
        const sql = yield* SqlClient;
        const poll = yield* AttentionPollStore;
        const transactions = yield* TransactionPort;
        yield* runMigrations(P37_MIGRATIONS);
        yield* sql.unsafe(
          `INSERT INTO p10_attention_project_poll_state
             (project_id, last_attempt_sequence, next_eligible_at)
           VALUES ('prj_claimed', 3, '2026-10-11T00:00:00.000Z')`,
        );
        yield* sql.unsafe(
          `UPDATE p10_attention_dispatch_state
              SET active_project_id = 'prj_claimed', lease_owner = 'owner-new',
                  lease_generation = 8, claim_started_at = '2026-10-11T00:00:00.000Z',
                  lease_expires_at = '2026-10-11T00:01:00.000Z'
            WHERE singleton = 1`,
        );
        const before = yield* sql.unsafe(
          "SELECT * FROM p10_attention_dispatch_state WHERE singleton = 1",
        );
        const result = yield* transactions.transact(
          poll.recordFailure(
            {
              projectId: "prj_claimed" as never,
              leaseOwner: "owner-old",
              leaseGeneration: 7,
              attemptSequence: 2,
              leaseExpiresAt: "2026-10-11T00:00:30.000Z",
            },
            "MissingP9Fact",
            "2026-10-11T00:00:10.000Z",
            {
              baseBackoffMs: 1_000,
              maxBackoffMs: 60_000,
              backoffExponentCap: 5,
            },
          ),
        );
        const after = yield* sql.unsafe(
          "SELECT * FROM p10_attention_dispatch_state WHERE singleton = 1",
        );
        const schedule = yield* sql.unsafe<{ readonly consecutive_failed_attempts: number }>(
          "SELECT consecutive_failed_attempts FROM p10_attention_project_poll_state WHERE project_id = 'prj_claimed'",
        );
        expect(result).toBe(false);
        expect(after).toEqual(before);
        expect(Number(schedule[0]?.consecutive_failed_attempts)).toBe(0);
      }),
    ),
  );

  it("does not let an expired, not-yet-taken-over claim persist failure or release", () =>
    runDb(
      Effect.gen(function* () {
        const sql = yield* SqlClient;
        const poll = yield* AttentionPollStore;
        const transactions = yield* TransactionPort;
        yield* runMigrations(P37_MIGRATIONS);
        yield* sql.unsafe(
          `INSERT INTO p10_attention_project_poll_state
             (project_id, last_attempt_sequence, next_eligible_at)
           VALUES ('prj_expired', 3, '2026-10-11T00:00:00.000Z')`,
        );
        yield* sql.unsafe(
          `UPDATE p10_attention_dispatch_state
              SET active_project_id = 'prj_expired', lease_owner = 'owner-old',
                  lease_generation = 7, claim_started_at = '2026-10-11T00:00:00.000Z',
                  lease_expires_at = '2026-10-11T00:00:10.000Z'
            WHERE singleton = 1`,
        );
        const beforeDispatch = yield* sql.unsafe(
          "SELECT * FROM p10_attention_dispatch_state WHERE singleton = 1",
        );
        const beforeSchedule = yield* sql.unsafe(
          "SELECT * FROM p10_attention_project_poll_state WHERE project_id = 'prj_expired'",
        );
        const result = yield* transactions.transact(
          poll.recordFailure(
            {
              projectId: "prj_expired" as never,
              leaseOwner: "owner-old",
              leaseGeneration: 7,
              attemptSequence: 3,
              leaseExpiresAt: "2026-10-11T00:00:10.000Z",
            },
            "MissingP9Fact",
            "2026-10-11T00:00:11.000Z",
            {
              baseBackoffMs: 1_000,
              maxBackoffMs: 60_000,
              backoffExponentCap: 5,
            },
          ),
        );
        const afterDispatch = yield* sql.unsafe(
          "SELECT * FROM p10_attention_dispatch_state WHERE singleton = 1",
        );
        const afterSchedule = yield* sql.unsafe(
          "SELECT * FROM p10_attention_project_poll_state WHERE project_id = 'prj_expired'",
        );
        expect(result).toBe(false);
        expect(afterDispatch).toEqual(beforeDispatch);
        expect(afterSchedule).toEqual(beforeSchedule);
      }),
    ),
  );
});
