import type { ProviderTurnId } from "@arbor/domain";
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
    };
    return ProviderTurnStore.of(store);
  }),
);

export type { ProviderTurnId };
