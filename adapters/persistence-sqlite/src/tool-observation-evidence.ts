import type { ExecutionId, ToolInvocationId } from "@arbor/domain";
import {
  P4_TOOL_OBSERVATION_FORMAT_V1,
  P4_TOOL_OBSERVATION_MAX_TEXT_UTF16_CODE_UNITS,
  type ToolExecutionContext,
  type ToolInvocationIntent,
  type ToolObservationEvidence,
  type ToolObservationEvidenceCandidate,
  ToolObservationEvidenceStore,
  type ToolObservationEvidenceStoreError,
  type ToolObservationEvidenceStoreService,
  type ToolObservationReplayFailureCode,
  type ToolObservationSettlement,
  TransactionScope,
} from "@arbor/ports";
import { Effect, Layer } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";
import {
  persistenceCorruption,
  repositoryFailure,
} from "./repository-error.js";
import {
  decodeToolObservationEvidence,
  encodeToolObservationEvidence,
} from "./tool-observation-evidence-codec.js";

interface EvidenceInvocationRow {
  readonly invocation_id: string;
  readonly execution_id: string;
  readonly workspace_id: string;
  readonly tool_name: string;
  readonly tool_version: string;
  readonly side_effect_semantics: string;
  readonly arguments_json: string;
  readonly resolved_regions_json: string;
  readonly approval_id: string | null;
  readonly effect_admission_state: string;
  readonly intent_at: string;
  readonly settled_at: string | null;
  readonly settlement_kind: string | null;
  readonly settlement_json: string | null;
  readonly result_ref: string | null;
  readonly observation_format_version: string | null;
  readonly observation_json: Uint8Array | null;
  readonly observation_sha256: string | null;
  readonly settlement_provenance: string | null;
  readonly recovery_binding_state: string;
  readonly recovery_binding_sha256: string | null;
  readonly selected_attempt_no: number | null;
  readonly selected_fact_id: string | null;
}

const sameIntent = (
  row: EvidenceInvocationRow,
  intent: ToolInvocationIntent,
): boolean =>
  row.invocation_id === intent.invocationId &&
  row.execution_id === intent.executionId &&
  row.workspace_id === intent.workspaceId &&
  row.tool_name === intent.toolName &&
  row.tool_version === intent.toolVersion &&
  row.side_effect_semantics === intent.sideEffectSemantics &&
  row.arguments_json === intent.argumentsJson &&
  row.resolved_regions_json === JSON.stringify(intent.resolvedRegions) &&
  row.approval_id === intent.approvalId &&
  row.intent_at === intent.intentAt;

const settlementFromRow = (
  row: EvidenceInvocationRow,
): ToolObservationSettlement | null => {
  if (row.settlement_json === null || row.settlement_kind === null) return null;
  try {
    const value = JSON.parse(row.settlement_json) as unknown;
    if (
      typeof value !== "object" ||
      value === null ||
      (value as { readonly _tag?: unknown })._tag !== row.settlement_kind
    ) {
      return null;
    }
    return value as ToolObservationSettlement;
  } catch {
    return null;
  }
};

const replayFailure = (
  invocationId: ToolInvocationId,
  failureCode: ToolObservationReplayFailureCode,
) => ({
  _tag: "ToolObservationReplayEvidenceFailure" as const,
  invocationId,
  failureCode,
});

export const ToolObservationEvidenceStoreLive: Layer.Layer<
  ToolObservationEvidenceStore,
  never,
  SqlClient
> = Layer.effect(
  ToolObservationEvidenceStore,
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    const failure = repositoryFailure(
      "ToolObservationEvidenceStore",
      "tool-observation-evidence",
    );
    const run = <A>(effect: Effect.Effect<A, SqlError>) =>
      effect.pipe(Effect.mapError(failure));

    const checkFence = (
      executionId: ExecutionId,
      executionFence: ToolExecutionContext["executionFence"],
      fenceNow: string,
    ) =>
      Effect.gen(function* () {
        if (executionFence === undefined) {
          return yield* Effect.fail<ToolObservationEvidenceStoreError>(
            persistenceCorruption(
              "ToolObservationEvidenceStore",
              "lease-fence",
              "P40 observation reads and settlements require a complete P2 lease fence",
            ),
          );
        }
        if (executionFence.executionId !== executionId) {
          return yield* Effect.fail<ToolObservationEvidenceStoreError>({
            _tag: "LeaseFencingRejected",
            executionId: executionFence.executionId,
            generation: executionFence.fencingGeneration,
          });
        }
        const rows = yield* run(
          sql.unsafe<{ readonly ok: number }>(
            `SELECT 1 AS ok
               FROM executions e
               JOIN execution_leases l ON l.execution_id = e.execution_id
              WHERE e.execution_id = ?
                AND e.settled_at IS NULL
                AND l.worker_id = ?
                AND l.worker_incarnation_id = ?
                AND l.generation = ?
                AND l.expires_at > ?`,
            [
              executionId,
              executionFence.workerId,
              executionFence.workerIncarnationId,
              executionFence.fencingGeneration,
              fenceNow,
            ],
          ),
        );
        if (rows.length === 0) {
          return yield* Effect.fail<ToolObservationEvidenceStoreError>({
            _tag: "LeaseFencingRejected",
            executionId: executionFence.executionId,
            generation: executionFence.fencingGeneration,
          } as ToolObservationEvidenceStoreError);
        }
      });

    const readRow = (
      invocationId: ToolInvocationId,
      executionId: ExecutionId,
    ) =>
      run(
        sql.unsafe<EvidenceInvocationRow>(
          `SELECT invocation_id, execution_id, workspace_id, tool_name,
                  tool_version, side_effect_semantics, arguments_json,
                  resolved_regions_json, approval_id, effect_admission_state,
                  intent_at, settled_at, settlement_kind, settlement_json,
                  result_ref, observation_format_version, observation_json,
                  observation_sha256, settlement_provenance,
                  recovery_binding_state, recovery_binding_sha256,
                  selected_attempt_no, selected_fact_id
             FROM tool_invocations
            WHERE invocation_id = ? AND execution_id = ?`,
          [invocationId, executionId],
        ),
      );

    const validateArtifactRef = (
      invocationId: ToolInvocationId,
      resultRef: string | null,
    ) =>
      Effect.gen(function* () {
        if (resultRef === null) return;
        const rows = yield* run(
          sql.unsafe<{ readonly artifact_id: string }>(
            "SELECT artifact_id FROM artifacts WHERE artifact_id = ?",
            [resultRef],
          ),
        );
        if (rows[0]?.artifact_id !== resultRef) {
          return yield* Effect.fail<ToolObservationEvidenceStoreError>(
            replayFailure(invocationId, "ResultRefMismatch"),
          );
        }
      });

    const verifyReconciledNoEffect = (
      row: EvidenceInvocationRow,
      evidence: ToolObservationEvidence,
    ) =>
      Effect.gen(function* () {
        if (evidence.observation._tag !== "ReconciledNoEffect") return;
        const selectedFactId = evidence.observation.reconciliationFactRef;
        if (
          row.settlement_provenance !== "Reconciliation" ||
          row.effect_admission_state !== "MayHaveStarted" ||
          row.recovery_binding_state !== "Bound" ||
          row.recovery_binding_sha256 === null ||
          row.selected_attempt_no === null ||
          row.selected_fact_id !== selectedFactId ||
          row.result_ref === null
        ) {
          return yield* Effect.fail<ToolObservationEvidenceStoreError>(
            replayFailure(
              row.invocation_id as ToolInvocationId,
              "SettlementMismatch",
            ),
          );
        }
        const facts = yield* run(
          sql.unsafe<{ readonly fact_id: string }>(
            `SELECT f.fact_id
               FROM tool_reconciliation_facts AS f
               JOIN tool_invocation_effect_attempts AS a
                 ON a.invocation_id = f.invocation_id
                AND a.attempt_no = f.attempt_no
               JOIN tool_invocation_recovery_bindings AS b
                 ON b.invocation_id = f.invocation_id
                AND b.binding_sha256 = f.binding_sha256
               JOIN artifacts AS evidence
                 ON evidence.artifact_id = f.evidence_ref
              WHERE f.fact_id = ?
                AND f.invocation_id = ?
                AND f.attempt_no = ?
                AND f.fact_origin = 'ProfileReconciliation'
                AND f.fact_disposition = 'RecoveryInput'
                AND f.binding_sha256 = ?
                AND f.profile_hash = a.profile_hash
                AND f.effect_key = a.effect_key
                AND a.binding_sha256 = f.binding_sha256
                AND a.admission_state = 'MayHaveStarted'
                AND f.outcome = 'NotOccurred'
                AND f.reason_code IS NULL
                AND f.evidence_sha256 IS NOT NULL
                AND length(f.evidence_sha256) = 64
                AND f.evidence_sha256 NOT GLOB '*[^0-9a-f]*'
                AND evidence.content_hash = f.evidence_sha256
                AND f.result_ref IS NULL`,
            [
              selectedFactId,
              row.invocation_id,
              row.selected_attempt_no,
              row.recovery_binding_sha256,
            ],
          ),
        );
        if (facts.length === 0) {
          return yield* Effect.fail<ToolObservationEvidenceStoreError>(
            replayFailure(
              row.invocation_id as ToolInvocationId,
              "SettlementMismatch",
            ),
          );
        }
      });

    const verifyEffectAdmissionAndProvenance = (
      row: EvidenceInvocationRow,
      observation: ToolObservationEvidence["observation"],
      terminal: boolean,
    ): Effect.Effect<
      "Ordinary" | "Reconciliation",
      ToolObservationEvidenceStoreError
    > =>
      Effect.gen(function* () {
        if (observation._tag === "ReconciledNoEffect") {
          const validSelectedBinding =
            row.effect_admission_state === "MayHaveStarted" &&
            row.recovery_binding_state === "Bound" &&
            row.recovery_binding_sha256 !== null &&
            row.selected_attempt_no !== null &&
            row.selected_fact_id === observation.reconciliationFactRef;
          if (
            !validSelectedBinding ||
            row.settlement_provenance !== (terminal ? "Reconciliation" : null)
          ) {
            return yield* Effect.fail<ToolObservationEvidenceStoreError>(
              replayFailure(
                row.invocation_id as ToolInvocationId,
                "SettlementMismatch",
              ),
            );
          }
          if (terminal) {
            yield* verifyReconciledNoEffect(row, {
              formatVersion: P4_TOOL_OBSERVATION_FORMAT_V1,
              bytes: row.observation_json ?? new Uint8Array(),
              sha256: row.observation_sha256 ?? "",
              observation,
            });
          }
          return "Reconciliation" as const;
        }
        const effectMayHaveStarted =
          row.effect_admission_state === "MayHaveStarted";
        const noEffectInterruption =
          observation._tag === "Interrupted" &&
          row.effect_admission_state === "NotAdmitted";
        const hasAttempt = row.selected_attempt_no !== null;
        const hasFact = row.selected_fact_id !== null;
        const noSelectedFact = !hasAttempt && !hasFact;
        const completeSelectedFact = hasAttempt && hasFact;
        const permitsOccurredRecovery =
          observation._tag === "Success" ||
          observation._tag === "ExpectedFailure";
        const hasReconciliationBinding =
          permitsOccurredRecovery &&
          completeSelectedFact &&
          row.recovery_binding_state === "Bound" &&
          row.recovery_binding_sha256 !== null;
        const inferredProvenance = hasReconciliationBinding
          ? "Reconciliation"
          : "Ordinary";
        if (
          (!effectMayHaveStarted && !noEffectInterruption) ||
          (!noSelectedFact && !hasReconciliationBinding) ||
          row.settlement_provenance !== (terminal ? inferredProvenance : null)
        ) {
          return yield* Effect.fail<ToolObservationEvidenceStoreError>(
            replayFailure(
              row.invocation_id as ToolInvocationId,
              "SettlementMismatch",
            ),
          );
        }
        return inferredProvenance;
      });

    const decodeRow = (row: EvidenceInvocationRow) => {
      const settlement = settlementFromRow(row);
      const decoded = decodeToolObservationEvidence({
        formatVersion: row.observation_format_version,
        bytes: row.observation_json,
        sha256: row.observation_sha256,
        settlement,
        resultRef: row.result_ref,
      });
      if (decoded._tag === "Failure") {
        return Effect.fail<ToolObservationEvidenceStoreError>(
          replayFailure(
            row.invocation_id as ToolInvocationId,
            decoded.failureCode,
          ),
        );
      }
      return Effect.gen(function* () {
        yield* validateArtifactRef(
          row.invocation_id as ToolInvocationId,
          row.result_ref,
        );
        yield* verifyEffectAdmissionAndProvenance(
          row,
          decoded.evidence.observation,
          true,
        );
        return decoded.evidence;
      });
    };

    const validateIntent = (
      row: EvidenceInvocationRow | undefined,
      intent: ToolInvocationIntent,
    ) => {
      if (row === undefined) {
        return Effect.fail<ToolObservationEvidenceStoreError>(
          replayFailure(intent.invocationId, "Missing"),
        );
      }
      if (!sameIntent(row, intent)) {
        return Effect.fail<ToolObservationEvidenceStoreError>(
          replayFailure(intent.invocationId, "IntentMismatch"),
        );
      }
      return Effect.succeed(row);
    };

    const service: ToolObservationEvidenceStoreService = {
      assertCurrentFence: (executionFence, fenceNow) =>
        Effect.gen(function* () {
          yield* TransactionScope;
          yield* checkFence(
            executionFence.executionId,
            executionFence,
            fenceNow,
          );
        }),
      settleOrReadWinner: (candidate: ToolObservationEvidenceCandidate) =>
        Effect.gen(function* () {
          yield* TransactionScope;
          const invocationId = candidate.invocation.invocationId;
          const fence = candidate.executionFence;
          yield* checkFence(
            candidate.invocation.executionId,
            fence,
            candidate.fenceNow ?? candidate.settledAt,
          );
          const rows = yield* readRow(
            invocationId,
            candidate.invocation.executionId,
          );
          const row = yield* validateIntent(rows[0], candidate.invocation);
          if (row.settled_at !== null) {
            const evidence = yield* decodeRow(row);
            return { _tag: "Existing" as const, evidence };
          }
          const isReconciledNoEffect =
            candidate.observation._tag === "ReconciledNoEffect";
          const selection = candidate.reconciliationSelection;
          const authenticatedEvidence = candidate.authenticatedRecoveryEvidence;
          const hasPartialExistingSelection =
            (row.selected_attempt_no === null) !==
            (row.selected_fact_id === null);
          if (
            hasPartialExistingSelection ||
            (isReconciledNoEffect &&
              (selection === undefined ||
                selection.factId !==
                  candidate.observation.reconciliationFactRef ||
                (row.selected_attempt_no !== null &&
                  row.selected_attempt_no !== selection.attemptNo) ||
                (row.selected_fact_id !== null &&
                  row.selected_fact_id !== selection.factId))) ||
            (isReconciledNoEffect &&
              authenticatedEvidence !== undefined &&
              (selection === undefined ||
                authenticatedEvidence.binding.value.invocationId !==
                  invocationId ||
                authenticatedEvidence.binding.bindingSha256 !==
                  row.recovery_binding_sha256 ||
                authenticatedEvidence.attempt.invocationId !== invocationId ||
                authenticatedEvidence.fact.invocationId !== invocationId ||
                authenticatedEvidence.attempt.attemptNo !==
                  selection.attemptNo ||
                authenticatedEvidence.fact.attemptNo !== selection.attemptNo ||
                authenticatedEvidence.fact.factId !== selection.factId ||
                authenticatedEvidence.fact.outcome !== "NotOccurred" ||
                authenticatedEvidence.fact.factDisposition !==
                  "RecoveryInput")) ||
            (isReconciledNoEffect && authenticatedEvidence === undefined) ||
            (!isReconciledNoEffect && authenticatedEvidence !== undefined) ||
            (!isReconciledNoEffect && selection !== undefined)
          ) {
            return yield* Effect.fail<ToolObservationEvidenceStoreError>(
              replayFailure(invocationId, "SettlementMismatch"),
            );
          }
          const candidateRow =
            isReconciledNoEffect && selection !== undefined
              ? {
                  ...row,
                  selected_attempt_no: selection.attemptNo,
                  selected_fact_id: selection.factId,
                }
              : row;
          const boundedObservationText =
            candidate.observation._tag === "Success" ||
            candidate.observation._tag === "ExpectedFailure" ||
            candidate.observation._tag === "ReconciledNoEffect"
              ? candidate.observation.observation.text
              : undefined;
          if (
            boundedObservationText !== undefined &&
            boundedObservationText.length >
              P4_TOOL_OBSERVATION_MAX_TEXT_UTF16_CODE_UNITS
          ) {
            return yield* Effect.fail<ToolObservationEvidenceStoreError>(
              replayFailure(invocationId, "Malformed"),
            );
          }
          const settlementProvenance =
            yield* verifyEffectAdmissionAndProvenance(
              candidateRow,
              candidate.observation,
              false,
            );
          let resultRef = candidate.resultRef;
          let observation = candidate.observation;
          if (
            (candidate.settlement._tag === "Success" ||
              candidate.settlement._tag === "ReconciledNoEffect") &&
            resultRef === null &&
            candidate.materializeResultRef !== undefined
          ) {
            resultRef = yield* candidate.materializeResultRef();
            if (
              observation._tag === "Success" ||
              observation._tag === "ReconciledNoEffect"
            ) {
              observation = { ...observation, resultRef };
            }
          }
          const encoded = encodeToolObservationEvidence({
            observation,
            settlement: candidate.settlement,
            resultRef,
          });
          if (encoded._tag === "Failure") {
            return yield* Effect.fail<ToolObservationEvidenceStoreError>(
              replayFailure(invocationId, encoded.failureCode),
            );
          }
          yield* validateArtifactRef(invocationId, resultRef);
          if (observation._tag === "ReconciledNoEffect") {
            yield* verifyReconciledNoEffect(
              {
                ...candidateRow,
                result_ref: resultRef,
                settlement_provenance: "Reconciliation",
              },
              encoded.evidence,
            );
          }
          const updated = yield* run(
            sql.unsafe<{ readonly invocation_id: string }>(
              `UPDATE tool_invocations
                  SET settled_at = ?, settlement_kind = ?, settlement_json = ?,
                      result_ref = ?, observation_format_version = ?,
                      observation_json = ?, observation_sha256 = ?,
                      settlement_provenance = ?, selected_attempt_no = ?,
                      selected_fact_id = ?
                WHERE invocation_id = ? AND execution_id = ? AND settled_at IS NULL
                RETURNING invocation_id`,
              [
                candidate.settledAt,
                candidate.settlement._tag,
                JSON.stringify(candidate.settlement),
                resultRef,
                P4_TOOL_OBSERVATION_FORMAT_V1,
                encoded.evidence.bytes,
                encoded.evidence.sha256,
                settlementProvenance,
                candidateRow.selected_attempt_no,
                candidateRow.selected_fact_id,
                invocationId,
                candidate.invocation.executionId,
              ],
            ),
          );
          if (updated.length > 0) {
            return { _tag: "Applied" as const, evidence: encoded.evidence };
          }
          // The CAS loser must never return its local candidate. Re-read the
          // immutable P4 winner under the same fence and validate its bytes.
          yield* checkFence(
            candidate.invocation.executionId,
            fence,
            candidate.fenceNow ?? candidate.settledAt,
          );
          const winnerRows = yield* readRow(
            invocationId,
            candidate.invocation.executionId,
          );
          const winner = yield* validateIntent(
            winnerRows[0],
            candidate.invocation,
          );
          if (winner.settled_at === null) {
            return yield* Effect.fail(
              persistenceCorruption(
                "ToolObservationEvidenceStore",
                "settle-or-read-winner",
                "observation settlement compare-and-set did not apply and no winner exists",
              ),
            );
          }
          return {
            _tag: "Existing" as const,
            evidence: yield* decodeRow(winner),
          };
        }),
      read: (invocation, executionFence, fenceNow) =>
        Effect.gen(function* () {
          yield* TransactionScope;
          yield* checkFence(invocation.executionId, executionFence, fenceNow);
          const rows = yield* readRow(
            invocation.invocationId,
            invocation.executionId,
          );
          const row = yield* validateIntent(rows[0], invocation);
          if (row.settled_at === null) {
            return yield* Effect.fail<ToolObservationEvidenceStoreError>(
              replayFailure(invocation.invocationId, "Missing"),
            );
          }
          return yield* decodeRow(row);
        }),
    };
    return ToolObservationEvidenceStore.of(service);
  }),
);
