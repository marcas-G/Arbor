import * as SqliteClient from "@effect/sql-sqlite-node/SqliteClient";
import { Effect, Layer } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { type SqliteAdapterError, sqliteAdapterError } from "./errors.js";

export interface SqliteAdapterConfig {
  readonly filename: string;
}

/**
 * Connection settings from `04-sqlite-schema.md` §1. WAL is enabled by
 * `disableWAL: false`; the remaining PRAGMAs are applied on open.
 */
const pragmas = Effect.gen(function* () {
  const sql = yield* SqlClient;
  yield* sql.unsafe("PRAGMA foreign_keys = ON");
  yield* sql.unsafe("PRAGMA busy_timeout = 5000");
  yield* sql.unsafe("PRAGMA synchronous = FULL");
}).pipe(
  Effect.mapError((cause) =>
    sqliteAdapterError("failed to apply sqlite pragmas", cause),
  ),
);

export const layer = (
  config: SqliteAdapterConfig,
): Layer.Layer<SqlClient | SqliteClient.SqliteClient, SqliteAdapterError> =>
  Layer.provideMerge(
    Layer.effectDiscard(pragmas),
    SqliteClient.layer({ filename: config.filename, disableWAL: false }),
  );
