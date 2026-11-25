import type { ProjectId } from "@arbor/domain";
import {
  decodeCanonicalSandboxPolicyDecisionCommittedInternal,
  encodeExecutionEpisodeBinding,
} from "@arbor/domain";
import {
  type AttentionProjectionStoreService,
  canonicalArgumentsDigestV1,
  type ProcessExecutionUnavailableProjectionRow,
  processExecutionUnavailableAttentionFactIdV1,
  type SandboxProviderUnavailableAttentionProjectionRow,
  sha256Hex,
  verifyRecoveryBindingV1,
} from "@arbor/ports";
import { Effect } from "effect";
import { persistenceCorruption } from "../repository-error.js";
import type { ProjectionContext } from "./context.js";
import {
  canonicalUtcText,
  type ProcessExecutionUnavailableDbRow,
  type SandboxProviderUnavailableAttentionDbRow,
} from "./row-codecs.js";

export const makeSandboxUnavailableQueries = (
  context: ProjectionContext,
): Pick<
  AttentionProjectionStoreService,
  | "listProjectedSandboxProviderUnavailableFailures"
  | "listProjectedProcessExecutionUnavailable"
> => {
  const { sql, run } = context;
  return {
    listProjectedSandboxProviderUnavailableFailures: (projectId, now) =>
      Effect.gen(function* () {
        if (!canonicalUtcText(now)) {
          return yield* Effect.fail(
            persistenceCorruption(
              "AttentionProjectionStore",
              "sandbox-provider-unavailable-read",
              "query time is not canonical UTC",
            ),
          );
        }
        const policyColumns = yield* run(
          sql.unsafe<{ readonly name: string }>(
            "PRAGMA table_info(sandbox_policy_decisions)",
          ),
        );
        const provenanceColumns = policyColumns.some(
          (column) => column.name === "authority_kind",
        )
          ? "d.authority_kind, d.workspace_authorization_revision"
          : "'LegacyHumanGrant' AS authority_kind, NULL AS workspace_authorization_revision";
        const rows = yield* run(
          sql.unsafe<SandboxProviderUnavailableAttentionDbRow>(
            `SELECT f.project_id, f.attention_fact_id, f.workspace_id,
                        f.execution_id, f.policy_revision, f.first_detected_at,
                        f.provider_version, f.probe_evidence_ref, f.failure_code,
                        d.policy_digest, d.profile_id, d.provider_id,
                        d.episode_binding_json, s.episode_json AS active_episode_json,
                        d.decision_command_id, ${provenanceColumns}, c.resolution AS command_resolution,
                        c.schema_version AS command_schema_version,
                        c.result_json AS command_result_json,
                        c.project_id AS command_project_id,
                        a.disposition_json
                   FROM sandbox_provider_unavailable_attention_rows m
                   JOIN sandbox_provider_unavailable_facts f
                     ON f.project_id = m.project_id
                    AND f.attention_fact_id = m.attention_fact_id
                    AND f.workspace_id = m.workspace_id
                   JOIN executions e ON e.execution_id = f.execution_id
                    AND e.project_id = f.project_id
                    AND e.workspace_id = f.workspace_id
                   JOIN agent_loop_step_actions a
                     ON a.execution_id = e.execution_id
                    AND a.state = 'TerminalRejected'
                    AND a.disposition_json IS NOT NULL
                    AND json_valid(a.disposition_json)
                    AND json_extract(a.disposition_json, '$._tag') = 'SandboxUnavailableV1'
                    AND json_extract(a.disposition_json, '$.attentionFactId') = f.attention_fact_id
                    AND json_extract(a.disposition_json, '$.policyRevision') = f.policy_revision
                    AND json_extract(a.disposition_json, '$.policyDigest') = f.policy_digest
                    AND json_extract(a.disposition_json, '$.profile') = f.profile_id
                    AND json_extract(a.disposition_json, '$.providerId') = f.provider_id
                    AND json_extract(a.disposition_json, '$.providerVersion') = f.provider_version
                    AND json_extract(a.disposition_json, '$.probeEvidenceRef') IS f.probe_evidence_ref
                    AND json_extract(a.disposition_json, '$.failureCode') = f.failure_code
                   JOIN agent_loop_steps step
                     ON step.execution_id = a.execution_id
                    AND step.logical_step_no = a.logical_step_no
                    AND step.repair_attempt = a.repair_attempt
                    AND step.state = 'StepEffectsCommitted'
                    AND step.next_action_index = a.action_index + 1
                   JOIN agent_execution_state s ON s.execution_id = e.execution_id
                   JOIN sandbox_policy_decisions d ON d.execution_id = e.execution_id
                    AND d.project_id = e.project_id AND d.workspace_id = e.workspace_id
                    AND d.episode_binding_json = s.episode_json
                    AND d.policy_revision = f.policy_revision
                  JOIN commands c ON c.command_id = d.decision_command_id
                  WHERE m.project_id = ? AND e.settled_at IS NULL
                    AND e.stop_requested_at IS NULL
                    AND d.policy_revision = (
                      SELECT MAX(d2.policy_revision) FROM sandbox_policy_decisions d2
                       WHERE d2.execution_id = e.execution_id
                         AND d2.episode_binding_json = s.episode_json
                    )
                  ORDER BY f.first_detected_at, f.attention_fact_id`,
            [projectId],
          ),
        );
        for (const row of rows) {
          if (!canonicalUtcText(row.first_detected_at)) {
            return yield* Effect.fail(
              persistenceCorruption(
                "AttentionProjectionStore",
                "sandbox-provider-unavailable-read",
                "fact timestamp is not canonical UTC",
              ),
            );
          }
          const committed =
            row.command_resolution === "Committed" &&
            (row.command_schema_version === "1" ||
              row.command_schema_version === "2") &&
            row.command_project_id === row.project_id &&
            row.command_result_json !== null
              ? decodeCanonicalSandboxPolicyDecisionCommittedInternal(
                  row.command_result_json,
                  sha256Hex,
                )
              : undefined;
          if (
            committed === undefined ||
            (row.authority_kind === "WorkspaceAuthorization"
              ? row.command_schema_version !== "1" ||
                committed.version !== 3 ||
                committed.workspaceAuthorizationRevision !==
                  row.workspace_authorization_revision
              : row.authority_kind !== "LegacyHumanGrant" ||
                row.workspace_authorization_revision !== null ||
                committed.version === 3 ||
                (row.command_schema_version === "1" &&
                  committed.version !== 1)) ||
            committed.commandId !== row.decision_command_id ||
            committed.projectId !== row.project_id ||
            committed.workspaceId !== row.workspace_id ||
            committed.executionId !== row.execution_id ||
            committed.policyRevision !== row.policy_revision ||
            committed.policyDigest !== row.policy_digest ||
            encodeExecutionEpisodeBinding(committed.episodeBinding) !==
              row.episode_binding_json ||
            row.episode_binding_json !== row.active_episode_json ||
            committed.effectivePolicySnapshot.kind !== "OsEnforced" ||
            committed.effectivePolicySnapshot.profile !== row.profile_id ||
            committed.effectivePolicySnapshot.providerId !== row.provider_id ||
            committed.effectivePolicySnapshot.providerVersion !==
              row.provider_version
          ) {
            return yield* Effect.fail(
              persistenceCorruption(
                "AttentionProjectionStore",
                "sandbox-provider-unavailable-read",
                "committed policy result does not match the P9 fact binding",
              ),
            );
          }
          const disposition = JSON.parse(row.disposition_json) as Record<
            string,
            unknown
          >;
          if (
            disposition._tag !== "SandboxUnavailableV1" ||
            disposition.attentionFactId !== row.attention_fact_id ||
            disposition.policyRevision !== row.policy_revision ||
            disposition.policyDigest !== row.policy_digest ||
            disposition.profile !== row.profile_id ||
            disposition.providerId !== row.provider_id ||
            disposition.providerVersion !== row.provider_version ||
            disposition.capabilityRevision !==
              String(committed.effectivePolicySnapshot.capabilityRevision) ||
            disposition.probeEvidenceRef !== row.probe_evidence_ref ||
            disposition.failureCode !== row.failure_code
          ) {
            return yield* Effect.fail(
              persistenceCorruption(
                "AttentionProjectionStore",
                "sandbox-provider-unavailable-read",
                "P3 terminal disposition does not match the P9 unavailable fact",
              ),
            );
          }
          const factRows = yield* run(
            sql.unsafe<{
              readonly policy_digest: string;
              readonly profile_id: string;
              readonly provider_id: string;
              readonly provider_version: string;
              readonly probe_evidence_ref: string | null;
              readonly failure_code: string;
            }>(
              `SELECT policy_digest, profile_id, provider_id,
                          provider_version, probe_evidence_ref, failure_code
                     FROM sandbox_provider_unavailable_facts
                    WHERE project_id = ? AND attention_fact_id = ?`,
              [projectId, row.attention_fact_id],
            ),
          );
          const fact = factRows[0];
          if (
            fact === undefined ||
            fact.policy_digest !== row.policy_digest ||
            fact.profile_id !== row.profile_id ||
            fact.provider_id !== row.provider_id ||
            fact.provider_version !== row.provider_version ||
            fact.probe_evidence_ref !== row.probe_evidence_ref ||
            fact.failure_code !== row.failure_code
          ) {
            return yield* Effect.fail(
              persistenceCorruption(
                "AttentionProjectionStore",
                "sandbox-provider-unavailable-read",
                "current policy decision conflicts with its immutable source fact",
              ),
            );
          }
        }
        return rows.map(
          (row) =>
            ({
              projectId: row.project_id as ProjectId,
              attentionFactId: row.attention_fact_id,
              workspaceId: row.workspace_id as never,
              executionId: row.execution_id,
              policyRevision: row.policy_revision,
              firstDetectedAt: row.first_detected_at,
            }) satisfies SandboxProviderUnavailableAttentionProjectionRow,
        );
      }),
    listProjectedProcessExecutionUnavailable: (projectId) =>
      Effect.gen(function* () {
        const rows = yield* run(
          sql.unsafe<ProcessExecutionUnavailableDbRow>(
            `SELECT e.project_id, e.execution_id, e.workspace_id,
                        i.invocation_id, i.tool_name, i.tool_version,
                        i.side_effect_semantics, i.arguments_json, i.approval_id,
                        i.effect_admission_state, i.settled_at,
                        i.settlement_kind, i.settlement_json,
                        i.settlement_provenance, i.result_ref,
                        i.observation_format_version, i.observation_json,
                        i.observation_sha256, i.selected_attempt_no,
                        i.selected_fact_id, i.recovery_binding_state,
                        i.recovery_binding_sha256, b.binding_version,
                        b.canonical_binding_json, b.binding_sha256,
                        act.state AS action_state,
                        act.input_hash AS action_input_hash,
                        act.action_kind AS action_kind,
                        act.logical_step_no AS p3_logical_step_no,
                        act.repair_attempt AS p3_repair_attempt,
                        act.logical_action_id AS p3_logical_action_id,
                        act.action_index AS p3_action_index,
                        act.call_ref AS p3_call_ref,
                        step.provider_turn_id AS p3_provider_turn_id
                   FROM tool_invocations i
                   JOIN executions e ON e.execution_id = i.execution_id
                    AND e.workspace_id = i.workspace_id
                   LEFT JOIN tool_invocation_recovery_bindings b
                    ON b.invocation_id = i.invocation_id
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
                    AND e.stop_requested_at IS NULL
                    AND i.tool_name = 'shell'
                    AND i.settled_at IS NOT NULL
                    AND i.settlement_kind = 'Denied'
                    AND i.effect_admission_state = 'NotAdmitted'
                    AND i.result_ref IS NULL
                    AND i.observation_format_version IS NULL
                    AND i.observation_json IS NULL
                    AND i.observation_sha256 IS NULL
                    AND i.settlement_provenance = 'Ordinary'
                    AND i.selected_attempt_no IS NULL
                    AND i.selected_fact_id IS NULL
                    AND json_valid(i.settlement_json)
                    AND json_extract(i.settlement_json, '$._tag') = 'Denied'
                    AND json_extract(i.settlement_json, '$.projectionVersion') = 1
                    AND json_extract(i.settlement_json, '$.reasonCode') IN
                        ('ProcessExecutionDisabled','NativeOsTupleUnavailable')
                    AND NOT EXISTS (
                      SELECT 1 FROM tool_invocation_effect_attempts a
                       WHERE a.invocation_id = i.invocation_id
                         AND a.admission_state = 'MayHaveStarted')
                  ORDER BY e.execution_id, i.settled_at, i.invocation_id`,
            [projectId],
          ),
        );
        const projections: ProcessExecutionUnavailableProjectionRow[] = [];
        const seenInvocations = new Set<string>();
        for (const row of rows) {
          const operation = "process-execution-unavailable-read";
          const failIntegrity = (reason: string) =>
            persistenceCorruption(
              "AttentionProjectionStore",
              operation,
              reason,
            );
          if (seenInvocations.has(row.invocation_id)) {
            return yield* Effect.fail(
              failIntegrity("P4 invocation has a non-unique P3 action join"),
            );
          }
          seenInvocations.add(row.invocation_id);
          if (
            row.settled_at === null ||
            !canonicalUtcText(row.settled_at) ||
            row.tool_name !== "shell" ||
            row.effect_admission_state !== "NotAdmitted" ||
            row.settlement_kind !== "Denied" ||
            row.settlement_provenance !== "Ordinary" ||
            row.result_ref !== null ||
            row.observation_format_version !== null ||
            row.observation_json !== null ||
            row.observation_sha256 !== null ||
            row.selected_attempt_no !== null ||
            row.selected_fact_id !== null
          ) {
            return yield* Effect.fail(
              failIntegrity(
                "P4 denial post-image is not the exact NotAdmitted shape",
              ),
            );
          }
          let settlement: unknown;
          try {
            settlement = JSON.parse(row.settlement_json ?? "null") as unknown;
          } catch {
            return yield* Effect.fail(
              failIntegrity("P4 Denied settlement is malformed"),
            );
          }
          const settlementRecord =
            typeof settlement === "object" && settlement !== null
              ? (settlement as Record<string, unknown>)
              : undefined;
          const reasonCode = settlementRecord?.reasonCode;
          if (
            settlementRecord === undefined ||
            Object.keys(settlementRecord).length !== 3 ||
            settlementRecord._tag !== "Denied" ||
            settlementRecord.projectionVersion !== 1 ||
            (reasonCode !== "ProcessExecutionDisabled" &&
              reasonCode !== "NativeOsTupleUnavailable")
          ) {
            return yield* Effect.fail(
              failIntegrity(
                "P4 denial reason or projection version is invalid",
              ),
            );
          }
          if (
            row.recovery_binding_state !== "Bound" ||
            row.recovery_binding_sha256 === null ||
            row.recovery_binding_sha256 !== row.binding_sha256 ||
            row.binding_version !== 1 ||
            row.canonical_binding_json === null ||
            row.binding_sha256 === null ||
            row.action_state !== "TerminalRejected" ||
            row.action_input_hash !== sha256Hex(row.arguments_json) ||
            row.action_kind !== row.tool_name ||
            row.p3_logical_step_no === null ||
            row.p3_repair_attempt === null ||
            row.p3_logical_action_id === null ||
            row.p3_action_index === null ||
            row.p3_call_ref === null ||
            row.p3_provider_turn_id === null
          ) {
            return yield* Effect.fail(
              failIntegrity("exact P4/P3 RecoveryBinding join is unavailable"),
            );
          }
          const verified = verifyRecoveryBindingV1({
            invocationId: row.invocation_id as never,
            canonicalJson: row.canonical_binding_json,
            bindingSha256: row.binding_sha256,
          });
          const binding = verified?.value;
          let argumentsDigest: string | null = null;
          try {
            argumentsDigest = canonicalArgumentsDigestV1(
              JSON.parse(row.arguments_json) as unknown,
            );
          } catch {
            argumentsDigest = null;
          }
          if (
            binding === undefined ||
            binding.executionId !== row.execution_id ||
            binding.invocationId !== row.invocation_id ||
            binding.toolName !== row.tool_name ||
            binding.toolVersion !== row.tool_version ||
            binding.sideEffectSemantics !== row.side_effect_semantics ||
            binding.approvalId !== row.approval_id ||
            binding.canonicalArgumentsDigest !== argumentsDigest ||
            binding.providerTurnId !== row.p3_provider_turn_id ||
            binding.logicalStepNo !== row.p3_logical_step_no ||
            binding.repairAttempt !== row.p3_repair_attempt ||
            binding.logicalActionId !== row.p3_logical_action_id ||
            binding.actionIndex !== row.p3_action_index ||
            binding.callRef !== row.p3_call_ref
          ) {
            return yield* Effect.fail(
              failIntegrity("P4 invocation does not match its exact P3 action"),
            );
          }
          const attentionIdentity = {
            executionId: row.execution_id,
            workspaceId: row.workspace_id as never,
            invocationId: row.invocation_id,
            providerTurnId: binding.providerTurnId,
            logicalStepNo: binding.logicalStepNo,
            repairAttempt: binding.repairAttempt,
            logicalActionId: binding.logicalActionId,
            actionIndex: binding.actionIndex,
            callRef: binding.callRef,
            reasonCode,
          } satisfies Omit<
            ProcessExecutionUnavailableProjectionRow,
            "attentionFactId" | "occurredAt" | "projectId"
          >;
          projections.push({
            projectId: row.project_id as ProjectId,
            ...attentionIdentity,
            attentionFactId:
              processExecutionUnavailableAttentionFactIdV1(attentionIdentity),
            occurredAt: row.settled_at,
          });
        }
        return projections;
      }),
  };
};
