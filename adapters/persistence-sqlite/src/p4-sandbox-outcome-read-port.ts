import { type ExecutionId, parse, ToolInvocationId } from "@arbor/domain";
import {
  canonicalArgumentsDigestV1,
  P4SandboxOutcomeReadPort,
  type P4SandboxOutcomeReadPortService,
  type P4SandboxUnavailableObservationV1,
  sha256Hex,
  type ToolObservationEvidenceStoreError,
  verifyRecoveryBindingV1,
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
  readonly recovery_binding_state: string;
  readonly recovery_binding_sha256: string | null;
  readonly binding_version: number | null;
  readonly canonical_binding_json: string | null;
  readonly binding_sha256: string | null;
  readonly arguments_json: string;
  readonly tool_name: string;
  readonly tool_version: string;
  readonly side_effect_semantics: string;
  readonly action_state: string;
  readonly action_route_kind: string;
  readonly action_kind: string;
  readonly action_input_hash: string;
  readonly action_logical_id: string;
  readonly action_index: number;
  readonly action_call_ref: string;
  readonly step_provider_turn_id: string;
  readonly step_state: string;
  readonly step_next_action_index: number;
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
                `SELECT i.invocation_id, i.execution_id, i.workspace_id,
                        i.effect_admission_state, i.settled_at, i.settlement_kind,
                        i.result_ref, i.observation_format_version,
                        i.observation_json, i.observation_sha256,
                        i.recovery_binding_state, i.recovery_binding_sha256,
                        b.binding_version, b.canonical_binding_json, b.binding_sha256,
                        i.arguments_json, i.tool_name, i.tool_version,
                        i.side_effect_semantics, a.state AS action_state,
                        a.route_kind AS action_route_kind,
                        a.action_kind AS action_kind, a.input_hash AS action_input_hash,
                        a.logical_action_id AS action_logical_id,
                        a.action_index AS action_index, a.call_ref AS action_call_ref,
                        s.provider_turn_id AS step_provider_turn_id,
                        s.state AS step_state, s.next_action_index AS step_next_action_index
                   FROM tool_invocations i
                   JOIN executions e ON e.execution_id = i.execution_id
                    AND e.workspace_id = i.workspace_id
                   JOIN tool_invocation_recovery_bindings b
                    ON b.invocation_id = i.invocation_id
                   JOIN agent_loop_step_actions a
                    ON a.execution_id = i.execution_id
                   AND a.logical_action_id = CASE WHEN json_valid(b.canonical_binding_json)
                     THEN json_extract(b.canonical_binding_json, '$.logicalActionId') ELSE NULL END
                   AND a.action_index = CASE WHEN json_valid(b.canonical_binding_json)
                     THEN json_extract(b.canonical_binding_json, '$.actionIndex') ELSE NULL END
                   AND a.call_ref = CASE WHEN json_valid(b.canonical_binding_json)
                     THEN json_extract(b.canonical_binding_json, '$.callRef') ELSE NULL END
                   JOIN agent_loop_steps s
                    ON s.execution_id = a.execution_id
                   AND s.logical_step_no = a.logical_step_no
                   AND s.repair_attempt = a.repair_attempt
                  WHERE i.execution_id = ? AND i.settlement_kind = 'ExpectedFailure'
                    AND i.settled_at IS NOT NULL AND i.result_ref IS NULL
                    AND e.settled_at IS NULL AND e.stop_requested_at IS NULL
                    AND a.state = 'Pending' AND a.route_kind = 'Executable'
                    AND s.state = 'ActionsInProgress'
                    AND s.next_action_index = a.action_index
                    AND json_valid(CAST(observation_json AS TEXT))
                    AND json_extract(CAST(observation_json AS TEXT),
                         '$.sandboxProviderUnavailable.policyRevision') = ?
                  ORDER BY i.settled_at, i.invocation_id`,
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
              const verified =
                row.binding_version === 1 &&
                row.canonical_binding_json !== null &&
                row.binding_sha256 !== null
                  ? verifyRecoveryBindingV1({
                      invocationId: parse(ToolInvocationId)(row.invocation_id),
                      canonicalJson: row.canonical_binding_json,
                      bindingSha256: row.binding_sha256,
                    })
                  : null;
              const binding = verified?.value;
              let argumentsDigest: string | null = null;
              try {
                argumentsDigest = canonicalArgumentsDigestV1(
                  JSON.parse(row.arguments_json) as unknown,
                );
              } catch {
                // Missing/unparseable exact intent bytes fail the proof below.
              }
              if (
                row.recovery_binding_state !== "Bound" ||
                row.recovery_binding_sha256 !== row.binding_sha256 ||
                binding === undefined ||
                binding === null ||
                binding.executionId !== row.execution_id ||
                binding.invocationId !== row.invocation_id ||
                binding.toolName !== row.tool_name ||
                binding.toolVersion !== row.tool_version ||
                binding.sideEffectSemantics !== row.side_effect_semantics ||
                binding.canonicalArgumentsDigest !== argumentsDigest ||
                row.action_state !== "Pending" ||
                row.action_route_kind !== "Executable" ||
                row.action_kind !== row.tool_name ||
                row.action_input_hash !== sha256Hex(row.arguments_json) ||
                row.action_logical_id !== binding.logicalActionId ||
                row.action_index !== binding.actionIndex ||
                row.action_call_ref !== binding.callRef ||
                row.step_provider_turn_id !== binding.providerTurnId ||
                row.step_state !== "ActionsInProgress" ||
                row.step_next_action_index !== binding.actionIndex
              ) {
                return yield* Effect.fail<ToolObservationEvidenceStoreError>(
                  persistenceCorruption(
                    "ToolObservationEvidenceStore",
                    "sandbox-view-read",
                    "provider-unavailable P4 observation is not bound to the exact pending P3 action",
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
