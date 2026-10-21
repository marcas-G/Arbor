import {
  type CanonicalResourceRegion,
  decodeCanonicalExecutionEpisodeBinding,
  type ExecutionId,
  encodeExecutionEpisodeBinding,
  isIsoTimestamp,
  type ProjectId,
  ProviderTurnId,
  parse,
  Sha256,
  ToolInvocationId,
  type WorkspaceId,
} from "@arbor/domain";
import {
  canonicalArgumentsDigestV1,
  type SandboxPolicyPreIntentRequirementV1,
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

      const findPreIntentRequirement = (input: {
        readonly projectId: ProjectId;
        readonly workspaceId: WorkspaceId;
        readonly executionId: ExecutionId;
      }) =>
        Effect.gen(function* () {
          interface PreIntentRow {
            readonly project_id: string;
            readonly workspace_id: string;
            readonly execution_id: string;
            readonly episode_revision: number;
            readonly episode_json: string | null;
            readonly provider_turn_id: string;
            readonly logical_step_no: number;
            readonly repair_attempt: number;
            readonly next_action_index: number;
            readonly action_index: number;
            readonly logical_action_id: string;
            readonly call_ref: string;
            readonly action_route_kind: string;
            readonly action_kind: string;
            readonly input_hash: string;
            readonly action_state: string;
            readonly action_revision: number;
            readonly approval_id: string | null;
            readonly approval_route_kind: string | null;
            readonly approval_state: string | null;
            readonly approval_revision: number | null;
            readonly approval_expires_at: string | null;
            readonly approval_consumed_by: string | null;
            readonly approval_tool_invocation_id: string | null;
            readonly approval_tool_name: string | null;
            readonly approval_tool_version: string | null;
            readonly approval_arguments_json: string | null;
            readonly approval_binding_proven: number | null;
            readonly matching_approval_count: number;
            readonly invocation_exists: number;
          }
          const rows = yield* run(
            sql.unsafe<PreIntentRow>(
              `SELECT e.project_id, e.workspace_id, e.execution_id,
                      e.episode_revision, es.episode_json,
                      s.provider_turn_id, s.logical_step_no,
                      s.repair_attempt, s.next_action_index,
                      a.action_index, a.logical_action_id, a.call_ref,
                      a.route_kind AS action_route_kind,
                      a.action_kind, a.input_hash, a.state AS action_state,
                      a.revision AS action_revision,
                      aa.approval_id, aa.route_kind AS approval_route_kind,
                      aa.state AS approval_state, aa.revision AS approval_revision,
                      aa.expires_at AS approval_expires_at,
                      aa.consumed_by AS approval_consumed_by,
                      aa.tool_invocation_id AS approval_tool_invocation_id,
                      aa.stable_action_id AS approval_tool_name,
                      aa.action_version AS approval_tool_version,
                      aa.arguments_json AS approval_arguments_json,
                      aa.binding_proven AS approval_binding_proven,
                      (SELECT COUNT(*) FROM action_approvals ax
                        WHERE ax.route_kind = 'Executable'
                          AND ax.execution_id = e.execution_id
                          AND ax.logical_step_no = s.logical_step_no
                          AND ax.repair_attempt = s.repair_attempt
                          AND ax.action_index = a.action_index
                          AND ax.logical_action_id = a.logical_action_id
                          AND ax.call_ref = a.call_ref) AS matching_approval_count,
                      CASE WHEN aa.tool_invocation_id IS NOT NULL AND EXISTS(
                        SELECT 1 FROM tool_invocations ti
                         WHERE ti.invocation_id = aa.tool_invocation_id
                      ) THEN 1 ELSE 0 END AS invocation_exists
                 FROM executions e
                 JOIN agent_execution_state es ON es.execution_id = e.execution_id
                 JOIN agent_loop_steps s ON s.execution_id = e.execution_id
                 JOIN agent_loop_step_actions a
                   ON a.execution_id = s.execution_id
                  AND a.logical_step_no = s.logical_step_no
                  AND a.repair_attempt = s.repair_attempt
                  AND a.action_index = s.next_action_index
                 LEFT JOIN action_approvals aa
                   ON aa.route_kind = 'Executable'
                  AND aa.execution_id = e.execution_id
                  AND aa.project_id = e.project_id
                  AND aa.workspace_id = e.workspace_id
                  AND aa.logical_step_no = a.logical_step_no
                  AND aa.repair_attempt = a.repair_attempt
                  AND aa.action_index = a.action_index
                  AND aa.logical_action_id = a.logical_action_id
                  AND aa.call_ref = a.call_ref
                WHERE e.execution_id = ? AND e.project_id = ?
                  AND e.workspace_id = ? AND e.settled_at IS NULL
                  AND e.stop_requested_at IS NULL
                  AND s.state = 'ActionsInProgress'
                  AND a.route_kind = 'Executable' AND a.state = 'Pending'
                  AND a.action_kind = 'shell'
                ORDER BY aa.approval_id`,
              [input.executionId, input.projectId, input.workspaceId],
            ),
          );
          if (rows.length === 0) return Option.none();
          if (rows.length !== 1) {
            return yield* failCorrupt(
              "multiple or ambiguous active pre-intent P3 actions were found",
            );
          }
          const row = rows[0];
          if (row === undefined)
            return yield* failCorrupt("source row disappeared");
          if (row.matching_approval_count > 1)
            return yield* failCorrupt(
              "duplicate P4 approval rows match the current P3 action",
            );
          if (row.matching_approval_count === 0) return Option.none();
          if (row.approval_id === null) return Option.none();
          if (
            row.approval_state !== "Pending" ||
            row.approval_consumed_by !== null
          )
            return Option.none();
          if (
            row.approval_route_kind !== "Executable" ||
            row.approval_binding_proven !== 1 ||
            row.approval_revision === null ||
            !Number.isSafeInteger(row.approval_revision) ||
            row.approval_revision < 0 ||
            row.approval_tool_invocation_id === null ||
            row.approval_tool_name !== row.action_kind ||
            row.approval_tool_version === null ||
            row.approval_tool_version.length === 0 ||
            row.approval_arguments_json === null ||
            sha256Hex(row.approval_arguments_json) !== row.input_hash ||
            row.invocation_exists !== 0
          ) {
            return yield* failCorrupt(
              "pre-intent P4 approval does not prove the exact Pending P3 action",
            );
          }
          const episodeBinding =
            row.episode_json === null
              ? undefined
              : decodeCanonicalExecutionEpisodeBinding(row.episode_json);
          let providerTurnId: import("@arbor/domain").ProviderTurnId;
          let inputHash: import("@arbor/domain").Sha256;
          try {
            providerTurnId = parse(ProviderTurnId)(row.provider_turn_id);
            inputHash = parse(Sha256)(row.input_hash);
          } catch {
            return yield* failCorrupt(
              "pre-intent P3 source contains malformed ProviderTurn or input hash",
            );
          }
          if (
            episodeBinding === undefined ||
            row.project_id !== input.projectId ||
            row.workspace_id !== input.workspaceId ||
            row.execution_id !== input.executionId ||
            !Number.isSafeInteger(row.episode_revision) ||
            row.episode_revision < 0 ||
            !Number.isSafeInteger(row.logical_step_no) ||
            row.logical_step_no < 0 ||
            !Number.isSafeInteger(row.repair_attempt) ||
            row.repair_attempt < 0 ||
            !Number.isSafeInteger(row.next_action_index) ||
            row.next_action_index < 0 ||
            row.action_index !== row.next_action_index ||
            !Number.isSafeInteger(row.action_revision) ||
            row.action_revision < 0 ||
            row.action_state !== "Pending" ||
            row.action_route_kind !== "Executable" ||
            row.action_kind !== "shell" ||
            row.approval_expires_at === null ||
            !isIsoTimestamp(row.approval_expires_at)
          ) {
            return yield* failCorrupt(
              "pre-intent P3/P4 identity or revision is malformed or inconsistent",
            );
          }
          return Option.some({
            _tag: "SandboxPolicyPreIntentRequirementV1" as const,
            version: 1 as const,
            projectId: row.project_id as ProjectId,
            workspaceId: row.workspace_id as WorkspaceId,
            executionId: row.execution_id as ExecutionId,
            episodeBinding,
            expectedEpisodeRevision: row.episode_revision,
            providerTurnId,
            logicalStepNo: row.logical_step_no,
            repairAttempt: row.repair_attempt,
            logicalActionId: row.logical_action_id,
            actionIndex: row.action_index,
            callRef: row.call_ref,
            actionRevision: row.action_revision,
            inputHash,
            toolName: row.action_kind,
            toolVersion: row.approval_tool_version,
            approvalId: row.approval_id,
            approvalState: "Pending" as const,
            approvalRevision: row.approval_revision,
            approvalConsumedBy: null,
            approvalExpiresAt: row.approval_expires_at,
          } satisfies SandboxPolicyPreIntentRequirementV1);
        });

      const comparePreIntentSource: SandboxPolicyRequirementReadPortService["comparePreIntentSource"] =
        ({ expected, trustedNow }) =>
          Effect.gen(function* () {
            interface ActionSourceRow {
              readonly project_id: string;
              readonly workspace_id: string;
              readonly episode_revision: number;
              readonly episode_json: string | null;
              readonly action_index: number;
              readonly logical_action_id: string;
              readonly call_ref: string;
              readonly route_kind: string;
              readonly action_kind: string;
              readonly input_hash: string;
              readonly state: string;
              readonly revision: number;
              readonly step_provider_turn_id: string;
              readonly step_logical_step_no: number;
              readonly step_repair_attempt: number;
              readonly step_state: string;
              readonly next_action_index: number;
              readonly settled_at: string | null;
              readonly stop_requested_at: string | null;
            }
            const actionRows = yield* run(
              sql.unsafe<ActionSourceRow>(
                `SELECT e.project_id, e.workspace_id, e.episode_revision,
                        es.episode_json,
                        a.action_index, a.logical_action_id, a.call_ref,
                        a.route_kind, a.action_kind, a.input_hash,
                        a.state, a.revision,
                        s.provider_turn_id AS step_provider_turn_id,
                        s.logical_step_no AS step_logical_step_no,
                        s.repair_attempt AS step_repair_attempt,
                        s.state AS step_state,
                        s.next_action_index,
                        e.settled_at, e.stop_requested_at
                   FROM executions e
                   JOIN agent_execution_state es
                     ON es.execution_id = e.execution_id
                   JOIN agent_loop_steps s
                     ON s.execution_id = e.execution_id
                    AND s.logical_step_no = ? AND s.repair_attempt = ?
                   JOIN agent_loop_step_actions a
                     ON a.execution_id = s.execution_id
                    AND a.logical_step_no = s.logical_step_no
                    AND a.repair_attempt = s.repair_attempt
                    AND a.action_index = ?
                  WHERE e.execution_id = ?`,
                [
                  expected.logicalStepNo,
                  expected.repairAttempt,
                  expected.actionIndex,
                  expected.executionId,
                ],
              ),
            );
            if (actionRows.length === 0) return "ActionRevision";
            if (actionRows.length !== 1)
              return yield* failCorrupt(
                "duplicate P3 Action rows match the pre-intent source proof",
              );
            const action = actionRows[0];
            if (action === undefined)
              return yield* failCorrupt("P3 Action source row disappeared");
            const episodeBinding =
              action.episode_json === null
                ? undefined
                : decodeCanonicalExecutionEpisodeBinding(action.episode_json);
            if (episodeBinding === undefined)
              return yield* failCorrupt(
                "P3 Action source has a malformed EpisodeBinding",
              );
            if (
              action.project_id !== expected.projectId ||
              action.workspace_id !== expected.workspaceId ||
              action.episode_revision !== expected.expectedEpisodeRevision ||
              encodeExecutionEpisodeBinding(episodeBinding) !==
                encodeExecutionEpisodeBinding(expected.episodeBinding) ||
              action.action_index !== expected.actionIndex ||
              action.logical_action_id !== expected.logicalActionId ||
              action.call_ref !== expected.callRef ||
              action.route_kind !== "Executable" ||
              action.action_kind !== expected.toolName ||
              action.input_hash !== expected.inputHash ||
              action.revision !== expected.actionRevision ||
              action.state !== "Pending" ||
              action.step_provider_turn_id !== expected.providerTurnId ||
              action.step_logical_step_no !== expected.logicalStepNo ||
              action.step_repair_attempt !== expected.repairAttempt ||
              action.step_state !== "ActionsInProgress" ||
              action.next_action_index !== expected.actionIndex ||
              action.settled_at !== null ||
              action.stop_requested_at !== null
            )
              return "ActionRevision";

            interface ApprovalSourceRow {
              readonly approval_id: string;
              readonly route_kind: string;
              readonly project_id: string | null;
              readonly workspace_id: string | null;
              readonly execution_id: string | null;
              readonly logical_step_no: number | null;
              readonly repair_attempt: number | null;
              readonly action_index: number | null;
              readonly logical_action_id: string | null;
              readonly call_ref: string | null;
              readonly tool_invocation_id: string | null;
              readonly stable_action_id: string;
              readonly action_version: string;
              readonly arguments_json: string;
              readonly state: string;
              readonly revision: number;
              readonly expires_at: string;
              readonly consumed_by: string | null;
              readonly binding_proven: number;
              readonly invocation_exists: number;
            }
            const approvalRows = yield* run(
              sql.unsafe<ApprovalSourceRow>(
                `SELECT aa.approval_id, aa.route_kind, aa.project_id,
                        aa.workspace_id, aa.execution_id, aa.logical_step_no,
                        aa.repair_attempt, aa.action_index,
                        aa.logical_action_id, aa.call_ref,
                        aa.tool_invocation_id, aa.stable_action_id,
                        aa.action_version, aa.arguments_json, aa.state, aa.revision,
                        aa.expires_at, aa.consumed_by, aa.binding_proven,
                        CASE WHEN aa.tool_invocation_id IS NOT NULL AND EXISTS(
                          SELECT 1 FROM tool_invocations ti
                           WHERE ti.invocation_id = aa.tool_invocation_id
                        ) THEN 1 ELSE 0 END AS invocation_exists
                   FROM action_approvals aa
                  WHERE aa.approval_id = ?`,
                [expected.approvalId],
              ),
            );
            if (approvalRows.length === 0) return "ExecutableApprovalRevision";
            if (approvalRows.length !== 1)
              return yield* failCorrupt(
                "duplicate P4 Executable approval ids match the pre-intent source proof",
              );
            const approval = approvalRows[0];
            if (approval === undefined)
              return yield* failCorrupt("P4 approval source row disappeared");
            if (
              approval.binding_proven !== 1 ||
              approval.tool_invocation_id === null ||
              !isIsoTimestamp(approval.expires_at)
            )
              return yield* failCorrupt(
                "P4 approval source is malformed or has an unexpected P4 intent",
              );
            if (
              approval.route_kind !== "Executable" ||
              approval.project_id !== expected.projectId ||
              approval.workspace_id !== expected.workspaceId ||
              approval.execution_id !== expected.executionId ||
              approval.logical_step_no !== expected.logicalStepNo ||
              approval.repair_attempt !== expected.repairAttempt ||
              approval.action_index !== expected.actionIndex ||
              approval.logical_action_id !== expected.logicalActionId ||
              approval.call_ref !== expected.callRef ||
              approval.stable_action_id !== expected.toolName ||
              approval.action_version !== expected.toolVersion ||
              sha256Hex(approval.arguments_json) !== expected.inputHash ||
              approval.state !== expected.approvalState ||
              approval.revision !== expected.approvalRevision ||
              approval.consumed_by !== expected.approvalConsumedBy ||
              approval.expires_at !== expected.approvalExpiresAt ||
              !isIsoTimestamp(trustedNow) ||
              Date.parse(approval.expires_at) <= Date.parse(trustedNow)
            )
              return "ExecutableApprovalRevision";
            if (approval.invocation_exists !== 0)
              return yield* failCorrupt(
                "an intent exists while its exact Executable approval remains Pending",
              );
            return undefined;
          });

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
            if (rows.length === 0)
              return yield* findPreIntentRequirement(input);

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
            if (candidates.length === 0)
              return yield* findPreIntentRequirement(input);
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

      return SandboxPolicyRequirementReadPort.of({
        findPendingByExecution,
        comparePreIntentSource,
      });
    }),
  );

export const SandboxPolicyRequirementReadPortLive = makeLayer();
