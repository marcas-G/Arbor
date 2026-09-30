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
  type SettledTurnRow,
  successEvidence,
  toRecord,
  UNKNOWN_OBSERVATION,
} from "./provider-turn-store-shared.js";

export const makeProviderTurnSettlementStore = (
  dependencies: ProviderTurnStoreDependencies,
): Pick<
  ProviderTurnStoreService,
  | "settleSuccessAtomically"
  | "findSettledResult"
  | "adoptSettledSuccessEvidence"
  | "settleTurn"
> => {
  const { sql, run } = dependencies;
  return {
    settleSuccessAtomically: (
      providerTurnId,
      attemptNo,
      settlement,
      finishReason,
      usageJson,
      settledAt,
      evidenceVersion,
    ) =>
      Effect.gen(function* () {
        yield* TransactionScope;
        const evidence = successEvidence(
          settlement.canonicalEventPrefixJson,
          providerTurnId,
          finishReason,
          settlement.deliveredPosition,
        );
        if (!evidence.ok) {
          return yield* Effect.fail<ProviderFailure>({
            _tag: "ProviderFailure",
            kind: "ProtocolViolation",
            safeDiagnostic: "provider-success-evidence-invalid",
          });
        }
        const currentRows = yield* run(
          sql.unsafe<{ observation_json: string; outcome: string }>(
            "SELECT observation_json, outcome FROM provider_attempts WHERE provider_turn_id = ? AND attempt_no = ?",
            [providerTurnId, attemptNo],
          ),
        );
        const current = currentRows[0];
        if (current === undefined || current.outcome !== "InProgress") {
          return yield* Effect.fail<ProviderFailure>({
            _tag: "ProviderFailure",
            kind: "UnknownProviderFailure",
            safeDiagnostic: "provider-attempt-settlement-invalid-state",
          });
        }
        let merged: ProviderAttemptObservation;
        try {
          merged = mergeObservation(
            decodeJson(current.observation_json, UNKNOWN_OBSERVATION),
            settlement.observation,
          );
        } catch {
          return yield* Effect.fail<ProviderFailure>({
            _tag: "ProviderFailure",
            kind: "UnknownProviderFailure",
            safeDiagnostic: "provider-settlement-observation-not-monotonic",
          });
        }
        const columns = yield* run(
          sql.unsafe<{ name: string }>("PRAGMA table_info(provider_attempts)"),
        );
        const hasEvidenceVersion = columns.some(
          (column) => column.name === "success_evidence_version",
        );
        const attemptRows = hasEvidenceVersion
          ? yield* run(
              sql.unsafe<{ attempt_no: number }>(
                "UPDATE provider_attempts SET settled_at = ?, outcome = 'Success', provider_error_kind = NULL, failure_taxonomy_version = ?, observation_json = ?, canonical_event_prefix_json = ?, delivered_position = ?, continuation_checkpoint_json = ?, retry_safety = NULL, retry_decision = NULL, retry_strategy = NULL, retry_reason = NULL, success_evidence_version = ? WHERE provider_turn_id = ? AND attempt_no = ? AND outcome = 'InProgress' RETURNING attempt_no",
                [
                  settledAt,
                  settlement.taxonomyVersion,
                  JSON.stringify(merged),
                  settlement.canonicalEventPrefixJson,
                  settlement.deliveredPosition,
                  settlement.continuationCheckpoint === undefined
                    ? null
                    : JSON.stringify(settlement.continuationCheckpoint),
                  evidenceVersion,
                  providerTurnId,
                  attemptNo,
                ],
              ),
            )
          : yield* run(
              sql.unsafe<{ attempt_no: number }>(
                "UPDATE provider_attempts SET settled_at = ?, outcome = 'Success', provider_error_kind = NULL, failure_taxonomy_version = ?, observation_json = ?, canonical_event_prefix_json = ?, delivered_position = ?, continuation_checkpoint_json = ?, retry_safety = NULL, retry_decision = NULL, retry_strategy = NULL, retry_reason = NULL WHERE provider_turn_id = ? AND attempt_no = ? AND outcome = 'InProgress' RETURNING attempt_no",
                [
                  settledAt,
                  settlement.taxonomyVersion,
                  JSON.stringify(merged),
                  settlement.canonicalEventPrefixJson,
                  settlement.deliveredPosition,
                  settlement.continuationCheckpoint === undefined
                    ? null
                    : JSON.stringify(settlement.continuationCheckpoint),
                  providerTurnId,
                  attemptNo,
                ],
              ),
            );
        if (attemptRows.length !== 1) {
          return yield* Effect.fail<ProviderFailure>({
            _tag: "ProviderFailure",
            kind: "UnknownProviderFailure",
            safeDiagnostic: "provider-attempt-success-cas-rejected",
          });
        }
        const turnRows = yield* run(
          sql.unsafe<{ provider_turn_id: string }>(
            "UPDATE provider_turns SET settled_at = ?, finish_reason = ?, usage_json = ? WHERE provider_turn_id = ? AND settled_at IS NULL RETURNING provider_turn_id",
            [settledAt, finishReason, usageJson, providerTurnId],
          ),
        );
        if (turnRows.length !== 1) {
          return yield* Effect.fail<ProviderFailure>({
            _tag: "ProviderFailure",
            kind: "UnknownProviderFailure",
            safeDiagnostic: "provider-turn-success-cas-rejected",
          });
        }
      }),
    findSettledResult: (providerTurnId) =>
      Effect.gen(function* () {
        yield* TransactionScope;
        const turnRows = yield* run(
          sql.unsafe<SettledTurnRow>(
            "SELECT t.provider_turn_id, t.execution_id, t.session_id, t.context_epoch, t.model_ref, t.output_contract_ref, t.manifest_id, t.execution_policy_json, t.turn_deadline_at, t.settled_at, t.finish_reason, t.usage_json, m.manifest_json FROM provider_turns t LEFT JOIN model_context_manifests m ON m.provider_turn_id = t.provider_turn_id AND m.manifest_id = t.manifest_id WHERE t.provider_turn_id = ?",
            [providerTurnId],
          ),
        );
        const row = turnRows[0];
        if (row === undefined) return { _tag: "NotFound" as const };
        const turn = toRecord(row);
        if (row.settled_at === null || row.finish_reason === null) {
          return { _tag: "Unsettled" as const, turn };
        }
        const columns = yield* run(
          sql.unsafe<{ name: string }>("PRAGMA table_info(provider_attempts)"),
        );
        const hasEvidenceVersion = columns.some(
          (column) => column.name === "success_evidence_version",
        );
        const attempts = hasEvidenceVersion
          ? yield* run(
              sql.unsafe<{
                attempt_no: number;
                canonical_event_prefix_json: string;
                delivered_position: number | null;
                success_evidence_version: string | null;
              }>(
                "SELECT attempt_no, canonical_event_prefix_json, delivered_position, success_evidence_version FROM provider_attempts WHERE provider_turn_id = ? AND outcome = 'Success' ORDER BY attempt_no DESC LIMIT 1",
                [providerTurnId],
              ),
            )
          : [];
        const attempt = attempts[0];
        if (attempt === undefined) {
          return {
            _tag: "SettledFailure" as const,
            turn,
            finishReason: row.finish_reason,
          };
        }
        const evidenceVersion =
          attempt.success_evidence_version === null
            ? "legacy-success-v1"
            : attempt.success_evidence_version;
        if (
          evidenceVersion !== "provider-success-v1" &&
          evidenceVersion !== "legacy-success-v1"
        ) {
          return {
            _tag: "SettledEvidenceInvalid" as const,
            turn,
            reason: "unsupported or missing success evidence version",
          };
        }
        const evidence = successEvidence(
          attempt.canonical_event_prefix_json,
          providerTurnId,
          row.finish_reason,
          attempt.delivered_position,
        );
        if (!evidence.ok || row.manifest_json === null) {
          return {
            _tag: "SettledEvidenceInvalid" as const,
            turn,
            reason: evidence.ok ? "manifest is missing" : evidence.reason,
          };
        }
        return {
          _tag: "SettledSuccess" as const,
          turn,
          manifestId: row.manifest_id,
          manifestJson: row.manifest_json,
          canonicalEvents: evidence.events,
          attemptNo: Number(attempt.attempt_no),
          finishReason: row.finish_reason,
          usageJson: row.usage_json ?? "{}",
          evidenceVersion,
        };
      }),
    adoptSettledSuccessEvidence: (
      providerTurnId,
      attemptNo,
      fromVersion,
      toVersion,
    ) =>
      Effect.gen(function* () {
        yield* TransactionScope;
        if (
          fromVersion !== "legacy-success-v1" ||
          toVersion !== "provider-success-v1"
        ) {
          return yield* Effect.fail<ProviderFailure>({
            _tag: "ProviderFailure",
            kind: "ProtocolViolation",
            safeDiagnostic: "provider-success-evidence-version-invalid",
          });
        }
        const rows = yield* run(
          sql.unsafe<{
            canonical_event_prefix_json: string;
            delivered_position: number | null;
            success_evidence_version: string | null;
            finish_reason: string | null;
          }>(
            "SELECT pa.canonical_event_prefix_json, pa.delivered_position, pa.success_evidence_version, pt.finish_reason FROM provider_attempts pa JOIN provider_turns pt ON pt.provider_turn_id = pa.provider_turn_id WHERE pa.provider_turn_id = ? AND pa.attempt_no = ? AND pa.outcome = 'Success' AND pt.settled_at IS NOT NULL",
            [providerTurnId, attemptNo],
          ),
        );
        const row = rows[0];
        if (row === undefined || row.finish_reason === null) {
          return yield* Effect.fail<ProviderFailure>({
            _tag: "ProviderFailure",
            kind: "ProtocolViolation",
            safeDiagnostic: "provider-legacy-success-evidence-missing",
          });
        }
        if (row.success_evidence_version === toVersion) return;
        if (row.success_evidence_version !== null) {
          return yield* Effect.fail<ProviderFailure>({
            _tag: "ProviderFailure",
            kind: "ProtocolViolation",
            safeDiagnostic: "provider-success-evidence-version-conflict",
          });
        }
        const evidence = successEvidence(
          row.canonical_event_prefix_json,
          providerTurnId,
          row.finish_reason,
          row.delivered_position,
        );
        if (!evidence.ok) {
          return yield* Effect.fail<ProviderFailure>({
            _tag: "ProviderFailure",
            kind: "ProtocolViolation",
            safeDiagnostic: "provider-legacy-success-evidence-invalid",
          });
        }
        const updated = yield* run(
          sql.unsafe<{ attempt_no: number }>(
            "UPDATE provider_attempts SET success_evidence_version = ? WHERE provider_turn_id = ? AND attempt_no = ? AND outcome = 'Success' AND success_evidence_version IS NULL RETURNING attempt_no",
            [toVersion, providerTurnId, attemptNo],
          ),
        );
        if (updated.length !== 1) {
          return yield* Effect.fail<ProviderFailure>({
            _tag: "ProviderFailure",
            kind: "UnknownProviderFailure",
            safeDiagnostic: "provider-success-evidence-adoption-cas-rejected",
          });
        }
      }),
    settleTurn: (providerTurnId, finishReason, usageJson, settledAt) =>
      Effect.gen(function* () {
        yield* TransactionScope;
        const rows = yield* run(
          sql.unsafe<{ provider_turn_id: string }>(
            "UPDATE provider_turns SET settled_at = ?, finish_reason = ?, usage_json = ? WHERE provider_turn_id = ? AND settled_at IS NULL RETURNING provider_turn_id",
            [settledAt, finishReason, usageJson, providerTurnId],
          ),
        );
        if (rows.length !== 1) {
          return yield* Effect.fail<ProviderFailure>({
            _tag: "ProviderFailure",
            kind: "UnknownProviderFailure",
            safeDiagnostic: "provider-turn-settlement-cas-rejected",
          });
        }
      }),
  };
};
