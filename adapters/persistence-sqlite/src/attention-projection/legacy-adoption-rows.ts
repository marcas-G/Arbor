import {
  type AttentionProjectionStoreError,
  type AttentionProjectionStoreService,
  canonicalizeLegacyActionDispositionSummaryV1,
  deriveLegacyAdoptionResolutionCodeV1,
  type LegacyAdoptionAttentionFact,
  type LegacyAdoptionAttentionResolutionFact,
  legacyAdoptionResolutionFactIdV1,
  sha256Hex,
  TransactionScope,
} from "@arbor/ports";
import {
  Effect,
} from "effect";
import {
  type LegacyAdoptionAttentionDbRow,
  legacyAdoptionRowFromDb,
} from "./row-codecs.js";
import type { ProjectionContext } from "./context.js";

export const makeLegacyAdoptionRows = (context: ProjectionContext): Pick<AttentionProjectionStoreService, "putLegacyAdoptionFailure" | "removeLegacyAdoptionFailure" | "listLegacyAdoptionFailures" | "listDeliverReplayFailures"> => {
  const { sql, run, requireLegacyAdoptionMarker } = context;
  return {
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
  };
};
