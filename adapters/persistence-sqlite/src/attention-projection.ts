import type { DomainEvent, ProjectId } from "@arbor/domain";
import {
  decodeCanonicalSandboxPolicyDecisionCommittedInternalV1,
  encodeExecutionEpisodeBinding,
} from "@arbor/domain";
import {
  type AssignWorkBindingAttentionFact,
  type AssignWorkBindingAttentionProjectionRow,
  AttentionProjectionStore,
  type AttentionProjectionStoreError,
  type AttentionProjectionStoreService,
  type ConsumerOffsetStoreError,
  canonicalArgumentsDigestV1,
  canonicalizeLegacyActionDispositionSummaryV1,
  type DeliverReplayAttentionProjectionRow,
  deriveLegacyAdoptionResolutionCodeV1,
  type LegacyAdoptionAttentionFact,
  type LegacyAdoptionAttentionProjectionRow,
  type LegacyAdoptionAttentionResolutionFact,
  legacyAdoptionResolutionFactIdV1,
  type ProjectionStoreService,
  type RecoveryAttentionFactStoreService,
  type SandboxPolicyDecisionRequiredProjectionRow,
  type SandboxProviderUnavailableAttentionProjectionRow,
  type SandboxProviderUnavailableAttentionQueueService,
  type SandboxProviderUnavailableStoreService,
  type SandboxRecoveryBindingFailureProjectionRow,
  type SubmittedDecisionBindingAttentionProjectionRow,
  sha256Hex,
  type ToolObservationReplayAttentionFactStoreService,
  type ToolObservationReplayAttentionProjectionRow,
  TransactionScope,
  targetResourceIdentityDigestV1,
  verifyRecoveryBindingV1,
  type WorkspaceResourceActivationAttentionProjectionRow,
  type WorkspaceResourceActivationIntent,
  type WorkspaceResourceActivationStoreService,
} from "@arbor/ports";
import { Effect, Layer, Option } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";
import {
  persistenceCorruption,
  repositoryFailure,
} from "./repository-error.js";

interface AttentionProjectionDbRow {
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

interface WorkspaceResourceActivationAttentionDbRow {
  readonly project_id: string;
  readonly workspace_id: string;
  readonly resource_boundary_revision: number;
  readonly occurred_at: string;
}

interface DeliverReplayAttentionDbRow {
  readonly project_id: string;
  readonly dedup_key: string;
  readonly target_workspace_id: string;
  readonly failure_code: DeliverReplayAttentionProjectionRow["failureCode"];
  readonly occurred_at: string;
  readonly source_event_id: string;
  readonly source_fact_id: string;
  readonly source_execution_id: string;
}

interface ToolObservationReplayAttentionDbRow {
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
interface SubmittedDecisionBindingAttentionDbRow {
  readonly project_id: string;
  readonly dedup_key: string;
  readonly target_workspace_id: string;
  readonly failure_code: SubmittedDecisionBindingAttentionProjectionRow["failureCode"];
  readonly occurred_at: string;
  readonly source_event_id: string;
  readonly source_fact_id: string;
  readonly source_execution_id: string;
}
interface LegacyAdoptionAttentionDbRow {
  readonly project_id: string;
  readonly attention_fact_id: string;
  readonly workspace_id: string;
  readonly failure_code: "LegacyActionDispositionUnproven";
  readonly first_detected_at: string;
  readonly source_event_id: string;
  readonly source_fact_id: string;
  readonly source_execution_id: string;
}

interface SandboxProviderUnavailableAttentionDbRow {
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
  readonly command_result_json: string | null;
  readonly command_project_id: string | null;
  readonly disposition_json: string;
}

interface SandboxRecoveryBindingDbRow {
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

const canonicalUtcText = (value: string): boolean => {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
};

const sandboxRecoveryBindingAttentionId = (
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

const fromDb = (
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

const activationRowFromDb = (
  row: WorkspaceResourceActivationAttentionDbRow,
): WorkspaceResourceActivationAttentionProjectionRow => ({
  projectId: row.project_id as ProjectId,
  workspaceId: row.workspace_id as never,
  resourceBoundaryRevision: Number(
    row.resource_boundary_revision,
  ) as WorkspaceResourceActivationAttentionProjectionRow["resourceBoundaryRevision"],
  occurredAt: row.occurred_at,
});

const legacyAdoptionRowFromDb = (
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

const deliverReplayRowFromDb = (
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

const toolObservationRowFromDb = (
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

const submittedDecisionBindingRowFromDb = (
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

const sameRow = (
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

export const makeAttentionProjectionStoreLive = (
  qualificationProbe?: AttentionProjectionQualificationProbe,
): Layer.Layer<AttentionProjectionStore, never, SqlClient> =>
  Layer.effect(
    AttentionProjectionStore,
    Effect.gen(function* () {
      const sql = yield* SqlClient;
      const failure = repositoryFailure("AttentionProjectionStore", "rows");
      const run = <A>(effect: Effect.Effect<A, SqlError>) =>
        effect.pipe(Effect.mapError(failure));
      const submittedDecisionBindingMarkerAvailable = () =>
        run(
          sql.unsafe<{ readonly name: string }>(
            `SELECT name FROM sqlite_master
              WHERE type = 'table'
                AND name = 'submitted_decision_binding_attention_rows'`,
          ),
        );
      const requireSubmittedDecisionBindingMarker = () =>
        Effect.gen(function* () {
          const tables = yield* submittedDecisionBindingMarkerAvailable();
          if (tables.length === 0) {
            return yield* Effect.fail<AttentionProjectionStoreError>({
              _tag: "PersistenceUnavailable",
              repository: "AttentionProjectionStore",
              operation: "submitted-decision-binding-marker",
              retryDisposition: "non-retryable",
              sourceTag: "P41MigrationNotRegistered",
              cause: { _tag: "P41MigrationNotRegistered" },
            });
          }
        });
      const requireLegacyAdoptionMarker = () =>
        Effect.gen(function* () {
          const tables = yield* run(
            sql.unsafe<{ readonly name: string }>(
              `SELECT name FROM sqlite_master
                WHERE type='table' AND name='legacy_adoption_attention_rows'`,
            ),
          );
          if (tables.length === 0) {
            return yield* Effect.fail<AttentionProjectionStoreError>({
              _tag: "PersistenceUnavailable",
              repository: "AttentionProjectionStore",
              operation: "legacy-adoption-attention",
              retryDisposition: "non-retryable",
              sourceTag: "P47MigrationNotRegistered",
              cause: { _tag: "P47MigrationNotRegistered" },
            });
          }
        });
      return AttentionProjectionStore.of({
        isSubmittedDecisionBindingAvailable: () =>
          Effect.gen(function* () {
            yield* TransactionScope;
            const tables = yield* submittedDecisionBindingMarkerAvailable();
            return tables.length > 0;
          }),
        putAssignWorkBindingFailure: (fact, occurredAt) =>
          Effect.gen(function* () {
            yield* TransactionScope;
            const owners = yield* run(
              sql.unsafe<{ workspace_id: string }>(
                "SELECT workspace_id FROM executions WHERE execution_id = ? AND project_id = ?",
                [fact.executionId, fact.projectId],
              ),
            );
            const targetWorkspaceId = owners[0]?.workspace_id;
            if (
              targetWorkspaceId === undefined ||
              targetWorkspaceId !== fact.targetWorkspaceId
            ) {
              return yield* Effect.fail<AttentionProjectionStoreError>({
                _tag: "PersistenceCorruption" as const,
                repository: "AttentionProjectionStore" as const,
                operation: "target",
                reason:
                  "P9 Attention fact target does not match the owning Execution workspace",
              });
            }
            const row: AssignWorkBindingAttentionProjectionRow = {
              projectId: fact.projectId,
              dedupKey: fact.attentionFactId,
              source: "AssignWorkTargetBindingFailure",
              severity: "ActionRequired",
              targetWorkspaceId: targetWorkspaceId as never,
              summary:
                "A committed AssignWork could not be proven to match its exact target; recovery is paused.",
              failureCode: fact.failureCode,
              occurredAt,
              sourceEventId: fact.eventId as never,
              sourceFactId: fact.attentionFactId,
              sourceExecutionId: fact.executionId,
            };
            yield* run(
              sql.unsafe(
                `INSERT INTO attention_projection_rows (
                project_id, dedup_key, source, severity, target_workspace_id,
                summary, failure_code, occurred_at, source_event_id, source_fact_id
              ) VALUES (?,?,?,?,?,?,?,?,?,?)
              ON CONFLICT(project_id, dedup_key) DO NOTHING`,
                [
                  row.projectId,
                  row.dedupKey,
                  row.source,
                  row.severity,
                  row.targetWorkspaceId,
                  row.summary,
                  row.failureCode,
                  row.occurredAt,
                  row.sourceEventId,
                  row.sourceFactId,
                ],
              ),
            );
            if (qualificationProbe !== undefined) {
              yield* Effect.promise(() =>
                qualificationProbe({
                  boundary: "P10AfterAttentionRowWriteBeforeConsumerCommit",
                  projectId: row.projectId,
                  attentionFactId: row.sourceFactId,
                }),
              );
            }
            const rows = yield* run(
              sql.unsafe<AttentionProjectionDbRow>(
                `SELECT project_id, dedup_key, source, severity,
                      target_workspace_id, summary, failure_code, occurred_at,
                      source_event_id, source_fact_id
                 FROM attention_projection_rows
                WHERE project_id = ? AND dedup_key = ?`,
                [row.projectId, row.dedupKey],
              ),
            );
            const stored = rows[0];
            if (stored === undefined || !sameRow(fromDb(stored), row)) {
              return yield* Effect.fail({
                _tag: "PersistenceCorruption" as const,
                repository: "AttentionProjectionStore" as const,
                operation: "rows",
                reason:
                  "Attention dedup identity is already bound to another source row",
              });
            }
          }),
        putDeliverReplayFailure: (fact) =>
          Effect.gen(function* () {
            yield* TransactionScope;
            const stored = yield* run(
              sql.unsafe<{
                readonly event_id: string;
                readonly project_id: string;
                readonly execution_id: string;
                readonly target_workspace_id: string;
                readonly logical_action_id: string;
                readonly message_id: string;
                readonly failure_code: string;
                readonly first_detected_at: string;
              }>(
                `SELECT event_id, project_id, execution_id, target_workspace_id,
                        logical_action_id, message_id, failure_code, first_detected_at
                   FROM deliver_replay_attention_facts
                  WHERE attention_fact_id = ?`,
                [fact.attentionFactId],
              ),
            );
            const row = stored[0];
            if (
              row === undefined ||
              row.event_id !== fact.eventId ||
              row.project_id !== fact.projectId ||
              row.execution_id !== fact.executionId ||
              row.target_workspace_id !== fact.targetWorkspaceId ||
              row.logical_action_id !== fact.logicalActionId ||
              row.message_id !== fact.messageId ||
              row.failure_code !== fact.failureCode ||
              row.first_detected_at !== fact.firstDetectedAt
            ) {
              return yield* Effect.fail<AttentionProjectionStoreError>({
                _tag: "PersistenceCorruption",
                repository: "AttentionProjectionStore",
                operation: "deliver-replay-marker",
                reason:
                  "Deliver marker input does not match its durable P9 fact",
              });
            }
            yield* run(
              sql.unsafe(
                `INSERT INTO deliver_replay_attention_rows (attention_fact_id)
                 VALUES (?) ON CONFLICT(attention_fact_id) DO NOTHING`,
                [fact.attentionFactId],
              ),
            );
            if (qualificationProbe !== undefined) {
              yield* Effect.promise(() =>
                qualificationProbe({
                  boundary: "P10AfterAttentionRowWriteBeforeConsumerCommit",
                  projectId: fact.projectId,
                  attentionFactId: fact.attentionFactId,
                }),
              );
            }
          }),
        putSubmittedDecisionBindingFailure: (fact) =>
          Effect.gen(function* () {
            yield* TransactionScope;
            yield* requireSubmittedDecisionBindingMarker();
            const sourceFacts = yield* run(
              sql.unsafe<{
                readonly attention_fact_id: string;
                readonly event_id: string;
                readonly project_id: string;
                readonly execution_id: string;
                readonly workspace_id: string;
                readonly logical_step_no: number;
                readonly repair_attempt: number;
                readonly provider_turn_id: string;
                readonly logical_action_id: string;
                readonly failure_code: string;
                readonly first_detected_at: string;
              }>(
                `SELECT attention_fact_id, event_id, project_id, execution_id,
                        workspace_id, logical_step_no, repair_attempt,
                        provider_turn_id, logical_action_id, failure_code,
                        first_detected_at
                   FROM submitted_decision_binding_attention_facts
                  WHERE attention_fact_id = ?`,
                [fact.attentionFactId],
              ),
            );
            const source = sourceFacts[0];
            if (
              source === undefined ||
              source.attention_fact_id !== fact.attentionFactId ||
              source.event_id !== fact.eventId ||
              source.project_id !== fact.projectId ||
              source.execution_id !== fact.executionId ||
              source.workspace_id !== fact.workspaceId ||
              Number(source.logical_step_no) !== fact.logicalStepNo ||
              Number(source.repair_attempt) !== fact.repairAttempt ||
              source.provider_turn_id !== fact.providerTurnId ||
              source.logical_action_id !== fact.logicalActionId ||
              source.failure_code !== fact.failureCode ||
              source.first_detected_at !== fact.firstDetectedAt
            ) {
              return yield* Effect.fail<AttentionProjectionStoreError>({
                _tag: "PersistenceCorruption",
                repository: "AttentionProjectionStore",
                operation: "submitted-decision-binding-marker",
                reason:
                  "Submitted DecisionEpisode marker input does not match its exact immutable P9 fact",
              });
            }
            const executions = yield* run(
              sql.unsafe<{ readonly workspace_id: string }>(
                `SELECT workspace_id FROM executions
                  WHERE execution_id = ? AND project_id = ?`,
                [fact.executionId, fact.projectId],
              ),
            );
            if (executions[0]?.workspace_id !== fact.workspaceId) {
              return yield* Effect.fail<AttentionProjectionStoreError>({
                _tag: "PersistenceCorruption",
                repository: "AttentionProjectionStore",
                operation: "submitted-decision-binding-marker",
                reason:
                  "Submitted DecisionEpisode fact Workspace does not match its authoritative Execution",
              });
            }
            yield* run(
              sql.unsafe(
                `INSERT INTO submitted_decision_binding_attention_rows (
                   project_id, attention_fact_id, workspace_id
                 ) VALUES (?, ?, ?)
                 ON CONFLICT(project_id, attention_fact_id) DO NOTHING`,
                [fact.projectId, fact.attentionFactId, fact.workspaceId],
              ),
            );
            const markers = yield* run(
              sql.unsafe<{ readonly workspace_id: string }>(
                `SELECT workspace_id
                   FROM submitted_decision_binding_attention_rows
                  WHERE project_id = ? AND attention_fact_id = ?`,
                [fact.projectId, fact.attentionFactId],
              ),
            );
            if (markers[0]?.workspace_id !== fact.workspaceId) {
              return yield* Effect.fail<AttentionProjectionStoreError>({
                _tag: "PersistenceCorruption",
                repository: "AttentionProjectionStore",
                operation: "submitted-decision-binding-marker",
                reason:
                  "Submitted DecisionEpisode marker identity is bound to another Workspace",
              });
            }
          }),
        listSubmittedDecisionBindingFailures: (projectId) =>
          Effect.gen(function* () {
            yield* TransactionScope;
            yield* requireSubmittedDecisionBindingMarker();
            const rows = yield* run(
              sql.unsafe<SubmittedDecisionBindingAttentionDbRow>(
                `SELECT marker.project_id AS project_id,
                        marker.attention_fact_id AS dedup_key,
                        marker.workspace_id AS target_workspace_id,
                        fact.failure_code AS failure_code,
                        fact.first_detected_at AS occurred_at,
                        fact.event_id AS source_event_id,
                        fact.attention_fact_id AS source_fact_id,
                        fact.execution_id AS source_execution_id
                   FROM submitted_decision_binding_attention_rows AS marker
                   JOIN submitted_decision_binding_attention_facts AS fact
                     ON fact.attention_fact_id = marker.attention_fact_id
                    AND fact.project_id = marker.project_id
                    AND fact.workspace_id = marker.workspace_id
                  WHERE marker.project_id = ?
                  ORDER BY fact.first_detected_at, fact.attention_fact_id`,
                [projectId],
              ),
            );
            return rows.map(submittedDecisionBindingRowFromDb);
          }),
        putLegacyAdoptionFailure: (fact: LegacyAdoptionAttentionFact) =>
          Effect.gen(function* () {
            yield* TransactionScope;
            yield* requireLegacyAdoptionMarker();
            const sources = yield* run(
              sql.unsafe<{
                readonly attention_fact_id: string;
                readonly event_id: string;
                readonly project_id: string;
                readonly execution_id: string;
                readonly workspace_id: string;
                readonly provider_turn_id: string;
                readonly logical_step_no: number;
                readonly repair_attempt: number;
                readonly failure_code: string;
                readonly evidence_sha256: string;
                readonly first_detected_at: string;
              }>(
                `SELECT attention_fact_id, event_id, project_id, execution_id,
                        workspace_id, provider_turn_id, logical_step_no,
                        repair_attempt, failure_code, evidence_sha256,
                        first_detected_at
                   FROM legacy_adoption_attention_facts
                  WHERE attention_fact_id = ?`,
                [fact.attentionFactId],
              ),
            );
            const source = sources[0];
            if (
              source === undefined ||
              source.event_id !== fact.eventId ||
              source.project_id !== fact.projectId ||
              source.execution_id !== fact.executionId ||
              source.workspace_id !== fact.workspaceId ||
              source.provider_turn_id !== fact.providerTurnId ||
              Number(source.logical_step_no) !== fact.logicalStepNo ||
              Number(source.repair_attempt) !== fact.repairAttempt ||
              source.failure_code !== fact.failureCode ||
              source.evidence_sha256 !== fact.evidenceSha256 ||
              source.first_detected_at !== fact.firstDetectedAt
            ) {
              return yield* Effect.fail<AttentionProjectionStoreError>({
                _tag: "PersistenceCorruption",
                repository: "AttentionProjectionStore",
                operation: "legacy-adoption-attention-marker",
                reason:
                  "AH14 marker input does not match its immutable P9 failure fact",
              });
            }
            const executions = yield* run(
              sql.unsafe<{ readonly workspace_id: string }>(
                `SELECT workspace_id FROM executions
                  WHERE execution_id = ? AND project_id = ?`,
                [fact.executionId, fact.projectId],
              ),
            );
            if (executions[0]?.workspace_id !== fact.workspaceId) {
              return yield* Effect.fail<AttentionProjectionStoreError>({
                _tag: "PersistenceCorruption",
                repository: "AttentionProjectionStore",
                operation: "legacy-adoption-attention-marker",
                reason:
                  "AH14 fact Workspace does not match its authoritative Execution",
              });
            }
            const resolutions = yield* run(
              sql.unsafe<{ readonly attention_fact_id: string }>(
                `SELECT attention_fact_id
                   FROM legacy_adoption_attention_resolution_facts
                  WHERE attention_fact_id = ?`,
                [fact.attentionFactId],
              ),
            );
            // A retained failure event replay after a resolution must not
            // resurrect the marker.
            if (resolutions.length > 0) return;
            yield* run(
              sql.unsafe(
                `INSERT INTO legacy_adoption_attention_rows (
                   project_id, attention_fact_id, workspace_id
                 ) VALUES (?, ?, ?)
                 ON CONFLICT(project_id, attention_fact_id) DO NOTHING`,
                [fact.projectId, fact.attentionFactId, fact.workspaceId],
              ),
            );
            const markers = yield* run(
              sql.unsafe<{ readonly workspace_id: string }>(
                `SELECT workspace_id FROM legacy_adoption_attention_rows
                  WHERE project_id = ? AND attention_fact_id = ?`,
                [fact.projectId, fact.attentionFactId],
              ),
            );
            if (markers[0]?.workspace_id !== fact.workspaceId) {
              return yield* Effect.fail<AttentionProjectionStoreError>({
                _tag: "PersistenceCorruption",
                repository: "AttentionProjectionStore",
                operation: "legacy-adoption-attention-marker",
                reason: "AH14 marker identity is bound to another Workspace",
              });
            }
          }),
        removeLegacyAdoptionFailure: (
          failureFact: LegacyAdoptionAttentionFact,
          resolution: LegacyAdoptionAttentionResolutionFact,
        ) =>
          Effect.gen(function* () {
            yield* TransactionScope;
            yield* requireLegacyAdoptionMarker();
            const sourceFacts = yield* run(
              sql.unsafe<{
                readonly event_id: string;
                readonly project_id: string;
                readonly execution_id: string;
                readonly workspace_id: string;
                readonly provider_turn_id: string;
                readonly evidence_sha256: string;
                readonly first_detected_at: string;
              }>(
                `SELECT event_id, project_id, execution_id, workspace_id,
                        provider_turn_id, evidence_sha256, first_detected_at
                   FROM legacy_adoption_attention_facts
                  WHERE attention_fact_id = ?`,
                [failureFact.attentionFactId],
              ),
            );
            const source = sourceFacts[0];
            const resolutionFacts = yield* run(
              sql.unsafe<{
                readonly resolution_fact_id: string;
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
              }>(
                `SELECT resolution_fact_id, event_id, project_id, execution_id,
                        workspace_id, provider_turn_id, original_evidence_sha256,
                        resolution_evidence_sha256, action_disposition_summary_json,
                        action_disposition_summary_sha256, resolution_code, resolved_at
                   FROM legacy_adoption_attention_resolution_facts
                  WHERE attention_fact_id = ?`,
                [resolution.attentionFactId],
              ),
            );
            const resolved = resolutionFacts[0];
            const summary = (() => {
              try {
                return JSON.parse(
                  resolution.actionDispositionSummaryJson,
                ) as unknown;
              } catch {
                return undefined;
              }
            })();
            let summaryCanonical: string | undefined;
            try {
              if (summary !== undefined) {
                summaryCanonical = canonicalizeLegacyActionDispositionSummaryV1(
                  summary as ReadonlyArray<{
                    readonly actionOrdinal: number;
                    readonly logicalActionId: string;
                    readonly callRef: string;
                    readonly toolName: string;
                    readonly toolSchemaVersion: string;
                    readonly inputHash: string;
                    readonly disposition: "Applied" | "NotAdmitted";
                  }>,
                );
              }
            } catch {
              summaryCanonical = undefined;
            }
            const summaryRows = Array.isArray(summary)
              ? (summary as Array<Record<string, unknown>>)
              : [];
            const derivedCode = deriveLegacyAdoptionResolutionCodeV1(
              summaryRows.map((row) => String(row.disposition ?? "")),
            );
            const expectedResolutionId = legacyAdoptionResolutionFactIdV1({
              attentionFactId: resolution.attentionFactId,
              originalEvidenceSha256: resolution.originalEvidenceSha256,
              resolutionEvidenceSha256: resolution.resolutionEvidenceSha256,
              resolutionCode: resolution.resolutionCode,
            });
            if (
              source === undefined ||
              source.event_id !== failureFact.eventId ||
              source.project_id !== failureFact.projectId ||
              source.execution_id !== failureFact.executionId ||
              source.workspace_id !== failureFact.workspaceId ||
              source.provider_turn_id !== failureFact.providerTurnId ||
              source.evidence_sha256 !== failureFact.evidenceSha256 ||
              source.first_detected_at !== failureFact.firstDetectedAt ||
              resolved === undefined ||
              resolved.resolution_fact_id !== resolution.resolutionFactId ||
              resolved.event_id !== resolution.eventId ||
              resolved.project_id !== resolution.projectId ||
              resolved.execution_id !== resolution.executionId ||
              resolved.workspace_id !== resolution.workspaceId ||
              resolved.provider_turn_id !== resolution.providerTurnId ||
              resolved.original_evidence_sha256 !==
                resolution.originalEvidenceSha256 ||
              resolved.resolution_evidence_sha256 !==
                resolution.resolutionEvidenceSha256 ||
              resolved.action_disposition_summary_json !==
                resolution.actionDispositionSummaryJson ||
              resolved.action_disposition_summary_sha256 !==
                resolution.actionDispositionSummarySha256 ||
              resolved.resolution_code !== resolution.resolutionCode ||
              resolved.resolved_at !== resolution.resolvedAt ||
              resolution.attentionFactId !== failureFact.attentionFactId ||
              resolution.projectId !== failureFact.projectId ||
              resolution.executionId !== failureFact.executionId ||
              resolution.workspaceId !== failureFact.workspaceId ||
              resolution.providerTurnId !== failureFact.providerTurnId ||
              resolution.originalEvidenceSha256 !==
                failureFact.evidenceSha256 ||
              resolution.resolutionFactId !== expectedResolutionId ||
              summaryCanonical !== resolution.actionDispositionSummaryJson ||
              sha256Hex(resolution.actionDispositionSummaryJson) !==
                resolution.actionDispositionSummarySha256 ||
              derivedCode !== resolution.resolutionCode
            ) {
              return yield* Effect.fail<AttentionProjectionStoreError>({
                _tag: "PersistenceCorruption",
                repository: "AttentionProjectionStore",
                operation: "legacy-adoption-attention-resolution",
                reason:
                  "AH14 resolution marker removal does not match the immutable P9 facts",
              });
            }
            yield* run(
              sql.unsafe(
                `DELETE FROM legacy_adoption_attention_rows
                  WHERE project_id = ? AND attention_fact_id = ? AND workspace_id = ?`,
                [
                  failureFact.projectId,
                  failureFact.attentionFactId,
                  failureFact.workspaceId,
                ],
              ),
            );
          }),
        listLegacyAdoptionFailures: (projectId) =>
          Effect.gen(function* () {
            yield* TransactionScope;
            yield* requireLegacyAdoptionMarker();
            const rows = yield* run(
              sql.unsafe<LegacyAdoptionAttentionDbRow>(
                `SELECT marker.project_id, marker.attention_fact_id,
                        marker.workspace_id, fact.failure_code,
                        fact.first_detected_at, fact.event_id AS source_event_id,
                        fact.attention_fact_id AS source_fact_id,
                        fact.execution_id AS source_execution_id
                   FROM legacy_adoption_attention_rows AS marker
                   JOIN legacy_adoption_attention_facts AS fact
                     ON fact.attention_fact_id = marker.attention_fact_id
                    AND fact.project_id = marker.project_id
                    AND fact.workspace_id = marker.workspace_id
                  WHERE marker.project_id = ?
                  ORDER BY fact.first_detected_at, fact.attention_fact_id`,
                [projectId],
              ),
            );
            return rows.map(legacyAdoptionRowFromDb);
          }),
        listDeliverReplayFailures: (projectId) =>
          Effect.gen(function* () {
            yield* TransactionScope;
            const rows = yield* run(
              sql.unsafe<DeliverReplayAttentionDbRow>(
                `SELECT fact.project_id AS project_id,
                        fact.attention_fact_id AS dedup_key,
                        fact.target_workspace_id AS target_workspace_id,
                        fact.failure_code AS failure_code,
                        fact.first_detected_at AS occurred_at,
                        fact.event_id AS source_event_id,
                        fact.attention_fact_id AS source_fact_id,
                        fact.execution_id AS source_execution_id
                   FROM deliver_replay_attention_rows AS projected
                   JOIN deliver_replay_attention_facts AS fact
                     ON fact.attention_fact_id = projected.attention_fact_id
                  WHERE fact.project_id = ?
                  ORDER BY fact.first_detected_at, fact.attention_fact_id`,
                [projectId],
              ),
            );
            return rows.map(deliverReplayRowFromDb);
          }),
        listAssignWorkBindingFailures: (projectId) =>
          Effect.map(
            run(
              sql.unsafe<AttentionProjectionDbRow>(
                `SELECT projected.project_id, projected.dedup_key,
                      projected.source, projected.severity,
                      projected.target_workspace_id, projected.summary,
                      projected.failure_code, projected.occurred_at,
                      projected.source_event_id, projected.source_fact_id,
                      fact.execution_id AS source_execution_id
                 FROM attention_projection_rows AS projected
                 JOIN assign_work_binding_attention_facts AS fact
                   ON fact.attention_fact_id = projected.source_fact_id
                WHERE projected.project_id = ? ORDER BY occurred_at, dedup_key`,
                [projectId],
              ),
            ),
            (rows) => rows.map(fromDb),
          ),
        putToolObservationReplayFailure: (fact, occurredAt) =>
          Effect.gen(function* () {
            yield* TransactionScope;
            const owners = yield* run(
              sql.unsafe<{ workspace_id: string }>(
                "SELECT workspace_id FROM executions WHERE execution_id = ? AND project_id = ?",
                [fact.executionId, fact.projectId],
              ),
            );
            const targetWorkspaceId = owners[0]?.workspace_id;
            if (
              targetWorkspaceId === undefined ||
              targetWorkspaceId !== fact.targetWorkspaceId
            ) {
              return yield* Effect.fail<AttentionProjectionStoreError>({
                _tag: "PersistenceCorruption",
                repository: "AttentionProjectionStore",
                operation: "tool-observation-target",
                reason:
                  "P9 tool observation replay fact target does not match the owning Execution workspace",
              });
            }
            const row: ToolObservationReplayAttentionProjectionRow = {
              projectId: fact.projectId,
              dedupKey: fact.attentionFactId,
              source: "ToolObservationReplayEvidenceFailure",
              severity: "ActionRequired",
              targetWorkspaceId: targetWorkspaceId as never,
              summary:
                "A terminal tool outcome could not be replayed from durable observation evidence; recovery is paused.",
              failureCode: fact.failureCode,
              occurredAt,
              sourceEventId: fact.eventId,
              sourceFactId: fact.attentionFactId,
            };
            yield* run(
              sql.unsafe(
                `INSERT INTO tool_observation_replay_attention_rows (
                  project_id, dedup_key, source, severity, target_workspace_id,
                  summary, failure_code, occurred_at, source_event_id, source_fact_id
                ) VALUES (?,?,?,?,?,?,?,?,?,?)
                ON CONFLICT(project_id, dedup_key) DO NOTHING`,
                [
                  row.projectId,
                  row.dedupKey,
                  row.source,
                  row.severity,
                  row.targetWorkspaceId,
                  row.summary,
                  row.failureCode,
                  row.occurredAt,
                  row.sourceEventId,
                  row.sourceFactId,
                ],
              ),
            );
            const rows = yield* run(
              sql.unsafe<ToolObservationReplayAttentionDbRow>(
                `SELECT project_id, dedup_key, source, severity,
                        target_workspace_id, summary, failure_code, occurred_at,
                        source_event_id, source_fact_id
                   FROM tool_observation_replay_attention_rows
                  WHERE project_id = ? AND dedup_key = ?`,
                [row.projectId, row.dedupKey],
              ),
            );
            const stored = rows[0];
            if (
              stored === undefined ||
              JSON.stringify(toolObservationRowFromDb(stored)) !==
                JSON.stringify(row)
            ) {
              return yield* Effect.fail<AttentionProjectionStoreError>({
                _tag: "PersistenceCorruption",
                repository: "AttentionProjectionStore",
                operation: "tool-observation-rows",
                reason:
                  "P10 replay-evidence dedup identity is already bound to another source row",
              });
            }
          }),
        listToolObservationReplayFailures: (projectId) =>
          Effect.gen(function* () {
            const exists = yield* run(
              sql.unsafe<{ readonly n: number }>(
                "SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'tool_observation_replay_attention_rows'",
              ),
            );
            if (Number(exists[0]?.n ?? 0) !== 1) return [];
            const rows = yield* run(
              sql.unsafe<ToolObservationReplayAttentionDbRow>(
                `SELECT project_id, dedup_key, source, severity,
                        target_workspace_id, summary, failure_code, occurred_at,
                        source_event_id, source_fact_id
                   FROM tool_observation_replay_attention_rows
                  WHERE project_id = ? ORDER BY occurred_at, dedup_key`,
                [projectId],
              ),
            );
            return rows.map(toolObservationRowFromDb);
          }),
        reconcileWorkspaceResourceActivation: (projectId, intents) =>
          Effect.gen(function* () {
            yield* TransactionScope;
            const current = new Map<
              string,
              WorkspaceResourceActivationIntent
            >();
            for (const intent of intents) {
              if (intent.projectId !== projectId) continue;
              const key = `${intent.workspaceId}:${intent.resourceBoundaryRevision}`;
              if (current.has(key)) {
                return yield* Effect.fail<AttentionProjectionStoreError>({
                  _tag: "PersistenceCorruption",
                  repository: "AttentionProjectionStore",
                  operation: "activation-reconcile",
                  reason:
                    "P1 activation intent snapshot has duplicate identities",
                });
              }
              current.set(key, intent);
            }
            const existing = yield* run(
              sql.unsafe<WorkspaceResourceActivationAttentionDbRow>(
                `SELECT project_id, workspace_id, resource_boundary_revision,
                        occurred_at
                   FROM workspace_resource_activation_attention_rows
                  WHERE project_id = ?`,
                [projectId],
              ),
            );
            const pendingKeys = new Set(
              [...current.entries()]
                .filter(([, intent]) => intent.status === "Pending")
                .map(([key]) => key),
            );
            for (const row of existing) {
              const key = `${row.workspace_id}:${Number(row.resource_boundary_revision)}`;
              if (pendingKeys.has(key)) continue;
              yield* run(
                sql.unsafe(
                  `DELETE FROM workspace_resource_activation_attention_rows
                    WHERE project_id = ? AND workspace_id = ?
                      AND resource_boundary_revision = ?`,
                  [projectId, row.workspace_id, row.resource_boundary_revision],
                ),
              );
            }
            for (const intent of current.values()) {
              if (intent.status !== "Pending") continue;
              yield* run(
                sql.unsafe(
                  `INSERT INTO workspace_resource_activation_attention_rows (
                    project_id, workspace_id, resource_boundary_revision,
                    occurred_at
                  ) VALUES (?,?,?,?)
                  ON CONFLICT(project_id, workspace_id, resource_boundary_revision)
                  DO UPDATE SET occurred_at = excluded.occurred_at`,
                  [
                    projectId,
                    intent.workspaceId,
                    intent.resourceBoundaryRevision,
                    intent.createdAt,
                  ],
                ),
              );
              if (qualificationProbe !== undefined) {
                yield* Effect.promise(() =>
                  qualificationProbe({
                    boundary:
                      "P10AfterActivationAttentionRowWriteBeforeProjectionCommit",
                    projectId,
                    workspaceId: intent.workspaceId,
                    resourceBoundaryRevision: intent.resourceBoundaryRevision,
                  }),
                );
              }
            }
          }),
        reconcileStaleWorkRevisionRows: (projectId) =>
          Effect.gen(function* () {
            yield* TransactionScope;
            const staleExecution = `
              SELECT e.execution_id
                FROM executions AS e
                JOIN agent_execution_state AS state
                  ON state.execution_id = e.execution_id
                JOIN works AS work
                  ON work.work_id = CASE
                       WHEN json_valid(state.episode_json)
                       THEN json_extract(state.episode_json, '$.workId')
                       ELSE NULL
                     END
                 AND work.project_id = e.project_id
                 AND work.workspace_id = e.workspace_id
               WHERE e.project_id = ?
                 AND json_valid(state.episode_json)
                 AND CASE WHEN json_valid(state.episode_json)
                          THEN json_extract(state.episode_json, '$._tag')
                          ELSE NULL END = 'WorkEpisode'
                 AND CASE WHEN json_valid(state.episode_json)
                          THEN json_type(state.episode_json, '$.targetWorkRevision')
                          ELSE NULL END = 'integer'
                 AND CAST(CASE WHEN json_valid(state.episode_json)
                               THEN json_extract(state.episode_json, '$.targetWorkRevision')
                               ELSE NULL END AS INTEGER) < work.revision`;
            yield* run(
              sql.unsafe(
                `DELETE FROM attention_projection_rows
                  WHERE project_id = ?
                    AND source = 'AssignWorkTargetBindingFailure'
                    AND source_fact_id IN (
                      SELECT fact.attention_fact_id
                        FROM assign_work_binding_attention_facts AS fact
                        JOIN executions AS e
                          ON e.execution_id = fact.execution_id
                         AND e.project_id = fact.project_id
                         AND e.workspace_id = fact.target_workspace_id
                       WHERE fact.project_id = ?
                         AND fact.execution_id IN (${staleExecution})
                    )`,
                [projectId, projectId, projectId],
              ),
            );
            const deliverTable = yield* run(
              sql.unsafe<{ readonly name: string }>(
                `SELECT name FROM sqlite_master
                  WHERE type = 'table'
                    AND name = 'deliver_replay_attention_rows'`,
              ),
            );
            if (deliverTable.length > 0) {
              yield* run(
                sql.unsafe(
                  `DELETE FROM deliver_replay_attention_rows
                    WHERE attention_fact_id IN (
                      SELECT fact.attention_fact_id
                        FROM deliver_replay_attention_facts AS fact
                        JOIN executions AS e
                          ON e.execution_id = fact.execution_id
                         AND e.project_id = fact.project_id
                         AND e.workspace_id = fact.target_workspace_id
                       WHERE fact.project_id = ?
                         AND fact.execution_id IN (${staleExecution})
                    )`,
                  [projectId, projectId],
                ),
              );
            }
          }),
        listWorkspaceResourceActivationPending: (projectId) =>
          Effect.map(
            run(
              sql.unsafe<WorkspaceResourceActivationAttentionDbRow>(
                `SELECT project_id, workspace_id, resource_boundary_revision,
                        occurred_at
                   FROM workspace_resource_activation_attention_rows
                  WHERE project_id = ?
                  ORDER BY occurred_at, workspace_id, resource_boundary_revision`,
                [projectId],
              ),
            ),
            (rows) => rows.map(activationRowFromDb),
          ),
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
            const rows = yield* run(
              sql.unsafe<SandboxProviderUnavailableAttentionDbRow>(
                `SELECT f.project_id, f.attention_fact_id, f.workspace_id,
                        f.execution_id, f.policy_revision, f.first_detected_at,
                        f.provider_version, f.probe_evidence_ref, f.failure_code,
                        d.policy_digest, d.profile_id, d.provider_id,
                        d.episode_binding_json, s.episode_json AS active_episode_json,
                        d.decision_command_id, c.resolution AS command_resolution,
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
                row.command_schema_version === "1" &&
                row.command_project_id === row.project_id &&
                row.command_result_json !== null
                  ? decodeCanonicalSandboxPolicyDecisionCommittedInternalV1(
                      row.command_result_json,
                      sha256Hex,
                    )
                  : undefined;
              if (
                committed === undefined ||
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
                committed.effectivePolicySnapshot.providerId !==
                  row.provider_id ||
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
                  String(
                    committed.effectivePolicySnapshot.capabilityRevision,
                  ) ||
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
        resetProject: (projectId) =>
          Effect.gen(function* () {
            const submittedMarkers =
              yield* submittedDecisionBindingMarkerAvailable();
            if (submittedMarkers.length > 0) {
              yield* run(
                sql.unsafe(
                  `DELETE FROM submitted_decision_binding_attention_rows
                    WHERE project_id = ?`,
                  [projectId],
                ),
              );
            }
            const legacyMarkers = yield* run(
              sql.unsafe<{ readonly name: string }>(
                `SELECT name FROM sqlite_master
                  WHERE type='table' AND name='legacy_adoption_attention_rows'`,
              ),
            );
            if (legacyMarkers.length > 0) {
              yield* run(
                sql.unsafe(
                  `DELETE FROM legacy_adoption_attention_rows
                    WHERE project_id = ?`,
                  [projectId],
                ),
              );
            }
            yield* run(
              sql.unsafe(
                `DELETE FROM deliver_replay_attention_rows
                  WHERE attention_fact_id IN (
                    SELECT attention_fact_id FROM deliver_replay_attention_facts
                     WHERE project_id = ?
                  )`,
                [projectId],
              ),
            );
            yield* run(
              sql.unsafe(
                "DELETE FROM attention_projection_rows WHERE project_id = ?",
                [projectId],
              ),
            );
            const table = yield* run(
              sql.unsafe<{ name: string }>(
                `SELECT name FROM sqlite_master
                  WHERE type = 'table'
                    AND name = 'workspace_resource_activation_attention_rows'`,
              ),
            );
            if (table.length > 0) {
              yield* run(
                sql.unsafe(
                  "DELETE FROM workspace_resource_activation_attention_rows WHERE project_id = ?",
                  [projectId],
                ),
              );
            }
            const replayTable = yield* run(
              sql.unsafe<{ name: string }>(
                `SELECT name FROM sqlite_master
                  WHERE type = 'table'
                    AND name = 'tool_observation_replay_attention_rows'`,
              ),
            );
            if (replayTable.length > 0) {
              yield* run(
                sql.unsafe(
                  "DELETE FROM tool_observation_replay_attention_rows WHERE project_id = ?",
                  [projectId],
                ),
              );
            }
            const sandboxMarkers = yield* run(
              sql.unsafe<{ readonly name: string }>(
                `SELECT name FROM sqlite_master WHERE type='table'
                  AND name='sandbox_provider_unavailable_attention_rows'`,
              ),
            );
            if (sandboxMarkers.length > 0) {
              yield* run(
                sql.unsafe(
                  `DELETE FROM sandbox_provider_unavailable_attention_rows
                    WHERE project_id = ?`,
                  [projectId],
                ),
              );
            }
          }),
      });
    }),
  );

export const AttentionProjectionStoreLive = makeAttentionProjectionStoreLive();

const payloadRecord = (payload: unknown): Record<string, unknown> =>
  typeof payload === "object" && payload !== null
    ? (payload as Record<string, unknown>)
    : {};

const projectionFailure = (cause: unknown): ConsumerOffsetStoreError => {
  if (
    typeof cause === "object" &&
    cause !== null &&
    (cause as { readonly _tag?: unknown })._tag === "PersistenceUnavailable"
  ) {
    const unavailable = cause as {
      readonly operation: string;
      readonly retryDisposition: "retryable" | "non-retryable";
      readonly sourceTag: string;
      readonly cause: unknown;
    };
    return {
      _tag: "PersistenceUnavailable",
      repository: "ConsumerOffsetStore",
      operation: unavailable.operation,
      retryDisposition: unavailable.retryDisposition,
      sourceTag: unavailable.sourceTag,
      cause: unavailable.cause,
    };
  }
  return {
    _tag: "PersistenceCorruption",
    repository: "ConsumerOffsetStore",
    operation: "p10-attention-apply",
    reason: "P10 Attention source fact or projection row failed validation",
  };
};

/** Bind the shared P1 ProjectionStore face to one P10 project. `pollOnce`
 * will call `apply` and advance that consumer's offset in its existing single
 * transaction. Reset affects only this project's P10 rows; the P1 generic
 * marker store is not delegated to or cleared. */
export const makeProjectAttentionProjectionStore = (
  projectId: ProjectId,
  sourceFacts: Pick<
    RecoveryAttentionFactStoreService,
    | "findAssignWorkBindingFailure"
    | "findDeliverReplayFailure"
    | "listDeliverReplayFailures"
    | "listPendingDeliverReplayAttention"
    | "acknowledgePendingDeliverReplayAttention"
    | "isSubmittedDecisionBindingAvailable"
    | "findSubmittedDecisionBindingFailure"
    | "listSubmittedDecisionBindingFailures"
    | "findLegacyAdoptionFailure"
    | "findLegacyAdoptionFailureByEventId"
    | "listLegacyAdoptionFailures"
    | "findLegacyAdoptionResolution"
    | "listLegacyAdoptionResolutions"
  >,
  attentionRows: Pick<
    AttentionProjectionStoreService,
    | "putAssignWorkBindingFailure"
    | "putDeliverReplayFailure"
    | "putToolObservationReplayFailure"
    | "isSubmittedDecisionBindingAvailable"
    | "putSubmittedDecisionBindingFailure"
    | "putLegacyAdoptionFailure"
    | "removeLegacyAdoptionFailure"
    | "listLegacyAdoptionFailures"
    | "resetProject"
    | "reconcileWorkspaceResourceActivation"
    | "reconcileStaleWorkRevisionRows"
  >,
  activationIntents?: Pick<WorkspaceResourceActivationStoreService, "listAll">,
  toolObservationFacts?: Pick<
    ToolObservationReplayAttentionFactStoreService,
    "findById"
  >,
  sandboxUnavailableFacts?: Pick<
    SandboxProviderUnavailableStoreService,
    "list"
  >,
  sandboxUnavailableQueue?: Pick<
    SandboxProviderUnavailableAttentionQueueService,
    "rearm"
  >,
): ProjectionStoreService => ({
  apply: (batch: ReadonlyArray<DomainEvent<unknown>>) =>
    Effect.gen(function* () {
      for (const event of batch) {
        if (event.eventType === "WorkSteered") {
          if (event.projectId !== projectId) {
            return yield* Effect.fail<ConsumerOffsetStoreError>({
              _tag: "PersistenceCorruption",
              repository: "ConsumerOffsetStore",
              operation: "p10-attention-apply",
              reason:
                "P10 Attention consumer received a WorkSteered event for another project",
            });
          }
          yield* attentionRows
            .reconcileStaleWorkRevisionRows(projectId)
            .pipe(Effect.mapError(projectionFailure));
          continue;
        }
        if (event.eventType === "WorkspaceResourceActivationChanged") {
          if (event.projectId !== projectId) {
            return yield* Effect.fail<ConsumerOffsetStoreError>({
              _tag: "PersistenceCorruption",
              repository: "ConsumerOffsetStore",
              operation: "p10-attention-apply",
              reason:
                "P10 Attention consumer received an activation event for another project",
            });
          }
          if (activationIntents === undefined) {
            return yield* Effect.fail<ConsumerOffsetStoreError>({
              _tag: "PersistenceCorruption",
              repository: "ConsumerOffsetStore",
              operation: "p10-attention-apply",
              reason: "P10 Activation Attention event has no P1 intent source",
            });
          }
          const eventPayload = payloadRecord(event.payload);
          const revision = eventPayload.resourceBoundaryRevision;
          if (
            eventPayload._tag !== "WorkspaceResourceActivationChanged" ||
            typeof eventPayload.workspaceId !== "string" ||
            event.aggregateRef !== eventPayload.workspaceId ||
            typeof revision !== "number" ||
            !Number.isInteger(revision) ||
            revision < 0 ||
            (eventPayload.status !== "Pending" &&
              eventPayload.status !== "Active")
          ) {
            return yield* Effect.fail<ConsumerOffsetStoreError>({
              _tag: "PersistenceCorruption",
              repository: "ConsumerOffsetStore",
              operation: "p10-attention-apply",
              reason: "P10 Activation Attention wakeup event was malformed",
            });
          }
          const intents = yield* activationIntents
            .listAll()
            .pipe(Effect.mapError(projectionFailure));
          yield* attentionRows
            .reconcileWorkspaceResourceActivation(projectId, intents)
            .pipe(Effect.mapError(projectionFailure));
          continue;
        }
        if (event.eventType === "DeliverReplayEscalated") {
          if (event.projectId !== projectId) {
            return yield* Effect.fail<ConsumerOffsetStoreError>({
              _tag: "PersistenceCorruption",
              repository: "ConsumerOffsetStore",
              operation: "p10-attention-apply",
              reason:
                "P10 Attention consumer received a Deliver event for another project",
            });
          }
          const payload = payloadRecord(event.payload);
          const payloadKeys = Object.keys(payload).sort();
          const expectedPayloadKeys = [
            "attentionFactId",
            "executionId",
            "failureCode",
            "logicalActionId",
            "messageId",
            "targetWorkspaceId",
          ];
          const attentionFactId = payload.attentionFactId;
          if (
            typeof attentionFactId !== "string" ||
            attentionFactId.length === 0
          ) {
            return yield* Effect.fail<ConsumerOffsetStoreError>({
              _tag: "PersistenceCorruption",
              repository: "ConsumerOffsetStore",
              operation: "p10-attention-apply",
              reason: "Deliver replay event is missing its attentionFactId",
            });
          }
          const found = yield* sourceFacts
            .findDeliverReplayFailure(attentionFactId)
            .pipe(Effect.mapError(projectionFailure));
          if (Option.isNone(found)) {
            return yield* Effect.fail<ConsumerOffsetStoreError>({
              _tag: "PersistenceCorruption",
              repository: "ConsumerOffsetStore",
              operation: "p10-attention-apply",
              reason: "Deliver replay event has no matching immutable P9 fact",
            });
          }
          const fact = found.value;
          if (
            fact.eventId !== event.eventId ||
            fact.projectId !== projectId ||
            event.eventType !== "DeliverReplayEscalated" ||
            event.eventVersion !== 1 ||
            event.actor !== "system:recovery" ||
            event.causedByEventId !== undefined ||
            event.aggregateRef !== fact.targetWorkspaceId ||
            event.correlationRef !== fact.logicalActionId ||
            event.occurredAt !== fact.firstDetectedAt ||
            fact.executionId !== String(payload.executionId ?? "") ||
            fact.targetWorkspaceId !==
              String(payload.targetWorkspaceId ?? "") ||
            fact.logicalActionId !== String(payload.logicalActionId ?? "") ||
            fact.messageId !== String(payload.messageId ?? "") ||
            fact.failureCode !== String(payload.failureCode ?? "") ||
            payloadKeys.length !== expectedPayloadKeys.length ||
            payloadKeys.some((key, index) => key !== expectedPayloadKeys[index])
          ) {
            return yield* Effect.fail<ConsumerOffsetStoreError>({
              _tag: "PersistenceCorruption",
              repository: "ConsumerOffsetStore",
              operation: "p10-attention-apply",
              reason:
                "Deliver replay event does not exactly match its immutable P9 fact",
            });
          }
          yield* attentionRows
            .putDeliverReplayFailure(fact)
            .pipe(Effect.mapError(projectionFailure));
          continue;
        }
        if (event.eventType === "ToolObservationReplayEvidenceEscalated") {
          if (event.projectId !== projectId) {
            return yield* Effect.fail<ConsumerOffsetStoreError>({
              _tag: "PersistenceCorruption",
              repository: "ConsumerOffsetStore",
              operation: "p10-attention-apply",
              reason:
                "P10 Attention consumer received a tool observation replay event for another project",
            });
          }
          if (
            toolObservationFacts === undefined ||
            attentionRows.putToolObservationReplayFailure === undefined
          ) {
            return yield* Effect.fail<ConsumerOffsetStoreError>({
              _tag: "PersistenceCorruption",
              repository: "ConsumerOffsetStore",
              operation: "p10-attention-apply",
              reason:
                "P10 tool observation replay event has no exact P9 fact or P10 marker store",
            });
          }
          const payload = payloadRecord(event.payload);
          const attentionFactId = String(payload.attentionFactId ?? "");
          const found = yield* toolObservationFacts
            .findById(attentionFactId)
            .pipe(Effect.mapError(projectionFailure));
          if (Option.isNone(found)) {
            return yield* Effect.fail<ConsumerOffsetStoreError>({
              _tag: "PersistenceCorruption",
              repository: "ConsumerOffsetStore",
              operation: "p10-attention-apply",
              reason:
                "tool observation replay event has no matching immutable P9 fact",
            });
          }
          const fact = found.value;
          if (
            fact.eventId !== event.eventId ||
            fact.projectId !== projectId ||
            event.aggregateRef !== fact.targetWorkspaceId ||
            event.correlationRef !== fact.logicalActionId ||
            event.causedByCommandId !== undefined ||
            event.occurredAt !== fact.firstDetectedAt ||
            fact.attentionFactId !== attentionFactId ||
            fact.executionId !== String(payload.executionId ?? "") ||
            fact.targetWorkspaceId !==
              String(payload.targetWorkspaceId ?? "") ||
            fact.logicalActionId !== String(payload.logicalActionId ?? "") ||
            fact.providerTurnId !== String(payload.providerTurnId ?? "") ||
            fact.callRef !== String(payload.callRef ?? "") ||
            fact.invocationId !== String(payload.invocationId ?? "") ||
            fact.failureCode !== String(payload.failureCode ?? "")
          ) {
            return yield* Effect.fail<ConsumerOffsetStoreError>({
              _tag: "PersistenceCorruption",
              repository: "ConsumerOffsetStore",
              operation: "p10-attention-apply",
              reason:
                "tool observation replay event does not exactly match its immutable P9 fact",
            });
          }
          yield* attentionRows
            .putToolObservationReplayFailure(fact, event.occurredAt)
            .pipe(Effect.mapError(projectionFailure));
          continue;
        }
        if (event.eventType === "SubmittedDecisionBindingEscalated") {
          if (event.projectId !== projectId) {
            return yield* Effect.fail<ConsumerOffsetStoreError>({
              _tag: "PersistenceCorruption",
              repository: "ConsumerOffsetStore",
              operation: "p10-attention-apply",
              reason:
                "P10 Attention consumer received a Submitted Decision event for another project",
            });
          }
          const payload = payloadRecord(event.payload);
          const payloadKeys = Object.keys(payload).sort();
          const expectedPayloadKeys = [
            "attentionFactId",
            "executionId",
            "failureCode",
            "logicalActionId",
            "logicalStepNo",
            "providerTurnId",
            "repairAttempt",
            "workspaceId",
          ].sort();
          const attentionFactId = payload.attentionFactId;
          const findSubmitted = sourceFacts.findSubmittedDecisionBindingFailure;
          const putSubmitted = attentionRows.putSubmittedDecisionBindingFailure;
          if (
            typeof attentionFactId !== "string" ||
            attentionFactId.length === 0 ||
            findSubmitted === undefined ||
            putSubmitted === undefined
          ) {
            return yield* Effect.fail<ConsumerOffsetStoreError>({
              _tag: "PersistenceCorruption",
              repository: "ConsumerOffsetStore",
              operation: "p10-attention-apply",
              reason:
                "Submitted Decision event has no available immutable P9 fact and P10 marker route",
            });
          }
          const source = yield* findSubmitted(attentionFactId).pipe(
            Effect.mapError(projectionFailure),
          );
          if (Option.isNone(source)) {
            return yield* Effect.fail<ConsumerOffsetStoreError>({
              _tag: "PersistenceCorruption",
              repository: "ConsumerOffsetStore",
              operation: "p10-attention-apply",
              reason:
                "Submitted Decision event has no matching immutable P9 fact",
            });
          }
          const fact = source.value;
          if (
            event.eventVersion !== 1 ||
            event.actor !== "system:recovery" ||
            event.aggregateRef !== fact.workspaceId ||
            event.correlationRef !== fact.logicalActionId ||
            event.causedByCommandId !== undefined ||
            event.causedByEventId !== undefined ||
            event.occurredAt !== fact.firstDetectedAt ||
            fact.eventId !== event.eventId ||
            fact.projectId !== projectId ||
            fact.attentionFactId !== attentionFactId ||
            fact.executionId !== payload.executionId ||
            fact.workspaceId !== payload.workspaceId ||
            fact.logicalStepNo !== payload.logicalStepNo ||
            fact.repairAttempt !== payload.repairAttempt ||
            fact.providerTurnId !== payload.providerTurnId ||
            fact.logicalActionId !== payload.logicalActionId ||
            fact.failureCode !== payload.failureCode ||
            payloadKeys.length !== expectedPayloadKeys.length ||
            payloadKeys.some((key, index) => key !== expectedPayloadKeys[index])
          ) {
            return yield* Effect.fail<ConsumerOffsetStoreError>({
              _tag: "PersistenceCorruption",
              repository: "ConsumerOffsetStore",
              operation: "p10-attention-apply",
              reason:
                "Submitted Decision event does not exactly match its immutable P9 fact",
            });
          }
          yield* putSubmitted(fact).pipe(Effect.mapError(projectionFailure));
          continue;
        }
        if (event.eventType === "LegacyAdoptionEvidenceEscalated") {
          const payload = payloadRecord(event.payload);
          const payloadKeys = Object.keys(payload).sort();
          const expectedPayloadKeys = [
            "factId",
            "attentionFactId",
            "projectId",
            "executionId",
            "targetWorkspaceId",
            "providerTurnId",
            "logicalStepNo",
            "repairAttempt",
            "failureCode",
            "evidenceSha256",
            "firstDetectedAt",
          ].sort();
          const attentionFactId = payload.attentionFactId;
          const findLegacy = sourceFacts.findLegacyAdoptionFailure;
          const putLegacy = attentionRows.putLegacyAdoptionFailure;
          if (
            event.projectId !== projectId ||
            typeof attentionFactId !== "string" ||
            attentionFactId.length === 0 ||
            findLegacy === undefined ||
            putLegacy === undefined
          ) {
            return yield* Effect.fail<ConsumerOffsetStoreError>({
              _tag: "PersistenceCorruption",
              repository: "ConsumerOffsetStore",
              operation: "p10-attention-apply",
              reason:
                "AH14 failure event has no exact immutable P9 fact and P10 marker route",
            });
          }
          const source = yield* findLegacy(attentionFactId).pipe(
            Effect.mapError(projectionFailure),
          );
          if (Option.isNone(source)) {
            return yield* Effect.fail<ConsumerOffsetStoreError>({
              _tag: "PersistenceCorruption",
              repository: "ConsumerOffsetStore",
              operation: "p10-attention-apply",
              reason: "AH14 failure event has no matching immutable P9 fact",
            });
          }
          const fact = source.value;
          if (
            event.eventVersion !== 1 ||
            event.actor !== "system:recovery" ||
            event.aggregateRef !== fact.executionId ||
            event.correlationRef !== fact.attentionFactId ||
            event.causedByCommandId !== undefined ||
            event.causedByEventId !== undefined ||
            event.occurredAt !== fact.firstDetectedAt ||
            fact.eventId !== event.eventId ||
            fact.projectId !== projectId ||
            fact.executionId !== payload.executionId ||
            fact.workspaceId !== payload.targetWorkspaceId ||
            fact.providerTurnId !== payload.providerTurnId ||
            fact.logicalStepNo !== payload.logicalStepNo ||
            fact.repairAttempt !== payload.repairAttempt ||
            fact.failureCode !== payload.failureCode ||
            fact.evidenceSha256 !== payload.evidenceSha256 ||
            fact.firstDetectedAt !== payload.firstDetectedAt ||
            payload.factId !== fact.attentionFactId ||
            payload.attentionFactId !== fact.attentionFactId ||
            payload.projectId !== fact.projectId ||
            payload.executionId !== fact.executionId ||
            payload.targetWorkspaceId !== fact.workspaceId ||
            payloadKeys.length !== expectedPayloadKeys.length ||
            payloadKeys.some((key, index) => key !== expectedPayloadKeys[index])
          ) {
            return yield* Effect.fail<ConsumerOffsetStoreError>({
              _tag: "PersistenceCorruption",
              repository: "ConsumerOffsetStore",
              operation: "p10-attention-apply",
              reason:
                "AH14 failure event does not exactly match its immutable P9 fact",
            });
          }
          yield* putLegacy(fact).pipe(Effect.mapError(projectionFailure));
          continue;
        }
        if (event.eventType === "LegacyAdoptionEvidenceResolved") {
          const payload = payloadRecord(event.payload);
          const payloadKeys = Object.keys(payload).sort();
          const expectedPayloadKeys = [
            "factId",
            "attentionFactId",
            "projectId",
            "executionId",
            "targetWorkspaceId",
            "providerTurnId",
            "originalEvidenceSha256",
            "resolutionEvidenceSha256",
            "resolutionCode",
            "resolvedAt",
          ].sort();
          const attentionFactId = payload.attentionFactId;
          const findLegacy = sourceFacts.findLegacyAdoptionFailure;
          const findResolution = sourceFacts.findLegacyAdoptionResolution;
          const removeLegacy = attentionRows.removeLegacyAdoptionFailure;
          if (
            event.projectId !== projectId ||
            typeof attentionFactId !== "string" ||
            attentionFactId.length === 0 ||
            findLegacy === undefined ||
            findResolution === undefined ||
            removeLegacy === undefined
          ) {
            return yield* Effect.fail<ConsumerOffsetStoreError>({
              _tag: "PersistenceCorruption",
              repository: "ConsumerOffsetStore",
              operation: "p10-attention-apply",
              reason:
                "AH14 resolution event has no exact immutable P9 facts and P10 marker route",
            });
          }
          const source = yield* findLegacy(attentionFactId).pipe(
            Effect.mapError(projectionFailure),
          );
          const resolved = yield* findResolution(attentionFactId).pipe(
            Effect.mapError(projectionFailure),
          );
          if (Option.isNone(source) || Option.isNone(resolved)) {
            return yield* Effect.fail<ConsumerOffsetStoreError>({
              _tag: "PersistenceCorruption",
              repository: "ConsumerOffsetStore",
              operation: "p10-attention-apply",
              reason:
                "AH14 resolution event has no matching immutable P9 facts",
            });
          }
          const failureFact = source.value;
          const resolution = resolved.value;
          if (
            event.eventVersion !== 1 ||
            event.actor !== "system:recovery" ||
            event.aggregateRef !== failureFact.executionId ||
            event.correlationRef !== failureFact.attentionFactId ||
            event.causedByCommandId !== undefined ||
            event.causedByEventId !== failureFact.eventId ||
            event.occurredAt !== resolution.resolvedAt ||
            resolution.eventId !== event.eventId ||
            resolution.attentionFactId !== failureFact.attentionFactId ||
            resolution.projectId !== projectId ||
            resolution.executionId !== failureFact.executionId ||
            resolution.workspaceId !== failureFact.workspaceId ||
            resolution.providerTurnId !== failureFact.providerTurnId ||
            resolution.originalEvidenceSha256 !== failureFact.evidenceSha256 ||
            payload.factId !== resolution.resolutionFactId ||
            payload.attentionFactId !== failureFact.attentionFactId ||
            payload.projectId !== resolution.projectId ||
            payload.executionId !== resolution.executionId ||
            payload.targetWorkspaceId !== resolution.workspaceId ||
            payload.providerTurnId !== resolution.providerTurnId ||
            payload.originalEvidenceSha256 !==
              resolution.originalEvidenceSha256 ||
            payload.resolutionEvidenceSha256 !==
              resolution.resolutionEvidenceSha256 ||
            payload.resolutionCode !== resolution.resolutionCode ||
            payload.resolvedAt !== resolution.resolvedAt ||
            payloadKeys.length !== expectedPayloadKeys.length ||
            payloadKeys.some((key, index) => key !== expectedPayloadKeys[index])
          ) {
            return yield* Effect.fail<ConsumerOffsetStoreError>({
              _tag: "PersistenceCorruption",
              repository: "ConsumerOffsetStore",
              operation: "p10-attention-apply",
              reason:
                "AH14 resolution event does not exactly match its immutable P9 facts",
            });
          }
          yield* removeLegacy(failureFact, resolution).pipe(
            Effect.mapError(projectionFailure),
          );
          continue;
        }
        if (event.eventType !== "AssignWorkTargetBindingEscalated") continue;
        if (event.projectId !== projectId) {
          return yield* Effect.fail<ConsumerOffsetStoreError>({
            _tag: "PersistenceCorruption",
            repository: "ConsumerOffsetStore",
            operation: "p10-attention-apply",
            reason:
              "P10 Attention consumer received an event for another project",
          });
        }
        const payload = payloadRecord(event.payload);
        const attentionFactId = String(payload.attentionFactId ?? "");
        if (attentionFactId.length === 0) {
          return yield* Effect.fail<ConsumerOffsetStoreError>({
            _tag: "PersistenceCorruption",
            repository: "ConsumerOffsetStore",
            operation: "p10-attention-apply",
            reason: "AssignWork binding event is missing its attentionFactId",
          });
        }
        const found = yield* sourceFacts
          .findAssignWorkBindingFailure(attentionFactId)
          .pipe(Effect.mapError(projectionFailure));
        if (Option.isNone(found)) {
          return yield* Effect.fail<ConsumerOffsetStoreError>({
            _tag: "PersistenceCorruption",
            repository: "ConsumerOffsetStore",
            operation: "p10-attention-apply",
            reason:
              "AssignWork binding event has no matching immutable P9 fact",
          });
        }
        const fact: AssignWorkBindingAttentionFact = found.value;
        const payloadKeys = Object.keys(payload).sort();
        const expectedPayloadKeys = [
          "attentionFactId",
          "committedCommandId",
          "executionId",
          "failureCode",
          "logicalActionId",
          "targetWorkspaceId",
        ];
        if (
          fact.eventId !== event.eventId ||
          fact.projectId !== projectId ||
          event.eventVersion !== 1 ||
          event.actor !== "system:recovery" ||
          event.causedByEventId !== undefined ||
          event.aggregateRef !== fact.targetWorkspaceId ||
          event.correlationRef !== fact.logicalActionId ||
          event.causedByCommandId !== fact.committedCommandId ||
          event.occurredAt !== fact.firstDetectedAt ||
          fact.attentionFactId !== String(payload.attentionFactId ?? "") ||
          fact.executionId !== String(payload.executionId ?? "") ||
          fact.targetWorkspaceId !== String(payload.targetWorkspaceId ?? "") ||
          fact.logicalActionId !== String(payload.logicalActionId ?? "") ||
          fact.committedCommandId !==
            String(payload.committedCommandId ?? "") ||
          fact.failureCode !== String(payload.failureCode ?? "") ||
          payloadKeys.length !== expectedPayloadKeys.length ||
          payloadKeys.some((key, index) => key !== expectedPayloadKeys[index])
        ) {
          return yield* Effect.fail<ConsumerOffsetStoreError>({
            _tag: "PersistenceCorruption",
            repository: "ConsumerOffsetStore",
            operation: "p10-attention-apply",
            reason:
              "AssignWork binding event does not exactly match its immutable P9 fact",
          });
        }
        yield* attentionRows
          .putAssignWorkBindingFailure(fact, event.occurredAt)
          .pipe(Effect.mapError(projectionFailure));
      }
    }),
  reset: () =>
    Effect.gen(function* () {
      yield* attentionRows
        .resetProject(projectId)
        .pipe(Effect.mapError(projectionFailure));
      const legacyFailures = sourceFacts.listLegacyAdoptionFailures;
      const legacyResolutions = sourceFacts.listLegacyAdoptionResolutions;
      const putLegacy = attentionRows.putLegacyAdoptionFailure;
      if (
        legacyFailures !== undefined ||
        legacyResolutions !== undefined ||
        putLegacy !== undefined
      ) {
        if (
          legacyFailures === undefined ||
          legacyResolutions === undefined ||
          putLegacy === undefined
        ) {
          return yield* Effect.fail<ConsumerOffsetStoreError>({
            _tag: "PersistenceCorruption",
            repository: "ConsumerOffsetStore",
            operation: "p10-attention-rebuild",
            reason:
              "AH14 fact snapshots and marker writer are not all available",
          });
        }
        const [failureFacts, resolutionFacts] = yield* Effect.all([
          legacyFailures(projectId),
          legacyResolutions(projectId),
        ]).pipe(Effect.mapError(projectionFailure));
        const failureById = new Map(
          failureFacts.map((fact) => [fact.attentionFactId, fact]),
        );
        const removeLegacy = attentionRows.removeLegacyAdoptionFailure;
        if (removeLegacy === undefined) {
          return yield* Effect.fail<ConsumerOffsetStoreError>({
            _tag: "PersistenceCorruption",
            repository: "ConsumerOffsetStore",
            operation: "p10-attention-rebuild",
            reason:
              "AH14 resolution snapshot has no P10 marker validation route",
          });
        }
        for (const resolution of resolutionFacts) {
          const failureFact = failureById.get(resolution.attentionFactId);
          if (failureFact === undefined) {
            return yield* Effect.fail<ConsumerOffsetStoreError>({
              _tag: "PersistenceCorruption",
              repository: "ConsumerOffsetStore",
              operation: "p10-attention-rebuild",
              reason: "AH14 resolution fact has no original failure fact",
            });
          }
          yield* removeLegacy(failureFact, resolution).pipe(
            Effect.mapError(projectionFailure),
          );
        }
        const resolvedIds = new Set(
          resolutionFacts.map((fact) => fact.attentionFactId),
        );
        for (const fact of failureFacts) {
          if (resolvedIds.has(fact.attentionFactId)) continue;
          yield* putLegacy(fact).pipe(Effect.mapError(projectionFailure));
        }
      }
      const deliverFacts = yield* sourceFacts
        .listDeliverReplayFailures(projectId)
        .pipe(Effect.mapError(projectionFailure));
      for (const fact of deliverFacts) {
        yield* attentionRows
          .putDeliverReplayFailure(fact)
          .pipe(Effect.mapError(projectionFailure));
      }
      const submittedFactsAvailable =
        sourceFacts.isSubmittedDecisionBindingAvailable === undefined
          ? false
          : yield* sourceFacts
              .isSubmittedDecisionBindingAvailable()
              .pipe(Effect.mapError(projectionFailure));
      const submittedMarkersAvailable =
        attentionRows.isSubmittedDecisionBindingAvailable === undefined
          ? false
          : yield* attentionRows
              .isSubmittedDecisionBindingAvailable()
              .pipe(Effect.mapError(projectionFailure));
      if (submittedFactsAvailable !== submittedMarkersAvailable) {
        return yield* Effect.fail<ConsumerOffsetStoreError>({
          _tag: "PersistenceCorruption",
          repository: "ConsumerOffsetStore",
          operation: "p10-attention-rebuild",
          reason:
            "Submitted Decision fact and Attention marker availability do not converge",
        });
      }
      if (submittedFactsAvailable) {
        if (
          sourceFacts.listSubmittedDecisionBindingFailures === undefined ||
          attentionRows.putSubmittedDecisionBindingFailure === undefined
        ) {
          return yield* Effect.fail<ConsumerOffsetStoreError>({
            _tag: "PersistenceCorruption",
            repository: "ConsumerOffsetStore",
            operation: "p10-attention-rebuild",
            reason:
              "Submitted Decision fact snapshot has no P10 marker write route",
          });
        }
        const submittedFacts = yield* sourceFacts
          .listSubmittedDecisionBindingFailures(projectId)
          .pipe(Effect.mapError(projectionFailure));
        for (const fact of submittedFacts) {
          yield* attentionRows
            .putSubmittedDecisionBindingFailure(fact)
            .pipe(Effect.mapError(projectionFailure));
        }
      }
      if (
        sandboxUnavailableFacts !== undefined ||
        sandboxUnavailableQueue !== undefined
      ) {
        if (
          sandboxUnavailableFacts === undefined ||
          sandboxUnavailableQueue === undefined
        ) {
          return yield* Effect.fail<ConsumerOffsetStoreError>({
            _tag: "PersistenceCorruption",
            repository: "ConsumerOffsetStore",
            operation: "sandbox-provider-unavailable-rebuild",
            reason:
              "P50 fact snapshot and queue re-arm ports are not both available",
          });
        }
        const sandboxFacts = yield* sandboxUnavailableFacts
          .list(projectId)
          .pipe(Effect.mapError(projectionFailure));
        for (const fact of sandboxFacts) {
          yield* sandboxUnavailableQueue
            .rearm(fact)
            .pipe(Effect.mapError(projectionFailure));
        }
      }
      const pending = yield* sourceFacts
        .listPendingDeliverReplayAttention(projectId, Number.MAX_SAFE_INTEGER)
        .pipe(Effect.mapError(projectionFailure));
      for (const fact of pending) {
        yield* sourceFacts
          .acknowledgePendingDeliverReplayAttention(fact.attentionFactId)
          .pipe(Effect.mapError(projectionFailure));
      }
      yield* attentionRows
        .reconcileStaleWorkRevisionRows(projectId)
        .pipe(Effect.mapError(projectionFailure));
      if (activationIntents === undefined) return;
      const intents = yield* activationIntents
        .listAll()
        .pipe(Effect.mapError(projectionFailure));
      yield* attentionRows
        .reconcileWorkspaceResourceActivation(projectId, intents)
        .pipe(Effect.mapError(projectionFailure));
    }),
});
