import type {
  CommandId,
  CommandReceipt,
  ProjectId,
  SemanticRequestFingerprint,
} from "@arbor/domain";
import {
  Clock,
  CommandStore,
  type CommandStoreError,
  TransactionScope,
} from "@arbor/ports";
import { Effect, Layer, Option } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";

interface CommandRow {
  readonly command_id: string;
  readonly project_id: string;
  readonly semantic_request_fingerprint: string;
  readonly schema_version: string;
  readonly fingerprint_algorithm_version: number;
  readonly resolution: "Committed" | "TerminalRejected";
  readonly result_json: string | null;
  readonly terminal_error_json: string | null;
  readonly created_at: string;
  readonly settled_at: string;
}

const toReceipt = (row: CommandRow): CommandReceipt<unknown, unknown> => ({
  commandId: row.command_id as CommandId,
  projectId: row.project_id as ProjectId,
  semanticRequestFingerprint:
    row.semantic_request_fingerprint as SemanticRequestFingerprint,
  schemaVersion: row.schema_version,
  fingerprintAlgorithmVersion: Number(row.fingerprint_algorithm_version),
  resolution:
    row.resolution === "Committed"
      ? { _tag: "Committed", result: JSON.parse(row.result_json ?? "null") }
      : {
          _tag: "TerminalRejected",
          error: JSON.parse(row.terminal_error_json ?? "null"),
        },
  createdAt: row.created_at,
  settledAt: row.settled_at,
});

export const CommandStoreLive: Layer.Layer<
  CommandStore,
  never,
  SqlClient | Clock
> = Layer.effect(
  CommandStore,
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    const clock = yield* Clock;
    const failure = (cause: unknown): CommandStoreError => ({
      _tag: "CommandStoreFailure",
      cause,
    });
    const run = <A>(effect: Effect.Effect<A, SqlError>) =>
      effect.pipe(Effect.mapError(failure));
    const nextAttempt = (
      commandId: CommandId,
    ): Effect.Effect<number, CommandStoreError, TransactionScope> =>
      Effect.gen(function* () {
        yield* TransactionScope;
        const rows = yield* run(
          sql.unsafe<{ next: number }>(
            "SELECT COALESCE(MAX(attempt_no) + 1, 0) AS next FROM command_attempts WHERE command_id = ?",
            [commandId],
          ),
        );
        return Number(rows[0]?.next ?? 0);
      });
    return CommandStore.of({
      findResolution: (commandId) =>
        Effect.gen(function* () {
          yield* TransactionScope;
          const rows = yield* run(
            sql.unsafe<CommandRow>(
              "SELECT * FROM commands WHERE command_id = ?",
              [commandId],
            ),
          );
          const row = rows[0];
          return row === undefined
            ? Option.none()
            : Option.some(toReceipt(row));
        }),
      insertCommitted: (
        commandId,
        projectId,
        fingerprint,
        schemaVersion,
        fingerprintAlgorithmVersion,
        resultJson,
      ) =>
        Effect.gen(function* () {
          yield* TransactionScope;
          const now = yield* clock.now();
          yield* run(
            sql.unsafe(
              "INSERT INTO commands (command_id, project_id, semantic_request_fingerprint, schema_version, fingerprint_algorithm_version, resolution, result_json, terminal_error_json, created_at, settled_at) VALUES (?,?,?,?,?,?,?,NULL,?,?)",
              [
                commandId,
                projectId,
                fingerprint,
                schemaVersion,
                fingerprintAlgorithmVersion,
                "Committed",
                resultJson,
                now,
                now,
              ],
            ),
          );
        }),
      insertTerminalRejected: (
        commandId,
        projectId,
        fingerprint,
        schemaVersion,
        fingerprintAlgorithmVersion,
        terminalErrorJson,
      ) =>
        Effect.gen(function* () {
          yield* TransactionScope;
          const now = yield* clock.now();
          yield* run(
            sql.unsafe(
              "INSERT INTO commands (command_id, project_id, semantic_request_fingerprint, schema_version, fingerprint_algorithm_version, resolution, result_json, terminal_error_json, created_at, settled_at) VALUES (?,?,?,?,?,?,NULL,?,?,?)",
              [
                commandId,
                projectId,
                fingerprint,
                schemaVersion,
                fingerprintAlgorithmVersion,
                "TerminalRejected",
                terminalErrorJson,
                now,
                now,
              ],
            ),
          );
        }),
      recordResolvingAttempt: (commandId, outcome, startedAt, settledAt) =>
        Effect.gen(function* () {
          const attemptNo = yield* nextAttempt(commandId);
          yield* run(
            sql.unsafe(
              "INSERT INTO command_attempts (command_id, attempt_no, started_at, settled_at, outcome, failure_kind, metadata_json) VALUES (?,?,?,?,?,NULL,NULL)",
              [commandId, attemptNo, startedAt, settledAt, outcome],
            ),
          );
        }),
      recordRetryableAttempt: (commandId, failureKind, startedAt, settledAt) =>
        Effect.gen(function* () {
          const attemptNo = yield* nextAttempt(commandId);
          yield* run(
            sql.unsafe(
              "INSERT INTO command_attempts (command_id, attempt_no, started_at, settled_at, outcome, failure_kind, metadata_json) VALUES (?,?,?,?,?,?,NULL)",
              [
                commandId,
                attemptNo,
                startedAt,
                settledAt,
                "RetryableOperationalFailure",
                failureKind,
              ],
            ),
          );
        }),
    });
  }),
);
