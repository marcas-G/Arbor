import {
  type CanonicalResourceRegion,
  decodeCanonicalExecutionEpisodeBinding,
  type ExecutionId,
  type ProjectId,
  parse,
  ToolInvocationId,
  type WorkspaceId,
} from "@arbor/domain";
import {
  canonicalArgumentsDigestV1,
  SandboxPolicyRequirementReadPort,
  type SandboxPolicyRequirementReadPortService,
  sha256Hex,
  type ToolObservationEvidenceStoreError,
  targetResourceIdentityDigestV1,
  verifyRecoveryBindingV1,
} from "@arbor/ports";
import { Effect, Layer, Option } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";
import {
  persistenceCorruption,
  repositoryFailure,
} from "./repository-error.js";

interface RequirementRow {
  readonly project_id: string;
  readonly workspace_id: string;
  readonly execution_id: string;
  readonly episode_revision: number;
  readonly episode_json: string | null;
  readonly invocation_id: string;
  readonly recovery_binding_state: string;
  readonly recovery_binding_sha256: string | null;
  readonly effect_admission_state: string;
  readonly settled_at: string | null;
  readonly tool_name: string;
  readonly tool_version: string;
  readonly side_effect_semantics: string;
  readonly arguments_json: string;
  readonly resolved_regions_json: string;
  readonly binding_version: number | null;
  readonly canonical_binding_json: string | null;
  readonly binding_sha256: string | null;
  readonly binding_profile_id: string | null;
  readonly action_state: string | null;
  readonly action_route_kind: string | null;
  readonly action_kind: string | null;
  readonly action_input_hash: string | null;
  readonly action_logical_id: string | null;
  readonly action_index: number | null;
  readonly action_call_ref: string | null;
  readonly action_logical_step_no: number | null;
  readonly action_repair_attempt: number | null;
  readonly step_provider_turn_id: string | null;
  readonly step_state: string | null;
  readonly step_next_action_index: number | null;
}

interface EffectAttemptRow {
  readonly attempt_no: number;
  readonly admission_state: string;
  readonly side_effect_semantics: string;
  readonly profile_id: string | null;
  readonly profile_version: string | null;
  readonly profile_hash: string | null;
  readonly profile_protocol: string | null;
  readonly effect_key: string | null;
  readonly binding_sha256: string | null;
}

const REPOSITORY = "ToolObservationEvidenceStore" as const;
const OPERATION = "sandbox-policy-requirement-read";

const makeLayer = () =>
  Layer.effect(
    SandboxPolicyRequirementReadPort,
    Effect.gen(function* () {
      const sql = yield* SqlClient;
      const run = <A>(effect: Effect.Effect<A, SqlError>) =>
        effect.pipe(Effect.mapError(repositoryFailure(REPOSITORY, OPERATION)));
      const failCorrupt = (reason: string) =>
        Effect.fail<ToolObservationEvidenceStoreError>(
          persistenceCorruption(REPOSITORY, OPERATION, reason),
        );

      const findPendingByExecution: SandboxPolicyRequirementReadPortService["findPendingByExecution"] =
        (input) =>
          Effect.gen(function* () {
            const rows = yield* run(
              sql.unsafe<RequirementRow>(
                `SELECT e.project_id, e.workspace_id, e.execution_id,
                        e.episode_revision, es.episode_json,
                        i.invocation_id, i.recovery_binding_state,
                        i.recovery_binding_sha256, i.effect_admission_state,
                        i.settled_at, i.tool_name, i.tool_version,
                        i.side_effect_semantics, i.arguments_json,
                        i.resolved_regions_json,
                        b.binding_version, b.canonical_binding_json,
                        b.binding_sha256,
                        CASE WHEN b.canonical_binding_json IS NOT NULL
                                  AND json_valid(b.canonical_binding_json)
                             THEN json_extract(b.canonical_binding_json, '$.profileId')
                             ELSE NULL END AS binding_profile_id,
                        a.state AS action_state, a.route_kind AS action_route_kind,
                        a.action_kind AS action_kind, a.input_hash AS action_input_hash,
                        a.logical_action_id AS action_logical_id,
                        a.action_index AS action_index, a.call_ref AS action_call_ref,
                        a.logical_step_no AS action_logical_step_no,
                        a.repair_attempt AS action_repair_attempt,
                        s.provider_turn_id AS step_provider_turn_id,
                        s.state AS step_state,
                        s.next_action_index AS step_next_action_index
                   FROM executions e
                   JOIN tool_invocations i
                     ON i.execution_id = e.execution_id
                    AND i.workspace_id = e.workspace_id
                    AND i.effect_admission_state = 'NotAdmitted'
                    AND i.settled_at IS NULL
                   LEFT JOIN agent_execution_state es
                     ON es.execution_id = e.execution_id
                   LEFT JOIN tool_invocation_recovery_bindings b
                     ON b.invocation_id = i.invocation_id
                   LEFT JOIN agent_loop_step_actions a
                     ON a.execution_id = i.execution_id
                    AND a.logical_action_id = CASE
                      WHEN b.canonical_binding_json IS NOT NULL
                       AND json_valid(b.canonical_binding_json)
                      THEN json_extract(b.canonical_binding_json, '$.logicalActionId')
                      ELSE NULL END
                    AND a.action_index = CASE
                      WHEN b.canonical_binding_json IS NOT NULL
                       AND json_valid(b.canonical_binding_json)
                      THEN json_extract(b.canonical_binding_json, '$.actionIndex')
                      ELSE NULL END
                    AND a.call_ref = CASE
                      WHEN b.canonical_binding_json IS NOT NULL
                       AND json_valid(b.canonical_binding_json)
                      THEN json_extract(b.canonical_binding_json, '$.callRef')
                      ELSE NULL END
                   LEFT JOIN agent_loop_steps s
                     ON s.execution_id = a.execution_id
                    AND s.logical_step_no = a.logical_step_no
                    AND s.repair_attempt = a.repair_attempt
                  WHERE e.execution_id = ? AND e.project_id = ?
                    AND e.workspace_id = ? AND e.settled_at IS NULL
                    AND e.stop_requested_at IS NULL
                  ORDER BY i.intent_at, i.invocation_id`,
                [input.executionId, input.projectId, input.workspaceId],
              ),
            );
            if (rows.length === 0) return Option.none();

            const candidates: RequirementRow[] = [];
            for (const row of rows) {
              const attempts = yield* run(
                sql.unsafe<EffectAttemptRow>(
                  `SELECT attempt_no, admission_state, side_effect_semantics,
                          profile_id, profile_version, profile_hash,
                          profile_protocol, effect_key, binding_sha256
                     FROM tool_invocation_effect_attempts
                    WHERE invocation_id = ? ORDER BY attempt_no`,
                  [row.invocation_id],
                ),
              );
              const hasAnyAttemptProfile = attempts.some((attempt) =>
                [
                  attempt.profile_id,
                  attempt.profile_version,
                  attempt.profile_hash,
                  attempt.profile_protocol,
                  attempt.effect_key,
                ].some((value) => value !== null),
              );
              const isPolicyBearing =
                row.tool_name === "shell" ||
                row.binding_profile_id !== null ||
                hasAnyAttemptProfile;
              if (!isPolicyBearing) continue;
              candidates.push(row);
            }
            if (candidates.length === 0) return Option.none();
            if (candidates.length !== 1) {
              return yield* failCorrupt(
                "multiple or ambiguous active sandbox-policy requirements were found",
              );
            }

            const row = candidates[0];
            if (row === undefined) {
              return yield* failCorrupt("candidate row disappeared");
            }
            let invocationId: import("@arbor/domain").ToolInvocationId;
            try {
              invocationId = parse(ToolInvocationId)(row.invocation_id);
            } catch {
              return yield* failCorrupt(
                "sandbox-policy requirement invocation id is malformed",
              );
            }
            const verified =
              row.binding_version === 1 &&
              row.canonical_binding_json !== null &&
              row.binding_sha256 !== null
                ? verifyRecoveryBindingV1({
                    invocationId,
                    canonicalJson: row.canonical_binding_json,
                    bindingSha256: row.binding_sha256,
                  })
                : null;
            if (
              row.project_id !== input.projectId ||
              row.workspace_id !== input.workspaceId ||
              row.execution_id !== input.executionId ||
              !Number.isSafeInteger(row.episode_revision) ||
              row.episode_revision < 0 ||
              row.episode_json === null ||
              row.effect_admission_state !== "NotAdmitted" ||
              row.settled_at !== null ||
              row.recovery_binding_state !== "Bound" ||
              row.recovery_binding_sha256 === null ||
              row.binding_sha256 !== row.recovery_binding_sha256 ||
              verified === null
            ) {
              return yield* failCorrupt(
                "sandbox-policy requirement is missing exact active invocation or RecoveryBinding evidence",
              );
            }

            const binding = verified.value;
            const episodeBinding = decodeCanonicalExecutionEpisodeBinding(
              row.episode_json,
            );
            if (
              episodeBinding === undefined ||
              !Number.isSafeInteger(binding.logicalStepNo) ||
              binding.logicalStepNo < 0 ||
              !Number.isSafeInteger(binding.repairAttempt) ||
              binding.repairAttempt < 0 ||
              !Number.isSafeInteger(binding.actionIndex) ||
              binding.actionIndex < 0 ||
              binding.executionId !== row.execution_id ||
              binding.invocationId !== row.invocation_id ||
              binding.toolName !== row.tool_name ||
              binding.toolVersion !== row.tool_version ||
              binding.sideEffectSemantics !== row.side_effect_semantics
            ) {
              return yield* failCorrupt(
                "RecoveryBinding identity, Episode or invocation tuple is inconsistent",
              );
            }

            let argumentsDigest: string | undefined;
            let targetDigest: string | undefined;
            try {
              argumentsDigest = canonicalArgumentsDigestV1(
                JSON.parse(row.arguments_json) as unknown,
              );
              const regions = JSON.parse(row.resolved_regions_json) as unknown;
              if (
                !Array.isArray(regions) ||
                JSON.stringify(regions) !== row.resolved_regions_json
              ) {
                return yield* failCorrupt(
                  "resolved resource regions are not canonical JSON",
                );
              }
              targetDigest = targetResourceIdentityDigestV1(
                regions as ReadonlyArray<CanonicalResourceRegion>,
              );
            } catch {
              return yield* failCorrupt(
                "immutable invocation arguments or regions are malformed",
              );
            }
            if (
              binding.canonicalArgumentsDigest !== argumentsDigest ||
              binding.targetResourceIdentityDigest !== targetDigest ||
              row.action_kind !== row.tool_name ||
              row.action_input_hash !== sha256Hex(row.arguments_json) ||
              row.action_logical_id !== binding.logicalActionId ||
              row.action_index !== binding.actionIndex ||
              row.action_call_ref !== binding.callRef ||
              row.action_logical_step_no !== binding.logicalStepNo ||
              row.action_repair_attempt !== binding.repairAttempt ||
              row.step_provider_turn_id !== binding.providerTurnId
            ) {
              return yield* failCorrupt(
                "RecoveryBinding does not prove the exact current P3 Pending action",
              );
            }

            const attemptRows = yield* run(
              sql.unsafe<EffectAttemptRow>(
                `SELECT attempt_no, admission_state, side_effect_semantics,
                        profile_id, profile_version, profile_hash,
                        profile_protocol, effect_key, binding_sha256
                   FROM tool_invocation_effect_attempts
                  WHERE invocation_id = ? ORDER BY attempt_no`,
                [row.invocation_id],
              ),
            );
            const seenAttempts = new Set<number>();
            for (const attempt of attemptRows) {
              if (
                seenAttempts.has(attempt.attempt_no) ||
                attempt.admission_state !== "NotAdmitted" ||
                attempt.side_effect_semantics !== row.side_effect_semantics ||
                (attempt.binding_sha256 !== null &&
                  attempt.binding_sha256 !== verified.bindingSha256)
              ) {
                return yield* failCorrupt(
                  "effect attempt conflicts with the exact NotAdmitted invocation",
                );
              }
              seenAttempts.add(attempt.attempt_no);
              const fields = [
                attempt.profile_id,
                attempt.profile_version,
                attempt.profile_hash,
                attempt.profile_protocol,
                attempt.effect_key,
              ];
              if (fields.every((field) => field === null)) continue;
              if (
                fields.some((field) => field === null) ||
                attempt.profile_id !== binding.profileId ||
                attempt.profile_version !== binding.profileVersion ||
                attempt.profile_hash !== binding.profileHash ||
                attempt.profile_protocol !== binding.profileProtocol ||
                attempt.effect_key !== binding.effectKey
              ) {
                return yield* failCorrupt(
                  "effect-attempt sandbox profile fields do not match RecoveryBinding",
                );
              }
            }

            if (row.action_state !== "Pending") return Option.none();
            if (row.action_route_kind !== "Executable") {
              if (row.tool_name !== "shell") return Option.none();
              return yield* failCorrupt(
                "process-capable shell action is not on the Executable route",
              );
            }
            if (
              row.step_state !== "ActionsInProgress" ||
              row.step_next_action_index !== binding.actionIndex
            ) {
              return yield* failCorrupt(
                "Pending P3 action is not at the current AgentLoopStep cursor",
              );
            }

            return Option.some({
              _tag: "SandboxPolicyRequirementV1" as const,
              projectId: row.project_id as ProjectId,
              workspaceId: row.workspace_id as WorkspaceId,
              executionId: row.execution_id as ExecutionId,
              episodeBinding,
              expectedEpisodeRevision: row.episode_revision,
              invocationId,
              providerTurnId: binding.providerTurnId,
              logicalStepNo: binding.logicalStepNo,
              repairAttempt: binding.repairAttempt,
              logicalActionId: binding.logicalActionId,
              actionIndex: binding.actionIndex,
              callRef: binding.callRef as never,
              recoveryBindingDigest: verified.bindingSha256 as never,
            });
          });

      return SandboxPolicyRequirementReadPort.of({ findPendingByExecution });
    }),
  );

export const SandboxPolicyRequirementReadPortLive = makeLayer();
