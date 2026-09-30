import type {
  ProviderAttemptObservation,
  ProviderAttemptSummary,
  ProviderContinuationCheckpoint,
  ProviderFailure,
  ProviderFailureTaxonomyVersion,
  ProviderTurnStoreService,
} from "@arbor/ports";
import { TransactionScope } from "@arbor/ports";
import { Effect } from "effect";
import {
  type AttemptRow,
  decodeJson,
  type ProviderTurnStoreDependencies,
  type TurnRow,
  toRecord,
} from "./provider-turn-store-shared.js";
export const PROVIDER_TURN_QUERY_BATCH_SIZE = 500;

export const providerTurnIdBatches = <A>(
  ids: ReadonlyArray<A>,
): ReadonlyArray<ReadonlyArray<A>> => {
  const batches: Array<ReadonlyArray<A>> = [];
  for (
    let start = 0;
    start < ids.length;
    start += PROVIDER_TURN_QUERY_BATCH_SIZE
  ) {
    batches.push(ids.slice(start, start + PROVIDER_TURN_QUERY_BATCH_SIZE));
  }
  return batches;
};

export const makeProviderTurnProjectStore = (
  dependencies: ProviderTurnStoreDependencies,
): Pick<
  ProviderTurnStoreService,
  | "findUnsettledByTurn"
  | "recordRecoveryDecision"
  | "findUnsettledByProject"
  | "failTurn"
  | "listUsageByProject"
> => {
  const { sql, run } = dependencies;
  return {
    findUnsettledByTurn: (providerTurnId) =>
      Effect.gen(function* () {
        yield* TransactionScope;
        const rows = yield* run(
          sql.unsafe<
            TurnRow & {
              readonly execution_policy_json: string | null;
              readonly turn_deadline_at: string | null;
              readonly manifest_json: string | null;
              readonly portable_request_json: string | null;
            }
          >(
            "SELECT t.provider_turn_id, t.execution_id, t.session_id, t.context_epoch, t.model_ref, t.output_contract_ref, t.manifest_id, t.execution_policy_json, t.turn_deadline_at, m.manifest_json, m.portable_request_json FROM provider_turns t LEFT JOIN model_context_manifests m ON m.provider_turn_id = t.provider_turn_id AND m.manifest_id = t.manifest_id WHERE t.provider_turn_id = ? AND t.settled_at IS NULL",
            [providerTurnId],
          ),
        );
        const row = rows[0];
        if (row === undefined) return null;
        const attemptRows = yield* run(
          sql.unsafe<AttemptRow>(
            "SELECT provider_turn_id, attempt_no, outcome, provider_error_kind, failure_taxonomy_version, observation_json, canonical_event_prefix_json, delivered_position, continuation_checkpoint_json, retry_safety, retry_decision, retry_strategy, retry_reason FROM provider_attempts WHERE provider_turn_id = ? ORDER BY attempt_no",
            [providerTurnId],
          ),
        );
        const attempts: Array<ProviderAttemptSummary> = attemptRows.map(
          (attempt) => ({
            attemptNo: Number(attempt.attempt_no),
            outcome: attempt.outcome as ProviderAttemptSummary["outcome"],
            providerErrorKind: attempt.provider_error_kind,
            taxonomyVersion:
              attempt.failure_taxonomy_version as ProviderFailureTaxonomyVersion,
            observation: decodeJson<ProviderAttemptObservation | null>(
              attempt.observation_json,
              null,
            ),
            continuationCheckpoint:
              attempt.continuation_checkpoint_json === null
                ? null
                : decodeJson<ProviderContinuationCheckpoint | null>(
                    attempt.continuation_checkpoint_json,
                    null,
                  ),
            retryDecision:
              attempt.retry_safety === null ||
              attempt.retry_decision === null ||
              attempt.retry_reason === null
                ? null
                : {
                    safety: attempt.retry_safety as
                      | "SafeReplay"
                      | "SafeResume"
                      | "UnsafeReplay",
                    decision: attempt.retry_decision as "Retry" | "Stop",
                    strategy:
                      attempt.retry_strategy === null
                        ? null
                        : (attempt.retry_strategy as "Replay" | "Resume"),
                    reason: attempt.retry_reason,
                  },
            canonicalEventPrefixJson: attempt.canonical_event_prefix_json,
            deliveredPosition: attempt.delivered_position,
          }),
        );
        return {
          turn: toRecord(row),
          attempts,
          manifestJson: row.manifest_json,
          portableRequestJson: row.portable_request_json,
        };
      }),
    recordRecoveryDecision: (providerTurnId, evidence) =>
      Effect.gen(function* () {
        yield* TransactionScope;
        const causeDetail =
          evidence.cause._tag === "ProviderFailure"
            ? evidence.cause.kind
            : evidence.cause._tag === "Timeout"
              ? evidence.cause.phase
              : null;
        yield* run(
          sql.unsafe(
            "INSERT INTO provider_recovery_decisions (provider_turn_id, sequence_no, attempt_no, cause_tag, cause_detail, retry_safety, retry_decision, retry_strategy, retry_reason, decided_at) VALUES (?, (SELECT COALESCE(MAX(sequence_no), -1) + 1 FROM provider_recovery_decisions WHERE provider_turn_id = ?), ?, ?, ?, ?, ?, ?, ?, ?)",
            [
              providerTurnId,
              providerTurnId,
              evidence.attemptNo,
              evidence.cause._tag,
              causeDetail,
              evidence.retryDecision.safety,
              evidence.retryDecision.decision,
              evidence.retryDecision.strategy,
              evidence.retryDecision.reason,
              evidence.decidedAt,
            ],
          ),
        );
      }),
    findUnsettledByProject: (projectId) =>
      Effect.gen(function* () {
        yield* TransactionScope;
        const turnRows = yield* run(
          sql.unsafe<
            TurnRow & {
              readonly manifest_json: string | null;
              readonly portable_request_json: string | null;
            }
          >(
            "SELECT pt.provider_turn_id, pt.execution_id, pt.session_id, pt.context_epoch, pt.model_ref, pt.output_contract_ref, pt.manifest_id, pt.execution_policy_json, pt.turn_deadline_at, m.manifest_json, m.portable_request_json FROM provider_turns pt LEFT JOIN model_context_manifests m ON m.provider_turn_id = pt.provider_turn_id AND m.manifest_id = pt.manifest_id JOIN executions e ON e.execution_id = pt.execution_id WHERE e.project_id = ? AND pt.settled_at IS NULL ORDER BY pt.started_at, pt.provider_turn_id",
            [projectId],
          ),
        );
        if (turnRows.length === 0) {
          return [];
        }
        const attemptRows: AttemptRow[] = [];
        for (const ids of providerTurnIdBatches(
          turnRows.map((row) => row.provider_turn_id),
        )) {
          const placeholders = ids.map(() => "?").join(",");
          const batch = yield* run(
            sql.unsafe<AttemptRow>(
              `SELECT provider_turn_id, attempt_no, outcome, provider_error_kind, failure_taxonomy_version, observation_json, canonical_event_prefix_json, delivered_position, continuation_checkpoint_json, retry_safety, retry_decision, retry_strategy, retry_reason FROM provider_attempts WHERE provider_turn_id IN (${placeholders}) ORDER BY provider_turn_id, attempt_no`,
              ids,
            ),
          );
          attemptRows.push(...batch);
        }
        const attemptsByTurn = new Map<
          string,
          Array<{
            readonly attemptNo: number;
            readonly outcome:
              | "InProgress"
              | "Success"
              | "RetryableFailure"
              | "TerminalFailure"
              | "Cancelled"
              | "TimedOut";
            readonly providerErrorKind: string | null;
            readonly taxonomyVersion: ProviderFailureTaxonomyVersion;
            readonly observation: ProviderAttemptObservation | null;
            readonly continuationCheckpoint: ProviderContinuationCheckpoint | null;
            readonly retryDecision: {
              readonly safety: "SafeReplay" | "SafeResume" | "UnsafeReplay";
              readonly decision: "Retry" | "Stop";
              readonly strategy: "Replay" | "Resume" | null;
              readonly reason: string;
            } | null;
            readonly canonicalEventPrefixJson: string;
            readonly deliveredPosition: number | null;
          }>
        >();
        for (const row of attemptRows) {
          const list = attemptsByTurn.get(row.provider_turn_id) ?? [];
          list.push({
            attemptNo: Number(row.attempt_no),
            outcome: row.outcome as
              | "InProgress"
              | "Success"
              | "RetryableFailure"
              | "TerminalFailure"
              | "Cancelled"
              | "TimedOut",
            providerErrorKind: row.provider_error_kind,
            taxonomyVersion:
              row.failure_taxonomy_version as ProviderFailureTaxonomyVersion,
            observation: decodeJson<ProviderAttemptObservation | null>(
              row.observation_json,
              null,
            ),
            continuationCheckpoint:
              row.continuation_checkpoint_json === null
                ? null
                : decodeJson<ProviderContinuationCheckpoint | null>(
                    row.continuation_checkpoint_json,
                    null,
                  ),
            retryDecision:
              row.retry_safety === null ||
              row.retry_decision === null ||
              row.retry_reason === null
                ? null
                : {
                    safety: row.retry_safety as
                      | "SafeReplay"
                      | "SafeResume"
                      | "UnsafeReplay",
                    decision: row.retry_decision as "Retry" | "Stop",
                    strategy:
                      row.retry_strategy === null
                        ? null
                        : (row.retry_strategy as "Replay" | "Resume"),
                    reason: row.retry_reason,
                  },
            canonicalEventPrefixJson: row.canonical_event_prefix_json,
            deliveredPosition: row.delivered_position,
          });
          attemptsByTurn.set(row.provider_turn_id, list);
        }
        return turnRows.map((row) => ({
          turn: toRecord(row),
          attempts: attemptsByTurn.get(row.provider_turn_id) ?? [],
          manifestJson: row.manifest_json,
          portableRequestJson: row.portable_request_json,
        }));
      }),
    failTurn: (providerTurnId, settledAt) =>
      Effect.gen(function* () {
        yield* TransactionScope;
        const rows = yield* run(
          sql.unsafe<{ provider_turn_id: string }>(
            "UPDATE provider_turns SET settled_at = ?, finish_reason = 'Failed', usage_json = '{}' WHERE provider_turn_id = ? AND settled_at IS NULL RETURNING provider_turn_id",
            [settledAt, providerTurnId],
          ),
        );
        if (rows.length !== 1) {
          return yield* Effect.fail<ProviderFailure>({
            _tag: "ProviderFailure",
            kind: "UnknownProviderFailure",
            safeDiagnostic: "provider-turn-failure-cas-rejected",
          });
        }
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
};
