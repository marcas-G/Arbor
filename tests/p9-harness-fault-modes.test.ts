import { Effect, Layer } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { describe, expect, it } from "vitest";
import {
  layer,
  P8_MIGRATIONS,
  runMigrations,
} from "../adapters/persistence-sqlite/src/index.js";
import { TransactionPort } from "../packages/ports/src/index.js";
import {
  type FaultMode,
  faultingTransactionP9 as faultTx,
} from "./support/p9-fault-transaction.js";
import { labeled } from "./support/p9-harness-api.js";

const base = layer({ filename: ":memory:" });
const txLayer = (mode: FaultMode, injectOn: number) =>
  Layer.provideMerge(faultTx(mode, injectOn), base);

describe("P9-001 PB1/PB2/PB3 (transaction fault modes)", () => {
  it("PB1 [crash-injected]: fail-on-commit rolls back explicitly — no partial state, retry succeeds", async () => {
    expect(labeled("PB1-commit-rollback", "crash-injected").guarantee).toBe(
      "crash-injected",
    );
    const insertProject =
      "INSERT INTO inbox_entries (workspace_id, entry_key, kind, summary, correlation_id, admitted_at, consumed_at) VALUES ('ws_x', 'pb1', 'Message', 'x', NULL, 't', NULL)";
    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.provide(
          Effect.gen(function* () {
            yield* runMigrations(P8_MIGRATIONS);
            const sql = yield* SqlClient;
            const tx = yield* TransactionPort;
            const first = yield* tx
              .transact(
                Effect.gen(function* () {
                  yield* (yield* SqlClient).unsafe(insertProject);
                }),
              )
              .pipe(Effect.flip);
            expect(first._tag).toBe("TransactionOperationalFailure");
            const rows = yield* sql.unsafe<{ count: number }>(
              "SELECT COUNT(*) AS count FROM inbox_entries WHERE entry_key = 'pb1'",
            );
            expect(Number(rows[0]!.count)).toBe(0);
            yield* tx.transact(
              Effect.gen(function* () {
                yield* (yield* SqlClient).unsafe(insertProject);
              }),
            );
            const after = yield* sql.unsafe<{ count: number }>(
              "SELECT COUNT(*) AS count FROM inbox_entries WHERE entry_key = 'pb1'",
            );
            expect(Number(after[0]!.count)).toBe(1);
          }) as Effect.Effect<void, unknown, never>,
          txLayer("fail-on-commit", 1),
        ),
      ),
    );
    void result;
  });

  it("PB2 [crash-injected]: nested transaction attempt -> typed rejection", async () => {
    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.provide(
          Effect.gen(function* () {
            yield* runMigrations(P8_MIGRATIONS);
            const tx = yield* TransactionPort;
            const nested = yield* tx
              .transact(tx.transact(Effect.void) as never)
              .pipe(Effect.flip);
            expect(
              String((nested as { cause?: unknown }).cause ?? nested),
            ).toContain("nested");
          }) as Effect.Effect<void, unknown, never>,
          txLayer("rollback-after-body", 99),
        ),
      ),
    );
    void result;
  });

  it("PB3 [crash-injected]: begin failure surfaces TransactionOperationalFailure", async () => {
    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.provide(
          Effect.gen(function* () {
            yield* runMigrations(P8_MIGRATIONS);
            const tx = yield* TransactionPort;
            const failure = yield* tx.transact(Effect.void).pipe(Effect.flip);
            expect(failure._tag).toBe("TransactionOperationalFailure");
          }) as Effect.Effect<void, unknown, never>,
          txLayer("fail-on-begin", 1),
        ),
      ),
    );
    void result;
  });
});
