import { ProviderTurnId as ProviderTurnIdSchema, parse } from "@arbor/domain";
import type {
  ContextEpochNumber,
  ProviderFailure,
  ProviderTurnRecord,
  ProviderTurnStoreService,
  SessionId,
} from "@arbor/ports";
import {
  PROVIDER_TURN_ADMISSION_EXECUTION_STOPPING,
  TransactionScope,
} from "@arbor/ports";
import { Effect } from "effect";
import {
  decodeJson,
  type ProviderTurnStoreDependencies,
} from "./provider-turn-store-shared.js";

export const makeProviderTurnIntentStore = (
  dependencies: ProviderTurnStoreDependencies,
): Pick<
  ProviderTurnStoreService,
  | "startTurnWithManifest"
  | "findManifestByTurn"
  | "findNativeCompactionsBySessionEpoch"
  | "startTurn"
> => {
  const { sql, run } = dependencies;
  return {
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
        const inserted = yield* run(
          sql.unsafe<{ provider_turn_id: string }>(
            `INSERT INTO provider_turns (
               provider_turn_id, execution_id, session_id, context_epoch,
               model_ref, output_contract_ref, manifest_id, started_at,
               settled_at, finish_reason, usage_json, created_at,
               execution_policy_json, turn_deadline_at
             )
             SELECT ?,?,?,?,?,?,?,?,NULL,NULL,NULL,?,?,?
               FROM executions
              WHERE execution_id = ?
                AND stop_requested_at IS NULL
                AND settled_at IS NULL
             RETURNING provider_turn_id`,
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
              record.executionId,
            ],
          ),
        );
        if (inserted.length === 0) {
          const executions = yield* run(
            sql.unsafe<{
              stop_requested_at: string | null;
              settled_at: string | null;
            }>(
              "SELECT stop_requested_at, settled_at FROM executions WHERE execution_id = ?",
              [record.executionId],
            ),
          );
          const execution = executions[0];
          return yield* Effect.fail<ProviderFailure>({
            _tag: "ProviderFailure",
            kind: "UnknownProviderFailure",
            safeDiagnostic:
              execution !== undefined && execution.stop_requested_at !== null
                ? PROVIDER_TURN_ADMISSION_EXECUTION_STOPPING
                : execution !== undefined && execution.settled_at !== null
                  ? "provider-turn-admission-execution-settled"
                  : "provider-turn-admission-execution-missing",
          });
        }
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
            owning_provider_turn_id: string | null;
          }>(
            `SELECT m.manifest_id, m.manifest_json, m.portable_request_json,
                    t.provider_turn_id AS owning_provider_turn_id
               FROM model_context_manifests m
               LEFT JOIN provider_turns t
                 ON t.provider_turn_id = m.provider_turn_id
                AND t.manifest_id = m.manifest_id
              WHERE m.provider_turn_id = ?
              ORDER BY m.manifest_id`,
            [providerTurnId],
          ),
        );
        const row = rows[0];
        if (row === undefined) return null;
        if (
          rows.length !== 1 ||
          row.owning_provider_turn_id !== providerTurnId
        ) {
          return yield* Effect.fail<ProviderFailure>({
            _tag: "ProviderFailure",
            kind: "ProtocolViolation",
            taxonomyVersion: "phase1-v2",
            safeDiagnostic: "provider-turn-manifest-orphaned-or-ambiguous",
          });
        }
        return row.portable_request_json === null
          ? null
          : {
              manifestId: row.manifest_id,
              manifestJson: row.manifest_json,
              portableRequestJson: row.portable_request_json,
            };
      }),
    findNativeCompactionsBySessionEpoch: (input) =>
      Effect.gen(function* () {
        yield* TransactionScope;
        const rows = yield* run(
          sql.unsafe<{
            provider_turn_id: string;
            manifest_id: string;
            execution_id: string;
            session_id: string;
            context_epoch: number;
            model_ref: string;
            output_contract_ref: string;
            manifest_json: string;
            portable_request_json: string | null;
            owning_provider_turn_id: string | null;
          }>(
            `SELECT m.provider_turn_id, m.manifest_id, m.execution_id,
                    m.session_id, m.context_epoch, m.model_ref,
                    t.output_contract_ref, m.manifest_json,
                    m.portable_request_json,
                    t.provider_turn_id AS owning_provider_turn_id
               FROM model_context_manifests m
               JOIN provider_turns t
                 ON t.provider_turn_id = m.provider_turn_id
                AND t.manifest_id = m.manifest_id
              WHERE m.session_id = ?
                AND m.context_epoch = ?
                AND json_extract(m.manifest_json, '$.operationKind') = 'CompactionNative'
              ORDER BY m.created_at, m.provider_turn_id`,
            [input.sessionId, input.contextEpoch],
          ),
        );
        if (
          rows.some(
            (row) =>
              row.owning_provider_turn_id !== row.provider_turn_id ||
              row.portable_request_json === null,
          )
        ) {
          return yield* Effect.fail<ProviderFailure>({
            _tag: "ProviderFailure",
            kind: "ProtocolViolation",
            taxonomyVersion: "phase1-v2",
            safeDiagnostic: "native-source-manifest-orphaned-or-incomplete",
          });
        }
        const decodedRows = rows.flatMap((row) => {
          try {
            return [
              {
                row,
                providerTurnId: parse(ProviderTurnIdSchema)(
                  row.provider_turn_id,
                ),
              },
            ];
          } catch {
            return [];
          }
        });
        if (decodedRows.length !== rows.length) {
          return yield* Effect.fail<ProviderFailure>({
            _tag: "ProviderFailure",
            kind: "ProtocolViolation",
            taxonomyVersion: "phase1-v2",
            safeDiagnostic: "persisted-provider-turn-id-invalid",
          });
        }
        return decodedRows.map(({ row, providerTurnId }) => ({
          providerTurnId,
          manifestId: row.manifest_id,
          executionId: row.execution_id,
          sessionId: row.session_id as SessionId,
          contextEpoch: row.context_epoch as ContextEpochNumber,
          modelRef: row.model_ref,
          outputContractRef: row.output_contract_ref,
          manifestJson: row.manifest_json,
          portableRequestJson: row.portable_request_json as string,
        }));
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
  };
};
