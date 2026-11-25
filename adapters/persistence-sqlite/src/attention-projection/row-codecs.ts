import type {
  ProjectId,
} from "@arbor/domain";
import {
  type AssignWorkBindingAttentionProjectionRow,
  type DeliverReplayAttentionProjectionRow,
  type LegacyAdoptionAttentionProjectionRow,
  type SubmittedDecisionBindingAttentionProjectionRow,
  sha256Hex,
  type ToolObservationReplayAttentionProjectionRow,
  type WorkspaceResourceActivationAttentionProjectionRow,
} from "@arbor/ports";

export interface AttentionProjectionDbRow {
  readonly project_id: string;
  readonly dedup_key: string;
  readonly source: "AssignWorkTargetBindingFailure";
  readonly severity: "ActionRequired";
  readonly target_workspace_id: string;
  readonly summary: string;
  readonly failure_code: AssignWorkBindingAttentionProjectionRow["failureCode"];
  readonly occurred_at: string;
  readonly source_event_id: string;
  readonly source_fact_id: string;
  readonly source_execution_id: string;
}

export interface WorkspaceResourceActivationAttentionDbRow {
  readonly project_id: string;
  readonly workspace_id: string;
  readonly resource_boundary_revision: number;
  readonly occurred_at: string;
}

export interface DeliverReplayAttentionDbRow {
  readonly project_id: string;
  readonly dedup_key: string;
  readonly target_workspace_id: string;
  readonly failure_code: DeliverReplayAttentionProjectionRow["failureCode"];
  readonly occurred_at: string;
  readonly source_event_id: string;
  readonly source_fact_id: string;
  readonly source_execution_id: string;
}

export interface ToolObservationReplayAttentionDbRow {
  readonly project_id: string;
  readonly dedup_key: string;
  readonly source: "ToolObservationReplayEvidenceFailure";
  readonly severity: "ActionRequired";
  readonly target_workspace_id: string;
  readonly summary: ToolObservationReplayAttentionProjectionRow["summary"];
  readonly failure_code: ToolObservationReplayAttentionProjectionRow["failureCode"];
  readonly occurred_at: string;
  readonly source_event_id: string;
  readonly source_fact_id: string;
}
export interface SubmittedDecisionBindingAttentionDbRow {
  readonly project_id: string;
  readonly dedup_key: string;
  readonly target_workspace_id: string;
  readonly failure_code: SubmittedDecisionBindingAttentionProjectionRow["failureCode"];
  readonly occurred_at: string;
  readonly source_event_id: string;
  readonly source_fact_id: string;
  readonly source_execution_id: string;
}
export interface LegacyAdoptionAttentionDbRow {
  readonly project_id: string;
  readonly attention_fact_id: string;
  readonly workspace_id: string;
  readonly failure_code: "LegacyActionDispositionUnproven";
  readonly first_detected_at: string;
  readonly source_event_id: string;
  readonly source_fact_id: string;
  readonly source_execution_id: string;
}

export interface SandboxProviderUnavailableAttentionDbRow {
  readonly project_id: string;
  readonly attention_fact_id: string;
  readonly workspace_id: string;
  readonly execution_id: string;
  readonly policy_revision: number;
  readonly first_detected_at: string;
  readonly policy_digest: string;
  readonly profile_id: string;
  readonly provider_id: string;
  readonly provider_version: string;
  readonly probe_evidence_ref: string | null;
  readonly failure_code: string;
  readonly episode_binding_json: string;
  readonly active_episode_json: string;
  readonly decision_command_id: string;
  readonly command_resolution: string | null;
  readonly command_schema_version: string | null;
  readonly authority_kind: "LegacyHumanGrant" | "WorkspaceAuthorization";
  readonly workspace_authorization_revision: number | null;
  readonly command_result_json: string | null;
  readonly command_project_id: string | null;
  readonly disposition_json: string;
}

export interface SandboxRecoveryBindingDbRow {
  readonly project_id: string;
  readonly execution_id: string;
  readonly invocation_id: string;
  readonly workspace_id: string;
  readonly intent_at: string;
  readonly recovery_binding_state: string;
  readonly recovery_binding_sha256: string | null;
  readonly effect_admission_state: string;
  readonly settled_at: string | null;
  readonly tool_name: string;
  readonly tool_version: string;
  readonly side_effect_semantics: string;
  readonly arguments_json: string;
  readonly resolved_regions_json?: string;
  readonly binding_version: number | null;
  readonly canonical_binding_json: string | null;
  readonly binding_sha256: string | null;
  readonly profile_id: string | null;
  readonly action_state: string | null;
  readonly action_input_hash: string | null;
  readonly action_kind: string | null;
  readonly p3_logical_action_id: string | null;
  readonly p3_action_index: number | null;
  readonly p3_call_ref: string | null;
  readonly p3_provider_turn_id: string | null;
  readonly p3_step_state: string | null;
  readonly p3_step_next_action_index?: number | null;
}

export interface ProcessExecutionUnavailableDbRow {
  readonly project_id: string;
  readonly execution_id: string;
  readonly workspace_id: string;
  readonly invocation_id: string;
  readonly tool_name: string;
  readonly tool_version: string;
  readonly side_effect_semantics: string;
  readonly arguments_json: string;
  readonly approval_id: string | null;
  readonly effect_admission_state: string;
  readonly settled_at: string | null;
  readonly settlement_kind: string | null;
  readonly settlement_json: string | null;
  readonly settlement_provenance: string | null;
  readonly result_ref: string | null;
  readonly observation_format_version: string | null;
  readonly observation_json: Uint8Array | string | null;
  readonly observation_sha256: string | null;
  readonly selected_attempt_no: number | null;
  readonly selected_fact_id: string | null;
  readonly recovery_binding_state: string;
  readonly recovery_binding_sha256: string | null;
  readonly binding_version: number | null;
  readonly canonical_binding_json: string | null;
  readonly binding_sha256: string | null;
  readonly action_state: string | null;
  readonly action_input_hash: string | null;
  readonly action_kind: string | null;
  readonly p3_logical_step_no: number | null;
  readonly p3_repair_attempt: number | null;
  readonly p3_logical_action_id: string | null;
  readonly p3_action_index: number | null;
  readonly p3_call_ref: string | null;
  readonly p3_provider_turn_id: string | null;
}

export const canonicalUtcText = (value: string): boolean => {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
};

export const sandboxRecoveryBindingAttentionId = (
  executionId: string,
  invocationId: string,
  bindingShaOr: string | null,
): string =>
  sha256Hex(
    JSON.stringify({
      version: 1,
      executionId,
      invocationId,
      bindingShaOr,
    }),
  );

export type AttentionProjectionQualificationEvent =
  | {
      readonly boundary: "P10AfterAttentionRowWriteBeforeConsumerCommit";
      readonly projectId: ProjectId;
      readonly attentionFactId: string;
    }
  | {
      readonly boundary: "P10AfterActivationAttentionRowWriteBeforeProjectionCommit";
      readonly projectId: ProjectId;
      readonly workspaceId: WorkspaceResourceActivationAttentionProjectionRow["workspaceId"];
      readonly resourceBoundaryRevision: WorkspaceResourceActivationAttentionProjectionRow["resourceBoundaryRevision"];
    };

export type AttentionProjectionQualificationProbe = (
  event: AttentionProjectionQualificationEvent,
) => Promise<void>;

export const fromDb = (
  row: AttentionProjectionDbRow,
): AssignWorkBindingAttentionProjectionRow => ({
  projectId: row.project_id as ProjectId,
  dedupKey: row.dedup_key,
  source: row.source,
  severity: row.severity,
  targetWorkspaceId: row.target_workspace_id as never,
  summary: row.summary,
  failureCode: row.failure_code,
  occurredAt: row.occurred_at,
  sourceEventId: row.source_event_id as never,
  sourceFactId: row.source_fact_id,
  sourceExecutionId: row.source_execution_id,
});

export const activationRowFromDb = (
  row: WorkspaceResourceActivationAttentionDbRow,
): WorkspaceResourceActivationAttentionProjectionRow => ({
  projectId: row.project_id as ProjectId,
  workspaceId: row.workspace_id as never,
  resourceBoundaryRevision: Number(
    row.resource_boundary_revision,
  ) as WorkspaceResourceActivationAttentionProjectionRow["resourceBoundaryRevision"],
  occurredAt: row.occurred_at,
});

export const legacyAdoptionRowFromDb = (
  row: LegacyAdoptionAttentionDbRow,
): LegacyAdoptionAttentionProjectionRow => ({
  projectId: row.project_id as ProjectId,
  attentionFactId: row.attention_fact_id,
  workspaceId: row.workspace_id as never,
  failureCode: row.failure_code,
  firstDetectedAt: row.first_detected_at,
  sourceEventId: row.source_event_id as never,
  sourceFactId: row.source_fact_id,
  sourceExecutionId: row.source_execution_id,
});

export const deliverReplayRowFromDb = (
  row: DeliverReplayAttentionDbRow,
): DeliverReplayAttentionProjectionRow => ({
  projectId: row.project_id as ProjectId,
  dedupKey: row.dedup_key,
  source: "DeliverReplayFailure",
  severity: "ActionRequired",
  targetWorkspaceId: row.target_workspace_id as never,
  summary:
    "A Deliver handover could not be reconciled with its exact Message and MessageSent facts; execution recovery is paused.",
  failureCode: row.failure_code,
  occurredAt: row.occurred_at,
  sourceEventId: row.source_event_id as never,
  sourceFactId: row.source_fact_id,
  sourceExecutionId: row.source_execution_id,
});

export const toolObservationRowFromDb = (
  row: ToolObservationReplayAttentionDbRow,
): ToolObservationReplayAttentionProjectionRow => ({
  projectId: row.project_id as ProjectId,
  dedupKey: row.dedup_key,
  source: row.source,
  severity: row.severity,
  targetWorkspaceId: row.target_workspace_id as never,
  summary: row.summary,
  failureCode: row.failure_code,
  occurredAt: row.occurred_at,
  sourceEventId: row.source_event_id as never,
  sourceFactId: row.source_fact_id,
});

export const submittedDecisionBindingRowFromDb = (
  row: SubmittedDecisionBindingAttentionDbRow,
): SubmittedDecisionBindingAttentionProjectionRow => ({
  projectId: row.project_id as ProjectId,
  attentionFactId: row.dedup_key,
  workspaceId: row.target_workspace_id as never,
  firstDetectedAt: row.occurred_at,
  dedupKey: row.dedup_key,
  source: "SubmittedDecisionBindingFailure",
  severity: "ActionRequired",
  targetWorkspaceId: row.target_workspace_id as never,
  summary:
    "A submitted DecisionEpisode binding could not be proven against its exact Execution, Step, and Action; recovery is paused.",
  failureCode: row.failure_code,
  occurredAt: row.occurred_at,
  sourceEventId: row.source_event_id as never,
  sourceFactId: row.source_fact_id,
  sourceExecutionId: row.source_execution_id,
});

export const sameRow = (
  left: AssignWorkBindingAttentionProjectionRow,
  right: AssignWorkBindingAttentionProjectionRow,
): boolean =>
  left.projectId === right.projectId &&
  left.dedupKey === right.dedupKey &&
  left.source === right.source &&
  left.severity === right.severity &&
  left.targetWorkspaceId === right.targetWorkspaceId &&
  left.summary === right.summary &&
  left.failureCode === right.failureCode &&
  left.occurredAt === right.occurredAt &&
  left.sourceEventId === right.sourceEventId &&
  left.sourceFactId === right.sourceFactId;

