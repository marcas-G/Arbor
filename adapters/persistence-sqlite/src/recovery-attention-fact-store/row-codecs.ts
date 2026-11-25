import {
  ProviderTurnId,
  parse,
} from "@arbor/domain";
import type {
  AssignWorkBindingAttentionFact,
  AssignWorkBindingFailureCode,
  DeliverReplayAttentionFact,
  DeliverReplayFailureCode,
  LegacyAdoptionAttentionFact,
  LegacyAdoptionAttentionResolutionFact,
  LegacyAdoptionEvidenceV1,
  RecoveryAttentionFactStoreError,
  SubmittedDecisionBindingAttentionFact,
} from "@arbor/ports";
import {
  canonicalizeLegacyAdoptionEvidenceV1,
  legacyAdoptionAttentionFactIdV1,
  legacyAdoptionEvidenceDigestV1,
} from "@arbor/ports";
import {
  Effect,
} from "effect";
import {
  persistenceCorruption,
} from "../repository-error.js";
import {
  decodeSubmittedDecisionBindingAttentionFactRow,
  type SubmittedDecisionBindingAttentionDbRow,
} from "../submitted-decision-binding-attention-codec.js";

export interface Row {
  readonly attention_fact_id: string;
  readonly event_id: string;
  readonly project_id: string;
  readonly execution_id: string;
  readonly target_workspace_id: string;
  readonly logical_action_id: string;
  readonly committed_command_id: string;
  readonly failure_code: string;
  readonly first_detected_at: string;
}

export interface DeliverReplayRow {
  readonly attention_fact_id: string;
  readonly event_id: string;
  readonly project_id: string;
  readonly execution_id: string;
  readonly target_workspace_id: string;
  readonly logical_action_id: string;
  readonly message_id: string;
  readonly failure_code: string;
  readonly first_detected_at: string;
}

export const submittedDecisionBindingColumns = `attention_fact_id, event_id, project_id,
  execution_id, workspace_id, logical_step_no, repair_attempt,
  provider_turn_id, logical_action_id, failure_code, first_detected_at`;

export interface LegacyAdoptionAttentionRow {
  readonly attention_fact_id: string;
  readonly event_id: string;
  readonly project_id: string;
  readonly execution_id: string;
  readonly workspace_id: string;
  readonly provider_turn_id: string;
  readonly logical_step_no: number;
  readonly repair_attempt: number;
  readonly failure_code: "LegacyActionDispositionUnproven";
  readonly evidence_sha256: string;
  readonly first_detected_at: string;
}

export const legacyAdoptionColumns = `attention_fact_id, event_id, project_id,
  execution_id, workspace_id, provider_turn_id, logical_step_no,
  repair_attempt, failure_code, evidence_sha256, first_detected_at`;

export interface LegacyAdoptionResolutionRow {
  readonly resolution_fact_id: string;
  readonly attention_fact_id: string;
  readonly event_id: string;
  readonly project_id: string;
  readonly execution_id: string;
  readonly workspace_id: string;
  readonly provider_turn_id: string;
  readonly original_evidence_sha256: string;
  readonly resolution_evidence_sha256: string;
  readonly action_disposition_summary_json: string;
  readonly action_disposition_summary_sha256: string;
  readonly resolution_code: string;
  readonly resolved_at: string;
}

export const legacyAdoptionResolutionColumns = `resolution_fact_id, attention_fact_id,
  event_id, project_id, execution_id, workspace_id, provider_turn_id,
  original_evidence_sha256, resolution_evidence_sha256,
  action_disposition_summary_json, action_disposition_summary_sha256,
  resolution_code, resolved_at`;

export const toLegacyAdoptionFact = (
  row: LegacyAdoptionAttentionRow,
): LegacyAdoptionAttentionFact => ({
  attentionFactId: row.attention_fact_id,
  eventId: row.event_id,
  projectId: row.project_id as never,
  executionId: row.execution_id as never,
  workspaceId: row.workspace_id as never,
  providerTurnId: parse(ProviderTurnId)(row.provider_turn_id),
  logicalStepNo: Number(row.logical_step_no),
  repairAttempt: Number(row.repair_attempt),
  failureCode: row.failure_code,
  evidenceSha256: row.evidence_sha256,
  firstDetectedAt: row.first_detected_at,
});

export const toLegacyAdoptionResolution = (
  row: LegacyAdoptionResolutionRow,
): LegacyAdoptionAttentionResolutionFact => ({
  resolutionFactId: row.resolution_fact_id,
  attentionFactId: row.attention_fact_id,
  eventId: row.event_id,
  projectId: row.project_id as never,
  executionId: row.execution_id as never,
  workspaceId: row.workspace_id as never,
  providerTurnId: parse(ProviderTurnId)(row.provider_turn_id),
  originalEvidenceSha256: row.original_evidence_sha256,
  resolutionEvidenceSha256: row.resolution_evidence_sha256,
  actionDispositionSummaryJson: row.action_disposition_summary_json,
  actionDispositionSummarySha256: row.action_disposition_summary_sha256,
  resolutionCode:
    row.resolution_code as LegacyAdoptionAttentionResolutionFact["resolutionCode"],
  resolvedAt: row.resolved_at,
});

export const legacyEvidenceMatchesFact = (
  evidence: LegacyAdoptionEvidenceV1,
  fact: LegacyAdoptionAttentionFact,
): boolean =>
  evidence.executionId === fact.executionId &&
  evidence.projectId === fact.projectId &&
  evidence.workspaceId === fact.workspaceId &&
  evidence.step.providerTurnId === fact.providerTurnId &&
  evidence.step.logicalStepNo === fact.logicalStepNo &&
  evidence.step.repairAttempt === fact.repairAttempt &&
  evidence.failureCode === fact.failureCode &&
  legacyAdoptionEvidenceDigestV1(evidence) === fact.evidenceSha256 &&
  legacyAdoptionAttentionFactIdV1(fact.executionId, fact.evidenceSha256) ===
    fact.attentionFactId;

export const isLegacyMissing = (value: unknown): boolean =>
  typeof value === "object" &&
  value !== null &&
  !Array.isArray(value) &&
  (value as Record<string, unknown>)._tag === "Missing" &&
  Object.keys(value as Record<string, unknown>).length === 1;

export const isSha256Hex = (value: unknown): value is string =>
  typeof value === "string" && /^[0-9a-f]{64}$/u.test(value);

export const validateLegacyAdoptionEvidence = (
  evidence: LegacyAdoptionEvidenceV1,
): string | undefined => {
  if (
    evidence.version !== 1 ||
    evidence.failureCode !== "LegacyActionDispositionUnproven" ||
    evidence.executionId.length === 0 ||
    evidence.projectId.length === 0 ||
    evidence.workspaceId.length === 0 ||
    evidence.episode.kind.length === 0 ||
    evidence.episode.ref.length === 0 ||
    !Number.isSafeInteger(evidence.episode.revision) ||
    evidence.episode.revision < 0 ||
    !Number.isSafeInteger(evidence.step.logicalStepNo) ||
    evidence.step.logicalStepNo < 0 ||
    !Number.isSafeInteger(evidence.step.repairAttempt) ||
    evidence.step.repairAttempt < 0 ||
    evidence.step.providerTurnId.length === 0 ||
    !Number.isSafeInteger(evidence.providerSuccess.attemptNo) ||
    evidence.providerSuccess.attemptNo < 0 ||
    evidence.providerSuccess.evidenceVersion.length === 0 ||
    evidence.providerSuccess.finishReason.length === 0 ||
    evidence.providerSuccess.settledAt.length === 0 ||
    !isSha256Hex(evidence.providerSuccess.canonicalEventsSha256) ||
    evidence.actions.length === 0
  ) {
    return "legacy adoption evidence has an invalid required identity";
  }
  let hasUnprovenDisposition = false;
  for (let index = 0; index < evidence.actions.length; index += 1) {
    const action = evidence.actions[index];
    if (
      action === undefined ||
      action.actionIndex !== index ||
      action.logicalActionId.length === 0 ||
      action.callRef.length === 0 ||
      action.toolName.length === 0 ||
      action.toolSchemaVersion.length === 0 ||
      !isSha256Hex(action.inputHash) ||
      !isSha256Hex(action.argumentsSha256) ||
      !(
        typeof action.stableActionId === "string" ||
        isLegacyMissing(action.stableActionId)
      ) ||
      !(
        typeof action.actionVersion === "string" ||
        isLegacyMissing(action.actionVersion)
      )
    ) {
      return "legacy adoption action evidence has an invalid required identity";
    }
    if (isLegacyMissing(action.disposition)) hasUnprovenDisposition = true;
  }
  if (!hasUnprovenDisposition) {
    return "legacy adoption failure requires at least one unproven action disposition";
  }
  try {
    canonicalizeLegacyAdoptionEvidenceV1(evidence);
  } catch (cause) {
    return cause instanceof Error
      ? cause.message
      : "legacy adoption evidence is not canonical JSON v1";
  }
  return undefined;
};

export const decodeSubmittedDecisionBindingFact = (
  row: SubmittedDecisionBindingAttentionDbRow,
): Effect.Effect<
  SubmittedDecisionBindingAttentionFact,
  RecoveryAttentionFactStoreError
> => {
  const fact = decodeSubmittedDecisionBindingAttentionFactRow(row);
  return fact === undefined
    ? Effect.fail(
        persistenceCorruption(
          "RecoveryAttentionFactStore",
          "submitted-decision-binding-read",
          "stored Submitted DecisionEpisode binding fact violates its closed physical codec",
        ),
      )
    : Effect.succeed(fact);
};

export const factsAreEqual = (
  left: SubmittedDecisionBindingAttentionFact,
  right: SubmittedDecisionBindingAttentionFact,
): boolean =>
  left.attentionFactId === right.attentionFactId &&
  left.eventId === right.eventId &&
  left.projectId === right.projectId &&
  left.executionId === right.executionId &&
  left.workspaceId === right.workspaceId &&
  left.logicalStepNo === right.logicalStepNo &&
  left.repairAttempt === right.repairAttempt &&
  left.providerTurnId === right.providerTurnId &&
  left.logicalActionId === right.logicalActionId &&
  left.failureCode === right.failureCode &&
  left.firstDetectedAt === right.firstDetectedAt;

export interface RecoveryAttentionFactQualificationEvent {
  readonly boundary:
    | "AH10BeforeAssignWorkBindingAttentionCommit"
    | "AH10AfterAssignWorkBindingAttentionCommit";
  readonly executionId: string;
  readonly logicalActionId: string;
  readonly committedCommandId: string;
}

export type RecoveryAttentionFactQualificationProbe = (
  event: RecoveryAttentionFactQualificationEvent,
) => Promise<void>;

export const toFact = (row: Row): AssignWorkBindingAttentionFact => ({
  attentionFactId: row.attention_fact_id,
  eventId: row.event_id as never,
  projectId: row.project_id as never,
  executionId: row.execution_id as never,
  targetWorkspaceId: row.target_workspace_id as never,
  logicalActionId: row.logical_action_id,
  committedCommandId: row.committed_command_id as never,
  failureCode: row.failure_code as AssignWorkBindingFailureCode,
  firstDetectedAt: row.first_detected_at,
});

export const toDeliverReplayFact = (
  row: DeliverReplayRow,
): DeliverReplayAttentionFact => ({
  attentionFactId: row.attention_fact_id,
  eventId: row.event_id,
  projectId: row.project_id as never,
  executionId: row.execution_id as never,
  targetWorkspaceId: row.target_workspace_id as never,
  logicalActionId: row.logical_action_id,
  messageId: row.message_id,
  failureCode: row.failure_code as DeliverReplayFailureCode,
  firstDetectedAt: row.first_detected_at,
});

export const DELIVER_REPLAY_COLUMNS = `attention_fact_id, event_id, project_id,
  execution_id, target_workspace_id, logical_action_id, message_id,
  failure_code, first_detected_at`;

