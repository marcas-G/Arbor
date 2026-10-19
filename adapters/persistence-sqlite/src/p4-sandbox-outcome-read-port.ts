import type { ExecutionId } from "@arbor/domain";
import {
  P4SandboxOutcomeReadPort,
  type P4SandboxOutcomeReadPortService,
  type P4SandboxUnavailableObservationV1,
  type ToolObservationEvidenceStoreError,
} from "@arbor/ports";
import { Effect, Layer } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";
import {
  persistenceCorruption,
  repositoryFailure,
} from "./repository-error.js";
import { decodeToolObservationEvidence } from "./tool-observation-evidence-codec.js";

const SUMMARY =
  "required sandbox capability was unavailable or could not be verified; execution did not start" as const;

interface SandboxOutcomeRow {
  readonly invocation_id: string;
  readonly execution_id: string;
  readonly workspace_id: string;
  readonly effect_admission_state: string;
  readonly settled_at: string | null;
  readonly settlement_kind: string | null;
  readonly result_ref: string | null;
  readonly observation_format_version: string | null;
  readonly observation_json: Uint8Array | string | null;
  readonly observation_sha256: string | null;
}

const makeLayer = () =>
  Layer.effect(
    P4SandboxOutcomeReadPort,
    Effect.gen(function* () {
      const sql = yield* SqlClient;
      const run = <A>(effect: Effect.Effect<A, SqlError>) =>
        effect.pipe(
          Effect.mapError(
            repositoryFailure(
              "ToolObservationEvidenceStore",
              "sandbox-view-read",
            ),
          ),
        );

      const findUnavailableByExecutionAndRevision: P4SandboxOutcomeReadPortService["findUnavailableByExecutionAndRevision"] =
        (executionId, policyRevision) =>
          Effect.gen(function* () {
            if (!Number.isSafeInteger(policyRevision) || policyRevision < 1) {
              return yield* Effect.fail<ToolObservationEvidenceStoreError>(
                persistenceCorruption(
                  "ToolObservationEvidenceStore",
                  "sandbox-view-read",
                  "policy revision is malformed",
                ),
              );
            }
            const rows = yield* run(
              sql.unsafe<SandboxOutcomeRow>(
                `SELECT invocation_id, execution_id, workspace_id,
                        effect_admission_state, settled_at, settlement_kind,
                        result_ref, observation_format_version,
                        observation_json, observation_sha256
                   FROM tool_invocations
                  WHERE execution_id = ? AND settlement_kind = 'ExpectedFailure'
                    AND settled_at IS NOT NULL AND result_ref IS NULL
                    AND json_valid(CAST(observation_json AS TEXT))
                    AND json_extract(CAST(observation_json AS TEXT),
                         '$.sandboxProviderUnavailable.policyRevision') = ?
                  ORDER BY settled_at, invocation_id`,
                [executionId, policyRevision],
              ),
            );
            const result: P4SandboxUnavailableObservationV1[] = [];
            for (const row of rows) {
              const bytes =
                typeof row.observation_json === "string"
                  ? new TextEncoder().encode(row.observation_json)
                  : row.observation_json;
              if (
                bytes === null ||
                row.effect_admission_state !== "MayHaveStarted" ||
                row.settled_at === null ||
                row.settlement_kind !== "ExpectedFailure"
              ) {
                return yield* Effect.fail<ToolObservationEvidenceStoreError>(
                  persistenceCorruption(
                    "ToolObservationEvidenceStore",
                    "sandbox-view-read",
                    "provider-unavailable P4 observation is not terminal MayHaveStarted ExpectedFailure",
                  ),
                );
              }
              const decoded = decodeToolObservationEvidence({
                formatVersion: row.observation_format_version,
                bytes,
                sha256: row.observation_sha256,
                settlement: { _tag: "ExpectedFailure" },
                resultRef: row.result_ref,
              });
              if (
                decoded._tag !== "Decoded" ||
                decoded.evidence.observation._tag !== "ExpectedFailure" ||
                decoded.evidence.observation.sandboxProviderUnavailable ===
                  undefined ||
                decoded.evidence.observation.observation.text !== SUMMARY ||
                decoded.evidence.observation.observation.truncated
              ) {
                return yield* Effect.fail<ToolObservationEvidenceStoreError>(
                  persistenceCorruption(
                    "ToolObservationEvidenceStore",
                    "sandbox-view-read",
                    "provider-unavailable P4 observation failed strict decoding or safe-summary validation",
                  ),
                );
              }
              result.push({
                ...decoded.evidence.observation.sandboxProviderUnavailable,
                invocationId: row.invocation_id,
                executionId: row.execution_id as ExecutionId,
                workspaceId: row.workspace_id as never,
                summary: SUMMARY,
              });
            }
            return result;
          });

      return P4SandboxOutcomeReadPort.of({
        findUnavailableByExecutionAndRevision,
      });
    }),
  );

export const P4SandboxOutcomeReadPortLive = makeLayer();
