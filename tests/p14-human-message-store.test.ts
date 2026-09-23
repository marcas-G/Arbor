import { Effect, Layer, Option } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { describe, expect, it } from "vitest";
import {
  ClockLive,
  HumanMessageStoreLive,
  IdGeneratorLive,
  layer,
  P14_MIGRATIONS,
  runMigrations,
  TransactionPortLive,
} from "../adapters/persistence-sqlite/src/index.js";
import {
  Principal,
  ProjectId,
  parse,
  WorkspaceId,
} from "../packages/domain/src/index.js";
import {
  type HumanMessageRecord,
  HumanMessageStore,
  TransactionPort,
} from "../packages/ports/src/index.js";

/**
 * P14-002 (contract `01` §4) — durable human-message store + migration 0014:
 * Pending → Claimed → Answered lifecycle, FIFO pending order, single-statement
 * CAS claim, crash rollback, and the user_version=14 baseline. Seam S1.
 */

const PROJECT = parse(ProjectId)("prj_018f2b3c-4d5e-7abc-8def-0123456789ab");
const ROOT = parse(WorkspaceId)("ws_018f2b3c-4d5e-7abc-8def-0123456789ab");

const record = (
  messageId: string,
  overrides: Partial<HumanMessageRecord> = {},
): HumanMessageRecord => ({
  messageId,
  projectId: PROJECT,
  rootWorkspaceId: ROOT,
  humanPrincipal: parse(Principal)("user:lgao"),
  bodyRef: `body ${messageId}`,
  commandId: `cmd_${messageId}` as HumanMessageRecord["commandId"],
  fingerprint: `fp_${messageId}`,
  state: "Pending",
  claimedByExecutionId: null,
  createdAt: "2026-09-23T05:00:00.000Z",
  settledAt: null,
  responseBody: null,
  attemptNo: 0,
  ...overrides,
});

const app = () => {
  const base = layer({ filename: ":memory:" });
  const infra = Layer.mergeAll(base, ClockLive, IdGeneratorLive);
  return Layer.mergeAll(
    Layer.provide(HumanMessageStoreLive, base),
    Layer.provide(TransactionPortLive, infra),
    infra,
  ) as Layer.Layer<HumanMessageStore | TransactionPort | SqlClient>;
};

describe("P14-002 human_messages migration + store", () => {
  it("migration 0014 settles PRAGMA user_version at 14 and creates the table", async () => {
    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.provide(
          Effect.gen(function* () {
            yield* runMigrations(P14_MIGRATIONS);
            const sql = yield* SqlClient;
            const version = yield* sql.unsafe<{ user_version: number }>(
              "PRAGMA user_version",
            );
            const table = yield* sql.unsafe<{ name: string }>(
              "SELECT name FROM sqlite_master WHERE type='table' AND name='human_messages'",
            );
            return {
              version: Number(version[0]?.user_version ?? -1),
              table: table[0]?.name ?? null,
            };
          }),
          app(),
        ),
      ),
    );
    expect(result.version).toBe(14);
    expect(result.table).toBe("human_messages");
  });

  it("S1: Pending → Claimed (CAS) → Answered lifecycle", async () => {
    const outcome = await Effect.runPromise(
      Effect.scoped(
        Effect.provide(
          Effect.gen(function* () {
            yield* runMigrations(P14_MIGRATIONS);
            const store = yield* HumanMessageStore;
            const tx = yield* TransactionPort;

            yield* tx.transact(store.insertPending(record("msg_1")));
            const pending = yield* tx.transact(
              store.pendingOrderedByCreated(PROJECT),
            );
            const claim = yield* tx.transact(store.claim("msg_1", "exe_1"));
            const secondClaim = yield* tx.transact(
              store.claim("msg_1", "exe_2"),
            );
            yield* tx.transact(
              store.markAnswered(
                "msg_1",
                "2026-09-23T05:01:00.000Z",
                "assistant reply",
              ),
            );
            const after = yield* tx.transact(store.findById("msg_1"));
            return { pending, claim, secondClaim, after };
          }),
          app(),
        ),
      ),
    );
    expect(outcome.pending.map((row) => row.messageId)).toEqual(["msg_1"]);
    expect(outcome.claim._tag).toBe("Claimed");
    // concurrent/repeat claim never double-admits (CAS)
    expect(outcome.secondClaim._tag).toBe("AlreadyClaimed");
    const row = Option.getOrThrow(outcome.after);
    expect(row.state).toBe("Answered");
    expect(row.settledAt).toBe("2026-09-23T05:01:00.000Z");
    expect(row.responseBody).toBe("assistant reply");
  });

  it("S1: insertPending conflict surfaces the existing row (no duplicate)", async () => {
    const outcome = await Effect.runPromise(
      Effect.scoped(
        Effect.provide(
          Effect.gen(function* () {
            yield* runMigrations(P14_MIGRATIONS);
            const store = yield* HumanMessageStore;
            const tx = yield* TransactionPort;
            yield* tx.transact(store.insertPending(record("msg_2")));
            const conflict = yield* Effect.flip(
              tx.transact(store.insertPending(record("msg_2"))),
            );
            const rows = yield* tx.transact(
              store.pendingOrderedByCreated(PROJECT),
            );
            return { conflict, count: rows.length };
          }),
          app(),
        ),
      ),
    );
    expect(outcome.conflict._tag).toBe("HumanMessageConflict");
    expect(outcome.count).toBe(1);
  });

  it("S1/S5: pendingOrderedByCreated is FIFO by created_at", async () => {
    const order = await Effect.runPromise(
      Effect.scoped(
        Effect.provide(
          Effect.gen(function* () {
            yield* runMigrations(P14_MIGRATIONS);
            const store = yield* HumanMessageStore;
            const tx = yield* TransactionPort;
            yield* tx.transact(
              store.insertPending(
                record("msg_b", { createdAt: "2026-09-23T05:00:02.000Z" }),
              ),
            );
            yield* tx.transact(
              store.insertPending(
                record("msg_a", { createdAt: "2026-09-23T05:00:01.000Z" }),
              ),
            );
            yield* tx.transact(
              store.insertPending(
                record("msg_c", { createdAt: "2026-09-23T05:00:03.000Z" }),
              ),
            );
            const rows = yield* tx.transact(
              store.pendingOrderedByCreated(PROJECT),
            );
            return rows.map((row) => row.messageId);
          }),
          app(),
        ),
      ),
    );
    expect(order).toEqual(["msg_a", "msg_b", "msg_c"]);
  });

  it("S6: rollbackClaim returns a stale claim to Pending (crash recovery)", async () => {
    const outcome = await Effect.runPromise(
      Effect.scoped(
        Effect.provide(
          Effect.gen(function* () {
            yield* runMigrations(P14_MIGRATIONS);
            const store = yield* HumanMessageStore;
            const tx = yield* TransactionPort;
            yield* tx.transact(store.insertPending(record("msg_3")));
            yield* tx.transact(store.claim("msg_3", "exe_dead"));
            yield* tx.transact(store.rollbackClaim("msg_3"));
            const row = yield* tx.transact(store.findById("msg_3"));
            const pending = yield* tx.transact(
              store.pendingOrderedByCreated(PROJECT),
            );
            return { row: Option.getOrThrow(row), pending: pending.length };
          }),
          app(),
        ),
      ),
    );
    expect(outcome.row.state).toBe("Pending");
    expect(outcome.row.claimedByExecutionId).toBeNull();
    expect(outcome.pending).toBe(1);
  });
});
