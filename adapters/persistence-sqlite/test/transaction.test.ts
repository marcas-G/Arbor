import { TransactionPort, TransactionScope } from "@arbor/ports";
import { Effect, Exit, Layer } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { describe, expect, it } from "vitest";
import {
  layer,
  P1_MIGRATIONS,
  runMigrations,
  sqliteAdapterError,
  TransactionPortLive,
} from "../src/index.js";

const app = Layer.provideMerge(
  TransactionPortLive,
  layer({ filename: ":memory:" }),
);

const program = Effect.gen(function* () {
  yield* runMigrations(P1_MIGRATIONS);
  const tx = yield* TransactionPort;

  const scopeId = yield* tx.transact(
    Effect.gen(function* () {
      const scope = yield* TransactionScope;
      const sql = yield* SqlClient;
      yield* sql.unsafe(
        "INSERT INTO project_event_sequences (project_id, last_sequence) VALUES ('p1', 1)",
      );
      return scope.session.id;
    }),
  );

  const nested = yield* Effect.exit(
    tx.transact(
      Effect.gen(function* () {
        yield* tx.transact(Effect.succeed(1));
        return 0;
      }),
    ),
  );

  const rolledBack = yield* Effect.exit(
    tx.transact(
      Effect.gen(function* () {
        const sql = yield* SqlClient;
        yield* sql.unsafe(
          "INSERT INTO project_event_sequences (project_id, last_sequence) VALUES ('p2', 1)",
        );
        return yield* Effect.fail(sqliteAdapterError("boom"));
      }),
    ),
  );

  const sql = yield* SqlClient;
  const rows = yield* sql.unsafe<{ project_id: string }>(
    "SELECT project_id FROM project_event_sequences ORDER BY project_id",
  );
  return {
    scopeId,
    nested,
    rolledBack,
    ids: rows.map((row) => row.project_id),
  };
});

describe("transaction port", () => {
  it("runs a body in one scope, rejects nesting, and rolls back on failure", async () => {
    const result = await Effect.runPromise(Effect.provide(program, app));
    expect(result.scopeId).toBe("sqlite");
    expect(Exit.isFailure(result.nested)).toBe(true);
    expect(Exit.isFailure(result.rolledBack)).toBe(true);
    expect(result.ids).toEqual(["p1"]);
    if (Exit.isFailure(result.nested)) {
      expect(JSON.stringify(result.nested.cause)).toContain(
        "nested transaction rejected",
      );
    }
  });
});
