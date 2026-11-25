import { Actor, parse } from "@arbor/domain";
import type {
  LegacyAdoptionAttentionFact,
  LegacyAdoptionAttentionResolutionFact,
  RecordLegacyAdoptionAttentionFailureInput,
  RecoveryAttentionFactStoreError,
  RecoveryAttentionFactStoreService,
  ResolveLegacyAdoptionAttentionInput,
} from "@arbor/ports";
import {
  canonicalizeLegacyActionDispositionSummaryV1,
  canonicalizeLegacyAdoptionEvidenceV1,
  deriveLegacyAdoptionResolutionCodeV1,
  IdGenerator,
  legacyAdoptionAttentionFactIdV1,
  legacyAdoptionEvidenceDigestV1,
  legacyAdoptionResolutionFactIdV1,
  P4_TOOL_OBSERVATION_FORMAT_V1,
  sha256Hex,
  TransactionScope,
  verifyRecoveryBindingV1,
} from "@arbor/ports";
import { Effect, Option } from "effect";
import type { FactContext } from "./context.js";
import {
  isSha256Hex,
  type LegacyAdoptionAttentionRow,
  type LegacyAdoptionResolutionRow,
  legacyAdoptionColumns,
  legacyAdoptionResolutionColumns,
  legacyEvidenceMatchesFact,
  toLegacyAdoptionFact,
  toLegacyAdoptionResolution,
  validateLegacyAdoptionEvidence,
} from "./row-codecs.js";

export const makeLegacyAdoptionFacts = (
  context: FactContext,
): Pick<
  RecoveryAttentionFactStoreService,
  | "recordLegacyAdoptionFailure"
  | "resolveLegacyAdoptionFailure"
  | "findLegacyAdoptionFailure"
  | "findLegacyAdoptionFailureByEventId"
  | "listLegacyAdoptionFailures"
  | "findLegacyAdoptionResolution"
  | "listLegacyAdoptionResolutions"
> => {
  const {
    sql,
    journal,
    ids,
    runLegacyAdoption,
    readLegacyAdoptionById,
    assertLegacyAdoptionFence,
  } = context;
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
          reason: invalid ?? "legacy adoption fence does not bind its evidence",
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
          reason: "legacy resolution does not match its original failure tuple",
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
            row.observation_format_version !== P4_TOOL_OBSERVATION_FORMAT_V1 ||
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
      const resolutionCode = deriveLegacyAdoptionResolutionCodeV1(dispositions);
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
      const resolutionEvidenceSha256 = legacyAdoptionEvidenceDigestV1(tuple);
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
          reason: "event journal did not return the AH14 resolution event id",
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
  return {
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
  };
};
