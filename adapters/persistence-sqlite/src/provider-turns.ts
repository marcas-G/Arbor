import type { ProjectId, ProviderTurnId } from "@arbor/domain";
import {
  type CanonicalProviderEvent,
  type ProviderAttemptObservation,
  type ProviderAttemptSummary,
  type ProviderContinuationCheckpoint,
  type ProviderFailure,
  type ProviderFailureTaxonomyVersion,
  type ProviderRuntimeExecutionPolicy,
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
  readonly execution_policy_json?: string | null;
  readonly turn_deadline_at?: string | null;
}

interface AttemptRow {
  readonly provider_turn_id: string;
  readonly attempt_no: number;
  readonly outcome: string;
  readonly provider_error_kind: string | null;
  readonly failure_taxonomy_version: string;
  readonly observation_json: string;
  readonly canonical_event_prefix_json: string;
  readonly delivered_position: number | null;
  readonly continuation_checkpoint_json: string | null;
  readonly retry_safety: string | null;
  readonly retry_decision: string | null;
  readonly retry_strategy: string | null;
  readonly retry_reason: string | null;
}

interface SettledTurnRow extends TurnRow {
  readonly settled_at: string | null;
  readonly finish_reason: string | null;
  readonly usage_json: string | null;
  readonly manifest_json: string | null;
}

const successEvidence = (
  canonicalEventPrefixJson: string,
  providerTurnId: ProviderTurnId,
  finishReason: string,
  deliveredPosition: number | null,
):
  | {
      readonly ok: true;
      readonly events: ReadonlyArray<CanonicalProviderEvent>;
    }
  | { readonly ok: false; readonly reason: string } => {
  let events: ReadonlyArray<CanonicalProviderEvent>;
  try {
    const parsed = JSON.parse(canonicalEventPrefixJson) as unknown;
    if (!Array.isArray(parsed)) {
      return { ok: false, reason: "canonical events are not an array" };
    }
    events = parsed as ReadonlyArray<CanonicalProviderEvent>;
  } catch {
    return { ok: false, reason: "canonical events are not valid JSON" };
  }
  if (events.length === 0 || deliveredPosition !== events.length) {
    return { ok: false, reason: "canonical event sequence is incomplete" };
  }
  const first = events[0];
  const last = events.at(-1);
  const terminalCount = events.filter(
    (event) => event._tag === "TurnCompleted" || event._tag === "TurnFailed",
  ).length;
  if (
    first?._tag !== "TurnStarted" ||
    first.providerTurnId !== providerTurnId ||
    last?._tag !== "TurnCompleted" ||
    last.finishReason !== finishReason ||
    terminalCount !== 1
  ) {
    return { ok: false, reason: "canonical terminal evidence is inconsistent" };
  }
  return { ok: true, events };
};

const UNKNOWN_OBSERVATION: ProviderAttemptObservation = {
  responseStarted: null,
  canonicalEventEmitted: null,
  consumerVisibleOutput: null,
  toolCallProposed: null,
  continuationAvailable: null,
  externalEffectPossible: null,
};
const UNKNOWN_OBSERVATION_JSON = JSON.stringify(UNKNOWN_OBSERVATION);

const decodeJson = <A>(value: string, fallback: A): A => {
  try {
    return JSON.parse(value) as A;
  } catch {
    return fallback;
  }
};

const mergeObservation = (
  current: ProviderAttemptObservation,
  next: ProviderAttemptObservation,
): ProviderAttemptObservation => {
  const merged = { ...current };
  for (const key of [
    "responseStarted",
    "canonicalEventEmitted",
    "consumerVisibleOutput",
    "toolCallProposed",
    "continuationAvailable",
    "externalEffectPossible",
  ] as const) {
    if (current[key] === true && next[key] !== true) {
      throw new Error(`provider observation ${key} is not monotonic`);
    }
    merged[key] = next[key];
  }
  return merged;
};

const toRecord = (row: TurnRow): ProviderTurnRecord => ({
  providerTurnId: row.provider_turn_id as ProviderTurnId,
  executionId: row.execution_id as never,
  sessionId: row.session_id as never,
  contextEpoch: row.context_epoch as never,
  modelRef: row.model_ref,
  outputContractRef: row.output_contract_ref,
  manifestId: row.manifest_id,
  ...(row.execution_policy_json === null ||
  row.execution_policy_json === undefined
    ? {}
    : (() => {
        const executionPolicy =
          decodeJson<ProviderRuntimeExecutionPolicy | null>(
            row.execution_policy_json,
            null,
          );
        return executionPolicy === null ? {} : { executionPolicy };
      })()),
  ...(row.turn_deadline_at === null || row.turn_deadline_at === undefined
    ? {}
    : { turnDeadlineAt: row.turn_deadline_at }),
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
      safeDiagnostic:
        typeof cause === "object" &&
        cause !== null &&
        "_tag" in cause &&
        typeof (cause as { readonly _tag: unknown })._tag === "string"
          ? `sqlite-${String((cause as { readonly _tag: string })._tag)}`
          : "sqlite-provider-turn-store",
    });
    const run = <A>(effect: Effect.Effect<A, SqlError>) =>
      effect.pipe(Effect.mapError(failure));
    const store: ProviderTurnStoreService = {
      startTurnWithManifest: (
        record,
        manifestJson,
        portableRequestJson,
        startedAt,
      ) =>
        Effect.gen(function* () {
          yield* TransactionScope;
          const manifest = decodeJson<{
            readonly providerTurnId?: string;
            readonly executionId?: string;
            readonly sessionId?: string;
            readonly contextEpoch?: number;
            readonly modelRef?: string;
            readonly outputContractRef?: string;
            readonly compiledRequestHash?: string;
          } | null>(manifestJson, null);
          if (
            manifest === null ||
            manifest.providerTurnId !== record.providerTurnId ||
            manifest.executionId !== record.executionId ||
            manifest.sessionId !== record.sessionId ||
            manifest.contextEpoch !== record.contextEpoch ||
            manifest.modelRef !== record.modelRef ||
            manifest.outputContractRef !== record.outputContractRef ||
            typeof manifest.compiledRequestHash !== "string"
          ) {
            return yield* Effect.fail<ProviderFailure>({
              _tag: "ProviderFailure",
              kind: "UnknownProviderFailure",
              safeDiagnostic: "manifest-identity-mismatch",
            });
          }
          yield* run(
            sql.unsafe(
              "INSERT INTO provider_turns (provider_turn_id, execution_id, session_id, context_epoch, model_ref, output_contract_ref, manifest_id, started_at, settled_at, finish_reason, usage_json, created_at, execution_policy_json, turn_deadline_at) VALUES (?,?,?,?,?,?,?,?,NULL,NULL,NULL,?,?,?)",
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
                JSON.stringify(record.executionPolicy ?? null),
                record.turnDeadlineAt ?? null,
              ],
            ),
          );
          yield* run(
            sql.unsafe(
              "INSERT INTO model_context_manifests (manifest_id, provider_turn_id, execution_id, session_id, context_epoch, model_ref, compiled_request_hash, manifest_json, created_at, portable_request_json) VALUES (?,?,?,?,?,?,?,?,?,?)",
              [
                record.manifestId,
                record.providerTurnId,
                record.executionId,
                record.sessionId,
                record.contextEpoch,
                record.modelRef,
                manifest.compiledRequestHash,
                manifestJson,
                startedAt,
                portableRequestJson,
              ],
            ),
          );
          return {
            providerTurnId: record.providerTurnId,
            manifestId: record.manifestId,
          };
        }),
      findManifestByTurn: (providerTurnId) =>
        Effect.gen(function* () {
          yield* TransactionScope;
          const rows = yield* run(
            sql.unsafe<{
              manifest_id: string;
              manifest_json: string;
              portable_request_json: string | null;
            }>(
              "SELECT m.manifest_id, m.manifest_json, m.portable_request_json FROM provider_turns t JOIN model_context_manifests m ON m.provider_turn_id = t.provider_turn_id AND m.manifest_id = t.manifest_id WHERE t.provider_turn_id = ?",
              [providerTurnId],
            ),
          );
          const row = rows[0];
          return row === undefined || row.portable_request_json === null
            ? null
            : {
                manifestId: row.manifest_id,
                manifestJson: row.manifest_json,
                portableRequestJson: row.portable_request_json,
              };
        }),
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
            sql.unsafe<{ name: string }>(
              "PRAGMA table_info(provider_attempts)",
            ),
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
            sql.unsafe<{ name: string }>(
              "PRAGMA table_info(provider_attempts)",
            ),
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
          const placeholders = turnRows.map(() => "?").join(",");
          const attemptRows = yield* run(
            sql.unsafe<AttemptRow>(
              `SELECT provider_turn_id, attempt_no, outcome, provider_error_kind, failure_taxonomy_version, observation_json, canonical_event_prefix_json, delivered_position, continuation_checkpoint_json, retry_safety, retry_decision, retry_strategy, retry_reason FROM provider_attempts WHERE provider_turn_id IN (${placeholders}) ORDER BY attempt_no`,
              turnRows.map((row) => row.provider_turn_id),
            ),
          );
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
    return ProviderTurnStore.of(store);
  }),
);

export type { ProjectId, ProviderTurnId };
