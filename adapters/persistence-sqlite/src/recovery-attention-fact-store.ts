import { Actor, ProviderTurnId, parse } from "@arbor/domain";
import type {
  AgentLoopStepFence,
  AssignWorkBindingAttentionFact,
  AssignWorkBindingFailureCode,
  DeliverReplayAttentionFact,
  DeliverReplayFailureCode,
  LeaseFencingRejected,
  LegacyAdoptionAttentionFact,
  LegacyAdoptionAttentionResolutionFact,
  LegacyAdoptionEvidenceV1,
  RecordAssignWorkBindingFailureInput,
  RecordDeliverReplayFailureInput,
  RecordLegacyAdoptionAttentionFailureInput,
  RecordSubmittedDecisionBindingFailureInput,
  RecoveryAttentionFactStoreError,
  ResolveLegacyAdoptionAttentionInput,
  SubmittedDecisionBindingAttentionFact,
} from "@arbor/ports";
import {
  canonicalizeLegacyActionDispositionSummaryV1,
  canonicalizeLegacyAdoptionEvidenceV1,
  DomainEventJournal,
  deriveLegacyAdoptionResolutionCodeV1,
  IdGenerator,
  legacyAdoptionAttentionFactIdV1,
  legacyAdoptionEvidenceDigestV1,
  legacyAdoptionResolutionFactIdV1,
  P4_TOOL_OBSERVATION_FORMAT_V1,
  RecoveryAttentionFactStore,
  sha256Hex,
  TransactionScope,
  verifyRecoveryBindingV1,
} from "@arbor/ports";
import { Effect, Layer, Option } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";
import {
  persistenceCorruption,
  repositoryFailure,
} from "./repository-error.js";
import {
  decodeSubmittedDecisionBindingAttentionFactRow,
  type SubmittedDecisionBindingAttentionDbRow,
} from "./submitted-decision-binding-attention-codec.js";

interface Row {
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

interface DeliverReplayRow {
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

const submittedDecisionBindingColumns = `attention_fact_id, event_id, project_id,
  execution_id, workspace_id, logical_step_no, repair_attempt,
  provider_turn_id, logical_action_id, failure_code, first_detected_at`;

interface LegacyAdoptionAttentionRow {
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

const legacyAdoptionColumns = `attention_fact_id, event_id, project_id,
  execution_id, workspace_id, provider_turn_id, logical_step_no,
  repair_attempt, failure_code, evidence_sha256, first_detected_at`;

interface LegacyAdoptionResolutionRow {
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

const legacyAdoptionResolutionColumns = `resolution_fact_id, attention_fact_id,
  event_id, project_id, execution_id, workspace_id, provider_turn_id,
  original_evidence_sha256, resolution_evidence_sha256,
  action_disposition_summary_json, action_disposition_summary_sha256,
  resolution_code, resolved_at`;

const toLegacyAdoptionFact = (
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

const toLegacyAdoptionResolution = (
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

const legacyEvidenceMatchesFact = (
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

const isLegacyMissing = (value: unknown): boolean =>
  typeof value === "object" &&
  value !== null &&
  !Array.isArray(value) &&
  (value as Record<string, unknown>)._tag === "Missing" &&
  Object.keys(value as Record<string, unknown>).length === 1;

const isSha256Hex = (value: unknown): value is string =>
  typeof value === "string" && /^[0-9a-f]{64}$/u.test(value);

const validateLegacyAdoptionEvidence = (
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

const decodeSubmittedDecisionBindingFact = (
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

const factsAreEqual = (
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

const toFact = (row: Row): AssignWorkBindingAttentionFact => ({
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

const toDeliverReplayFact = (
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

const DELIVER_REPLAY_COLUMNS = `attention_fact_id, event_id, project_id,
  execution_id, target_workspace_id, logical_action_id, message_id,
  failure_code, first_detected_at`;

export const makeRecoveryAttentionFactStoreLive = (
  qualificationProbe?: RecoveryAttentionFactQualificationProbe,
): Layer.Layer<
  RecoveryAttentionFactStore,
  never,
  SqlClient | DomainEventJournal | IdGenerator
> =>
  Layer.effect(
    RecoveryAttentionFactStore,
    Effect.gen(function* () {
      const sql = yield* SqlClient;
      const journal = yield* DomainEventJournal;
      const ids = yield* IdGenerator;
      const run = <A>(effect: Effect.Effect<A, SqlError>) =>
        effect.pipe(
          Effect.mapError(
            repositoryFailure(
              "RecoveryAttentionFactStore",
              "assign-work-binding",
            ),
          ),
        );
      const runLegacyAdoption = <A>(effect: Effect.Effect<A, SqlError>) =>
        effect.pipe(
          Effect.mapError(
            repositoryFailure(
              "RecoveryAttentionFactStore",
              "legacy-adoption-attention",
            ),
          ),
        );
      const readLegacyAdoptionById = (attentionFactId: string) =>
        runLegacyAdoption(
          sql.unsafe<LegacyAdoptionAttentionRow>(
            `SELECT ${legacyAdoptionColumns}
               FROM legacy_adoption_attention_facts
              WHERE attention_fact_id = ?`,
            [attentionFactId],
          ),
        );
      const assertLegacyAdoptionFence = (
        fence: AgentLoopStepFence,
        fenceNow: string,
      ) =>
        Effect.gen(function* () {
          const rows = yield* runLegacyAdoption(
            sql.unsafe<{ readonly ok: number }>(
              `SELECT 1 AS ok
                 FROM executions AS e
                 JOIN execution_leases AS l ON l.execution_id = e.execution_id
                WHERE e.execution_id = ? AND e.settled_at IS NULL
                  AND l.worker_id = ? AND l.worker_incarnation_id = ?
                  AND l.generation = ? AND l.expires_at > ?`,
              [
                fence.executionId,
                fence.workerId,
                fence.workerIncarnationId,
                fence.fencingGeneration,
                fenceNow,
              ],
            ),
          );
          if (rows.length === 0) {
            return yield* Effect.fail<LeaseFencingRejected>({
              _tag: "LeaseFencingRejected",
              executionId: fence.executionId,
              generation: fence.fencingGeneration,
            });
          }
        });
      const readByTuple = (input: RecordAssignWorkBindingFailureInput) =>
        run(
          sql.unsafe<Row>(
            `SELECT attention_fact_id, event_id, project_id, execution_id,
                  target_workspace_id, logical_action_id, committed_command_id,
                  failure_code, first_detected_at
             FROM assign_work_binding_attention_facts
            WHERE execution_id = ? AND logical_action_id = ? AND committed_command_id = ?`,
            [
              input.executionId,
              input.logicalActionId,
              input.committedCommandId,
            ],
          ),
        );
      const runDeliver = <A>(effect: Effect.Effect<A, SqlError>) =>
        effect.pipe(
          Effect.mapError(
            repositoryFailure("RecoveryAttentionFactStore", "deliver-replay"),
          ),
        );
      const readDeliverByTuple = (input: RecordDeliverReplayFailureInput) =>
        runDeliver(
          sql.unsafe<DeliverReplayRow>(
            `SELECT ${DELIVER_REPLAY_COLUMNS}
               FROM deliver_replay_attention_facts
              WHERE execution_id = ? AND logical_action_id = ? AND message_id = ?`,
            [input.executionId, input.logicalActionId, input.messageId],
          ),
        );
      const readDeliverById = (attentionFactId: string) =>
        runDeliver(
          sql.unsafe<DeliverReplayRow>(
            `SELECT ${DELIVER_REPLAY_COLUMNS}
               FROM deliver_replay_attention_facts WHERE attention_fact_id = ?`,
            [attentionFactId],
          ),
        );
      const ensureSubmittedDecisionBindingAvailable = () =>
        Effect.gen(function* () {
          const tables = yield* run(
            sql.unsafe<{ readonly name: string }>(
              `SELECT name FROM sqlite_master
                WHERE type = 'table'
                  AND name = 'submitted_decision_binding_attention_facts'`,
            ),
          );
          if (tables.length === 0) {
            return yield* Effect.fail<RecoveryAttentionFactStoreError>({
              _tag: "PersistenceUnavailable",
              repository: "RecoveryAttentionFactStore",
              operation: "submitted-decision-binding",
              retryDisposition: "non-retryable",
              sourceTag: "P41MigrationNotRegistered",
              cause: { _tag: "P41MigrationNotRegistered" },
            });
          }
        });
      const readSubmittedDecisionBindingByTuple = (
        input: RecordSubmittedDecisionBindingFailureInput,
      ) =>
        run(
          sql.unsafe<SubmittedDecisionBindingAttentionDbRow>(
            `SELECT ${submittedDecisionBindingColumns}
               FROM submitted_decision_binding_attention_facts
              WHERE execution_id = ? AND logical_step_no = ?
                AND repair_attempt = ? AND logical_action_id = ?`,
            [
              input.executionId,
              input.logicalStepNo,
              input.repairAttempt,
              input.logicalActionId,
            ],
          ),
        );
      const insertPending = (fact: DeliverReplayAttentionFact) =>
        runDeliver(
          sql.unsafe(
            `INSERT INTO deliver_replay_attention_pending
               (project_id, attention_fact_id, enqueued_at)
             VALUES (?, ?, ?)
             ON CONFLICT(attention_fact_id) DO NOTHING`,
            [fact.projectId, fact.attentionFactId, fact.firstDetectedAt],
          ),
        );
      const recordLegacyAdoptionFailure = (
        input: RecordLegacyAdoptionAttentionFailureInput,
      ) =>
        Effect.gen(function* () {
          yield* TransactionScope;
          const { evidence, fence, firstDetectedAt } = input;
          const invalid = validateLegacyAdoptionEvidence(evidence);
          if (
            invalid !== undefined ||
            evidence.executionId !== fence.executionId ||
            firstDetectedAt.length === 0
          ) {
            return yield* Effect.fail<RecoveryAttentionFactStoreError>({
              _tag: "RecoveryAttentionFactInvariantConflict",
              reason:
                invalid ?? "legacy adoption fence does not bind its evidence",
            });
          }
          yield* assertLegacyAdoptionFence(fence, firstDetectedAt);
          const executionRows = yield* runLegacyAdoption(
            sql.unsafe<{
              readonly project_id: string;
              readonly workspace_id: string;
            }>(
              `SELECT project_id, workspace_id FROM executions
                WHERE execution_id = ? AND settled_at IS NULL`,
              [evidence.executionId],
            ),
          );
          if (
            executionRows[0]?.project_id !== evidence.projectId ||
            executionRows[0]?.workspace_id !== evidence.workspaceId
          ) {
            return yield* Effect.fail<RecoveryAttentionFactStoreError>({
              _tag: "RecoveryAttentionFactInvariantConflict",
              reason:
                "legacy adoption evidence does not match its Execution binding",
            });
          }
          const evidenceSha256 = legacyAdoptionEvidenceDigestV1(evidence);
          const attentionFactId = legacyAdoptionAttentionFactIdV1(
            evidence.executionId,
            evidenceSha256,
          );
          const priorRows = yield* runLegacyAdoption(
            sql.unsafe<LegacyAdoptionAttentionRow>(
              `SELECT ${legacyAdoptionColumns}
                 FROM legacy_adoption_attention_facts
                WHERE execution_id = ? AND evidence_sha256 = ?`,
              [evidence.executionId, evidenceSha256],
            ),
          );
          const priorRow = priorRows[0];
          if (priorRow !== undefined) {
            const prior = toLegacyAdoptionFact(priorRow);
            if (!legacyEvidenceMatchesFact(evidence, prior)) {
              return yield* Effect.fail<RecoveryAttentionFactStoreError>({
                _tag: "RecoveryAttentionFactInvariantConflict",
                reason:
                  "existing AH14 failure fact conflicts with its evidence tuple",
              });
            }
            return prior;
          }
          yield* assertLegacyAdoptionFence(fence, firstDetectedAt);
          const events = yield* journal
            .appendReturningIds([
              {
                projectId: evidence.projectId,
                eventType: "LegacyAdoptionEvidenceEscalated",
                eventVersion: 1,
                occurredAt: firstDetectedAt,
                aggregateRef: evidence.executionId,
                actor: parse(Actor)("system:recovery"),
                correlationRef: attentionFactId,
                payload: {
                  factId: attentionFactId,
                  attentionFactId,
                  projectId: evidence.projectId,
                  executionId: evidence.executionId,
                  targetWorkspaceId: evidence.workspaceId,
                  providerTurnId: evidence.step.providerTurnId,
                  logicalStepNo: evidence.step.logicalStepNo,
                  repairAttempt: evidence.step.repairAttempt,
                  failureCode: evidence.failureCode,
                  evidenceSha256,
                  firstDetectedAt,
                },
              },
            ])
            .pipe(Effect.provideService(IdGenerator, ids));
          const eventId = events[0];
          if (eventId === undefined) {
            return yield* Effect.fail<RecoveryAttentionFactStoreError>({
              _tag: "RecoveryAttentionFactInvariantConflict",
              reason: "event journal did not return the AH14 failure event id",
            });
          }
          yield* runLegacyAdoption(
            sql.unsafe(
              `INSERT INTO legacy_adoption_attention_facts (
                 attention_fact_id, event_id, project_id, execution_id,
                 workspace_id, provider_turn_id, logical_step_no,
                 repair_attempt, failure_code, evidence_sha256, first_detected_at
               ) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
              [
                attentionFactId,
                eventId,
                evidence.projectId,
                evidence.executionId,
                evidence.workspaceId,
                evidence.step.providerTurnId,
                evidence.step.logicalStepNo,
                evidence.step.repairAttempt,
                evidence.failureCode,
                evidenceSha256,
                firstDetectedAt,
              ],
            ),
          );
          return {
            attentionFactId,
            eventId,
            projectId: evidence.projectId,
            executionId: evidence.executionId,
            workspaceId: evidence.workspaceId,
            providerTurnId: evidence.step.providerTurnId,
            logicalStepNo: evidence.step.logicalStepNo,
            repairAttempt: evidence.step.repairAttempt,
            failureCode: evidence.failureCode,
            evidenceSha256,
            firstDetectedAt,
          } satisfies LegacyAdoptionAttentionFact;
        });
      const resolveLegacyAdoptionFailure = (
        input: ResolveLegacyAdoptionAttentionInput,
      ) =>
        Effect.gen(function* () {
          yield* TransactionScope;
          const { evidence, fence, resolvedAt } = input;
          yield* assertLegacyAdoptionFence(fence, resolvedAt);
          const evidenceSha256 = legacyAdoptionEvidenceDigestV1(evidence);
          const factId = legacyAdoptionAttentionFactIdV1(
            evidence.executionId,
            evidenceSha256,
          );
          const failureRows = yield* readLegacyAdoptionById(factId);
          const failureRow = failureRows[0];
          if (failureRow === undefined) return Option.none();
          const failureFact = toLegacyAdoptionFact(failureRow);
          if (!legacyEvidenceMatchesFact(evidence, failureFact)) {
            return yield* Effect.fail<RecoveryAttentionFactStoreError>({
              _tag: "RecoveryAttentionFactInvariantConflict",
              reason:
                "legacy resolution does not match its original failure tuple",
            });
          }

          const p4Rows = [];
          for (const action of evidence.actions) {
            const rows = yield* runLegacyAdoption(
              sql.unsafe<{
                readonly invocation_id: string;
                readonly execution_id: string;
                readonly workspace_id: string;
                readonly tool_name: string;
                readonly tool_version: string;
                readonly side_effect_semantics: string;
                readonly arguments_json: string;
                readonly effect_admission_state: string;
                readonly settled_at: string | null;
                readonly settlement_kind: string | null;
                readonly settlement_json: string | null;
                readonly result_ref: string | null;
                readonly observation_format_version: string | null;
                readonly observation_json: Uint8Array | null;
                readonly observation_sha256: string | null;
                readonly binding_version: number;
                readonly canonical_binding_json: string;
                readonly binding_sha256: string;
              }>(
                `SELECT i.invocation_id, i.execution_id, i.workspace_id,
                        i.tool_name, i.tool_version, i.side_effect_semantics,
                        i.arguments_json, i.effect_admission_state, i.settled_at,
                        i.settlement_kind, i.settlement_json, i.result_ref,
                        i.observation_format_version, i.observation_json,
                        i.observation_sha256, b.binding_version,
                        b.canonical_binding_json, b.binding_sha256
                   FROM tool_invocation_recovery_bindings b
                   JOIN tool_invocations i ON i.invocation_id = b.invocation_id
                  WHERE i.execution_id = ?
                    AND json_extract(b.canonical_binding_json, '$.providerTurnId') = ?
                    AND json_extract(b.canonical_binding_json, '$.logicalStepNo') = ?
                    AND json_extract(b.canonical_binding_json, '$.repairAttempt') = ?
                    AND json_extract(b.canonical_binding_json, '$.actionIndex') = ?
                    AND json_extract(b.canonical_binding_json, '$.callRef') = ?
                    AND json_extract(b.canonical_binding_json, '$.toolName') = ?
                    AND i.workspace_id = ?`,
                [
                  evidence.executionId,
                  evidence.step.providerTurnId,
                  evidence.step.logicalStepNo,
                  evidence.step.repairAttempt,
                  action.actionIndex,
                  action.callRef,
                  action.toolName,
                  evidence.workspaceId,
                ],
              ),
            );
            if (rows.length === 0) return Option.none();
            if (rows.length !== 1) {
              return yield* Effect.fail<RecoveryAttentionFactStoreError>({
                _tag: "RecoveryAttentionFactInvariantConflict",
                reason: "legacy resolution P4 binding is not unique",
              });
            }
            const row = rows[0];
            if (row === undefined) return Option.none();
            const verified = verifyRecoveryBindingV1({
              invocationId: row.invocation_id as never,
              canonicalJson: row.canonical_binding_json,
              bindingSha256: row.binding_sha256,
            });
            if (
              row.binding_version !== 1 ||
              verified === null ||
              row.execution_id !== evidence.executionId ||
              row.workspace_id !== evidence.workspaceId ||
              row.tool_name !== action.toolName ||
              row.tool_version !== action.toolSchemaVersion ||
              sha256Hex(row.arguments_json) !== action.argumentsSha256 ||
              sha256Hex(row.arguments_json) !== action.inputHash ||
              verified.value.providerTurnId !== evidence.step.providerTurnId ||
              verified.value.logicalStepNo !== evidence.step.logicalStepNo ||
              verified.value.repairAttempt !== evidence.step.repairAttempt ||
              verified.value.logicalActionId !== action.logicalActionId ||
              verified.value.actionIndex !== action.actionIndex ||
              verified.value.callRef !== action.callRef ||
              verified.value.toolName !== action.toolName ||
              verified.value.toolVersion !== action.toolSchemaVersion ||
              verified.value.executionId !== evidence.executionId ||
              verified.value.canonicalArgumentsDigest !==
                sha256Hex(
                  canonicalizeLegacyAdoptionEvidenceV1(
                    JSON.parse(row.arguments_json) as unknown,
                  ),
                )
            ) {
              return yield* Effect.fail<RecoveryAttentionFactStoreError>({
                _tag: "RecoveryAttentionFactInvariantConflict",
                reason:
                  "legacy resolution P4 binding conflicts with its exact action",
              });
            }

            let disposition: "Applied" | "NotAdmitted";
            let observationJson: string | { readonly _tag: "Missing" };
            let resultArtifactHash: string | { readonly _tag: "Missing" } = {
              _tag: "Missing",
            };
            if (
              row.settlement_kind === "Denied" &&
              row.effect_admission_state === "NotAdmitted" &&
              row.settled_at !== null &&
              row.settlement_json !== null &&
              row.result_ref === null &&
              row.observation_format_version === null &&
              row.observation_json === null &&
              row.observation_sha256 === null
            ) {
              const denial = JSON.parse(row.settlement_json) as Record<
                string,
                unknown
              >;
              const allowed = [
                "InvocationAuthorityDenied",
                "ApprovalRejected",
                "ApprovalNotFound",
                "ApprovalMismatch",
                "ApprovalExpired",
                "ApprovalConsumedByOtherInvocation",
                "ResourceResolutionDenied",
                "ResourceAdmissionDenied",
                "ApprovalNoLongerAuthorized",
              ];
              if (
                denial._tag !== "Denied" ||
                denial.projectionVersion !== 1 ||
                Object.keys(denial).sort().join(",") !==
                  "_tag,projectionVersion,reasonCode" ||
                typeof denial.reasonCode !== "string" ||
                !allowed.includes(denial.reasonCode)
              ) {
                return yield* Effect.fail<RecoveryAttentionFactStoreError>({
                  _tag: "RecoveryAttentionFactInvariantConflict",
                  reason:
                    "legacy resolution P4 denial is not an accepted terminal no-effect proof",
                });
              }
              disposition = "NotAdmitted";
              observationJson = { _tag: "Missing" };
            } else if (
              (row.settlement_kind === "Success" ||
                row.settlement_kind === "ExpectedFailure") &&
              row.effect_admission_state === "MayHaveStarted" &&
              row.settled_at !== null &&
              row.settlement_json !== null &&
              row.observation_format_version ===
                "p4-canonical-tool-observation-v1" &&
              row.observation_json !== null &&
              row.observation_sha256 !== null
            ) {
              const observationText = new TextDecoder().decode(
                row.observation_json,
              );
              if (
                row.observation_format_version !==
                  P4_TOOL_OBSERVATION_FORMAT_V1 ||
                sha256Hex(
                  `${P4_TOOL_OBSERVATION_FORMAT_V1}\n${observationText}`,
                ) !== row.observation_sha256
              ) {
                return yield* Effect.fail<RecoveryAttentionFactStoreError>({
                  _tag: "RecoveryAttentionFactInvariantConflict",
                  reason: "legacy resolution P4 observation hash mismatch",
                });
              }
              const settlement = JSON.parse(row.settlement_json) as Record<
                string,
                unknown
              >;
              const observation = JSON.parse(observationText) as Record<
                string,
                unknown
              >;
              if (
                settlement._tag !== row.settlement_kind ||
                observation._tag !== row.settlement_kind ||
                observation.resultRef !== row.result_ref
              ) {
                return yield* Effect.fail<RecoveryAttentionFactStoreError>({
                  _tag: "RecoveryAttentionFactInvariantConflict",
                  reason:
                    "legacy resolution P4 settlement and Observation disagree",
                });
              }
              if (row.result_ref !== null) {
                const artifacts = yield* runLegacyAdoption(
                  sql.unsafe<{
                    readonly artifact_id: string;
                    readonly invocation_id: string | null;
                    readonly execution_id: string | null;
                    readonly content_hash: string;
                  }>(
                    `SELECT artifact_id, invocation_id, execution_id, content_hash
                       FROM artifacts WHERE artifact_id = ?`,
                    [row.result_ref],
                  ),
                );
                const artifact = artifacts[0];
                if (
                  artifacts.length !== 1 ||
                  artifact?.artifact_id !== row.result_ref ||
                  artifact.invocation_id !== row.invocation_id ||
                  artifact.execution_id !== row.execution_id ||
                  !isSha256Hex(artifact.content_hash)
                ) {
                  return yield* Effect.fail<RecoveryAttentionFactStoreError>({
                    _tag: "RecoveryAttentionFactInvariantConflict",
                    reason:
                      "legacy resolution result Artifact is not bound to the exact P4 invocation",
                  });
                }
                resultArtifactHash = artifact.content_hash;
              }
              disposition = "Applied";
              observationJson = observationText;
            } else {
              return yield* Effect.fail<RecoveryAttentionFactStoreError>({
                _tag: "RecoveryAttentionFactInvariantConflict",
                reason:
                  "legacy resolution P4 disposition is incomplete or uncertain",
              });
            }
            const p4Evidence = {
              invocationId: row.invocation_id,
              executionId: row.execution_id,
              workspaceId: row.workspace_id,
              toolName: row.tool_name,
              toolVersion: row.tool_version,
              sideEffectSemantics: row.side_effect_semantics,
              canonicalBindingJson: row.canonical_binding_json,
              bindingSha256: row.binding_sha256,
              argumentsSha256: sha256Hex(row.arguments_json),
              effectAdmissionState: row.effect_admission_state,
              settledAt: row.settled_at,
              settlementKind: row.settlement_kind,
              settlementJson: row.settlement_json,
              settlementSha256: sha256Hex(row.settlement_json ?? ""),
              resultRef: row.result_ref,
              resultArtifactHash,
              observationFormatVersion: row.observation_format_version ?? {
                _tag: "Missing",
              },
              observationJson,
              observationSha256: row.observation_sha256 ?? { _tag: "Missing" },
            };
            p4Rows.push({
              actionOrdinal: action.actionIndex,
              logicalActionId: action.logicalActionId,
              callRef: action.callRef,
              toolName: action.toolName,
              toolSchemaVersion: action.toolSchemaVersion,
              inputHash: action.inputHash,
              disposition,
              p4Evidence,
            });
          }
          const dispositions = p4Rows.map((row) => row.disposition);
          const resolutionCode =
            deriveLegacyAdoptionResolutionCodeV1(dispositions);
          if (resolutionCode === null) {
            return yield* Effect.fail<RecoveryAttentionFactStoreError>({
              _tag: "RecoveryAttentionFactInvariantConflict",
              reason:
                "legacy resolution requires a complete non-empty proven action set",
            });
          }
          const summaryJson = canonicalizeLegacyActionDispositionSummaryV1(
            p4Rows.map(
              ({
                actionOrdinal,
                logicalActionId,
                callRef,
                toolName,
                toolSchemaVersion,
                inputHash,
                disposition,
              }) => ({
                actionOrdinal,
                logicalActionId,
                callRef,
                toolName,
                toolSchemaVersion,
                inputHash,
                disposition,
              }),
            ),
          );
          const summarySha256 = sha256Hex(summaryJson);
          const tuple = {
            version: 1 as const,
            attentionFactId: failureFact.attentionFactId,
            originalEvidenceSha256: failureFact.evidenceSha256,
            executionId: failureFact.executionId,
            providerTurnId: failureFact.providerTurnId,
            logicalStepNo: failureFact.logicalStepNo,
            repairAttempt: failureFact.repairAttempt,
            resolutionCode,
            actionDispositionSummarySha256: summarySha256,
            actions: p4Rows,
          };
          const resolutionEvidenceSha256 =
            legacyAdoptionEvidenceDigestV1(tuple);
          const resolutionFactId = legacyAdoptionResolutionFactIdV1({
            attentionFactId: failureFact.attentionFactId,
            originalEvidenceSha256: failureFact.evidenceSha256,
            resolutionEvidenceSha256,
            resolutionCode,
          });
          const priorRows = yield* runLegacyAdoption(
            sql.unsafe<LegacyAdoptionResolutionRow>(
              `SELECT ${legacyAdoptionResolutionColumns}
                 FROM legacy_adoption_attention_resolution_facts
                WHERE attention_fact_id = ?`,
              [failureFact.attentionFactId],
            ),
          );
          const priorRow = priorRows[0];
          if (priorRow !== undefined) {
            const prior = toLegacyAdoptionResolution(priorRow);
            if (
              prior.resolutionFactId !== resolutionFactId ||
              prior.originalEvidenceSha256 !== failureFact.evidenceSha256 ||
              prior.resolutionEvidenceSha256 !== resolutionEvidenceSha256 ||
              prior.actionDispositionSummaryJson !== summaryJson ||
              prior.actionDispositionSummarySha256 !== summarySha256 ||
              prior.resolutionCode !== resolutionCode
            ) {
              return yield* Effect.fail<RecoveryAttentionFactStoreError>({
                _tag: "RecoveryAttentionFactInvariantConflict",
                reason:
                  "legacy resolution retry conflicts with its immutable resolution fact",
              });
            }
            return Option.some(prior);
          }
          yield* assertLegacyAdoptionFence(fence, resolvedAt);
          const events = yield* journal
            .appendReturningIds([
              {
                projectId: failureFact.projectId,
                eventType: "LegacyAdoptionEvidenceResolved",
                eventVersion: 1,
                occurredAt: resolvedAt,
                aggregateRef: failureFact.executionId,
                actor: parse(Actor)("system:recovery"),
                correlationRef: failureFact.attentionFactId,
                causedByEventId: failureFact.eventId as never,
                payload: {
                  factId: resolutionFactId,
                  attentionFactId: failureFact.attentionFactId,
                  projectId: failureFact.projectId,
                  executionId: failureFact.executionId,
                  targetWorkspaceId: failureFact.workspaceId,
                  providerTurnId: failureFact.providerTurnId,
                  originalEvidenceSha256: failureFact.evidenceSha256,
                  resolutionEvidenceSha256,
                  resolutionCode,
                  resolvedAt,
                },
              },
            ])
            .pipe(Effect.provideService(IdGenerator, ids));
          const eventId = events[0];
          if (eventId === undefined) {
            return yield* Effect.fail<RecoveryAttentionFactStoreError>({
              _tag: "RecoveryAttentionFactInvariantConflict",
              reason:
                "event journal did not return the AH14 resolution event id",
            });
          }
          yield* runLegacyAdoption(
            sql.unsafe(
              `INSERT INTO legacy_adoption_attention_resolution_facts (
                 resolution_fact_id, attention_fact_id, event_id, project_id,
                 execution_id, workspace_id, provider_turn_id,
                 original_evidence_sha256, resolution_evidence_sha256,
                 action_disposition_summary_json,
                 action_disposition_summary_sha256, resolution_code, resolved_at
               ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
              [
                resolutionFactId,
                failureFact.attentionFactId,
                eventId,
                failureFact.projectId,
                failureFact.executionId,
                failureFact.workspaceId,
                failureFact.providerTurnId,
                failureFact.evidenceSha256,
                resolutionEvidenceSha256,
                summaryJson,
                summarySha256,
                resolutionCode,
                resolvedAt,
              ],
            ),
          );
          return Option.some({
            resolutionFactId,
            attentionFactId: failureFact.attentionFactId,
            eventId,
            projectId: failureFact.projectId,
            executionId: failureFact.executionId,
            workspaceId: failureFact.workspaceId,
            providerTurnId: failureFact.providerTurnId,
            originalEvidenceSha256: failureFact.evidenceSha256,
            resolutionEvidenceSha256,
            actionDispositionSummaryJson: summaryJson,
            actionDispositionSummarySha256: summarySha256,
            resolutionCode,
            resolvedAt,
          } satisfies LegacyAdoptionAttentionResolutionFact);
        });
      return RecoveryAttentionFactStore.of({
        recordLegacyAdoptionFailure,
        resolveLegacyAdoptionFailure,
        findLegacyAdoptionFailure: (attentionFactId) =>
          Effect.gen(function* () {
            yield* TransactionScope;
            const rows = yield* readLegacyAdoptionById(attentionFactId);
            return rows[0] === undefined
              ? Option.none()
              : Option.some(toLegacyAdoptionFact(rows[0]));
          }),
        findLegacyAdoptionFailureByEventId: (eventId) =>
          Effect.gen(function* () {
            yield* TransactionScope;
            const rows = yield* runLegacyAdoption(
              sql.unsafe<LegacyAdoptionAttentionRow>(
                `SELECT ${legacyAdoptionColumns}
                   FROM legacy_adoption_attention_facts WHERE event_id = ?`,
                [eventId],
              ),
            );
            return rows[0] === undefined
              ? Option.none()
              : Option.some(toLegacyAdoptionFact(rows[0]));
          }),
        listLegacyAdoptionFailures: (projectId) =>
          Effect.gen(function* () {
            yield* TransactionScope;
            const rows = yield* runLegacyAdoption(
              sql.unsafe<LegacyAdoptionAttentionRow>(
                `SELECT ${legacyAdoptionColumns}
                   FROM legacy_adoption_attention_facts
                  WHERE project_id = ? ORDER BY first_detected_at, attention_fact_id`,
                [projectId],
              ),
            );
            return rows.map(toLegacyAdoptionFact);
          }),
        findLegacyAdoptionResolution: (attentionFactId) =>
          Effect.gen(function* () {
            yield* TransactionScope;
            const rows = yield* runLegacyAdoption(
              sql.unsafe<LegacyAdoptionResolutionRow>(
                `SELECT ${legacyAdoptionResolutionColumns}
                   FROM legacy_adoption_attention_resolution_facts
                  WHERE attention_fact_id = ?`,
                [attentionFactId],
              ),
            );
            return rows[0] === undefined
              ? Option.none()
              : Option.some(toLegacyAdoptionResolution(rows[0]));
          }),
        listLegacyAdoptionResolutions: (projectId) =>
          Effect.gen(function* () {
            yield* TransactionScope;
            const rows = yield* runLegacyAdoption(
              sql.unsafe<LegacyAdoptionResolutionRow>(
                `SELECT ${legacyAdoptionResolutionColumns}
                   FROM legacy_adoption_attention_resolution_facts
                  WHERE project_id = ? ORDER BY resolved_at, attention_fact_id`,
                [projectId],
              ),
            );
            return rows.map(toLegacyAdoptionResolution);
          }),
        isSubmittedDecisionBindingAvailable: () =>
          Effect.gen(function* () {
            yield* TransactionScope;
            const tables = yield* run(
              sql.unsafe<{ readonly name: string }>(
                `SELECT name FROM sqlite_master
                  WHERE type = 'table'
                    AND name = 'submitted_decision_binding_attention_facts'`,
              ),
            );
            return tables.length > 0;
          }),
        recordAssignWorkBindingFailure: (input) =>
          Effect.gen(function* () {
            yield* TransactionScope;
            const attentionFactId = `att_${sha256Hex(
              JSON.stringify({
                version: 1,
                executionId: input.executionId,
                logicalActionId: input.logicalActionId,
                committedCommandId: input.committedCommandId,
              }),
            )}`;
            const prior = yield* readByTuple(input);
            if (prior[0] !== undefined) {
              const fact = toFact(prior[0]);
              if (
                fact.projectId !== input.projectId ||
                fact.targetWorkspaceId !== input.targetWorkspaceId ||
                fact.attentionFactId !== attentionFactId
              ) {
                return yield* Effect.fail<RecoveryAttentionFactStoreError>({
                  _tag: "RecoveryAttentionFactInvariantConflict",
                  reason:
                    "existing AssignWork binding fact has a conflicting identity",
                });
              }
              return fact;
            }
            const events = yield* journal
              .appendReturningIds([
                {
                  projectId: input.projectId,
                  eventType: "AssignWorkTargetBindingEscalated",
                  eventVersion: 1,
                  occurredAt: input.firstDetectedAt,
                  aggregateRef: input.targetWorkspaceId,
                  actor: parse(Actor)("system:recovery"),
                  causedByCommandId: input.committedCommandId,
                  correlationRef: input.logicalActionId,
                  payload: {
                    attentionFactId,
                    executionId: input.executionId,
                    targetWorkspaceId: input.targetWorkspaceId,
                    logicalActionId: input.logicalActionId,
                    committedCommandId: input.committedCommandId,
                    failureCode: input.failureCode,
                  },
                },
              ])
              .pipe(Effect.provideService(IdGenerator, ids));
            const eventId = events[0];
            if (eventId === undefined) {
              return yield* Effect.fail<RecoveryAttentionFactStoreError>({
                _tag: "RecoveryAttentionFactInvariantConflict",
                reason:
                  "event journal did not return the AssignWork binding event id",
              });
            }
            yield* run(
              sql.unsafe(
                `INSERT INTO assign_work_binding_attention_facts (
                attention_fact_id, event_id, project_id, execution_id,
                target_workspace_id, logical_action_id, committed_command_id,
                failure_code, first_detected_at
              ) VALUES (?,?,?,?,?,?,?,?,?)`,
                [
                  attentionFactId,
                  eventId,
                  input.projectId,
                  input.executionId,
                  input.targetWorkspaceId,
                  input.logicalActionId,
                  input.committedCommandId,
                  input.failureCode,
                  input.firstDetectedAt,
                ],
              ),
            );
            if (qualificationProbe !== undefined) {
              yield* Effect.promise(() =>
                qualificationProbe({
                  boundary: "AH10BeforeAssignWorkBindingAttentionCommit",
                  executionId: input.executionId,
                  logicalActionId: input.logicalActionId,
                  committedCommandId: input.committedCommandId,
                }),
              );
            }
            return {
              ...input,
              attentionFactId,
              eventId,
            };
          }),
        findAssignWorkBindingFailure: (attentionFactId) =>
          Effect.gen(function* () {
            yield* TransactionScope;
            const rows = yield* run(
              sql.unsafe<Row>(
                `SELECT attention_fact_id, event_id, project_id, execution_id,
                      target_workspace_id, logical_action_id, committed_command_id,
                      failure_code, first_detected_at
                 FROM assign_work_binding_attention_facts WHERE attention_fact_id = ?`,
                [attentionFactId],
              ),
            );
            return rows[0] === undefined
              ? Option.none()
              : Option.some(toFact(rows[0]));
          }),
        recordDeliverReplayFailure: (input) =>
          Effect.gen(function* () {
            yield* TransactionScope;
            const attentionFactId = `att_${sha256Hex(
              JSON.stringify({
                version: 1,
                executionId: input.executionId,
                logicalActionId: input.logicalActionId,
                messageId: input.messageId,
              }),
            )}`;
            const prior = yield* readDeliverByTuple(input);
            if (prior[0] !== undefined) {
              const fact = toDeliverReplayFact(prior[0]);
              if (
                fact.projectId !== input.projectId ||
                fact.targetWorkspaceId !== input.targetWorkspaceId ||
                fact.attentionFactId !== attentionFactId
              ) {
                return yield* Effect.fail<RecoveryAttentionFactStoreError>({
                  _tag: "RecoveryAttentionFactInvariantConflict",
                  reason:
                    "existing Deliver replay fact has a conflicting identity",
                });
              }
              yield* insertPending(fact);
              return fact;
            }

            const payload = {
              attentionFactId,
              executionId: input.executionId,
              targetWorkspaceId: input.targetWorkspaceId,
              logicalActionId: input.logicalActionId,
              messageId: input.messageId,
              failureCode: input.failureCode,
            };
            const events = yield* journal
              .appendReturningIds([
                {
                  projectId: input.projectId,
                  eventType: "DeliverReplayEscalated",
                  eventVersion: 1,
                  occurredAt: input.firstDetectedAt,
                  aggregateRef: input.targetWorkspaceId,
                  actor: parse(Actor)("system:recovery"),
                  ...(input.causedByCommandId === undefined
                    ? {}
                    : { causedByCommandId: input.causedByCommandId }),
                  correlationRef: input.logicalActionId,
                  payload,
                },
              ])
              .pipe(Effect.provideService(IdGenerator, ids));
            const eventId = events[0];
            if (eventId === undefined) {
              return yield* Effect.fail<RecoveryAttentionFactStoreError>({
                _tag: "RecoveryAttentionFactInvariantConflict",
                reason:
                  "event journal did not return the Deliver replay event id",
              });
            }
            const witnesses = yield* runDeliver(
              sql.unsafe<{
                readonly project_id: string;
                readonly event_type: string;
                readonly event_version: number;
                readonly occurred_at: string;
                readonly aggregate_ref: string;
                readonly actor: string;
                readonly caused_by_command_id: string | null;
                readonly caused_by_event_id: string | null;
                readonly correlation_ref: string | null;
                readonly payload_json: string;
              }>(
                `SELECT project_id, event_type, event_version, occurred_at,
                        aggregate_ref, actor, caused_by_command_id,
                        caused_by_event_id, correlation_ref, payload_json
                   FROM domain_events WHERE event_id = ?`,
                [eventId],
              ),
            );
            const witness = witnesses[0];
            if (
              witness === undefined ||
              witness.project_id !== input.projectId ||
              witness.event_type !== "DeliverReplayEscalated" ||
              Number(witness.event_version) !== 1 ||
              witness.occurred_at !== input.firstDetectedAt ||
              witness.aggregate_ref !== input.targetWorkspaceId ||
              witness.actor !== "system:recovery" ||
              witness.caused_by_command_id !==
                (input.causedByCommandId ?? null) ||
              witness.caused_by_event_id !== null ||
              witness.correlation_ref !== input.logicalActionId ||
              witness.payload_json !== JSON.stringify(payload)
            ) {
              return yield* Effect.fail<RecoveryAttentionFactStoreError>({
                _tag: "RecoveryAttentionFactInvariantConflict",
                reason:
                  "stored Deliver replay event witness conflicts with its fact",
              });
            }
            const fact: DeliverReplayAttentionFact = {
              attentionFactId,
              eventId,
              projectId: input.projectId,
              executionId: input.executionId,
              targetWorkspaceId: input.targetWorkspaceId,
              logicalActionId: input.logicalActionId,
              messageId: input.messageId,
              failureCode: input.failureCode,
              firstDetectedAt: input.firstDetectedAt,
            };
            yield* runDeliver(
              sql.unsafe(
                `INSERT INTO deliver_replay_attention_facts (
                   attention_fact_id, event_id, project_id, execution_id,
                   target_workspace_id, logical_action_id, message_id,
                   failure_code, first_detected_at
                 ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [
                  attentionFactId,
                  eventId,
                  input.projectId,
                  input.executionId,
                  input.targetWorkspaceId,
                  input.logicalActionId,
                  input.messageId,
                  input.failureCode,
                  input.firstDetectedAt,
                ],
              ),
            );
            yield* insertPending(fact);
            return fact;
          }),
        findDeliverReplayFailure: (attentionFactId) =>
          Effect.gen(function* () {
            yield* TransactionScope;
            const rows = yield* readDeliverById(attentionFactId);
            return rows[0] === undefined
              ? Option.none()
              : Option.some(toDeliverReplayFact(rows[0]));
          }),
        findDeliverReplayFailureByEventId: (eventId) =>
          Effect.gen(function* () {
            yield* TransactionScope;
            const rows = yield* runDeliver(
              sql.unsafe<DeliverReplayRow>(
                `SELECT ${DELIVER_REPLAY_COLUMNS}
                   FROM deliver_replay_attention_facts WHERE event_id = ?`,
                [eventId],
              ),
            );
            return rows[0] === undefined
              ? Option.none()
              : Option.some(toDeliverReplayFact(rows[0]));
          }),
        listDeliverReplayFailures: (projectId) =>
          Effect.gen(function* () {
            yield* TransactionScope;
            const rows = yield* runDeliver(
              sql.unsafe<DeliverReplayRow>(
                `SELECT ${DELIVER_REPLAY_COLUMNS}
                   FROM deliver_replay_attention_facts
                  WHERE project_id = ?
                  ORDER BY first_detected_at, attention_fact_id`,
                [projectId],
              ),
            );
            return rows.map(toDeliverReplayFact);
          }),
        listPendingDeliverReplayAttention: (projectId, limit) =>
          Effect.gen(function* () {
            yield* TransactionScope;
            const columns = DELIVER_REPLAY_COLUMNS.split(", ")
              .map((column) => `fact.${column}`)
              .join(", ");
            const rows = yield* runDeliver(
              sql.unsafe<DeliverReplayRow>(
                `SELECT ${columns}
                   FROM deliver_replay_attention_pending AS pending
                   JOIN deliver_replay_attention_facts AS fact
                     ON fact.attention_fact_id = pending.attention_fact_id
                    AND fact.project_id = pending.project_id
                  WHERE pending.project_id = ?
                  ORDER BY pending.queue_sequence
                  LIMIT ?`,
                [projectId, Math.max(0, Math.trunc(limit))],
              ),
            );
            return rows.map(toDeliverReplayFact);
          }),
        acknowledgePendingDeliverReplayAttention: (attentionFactId) =>
          Effect.gen(function* () {
            yield* TransactionScope;
            const marker = yield* runDeliver(
              sql.unsafe<{ readonly present: number }>(
                `SELECT 1 AS present FROM deliver_replay_attention_rows
                  WHERE attention_fact_id = ?`,
                [attentionFactId],
              ),
            );
            if (marker[0] === undefined) {
              return yield* Effect.fail<RecoveryAttentionFactStoreError>({
                _tag: "RecoveryAttentionFactInvariantConflict",
                reason: "Deliver replay queue ACK requires its P10 marker",
              });
            }
            yield* runDeliver(
              sql.unsafe(
                "DELETE FROM deliver_replay_attention_pending WHERE attention_fact_id = ?",
                [attentionFactId],
              ),
            );
          }),
        recordSubmittedDecisionBindingFailure: (input) =>
          Effect.gen(function* () {
            yield* TransactionScope;
            yield* ensureSubmittedDecisionBindingAvailable();
            const validInput = decodeSubmittedDecisionBindingAttentionFactRow({
              attention_fact_id: input.attentionFactId,
              event_id: input.eventId,
              project_id: input.projectId,
              execution_id: input.executionId,
              workspace_id: input.workspaceId,
              logical_step_no: input.logicalStepNo,
              repair_attempt: input.repairAttempt,
              provider_turn_id: input.providerTurnId,
              logical_action_id: input.logicalActionId,
              failure_code: input.failureCode,
              first_detected_at: input.firstDetectedAt,
            });
            if (validInput === undefined) {
              return yield* Effect.fail<RecoveryAttentionFactStoreError>({
                _tag: "RecoveryAttentionFactInvariantConflict",
                reason:
                  "submitted DecisionEpisode fact input violates its closed physical codec",
              });
            }
            const prior = yield* readSubmittedDecisionBindingByTuple(input);
            if (prior[0] !== undefined) {
              const fact = yield* decodeSubmittedDecisionBindingFact(prior[0]);
              if (!factsAreEqual(fact, validInput)) {
                return yield* Effect.fail<RecoveryAttentionFactStoreError>({
                  _tag: "RecoveryAttentionFactInvariantConflict",
                  reason:
                    "existing Submitted DecisionEpisode binding fact conflicts with its immutable tuple",
                });
              }
              return fact;
            }
            yield* run(
              sql.unsafe(
                `INSERT INTO submitted_decision_binding_attention_facts (
                   attention_fact_id, event_id, project_id, execution_id,
                   workspace_id, logical_step_no, repair_attempt,
                   provider_turn_id, logical_action_id, failure_code,
                   first_detected_at
                 ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [
                  validInput.attentionFactId,
                  validInput.eventId,
                  validInput.projectId,
                  validInput.executionId,
                  validInput.workspaceId,
                  validInput.logicalStepNo,
                  validInput.repairAttempt,
                  validInput.providerTurnId,
                  validInput.logicalActionId,
                  validInput.failureCode,
                  validInput.firstDetectedAt,
                ],
              ),
            );
            return validInput;
          }),
        findSubmittedDecisionBindingFailure: (attentionFactId) =>
          Effect.gen(function* () {
            yield* TransactionScope;
            yield* ensureSubmittedDecisionBindingAvailable();
            const rows = yield* run(
              sql.unsafe<SubmittedDecisionBindingAttentionDbRow>(
                `SELECT ${submittedDecisionBindingColumns}
                   FROM submitted_decision_binding_attention_facts
                  WHERE attention_fact_id = ?`,
                [attentionFactId],
              ),
            );
            return rows[0] === undefined
              ? Option.none()
              : Option.some(yield* decodeSubmittedDecisionBindingFact(rows[0]));
          }),
        listSubmittedDecisionBindingFailures: (projectId) =>
          Effect.gen(function* () {
            yield* TransactionScope;
            yield* ensureSubmittedDecisionBindingAvailable();
            const rows = yield* run(
              sql.unsafe<SubmittedDecisionBindingAttentionDbRow>(
                `SELECT ${submittedDecisionBindingColumns}
                   FROM submitted_decision_binding_attention_facts
                  WHERE project_id = ?
                  ORDER BY first_detected_at, attention_fact_id`,
                [projectId],
              ),
            );
            const facts: SubmittedDecisionBindingAttentionFact[] = [];
            for (const row of rows) {
              facts.push(yield* decodeSubmittedDecisionBindingFact(row));
            }
            return facts;
          }),
      });
    }),
  );

export const RecoveryAttentionFactStoreLive =
  makeRecoveryAttentionFactStoreLive();
