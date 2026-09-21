import { Effect, Layer } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { describe, expect, it } from "vitest";
import {
  InboxProjectionStoreLive,
  layer,
  P6_MIGRATIONS,
  runMigrations,
  TransactionPortLive,
} from "../adapters/persistence-sqlite/src/index.js";
import { admitSpecialistSettlement } from "../packages/application/src/specialist-settlement.js";
import {
  ExecutionId,
  type ExecutionSettlement,
  parse,
  settlementFingerprint,
  specialistSettlementEntryKey,
} from "../packages/domain/src/index.js";
import {
  InboxProjectionStore,
  TransactionPort,
} from "../packages/ports/src/index.js";
import { WS_ROOT } from "./harness/p6-fixtures.js";

const EXE_1 = parse(ExecutionId)("exe_00000000-0000-7000-8000-000000000001");

const settlementCompleted: ExecutionSettlement = {
  _tag: "Completed",
  result: { _tag: "QueryCompleted" },
};

const settlementFailed: ExecutionSettlement = {
  _tag: "Failed",
  failure: { _tag: "ExecutionFailure", reason: "provider unavailable" },
};

const fullLayer = () => {
  const base = layer({ filename: ":memory:" });
  return Layer.provideMerge(
    Layer.mergeAll(InboxProjectionStoreLive, TransactionPortLive),
    base,
  );
};

const run = <A, E, R>(
  program: Effect.Effect<A, E, SqlClient | R>,
): Promise<A> =>
  Effect.runPromise(
    Effect.scoped(
      Effect.provide(
        Effect.gen(function* () {
          yield* runMigrations(P6_MIGRATIONS);
          const tx = yield* TransactionPort;
          return yield* tx.transact(program);
        }) as Effect.Effect<A, E, SqlClient>,
        fullLayer(),
      ),
    ),
  );

describe("p6-specialist-settlement", () => {
  it("admits exactly one Inbox entry keyed by the domain entry key", async () => {
    await run(
      Effect.gen(function* () {
        const inbox = yield* InboxProjectionStore;
        const outcome = yield* admitSpecialistSettlement(
          {
            specialistExecutionId: EXE_1,
            parentWorkspaceId: WS_ROOT,
            settlement: settlementCompleted,
            summary: "specialist finished the query",
            occurredAt: "2026-09-21T00:00:00.000Z",
          },
          { inbox },
        );
        const expectedKey = specialistSettlementEntryKey(
          EXE_1,
          settlementFingerprint(settlementCompleted),
        );
        expect(outcome.entryKey).toBe(expectedKey);
        expect(outcome.deduplicated).toBe(false);
        expect(outcome.wakeReason).toEqual({ _tag: "InputArrived" });

        const pending = yield* inbox.listUnconsumed(WS_ROOT);
        expect(pending).toHaveLength(1);
        expect(pending[0]?.entryKey).toBe(expectedKey);
        expect(pending[0]?.kind).toBe("SpecialistSettled");
      }),
    );
  });

  it("replays the same settlement as a no-op (replay-safe dedup, D3)", async () => {
    await run(
      Effect.gen(function* () {
        const inbox = yield* InboxProjectionStore;
        const first = yield* admitSpecialistSettlement(
          {
            specialistExecutionId: EXE_1,
            parentWorkspaceId: WS_ROOT,
            settlement: settlementCompleted,
            summary: "specialist finished the query",
            occurredAt: "2026-09-21T00:00:00.000Z",
          },
          { inbox },
        );
        expect(first.deduplicated).toBe(false);

        const replayed = yield* admitSpecialistSettlement(
          {
            specialistExecutionId: EXE_1,
            parentWorkspaceId: WS_ROOT,
            settlement: settlementCompleted,
            summary: "specialist finished the query (replayed)",
            occurredAt: "2026-09-21T00:00:01.000Z",
          },
          { inbox },
        );
        expect(replayed.deduplicated).toBe(true);
        expect(replayed.entryKey).toBe(first.entryKey);

        expect(yield* inbox.countByKey(WS_ROOT, first.entryKey)).toBe(1);
        const pending = yield* inbox.listUnconsumed(WS_ROOT);
        expect(pending).toHaveLength(1);
        expect(pending[0]?.summary).toBe("specialist finished the query");
      }),
    );
  });

  it("admits distinct settlements (distinct fingerprints) as two entries", async () => {
    await run(
      Effect.gen(function* () {
        const inbox = yield* InboxProjectionStore;
        const completed = yield* admitSpecialistSettlement(
          {
            specialistExecutionId: EXE_1,
            parentWorkspaceId: WS_ROOT,
            settlement: settlementCompleted,
            summary: "specialist finished the query",
            occurredAt: "2026-09-21T00:00:00.000Z",
          },
          { inbox },
        );
        const failed = yield* admitSpecialistSettlement(
          {
            specialistExecutionId: EXE_1,
            parentWorkspaceId: WS_ROOT,
            settlement: settlementFailed,
            summary: "specialist failed",
            occurredAt: "2026-09-21T00:00:02.000Z",
          },
          { inbox },
        );
        expect(completed.entryKey).not.toBe(failed.entryKey);
        expect(yield* inbox.countByKey(WS_ROOT, completed.entryKey)).toBe(1);
        expect(yield* inbox.countByKey(WS_ROOT, failed.entryKey)).toBe(1);
        expect(yield* inbox.listUnconsumed(WS_ROOT)).toHaveLength(2);
      }),
    );
  });

  it("never writes the sessions table across admissions (D3 ban)", async () => {
    await run(
      Effect.gen(function* () {
        const sql = yield* SqlClient;
        const sessionCount = () =>
          Effect.map(
            sql.unsafe<{ count: number }>(
              "SELECT COUNT(*) AS count FROM sessions",
            ),
            (rows) => Number(rows[0]?.count ?? 0),
          );
        const inbox = yield* InboxProjectionStore;

        const before = yield* sessionCount();
        yield* admitSpecialistSettlement(
          {
            specialistExecutionId: EXE_1,
            parentWorkspaceId: WS_ROOT,
            settlement: settlementCompleted,
            summary: "specialist finished the query",
            occurredAt: "2026-09-21T00:00:00.000Z",
          },
          { inbox },
        );
        const afterFirst = yield* sessionCount();
        yield* admitSpecialistSettlement(
          {
            specialistExecutionId: EXE_1,
            parentWorkspaceId: WS_ROOT,
            settlement: settlementCompleted,
            summary: "specialist finished the query (replayed)",
            occurredAt: "2026-09-21T00:00:01.000Z",
          },
          { inbox },
        );
        const afterReplay = yield* sessionCount();

        expect(before).toBe(0);
        expect(afterFirst).toBe(before);
        expect(afterReplay).toBe(before);
      }),
    );
  });
});
