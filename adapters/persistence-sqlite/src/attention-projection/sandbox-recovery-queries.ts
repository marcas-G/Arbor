import type {
  ProjectId,
} from "@arbor/domain";
import {
  type AttentionProjectionStoreService,
  canonicalArgumentsDigestV1,
  type SandboxPolicyDecisionRequiredProjectionRow,
  type SandboxRecoveryBindingFailureProjectionRow,
  sha256Hex,
  targetResourceIdentityDigestV1,
  verifyRecoveryBindingV1,
} from "@arbor/ports";
import {
  Effect,
} from "effect";
import {
  persistenceCorruption,
} from "../repository-error.js";
import {
  type SandboxRecoveryBindingDbRow,
  canonicalUtcText,
  sandboxRecoveryBindingAttentionId,
} from "./row-codecs.js";
import type { ProjectionContext } from "./context.js";

export const makeSandboxRecoveryQueries = (context: ProjectionContext): Pick<AttentionProjectionStoreService, "listSandboxRecoveryBindingFailures" | "listSandboxPolicyDecisionRequired"> => {
  const { sql, run } = context;
  return {
        listSandboxRecoveryBindingFailures: (projectId, now) =>
          Effect.gen(function* () {
            if (!canonicalUtcText(now)) {
              return yield* Effect.fail(
                persistenceCorruption(
                  "AttentionProjectionStore",
                  "sandbox-recovery-binding-read",
                  "query time is not canonical UTC",
                ),
              );
            }
            const rows = yield* run(
              sql.unsafe<SandboxRecoveryBindingDbRow>(
                `SELECT e.project_id, e.execution_id, e.workspace_id,
                        i.invocation_id, i.intent_at, i.recovery_binding_state,
                        i.recovery_binding_sha256, i.effect_admission_state,
                        i.settled_at, i.tool_name, i.tool_version,
                        i.side_effect_semantics, i.arguments_json, b.binding_version,
                        b.canonical_binding_json, b.binding_sha256,
                        a.profile_id, act.state AS action_state,
                        act.input_hash AS action_input_hash,
                        act.action_kind AS action_kind,
                        act.logical_action_id AS p3_logical_action_id,
                        act.action_index AS p3_action_index,
                        act.call_ref AS p3_call_ref,
                        step.provider_turn_id AS p3_provider_turn_id,
                        step.state AS p3_step_state
                   FROM tool_invocations i
                   JOIN executions e ON e.execution_id = i.execution_id
                    AND e.workspace_id = i.workspace_id
                   LEFT JOIN tool_invocation_recovery_bindings b
                    ON b.invocation_id = i.invocation_id
                   LEFT JOIN tool_invocation_effect_attempts a
                    ON a.invocation_id = i.invocation_id AND a.attempt_no = 0
                   LEFT JOIN agent_loop_step_actions act
                    ON act.execution_id = i.execution_id
                   AND act.logical_action_id = CASE
                     WHEN b.canonical_binding_json IS NOT NULL
                      AND json_valid(b.canonical_binding_json)
                     THEN json_extract(b.canonical_binding_json, '$.logicalActionId')
                     ELSE NULL END
                   AND act.action_index = CASE
                     WHEN b.canonical_binding_json IS NOT NULL
                      AND json_valid(b.canonical_binding_json)
                     THEN json_extract(b.canonical_binding_json, '$.actionIndex')
                     ELSE NULL END
                   AND act.call_ref = CASE
                     WHEN b.canonical_binding_json IS NOT NULL
                      AND json_valid(b.canonical_binding_json)
                     THEN json_extract(b.canonical_binding_json, '$.callRef')
                     ELSE NULL END
                   LEFT JOIN agent_loop_steps step
                    ON step.execution_id = act.execution_id
                   AND step.logical_step_no = act.logical_step_no
                   AND step.repair_attempt = act.repair_attempt
                  WHERE e.project_id = ? AND e.settled_at IS NULL
                    AND e.stop_requested_at IS NULL AND i.settled_at IS NULL
                    AND i.effect_admission_state = 'NotAdmitted'
                    AND (i.tool_name = 'shell' OR a.profile_id IS NOT NULL
                         OR CASE WHEN b.canonical_binding_json IS NOT NULL
                                   AND json_valid(b.canonical_binding_json)
                                 THEN json_extract(b.canonical_binding_json, '$.profileId')
                                 ELSE NULL END IS NOT NULL)
                  ORDER BY e.execution_id, i.intent_at, i.invocation_id`,
                [projectId],
              ),
            );
            const failures: SandboxRecoveryBindingFailureProjectionRow[] = [];
            for (const row of rows) {
              if (
                typeof row.recovery_binding_sha256 === "string" &&
                !/^[0-9a-f]{64}$/u.test(row.recovery_binding_sha256)
              ) {
                return yield* Effect.fail(
                  persistenceCorruption(
                    "AttentionProjectionStore",
                    "sandbox-recovery-binding-read",
                    "stored binding digest is malformed",
                  ),
                );
              }
              if (!canonicalUtcText(row.intent_at)) {
                return yield* Effect.fail(
                  persistenceCorruption(
                    "AttentionProjectionStore",
                    "sandbox-recovery-binding-read",
                    "invocation intent timestamp is malformed",
                  ),
                );
              }
              const verified =
                row.binding_version === 1 &&
                row.canonical_binding_json !== null &&
                row.binding_sha256 !== null
                  ? verifyRecoveryBindingV1({
                      invocationId: row.invocation_id as never,
                      canonicalJson: row.canonical_binding_json,
                      bindingSha256: row.binding_sha256,
                    })
                  : null;
              const valid =
                row.recovery_binding_state === "Bound" &&
                row.recovery_binding_sha256 !== null &&
                row.recovery_binding_sha256 === row.binding_sha256 &&
                verified !== null &&
                verified.value.executionId === row.execution_id &&
                verified.value.invocationId === row.invocation_id &&
                verified.value.toolName === row.tool_name &&
                verified.value.toolVersion === row.tool_version &&
                verified.value.sideEffectSemantics ===
                  row.side_effect_semantics &&
                verified.value.profileId !== null &&
                verified.value.profileId === row.profile_id &&
                row.action_state === "Pending" &&
                row.action_input_hash === sha256Hex(row.arguments_json) &&
                row.action_kind === row.tool_name &&
                row.p3_logical_action_id === verified.value.logicalActionId &&
                row.p3_action_index === verified.value.actionIndex &&
                row.p3_call_ref === verified.value.callRef &&
                row.p3_provider_turn_id === verified.value.providerTurnId &&
                row.p3_step_state === "ActionsInProgress" &&
                (() => {
                  try {
                    return (
                      verified.value.canonicalArgumentsDigest ===
                      canonicalArgumentsDigestV1(
                        JSON.parse(row.arguments_json) as unknown,
                      )
                    );
                  } catch {
                    return false;
                  }
                })();
              if (valid) continue;
              failures.push({
                projectId: row.project_id as ProjectId,
                executionId: row.execution_id,
                invocationId: row.invocation_id,
                workspaceId: row.workspace_id as never,
                attentionFactId: sandboxRecoveryBindingAttentionId(
                  row.execution_id,
                  row.invocation_id,
                  row.recovery_binding_sha256,
                ),
                intentAt: row.intent_at,
              });
            }
            return failures;
          }),
        listSandboxPolicyDecisionRequired: (projectId, now) =>
          Effect.gen(function* () {
            if (!canonicalUtcText(now)) {
              return yield* Effect.fail(
                persistenceCorruption(
                  "AttentionProjectionStore",
                  "sandbox-policy-decision-required-read",
                  "query time is not canonical UTC",
                ),
              );
            }
            const rows = yield* run(
              sql.unsafe<SandboxRecoveryBindingDbRow>(
                `SELECT e.project_id, e.execution_id, e.workspace_id,
                        i.invocation_id, i.intent_at, i.recovery_binding_state,
                        i.recovery_binding_sha256, i.effect_admission_state,
                        i.settled_at, i.tool_name, i.tool_version,
                        i.side_effect_semantics, i.arguments_json,
                        i.resolved_regions_json, b.binding_version,
                        b.canonical_binding_json, b.binding_sha256,
                        a.profile_id, act.state AS action_state,
                        act.input_hash AS action_input_hash,
                        act.action_kind AS action_kind,
                        act.logical_action_id AS p3_logical_action_id,
                        act.action_index AS p3_action_index,
                        act.call_ref AS p3_call_ref,
                        step.provider_turn_id AS p3_provider_turn_id,
                        step.state AS p3_step_state,
                        step.next_action_index AS p3_step_next_action_index
                   FROM tool_invocations i
                   JOIN executions e ON e.execution_id = i.execution_id
                    AND e.workspace_id = i.workspace_id
                   JOIN agent_execution_state s ON s.execution_id = e.execution_id
                   LEFT JOIN tool_invocation_recovery_bindings b
                    ON b.invocation_id = i.invocation_id
                   LEFT JOIN tool_invocation_effect_attempts a
                    ON a.invocation_id = i.invocation_id AND a.attempt_no = 0
                   LEFT JOIN agent_loop_step_actions act
                    ON act.execution_id = i.execution_id
                   AND act.logical_action_id = CASE
                     WHEN b.canonical_binding_json IS NOT NULL
                      AND json_valid(b.canonical_binding_json)
                     THEN json_extract(b.canonical_binding_json, '$.logicalActionId')
                     ELSE NULL END
                   AND act.action_index = CASE
                     WHEN b.canonical_binding_json IS NOT NULL
                      AND json_valid(b.canonical_binding_json)
                     THEN json_extract(b.canonical_binding_json, '$.actionIndex')
                     ELSE NULL END
                   AND act.call_ref = CASE
                     WHEN b.canonical_binding_json IS NOT NULL
                      AND json_valid(b.canonical_binding_json)
                     THEN json_extract(b.canonical_binding_json, '$.callRef')
                     ELSE NULL END
                   LEFT JOIN agent_loop_steps step
                    ON step.execution_id = act.execution_id
                   AND step.logical_step_no = act.logical_step_no
                   AND step.repair_attempt = act.repair_attempt
                  WHERE e.project_id = ? AND e.settled_at IS NULL
                    AND e.stop_requested_at IS NULL AND i.settled_at IS NULL
                    AND i.effect_admission_state = 'NotAdmitted'
                    AND (i.tool_name = 'shell' OR a.profile_id IS NOT NULL
                         OR CASE WHEN b.canonical_binding_json IS NOT NULL
                                   AND json_valid(b.canonical_binding_json)
                                 THEN json_extract(b.canonical_binding_json, '$.profileId')
                                 ELSE NULL END IS NOT NULL)
                    AND NOT EXISTS (
                      SELECT 1 FROM sandbox_policy_decisions d
                       WHERE d.execution_id = e.execution_id
                         AND d.project_id = e.project_id
                         AND d.workspace_id = e.workspace_id
                         AND d.episode_binding_json = s.episode_json
                         AND d.expires_at > ?
                    )
                  ORDER BY e.execution_id, i.intent_at, i.invocation_id`,
                [projectId, now],
              ),
            );
            const pending: SandboxPolicyDecisionRequiredProjectionRow[] = [];
            for (const row of rows) {
              if (!canonicalUtcText(row.intent_at)) {
                return yield* Effect.fail(
                  persistenceCorruption(
                    "AttentionProjectionStore",
                    "sandbox-policy-decision-required-read",
                    "pending invocation timestamp is malformed",
                  ),
                );
              }
              if (
                typeof row.recovery_binding_sha256 === "string" &&
                !/^[0-9a-f]{64}$/u.test(row.recovery_binding_sha256)
              ) {
                return yield* Effect.fail(
                  persistenceCorruption(
                    "AttentionProjectionStore",
                    "sandbox-policy-decision-required-read",
                    "stored binding digest is malformed",
                  ),
                );
              }
              const verified =
                row.binding_version === 1 &&
                row.canonical_binding_json !== null &&
                row.binding_sha256 !== null
                  ? verifyRecoveryBindingV1({
                      invocationId: row.invocation_id as never,
                      canonicalJson: row.canonical_binding_json,
                      bindingSha256: row.binding_sha256,
                    })
                  : null;
              const binding = verified?.value;
              let validRegions = false;
              try {
                const regions = JSON.parse(
                  row.resolved_regions_json ?? "null",
                ) as ReadonlyArray<
                  import("@arbor/domain").CanonicalResourceRegion
                >;
                validRegions =
                  Array.isArray(regions) &&
                  JSON.stringify(regions) === row.resolved_regions_json &&
                  binding?.targetResourceIdentityDigest ===
                    targetResourceIdentityDigestV1(regions);
              } catch {
                validRegions = false;
              }
              const valid =
                row.recovery_binding_state === "Bound" &&
                row.recovery_binding_sha256 !== null &&
                row.recovery_binding_sha256 === row.binding_sha256 &&
                binding !== undefined &&
                binding !== null &&
                binding.executionId === row.execution_id &&
                binding.invocationId === row.invocation_id &&
                binding.toolName === row.tool_name &&
                binding.toolVersion === row.tool_version &&
                binding.sideEffectSemantics === row.side_effect_semantics &&
                binding.profileId !== null &&
                binding.profileId === row.profile_id &&
                row.action_state === "Pending" &&
                row.action_input_hash === sha256Hex(row.arguments_json) &&
                row.action_kind === row.tool_name &&
                row.p3_logical_action_id === binding.logicalActionId &&
                row.p3_action_index === binding.actionIndex &&
                row.p3_call_ref === binding.callRef &&
                row.p3_provider_turn_id === binding.providerTurnId &&
                row.p3_step_state === "ActionsInProgress" &&
                row.p3_step_next_action_index === binding.actionIndex &&
                validRegions &&
                (() => {
                  try {
                    return (
                      binding.canonicalArgumentsDigest ===
                      canonicalArgumentsDigestV1(
                        JSON.parse(row.arguments_json) as unknown,
                      )
                    );
                  } catch {
                    return false;
                  }
                })();
              if (!valid) continue;
              pending.push({
                projectId: row.project_id as ProjectId,
                executionId: row.execution_id,
                invocationId: row.invocation_id,
                workspaceId: row.workspace_id as never,
                attentionFactId: `sandbox-policy-decision-required:${row.execution_id}:${row.invocation_id}`,
                intentAt: row.intent_at,
              });
            }
            return pending;
          }),
  };
};
