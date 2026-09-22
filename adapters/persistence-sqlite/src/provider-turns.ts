import type { ProjectId, ProviderTurnId } from "@arbor/domain";
import {
  type ProviderFailure,
  type ProviderTurnRecord,
  ProviderTurnStore,
  type ProviderTurnStoreService,
  TransactionScope,
} from "@arbor/ports";
import { Effect, Layer } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";

interface TurnRow {
  readonly provider_turn_id: string;
  readonly execution_id: string;
  readonly session_id: string;
  readonly context_epoch: number;
  readonly model_ref: string;
  readonly output_contract_ref: string;
  readonly manifest_id: string;
}

interface AttemptRow {
  readonly provider_turn_id: string;
  readonly attempt_no: number;
  readonly outcome: string;
  readonly provider_error_kind: string | null;
}

const toRecord = (row: TurnRow): ProviderTurnRecord => ({
  providerTurnId: row.provider_turn_id as ProviderTurnId,
  executionId: row.execution_id as never,
  sessionId: row.session_id as never,
  contextEpoch: row.context_epoch as never,
  modelRef: row.model_ref,
  outputContractRef: row.output_contract_ref,
  manifestId: row.manifest_id,
});

export const ProviderTurnStoreLive: Layer.Layer<
  ProviderTurnStore,
  never,
  SqlClient
> = Layer.effect(
  ProviderTurnStore,
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    const failure = (cause: unknown): ProviderFailure => ({
      _tag: "ProviderFailure",
      kind: "ProviderUnavailable",
      cause,
    });
    const run = <A>(effect: Effect.Effect<A, SqlError>) =>
      effect.pipe(Effect.mapError(failure));
    const store: ProviderTurnStoreService = {
      startTurn: (record: ProviderTurnRecord, startedAt: string) =>
        Effect.gen(function* () {
          yield* TransactionScope;
          yield* run(
            sql.unsafe(
              "INSERT INTO provider_turns (provider_turn_id, execution_id, session_id, context_epoch, model_ref, output_contract_ref, manifest_id, started_at, settled_at, finish_reason, usage_json, created_at) VALUES (?,?,?,?,?,?,?,?,NULL,NULL,NULL,?)",
              [
                record.providerTurnId,
                record.executionId,
                record.sessionId,
                record.contextEpoch,
                record.modelRef,
                record.outputContractRef,
                record.manifestId,
                startedAt,
                startedAt,
              ],
            ),
          );
        }),
      recordAttempt: (
        providerTurnId,
        attemptNo,
        outcome,
        startedAt,
        settledAt,
      ) =>
        Effect.gen(function* () {
          yield* TransactionScope;
          yield* run(
            sql.unsafe(
              "INSERT INTO provider_attempts (provider_turn_id, attempt_no, started_at, settled_at, outcome, provider_error_kind, transport_metadata_json) VALUES (?,?,?,?,?,?,NULL) ON CONFLICT(provider_turn_id, attempt_no) DO UPDATE SET settled_at = excluded.settled_at, outcome = excluded.outcome, provider_error_kind = excluded.provider_error_kind",
              [
                providerTurnId,
                attemptNo,
                startedAt,
                settledAt,
                outcome._tag,
                outcome.providerErrorKind ?? null,
              ],
            ),
          );
        }),
      settleTurn: (providerTurnId, finishReason, usageJson, settledAt) =>
        Effect.gen(function* () {
          yield* TransactionScope;
          yield* run(
            sql.unsafe(
              "UPDATE provider_turns SET settled_at = ?, finish_reason = ?, usage_json = ? WHERE provider_turn_id = ?",
              [settledAt, finishReason, usageJson, providerTurnId],
            ),
          );
        }),
      findUnsettledByProject: (projectId) =>
        Effect.gen(function* () {
          yield* TransactionScope;
          const turnRows = yield* run(
            sql.unsafe<TurnRow>(
              "SELECT pt.provider_turn_id, pt.execution_id, pt.session_id, pt.context_epoch, pt.model_ref, pt.output_contract_ref, pt.manifest_id FROM provider_turns pt JOIN executions e ON e.execution_id = pt.execution_id WHERE e.project_id = ? AND pt.settled_at IS NULL ORDER BY pt.started_at, pt.provider_turn_id",
              [projectId],
            ),
          );
          if (turnRows.length === 0) {
            return [];
          }
          const placeholders = turnRows.map(() => "?").join(",");
          const attemptRows = yield* run(
            sql.unsafe<AttemptRow>(
              `SELECT provider_turn_id, attempt_no, outcome, provider_error_kind FROM provider_attempts WHERE provider_turn_id IN (${placeholders}) ORDER BY attempt_no`,
              turnRows.map((row) => row.provider_turn_id),
            ),
          );
          const attemptsByTurn = new Map<
            string,
            Array<{
              readonly attemptNo: number;
              readonly outcome:
                | "Success"
                | "RetryableFailure"
                | "TerminalFailure";
              readonly providerErrorKind: string | null;
            }>
          >();
          for (const row of attemptRows) {
            const list = attemptsByTurn.get(row.provider_turn_id) ?? [];
            list.push({
              attemptNo: Number(row.attempt_no),
              outcome: row.outcome as
                | "Success"
                | "RetryableFailure"
                | "TerminalFailure",
              providerErrorKind: row.provider_error_kind,
            });
            attemptsByTurn.set(row.provider_turn_id, list);
          }
          return turnRows.map((row) => ({
            turn: toRecord(row),
            attempts: attemptsByTurn.get(row.provider_turn_id) ?? [],
          }));
        }),
      failTurn: (providerTurnId, settledAt) =>
        Effect.gen(function* () {
          yield* TransactionScope;
          yield* run(
            sql.unsafe(
              "UPDATE provider_turns SET settled_at = ?, finish_reason = 'Failed', usage_json = '{}' WHERE provider_turn_id = ? AND settled_at IS NULL",
              [settledAt, providerTurnId],
            ),
          );
        }),
      listUsageByProject: (projectId) =>
        Effect.gen(function* () {
          yield* TransactionScope;
          const rows = yield* run(
            sql.unsafe<{
              workspace_id: string;
              usage_json: string | null;
              settled_at: string | null;
            }>(
              "SELECT e.workspace_id AS workspace_id, pt.usage_json AS usage_json, pt.settled_at AS settled_at FROM provider_turns pt JOIN executions e ON e.execution_id = pt.execution_id WHERE e.project_id = ? ORDER BY pt.provider_turn_id",
              [projectId],
            ),
          );
          return rows.map((row) => ({
            workspaceId: row.workspace_id as never,
            usageJson: row.usage_json,
            settledAt: row.settled_at,
          }));
        }),
    };
    return ProviderTurnStore.of(store);
  }),
);

export type { ProjectId, ProviderTurnId };
