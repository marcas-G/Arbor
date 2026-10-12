import type { ToolInvocationId } from "@arbor/domain";
import {
  Option,
  P39RecoveryEvidenceStore,
  TransactionScope,
  verifyRecoveryBindingV1,
} from "@arbor/ports";
import { Effect, Layer } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";
import { persistenceCorruption, repositoryFailure } from "./repository-error.js";

interface SelectedRecoveryRow {
  readonly recovery_binding_state: string;
  readonly recovery_binding_sha256: string | null;
  readonly settlement_provenance: string | null;
  readonly selected_attempt_no: number | null;
  readonly selected_fact_id: string | null;
  readonly binding_version: number | null;
  readonly canonical_binding_json: string | null;
  readonly stored_binding_sha256: string | null;
  readonly attempt_no: number | null;
  readonly admission_state: string | null;
  readonly attempt_binding_sha256: string | null;
  readonly tool_definition_hash: string | null;
  readonly side_effect_semantics: string | null;
  readonly profile_id: string | null;
  readonly profile_version: string | null;
  readonly profile_hash: string | null;
  readonly profile_protocol: string | null;
  readonly effect_key: string | null;
  readonly admitted_at: string | null;
  readonly admission_source: string | null;
  readonly admission_time_precision: string | null;
  readonly fact_id: string | null;
  readonly fact_invocation_id: string | null;
  readonly fact_attempt_no: number | null;
  readonly fact_binding_sha256: string | null;
  readonly fact_profile_hash: string | null;
  readonly fact_effect_key: string | null;
  readonly fact_origin: string | null;
  readonly legacy_reason: string | null;
  readonly fact_disposition: string | null;
  readonly outcome: string | null;
  readonly reason_code: string | null;
  readonly evidence_ref: string | null;
  readonly evidence_sha256: string | null;
  readonly result_ref: string | null;
  readonly observed_at: string | null;
}

const isAdmissionSource = (
  value: string | null,
): value is "P36Backfill" | "P39Claim" | "P39Admission" =>
  value === "P36Backfill" ||
  value === "P39Claim" ||
  value === "P39Admission";

const isAdmissionTimePrecision = (
  value: string | null,
): value is "NotAdmitted" | "TransactionTimestamp" | "UnknownLegacy" =>
  value === "NotAdmitted" ||
  value === "TransactionTimestamp" ||
  value === "UnknownLegacy";

const isSideEffectSemantics = (
  value: string | null,
): value is "ReadOnly" | "Idempotent" | "Reconcilable" | "NonIdempotent" =>
  value === "ReadOnly" ||
  value === "Idempotent" ||
  value === "Reconcilable" ||
  value === "NonIdempotent";

const isOutcome = (
  value: string | null,
): value is "NotOccurred" | "Occurred" | "StillUnknown" =>
  value === "NotOccurred" ||
  value === "Occurred" ||
  value === "StillUnknown";

export const P39RecoveryEvidenceStoreLive: Layer.Layer<
  P39RecoveryEvidenceStore,
  never,
  SqlClient
> = Layer.effect(
  P39RecoveryEvidenceStore,
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    const failure = repositoryFailure(
      "P39RecoveryEvidenceStore",
      "find-selected",
    );
    const run = <A>(effect: Effect.Effect<A, SqlError>) =>
      effect.pipe(Effect.mapError(failure));

    const corrupt = (reason: string) =>
      Effect.fail(
        persistenceCorruption(
          "P39RecoveryEvidenceStore",
          "find-selected",
          reason,
        ),
      );

    return P39RecoveryEvidenceStore.of({
      findSelected: (invocationId) =>
        Effect.gen(function* () {
          yield* TransactionScope;
          const rows = yield* run(
            sql.unsafe<SelectedRecoveryRow>(
              `SELECT
                 i.recovery_binding_state,
                 i.recovery_binding_sha256,
                 i.settlement_provenance,
                 i.selected_attempt_no,
                 i.selected_fact_id,
                 b.binding_version,
                 b.canonical_binding_json,
                 b.binding_sha256 AS stored_binding_sha256,
                 a.attempt_no,
                 a.admission_state,
                 a.binding_sha256 AS attempt_binding_sha256,
                 a.tool_definition_hash,
                 a.side_effect_semantics,
                 a.profile_id,
                 a.profile_version,
                 a.profile_hash,
                 a.profile_protocol,
                 a.effect_key,
                 a.admitted_at,
                 a.admission_source,
                 a.admission_time_precision,
                 f.fact_id,
                 f.invocation_id AS fact_invocation_id,
                 f.attempt_no AS fact_attempt_no,
                 f.binding_sha256 AS fact_binding_sha256,
                 f.profile_hash AS fact_profile_hash,
                 f.effect_key AS fact_effect_key,
                 f.fact_origin,
                 f.legacy_reason,
                 f.fact_disposition,
                 f.outcome,
                 f.reason_code,
                 f.evidence_ref,
                 f.evidence_sha256,
                 f.result_ref,
                 f.observed_at
               FROM tool_invocations AS i
               LEFT JOIN tool_invocation_recovery_bindings AS b
                 ON b.invocation_id = i.invocation_id
                AND b.binding_sha256 = i.recovery_binding_sha256
               LEFT JOIN tool_invocation_effect_attempts AS a
                 ON a.invocation_id = i.invocation_id
                AND a.attempt_no = i.selected_attempt_no
               LEFT JOIN tool_reconciliation_facts AS f
                 ON f.invocation_id = i.invocation_id
                AND f.attempt_no = i.selected_attempt_no
                AND f.fact_id = i.selected_fact_id
               WHERE i.invocation_id = ?`,
              [invocationId],
            ),
          );
          const row = rows[0];
          if (row === undefined) return Option.none();
          if (row.selected_attempt_no === null && row.selected_fact_id === null) {
            return Option.none();
          }
          if (
            row.selected_attempt_no === null ||
            row.selected_fact_id === null ||
            row.recovery_binding_state !== "Bound" ||
            row.settlement_provenance !== "Reconciliation" ||
            row.recovery_binding_sha256 === null ||
            row.binding_version !== 1 ||
            row.canonical_binding_json === null ||
            (row.selected_attempt_no !== 0 && row.selected_attempt_no !== 1) ||
            row.stored_binding_sha256 !== row.recovery_binding_sha256 ||
            row.attempt_no !== row.selected_attempt_no ||
            row.admission_state !== "MayHaveStarted" ||
            row.attempt_binding_sha256 !== row.recovery_binding_sha256 ||
            row.tool_definition_hash === null ||
            !isSideEffectSemantics(row.side_effect_semantics) ||
            row.profile_id === null ||
            row.profile_version === null ||
            row.profile_hash === null ||
            row.profile_protocol === null ||
            row.effect_key === null ||
            row.admitted_at === null ||
            row.admission_source !== "P39Admission" ||
            row.admission_time_precision !== "TransactionTimestamp" ||
            row.fact_id !== row.selected_fact_id ||
            row.fact_invocation_id !== invocationId ||
            row.fact_attempt_no !== row.selected_attempt_no ||
            row.fact_binding_sha256 !== row.recovery_binding_sha256 ||
            row.fact_profile_hash !== row.profile_hash ||
            row.fact_effect_key !== row.effect_key ||
            row.fact_origin !== "ProfileReconciliation" ||
            row.legacy_reason !== null ||
            row.fact_disposition !== "RecoveryInput" ||
            !isOutcome(row.outcome) ||
            row.observed_at === null ||
            !isAdmissionSource(row.admission_source) ||
            !isAdmissionTimePrecision(row.admission_time_precision)
          ) {
            return yield* corrupt(
              "selected invocation, binding, effect attempt, and fact do not form one exact P39 tuple",
            );
          }

          const binding = verifyRecoveryBindingV1({
            invocationId,
            canonicalJson: row.canonical_binding_json,
            bindingSha256: row.recovery_binding_sha256,
          });
          if (
            binding === null ||
            binding.value.profileId !== row.profile_id ||
            binding.value.profileVersion !== row.profile_version ||
            binding.value.profileHash !== row.profile_hash ||
            binding.value.profileProtocol !== row.profile_protocol ||
            binding.value.effectKey !== row.effect_key ||
            binding.value.toolDefinitionHash !== row.tool_definition_hash ||
            binding.value.sideEffectSemantics !== row.side_effect_semantics
          ) {
            return yield* corrupt(
              "selected P39 evidence has an invalid or inconsistent RecoveryBindingV1",
            );
          }

          return Option.some({
            binding,
            attempt: {
              invocationId,
              attemptNo: row.attempt_no as 0 | 1,
              admissionState: "MayHaveStarted" as const,
              bindingSha256: row.attempt_binding_sha256,
              toolDefinitionHash: row.tool_definition_hash,
              sideEffectSemantics: row.side_effect_semantics,
              profileId: row.profile_id,
              profileVersion: row.profile_version,
              profileHash: row.profile_hash,
              profileProtocol: row.profile_protocol,
              effectKey: row.effect_key,
              admittedAt: row.admitted_at,
              admissionSource: "P39Admission" as const,
              admissionTimePrecision: "TransactionTimestamp" as const,
            },
            fact: {
              factId: row.fact_id as string,
              invocationId,
              attemptNo: row.fact_attempt_no as 0 | 1,
              bindingSha256: row.fact_binding_sha256,
              profileHash: row.fact_profile_hash,
              effectKey: row.fact_effect_key,
              factOrigin: "ProfileReconciliation" as const,
              legacyReason: null,
              factDisposition: "RecoveryInput" as const,
              outcome: row.outcome as
                | "NotOccurred"
                | "Occurred"
                | "StillUnknown",
              reasonCode: row.reason_code,
              evidenceRef: row.evidence_ref,
              evidenceSha256: row.evidence_sha256,
              resultRef: row.result_ref,
              observedAt: row.observed_at as string,
            },
          });
        }),
    });
  }),
);
