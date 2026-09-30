import type {
  ProviderAttemptObservation,
  ProviderFailure,
  ProviderTurnStoreService,
} from "@arbor/ports";
import { TransactionScope } from "@arbor/ports";
import { Effect } from "effect";
import {
  decodeJson,
  mergeObservation,
  type ProviderTurnStoreDependencies,
  UNKNOWN_OBSERVATION,
  UNKNOWN_OBSERVATION_JSON,
} from "./provider-turn-store-shared.js";

export const makeProviderAttemptStore = (
  dependencies: ProviderTurnStoreDependencies,
): Pick<
  ProviderTurnStoreService,
  | "startAttempt"
  | "updateAttemptObservation"
  | "settleAttempt"
  | "recordAttempt"
> => {
  const { sql, run } = dependencies;
  return {
    startAttempt: (providerTurnId, attemptNo, observation, startedAt) =>
      Effect.gen(function* () {
        yield* TransactionScope;
        yield* run(
          sql.unsafe(
            "INSERT INTO provider_attempts (provider_turn_id, attempt_no, started_at, settled_at, outcome, provider_error_kind, failure_taxonomy_version, observation_json, canonical_event_prefix_json, delivered_position, continuation_checkpoint_json, retry_safety, retry_decision, retry_strategy, retry_reason, transport_metadata_json) VALUES (?,?,?,NULL,'InProgress',NULL,'phase1-v2',?,?,0,NULL,NULL,NULL,NULL,NULL,NULL)",
            [
              providerTurnId,
              attemptNo,
              startedAt,
              JSON.stringify(observation),
              "[]",
            ],
          ),
        );
      }),
    updateAttemptObservation: (
      providerTurnId,
      attemptNo,
      observation,
      canonicalEventPrefixJson,
      deliveredPosition,
      continuationCheckpoint,
      updatedAt,
    ) =>
      Effect.gen(function* () {
        yield* TransactionScope;
        const rows = yield* run(
          sql.unsafe<{
            observation_json: string;
            canonical_event_prefix_json: string;
            delivered_position: number | null;
            continuation_checkpoint_json: string | null;
            outcome: string;
          }>(
            "SELECT observation_json, canonical_event_prefix_json, delivered_position, continuation_checkpoint_json, outcome FROM provider_attempts WHERE provider_turn_id = ? AND attempt_no = ?",
            [providerTurnId, attemptNo],
          ),
        );
        const row = rows[0];
        if (row === undefined || row.outcome !== "InProgress") {
          return yield* Effect.fail<ProviderFailure>({
            _tag: "ProviderFailure",
            kind: "UnknownProviderFailure",
            safeDiagnostic: "provider-attempt-not-in-progress",
          });
        }
        let merged: ProviderAttemptObservation;
        try {
          merged = mergeObservation(
            decodeJson(row.observation_json, UNKNOWN_OBSERVATION),
            observation,
          );
        } catch {
          return yield* Effect.fail<ProviderFailure>({
            _tag: "ProviderFailure",
            kind: "UnknownProviderFailure",
            safeDiagnostic: "provider-observation-not-monotonic",
          });
        }
        const previousPrefix = decodeJson<ReadonlyArray<unknown>>(
          row.canonical_event_prefix_json,
          [],
        );
        const nextPrefix = decodeJson<ReadonlyArray<unknown>>(
          canonicalEventPrefixJson,
          [],
        );
        if (
          nextPrefix.length < previousPrefix.length ||
          previousPrefix.some(
            (event, index) =>
              JSON.stringify(event) !== JSON.stringify(nextPrefix[index]),
          ) ||
          deliveredPosition < (row.delivered_position ?? 0)
        ) {
          return yield* Effect.fail<ProviderFailure>({
            _tag: "ProviderFailure",
            kind: "UnknownProviderFailure",
            safeDiagnostic: "provider-attempt-evidence-not-monotonic",
          });
        }
        const checkpointJson =
          continuationCheckpoint === null
            ? row.continuation_checkpoint_json
            : JSON.stringify(continuationCheckpoint);
        yield* run(
          sql.unsafe(
            "UPDATE provider_attempts SET observation_json = ?, canonical_event_prefix_json = ?, delivered_position = ?, continuation_checkpoint_json = ?, transport_metadata_json = ? WHERE provider_turn_id = ? AND attempt_no = ? AND outcome = 'InProgress'",
            [
              JSON.stringify(merged),
              canonicalEventPrefixJson,
              deliveredPosition,
              checkpointJson,
              JSON.stringify({ updatedAt }),
              providerTurnId,
              attemptNo,
            ],
          ),
        );
      }),
    settleAttempt: (providerTurnId, attemptNo, settlement, settledAt) =>
      Effect.gen(function* () {
        yield* TransactionScope;
        const rows = yield* run(
          sql.unsafe<{ observation_json: string; outcome: string }>(
            "SELECT observation_json, outcome FROM provider_attempts WHERE provider_turn_id = ? AND attempt_no = ?",
            [providerTurnId, attemptNo],
          ),
        );
        const row = rows[0];
        if (row === undefined || row.outcome !== "InProgress") {
          return yield* Effect.fail<ProviderFailure>({
            _tag: "ProviderFailure",
            kind: "UnknownProviderFailure",
            safeDiagnostic: "provider-attempt-settlement-invalid-state",
          });
        }
        let merged: ProviderAttemptObservation;
        try {
          merged = mergeObservation(
            decodeJson(row.observation_json, UNKNOWN_OBSERVATION),
            settlement.observation,
          );
        } catch {
          return yield* Effect.fail<ProviderFailure>({
            _tag: "ProviderFailure",
            kind: "UnknownProviderFailure",
            safeDiagnostic: "provider-settlement-observation-not-monotonic",
          });
        }
        yield* run(
          sql.unsafe(
            "UPDATE provider_attempts SET settled_at = ?, outcome = ?, provider_error_kind = ?, failure_taxonomy_version = ?, observation_json = ?, canonical_event_prefix_json = ?, delivered_position = ?, continuation_checkpoint_json = ?, retry_safety = ?, retry_decision = ?, retry_strategy = ?, retry_reason = ? WHERE provider_turn_id = ? AND attempt_no = ? AND outcome = 'InProgress'",
            [
              settledAt,
              settlement.outcome,
              settlement.providerErrorKind ?? null,
              settlement.taxonomyVersion,
              JSON.stringify(merged),
              settlement.canonicalEventPrefixJson,
              settlement.deliveredPosition,
              settlement.continuationCheckpoint === undefined
                ? null
                : JSON.stringify(settlement.continuationCheckpoint),
              settlement.retryDecision?.safety ?? null,
              settlement.retryDecision?.decision ?? null,
              settlement.retryDecision?.strategy ?? null,
              settlement.retryDecision?.reason ?? null,
              providerTurnId,
              attemptNo,
            ],
          ),
        );
      }),
    recordAttempt: (providerTurnId, attemptNo, outcome, startedAt, settledAt) =>
      Effect.gen(function* () {
        yield* TransactionScope;
        yield* run(
          sql.unsafe(
            "INSERT INTO provider_attempts (provider_turn_id, attempt_no, started_at, settled_at, outcome, provider_error_kind, failure_taxonomy_version, observation_json, canonical_event_prefix_json, delivered_position, transport_metadata_json) VALUES (?,?,?,?,?,?,'legacy-v1',?,?,NULL,NULL) ON CONFLICT(provider_turn_id, attempt_no) DO UPDATE SET settled_at = excluded.settled_at, outcome = excluded.outcome, provider_error_kind = excluded.provider_error_kind",
            [
              providerTurnId,
              attemptNo,
              startedAt,
              settledAt,
              outcome._tag,
              outcome.providerErrorKind ?? null,
              UNKNOWN_OBSERVATION_JSON,
              "[]",
            ],
          ),
        );
      }),
  };
};
