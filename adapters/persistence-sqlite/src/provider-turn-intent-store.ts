import type {
  ProviderFailure,
  ProviderTurnRecord,
  ProviderTurnStoreService,
} from "@arbor/ports";
import { TransactionScope } from "@arbor/ports";
import { Effect } from "effect";
import {
  decodeJson,
  type ProviderTurnStoreDependencies,
} from "./provider-turn-store-shared.js";

export const makeProviderTurnIntentStore = (
  dependencies: ProviderTurnStoreDependencies,
): Pick<
  ProviderTurnStoreService,
  "startTurnWithManifest" | "findManifestByTurn" | "startTurn"
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
