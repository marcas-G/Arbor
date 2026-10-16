import type { ToolInvocationId } from "@arbor/domain";
import {
  canonicalizeRecoveryBindingV1,
  P39RecoveryEvidenceStore,
  type RecoveryBindingV1,
  recoveryBindingV1Digest,
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
  value === "P36Backfill" || value === "P39Claim" || value === "P39Admission";

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
  value === "NotOccurred" || value === "Occurred" || value === "StillUnknown";

interface BindingRow {
  readonly recovery_binding_state: string;
  readonly recovery_binding_sha256: string | null;
  readonly effect_admission_state: string;
  readonly settled_at: string | null;
  readonly binding_version: number | null;
  readonly canonical_binding_json: string | null;
  readonly binding_sha256: string | null;
}

interface DeniedUnboundRow {
  readonly recovery_binding_state: string;
  readonly recovery_binding_sha256: string | null;
  readonly effect_admission_state: string;
  readonly settlement_provenance: string | null;
  readonly settled_at: string | null;
  readonly settlement_kind: string | null;
  readonly result_ref: string | null;
  readonly selected_attempt_no: number | null;
  readonly selected_fact_id: string | null;
  readonly binding_invocation_id: string | null;
}

export type P39RecoveryBindingClaimBranch =
  | "CreatedAtEmpty"
  | "CanonicalizationFailed"
  | "ExistingBindingRowInvalid"
  | "ExistingBindingConflict"
  | "ExistingAttempt0Mismatch"
  | "InvocationMissingOrIneligible"
  | "Attempt0AlreadyExists"
  | "BoundTransitionMismatch";

interface P39RecoveryBindingClaimProbeIdentity {
  readonly executionId: string;
  readonly invocationId: string;
  readonly providerTurnId: string;
  readonly logicalStepNo: number;
  readonly repairAttempt: number;
  readonly logicalActionId: string;
  readonly actionIndex: number;
  readonly callRef: string;
  readonly toolName: string;
  readonly toolVersion: string;
  readonly approvalId: string | null;
}

export type P39RecoveryBindingQualificationProbe = (
  event:
    | (P39RecoveryBindingClaimProbeIdentity & {
        readonly boundary: "P4P39BindClaimBranch";
        readonly branch: P39RecoveryBindingClaimBranch;
      })
    | (P39RecoveryBindingClaimProbeIdentity & {
        readonly boundary: "P4P39ClaimBeforeCommit";
      }),
) => Promise<void>;

export const makeP39RecoveryEvidenceStoreLive = (
  qualificationProbe?: P39RecoveryBindingQualificationProbe,
): Layer.Layer<P39RecoveryEvidenceStore, never, SqlClient> =>
  Layer.effect(
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

      const corruptClaim = (
        binding: RecoveryBindingV1,
        branch: P39RecoveryBindingClaimBranch,
        reason: string,
      ) =>
        Effect.gen(function* () {
          if (qualificationProbe !== undefined) {
            yield* Effect.promise(() =>
              qualificationProbe({
                boundary: "P4P39BindClaimBranch",
                branch,
                executionId: binding.executionId,
                invocationId: binding.invocationId,
                providerTurnId: binding.providerTurnId,
                logicalStepNo: binding.logicalStepNo,
                repairAttempt: binding.repairAttempt,
                logicalActionId: binding.logicalActionId,
                actionIndex: binding.actionIndex,
                callRef: binding.callRef,
                toolName: binding.toolName,
                toolVersion: binding.toolVersion,
                approvalId: binding.approvalId,
              }),
            );
          }
          return yield* corrupt(reason);
        });

      const findBinding = (
        invocationId: ToolInvocationId,
        claimBinding?: RecoveryBindingV1,
      ) =>
        Effect.gen(function* () {
          yield* TransactionScope;
          const rows = yield* run(
            sql.unsafe<BindingRow>(
              `SELECT i.recovery_binding_state,
                    i.recovery_binding_sha256,
                    i.effect_admission_state,
                    i.settled_at,
                    b.binding_version,
                    b.canonical_binding_json,
                    b.binding_sha256
               FROM tool_invocations AS i
               LEFT JOIN tool_invocation_recovery_bindings AS b
                 ON b.invocation_id = i.invocation_id
              WHERE i.invocation_id = ?`,
              [invocationId],
            ),
          );
          const row = rows[0];
          if (row === undefined) return Option.none();
          if (
            row.recovery_binding_state !== "Bound" ||
            row.recovery_binding_sha256 === null ||
            row.binding_version !== 1 ||
            row.canonical_binding_json === null ||
            row.binding_sha256 !== row.recovery_binding_sha256
          ) {
            if (
              row.recovery_binding_state === "LegacyBindingUnproven" &&
              row.recovery_binding_sha256 === null &&
              row.binding_version === null &&
              row.canonical_binding_json === null &&
              row.binding_sha256 === null
            ) {
              return Option.none();
            }
            if (
              row.recovery_binding_state === "DeniedUnbound" &&
              row.recovery_binding_sha256 === null &&
              row.effect_admission_state === "NotAdmitted" &&
              row.settled_at !== null &&
              row.binding_version === null &&
              row.canonical_binding_json === null &&
              row.binding_sha256 === null
            ) {
              return Option.none();
            }
            const reason =
              "invocation recovery-binding state does not match its immutable V1 row";
            return yield* claimBinding === undefined
              ? corrupt(reason)
              : corruptClaim(claimBinding, "ExistingBindingRowInvalid", reason);
          }
          const verified = verifyRecoveryBindingV1({
            invocationId,
            canonicalJson: row.canonical_binding_json,
            bindingSha256: row.binding_sha256,
          });
          if (verified === null) {
            const reason =
              "persisted RecoveryBindingV1 canonical bytes or SHA-256 are invalid";
            return yield* claimBinding === undefined
              ? corrupt(reason)
              : corruptClaim(claimBinding, "ExistingBindingRowInvalid", reason);
          }
          return Option.some(verified);
        });

      const findTerminalUnboundDenial = (invocationId: ToolInvocationId) =>
        Effect.gen(function* () {
          yield* TransactionScope;
          const rows = yield* sql
            .unsafe<DeniedUnboundRow>(
              `SELECT i.recovery_binding_state,
                    i.recovery_binding_sha256,
                    i.effect_admission_state,
                    i.settlement_provenance,
                    i.settled_at,
                    i.settlement_kind,
                    i.result_ref,
                    i.selected_attempt_no,
                    i.selected_fact_id,
                    b.invocation_id AS binding_invocation_id
               FROM tool_invocations AS i
               LEFT JOIN tool_invocation_recovery_bindings AS b
                 ON b.invocation_id = i.invocation_id
              WHERE i.invocation_id = ?`,
              [invocationId],
            )
            .pipe(
              Effect.mapError(
                repositoryFailure(
                  "P39RecoveryEvidenceStore",
                  "find-terminal-unbound-denial",
                ),
              ),
            );
          const row = rows[0];
          if (
            row === undefined ||
            row.recovery_binding_state !== "DeniedUnbound"
          ) {
            return Option.none();
          }
          if (
            row.recovery_binding_sha256 !== null ||
            row.effect_admission_state !== "NotAdmitted" ||
            row.settlement_provenance !== "Ordinary" ||
            row.settled_at === null ||
            row.settlement_kind !== "Denied" ||
            row.result_ref !== null ||
            row.selected_attempt_no !== null ||
            row.selected_fact_id !== null ||
            row.binding_invocation_id !== null
          ) {
            return yield* Effect.fail(
              persistenceCorruption(
                "P39RecoveryEvidenceStore",
                "find-terminal-unbound-denial",
                "DeniedUnbound row has binding, reconciliation, or settlement fields outside its closed shape",
              ),
            );
          }
          return Option.some({
            invocationId,
            recoveryBindingState: "DeniedUnbound" as const,
          });
        });

      return P39RecoveryEvidenceStore.of({
        bindClaim: (input: { binding: RecoveryBindingV1; createdAt: string }) =>
          Effect.gen(function* () {
            yield* TransactionScope;
            if (!input.createdAt.trim()) {
              return yield* corruptClaim(
                input.binding,
                "CreatedAtEmpty",
                "RecoveryBindingV1 createdAt is empty",
              );
            }
            let canonicalJson: string;
            let bindingSha256: string;
            try {
              canonicalJson = canonicalizeRecoveryBindingV1(input.binding);
              bindingSha256 = recoveryBindingV1Digest(input.binding);
            } catch (cause) {
              return yield* corruptClaim(
                input.binding,
                "CanonicalizationFailed",
                `RecoveryBindingV1 schema or digest construction failed: ${String(cause)}`,
              );
            }
            const existing = yield* findBinding(
              input.binding.invocationId,
              input.binding,
            );
            if (Option.isSome(existing)) {
              if (
                existing.value.canonicalJson !== canonicalJson ||
                existing.value.bindingSha256 !== bindingSha256
              ) {
                return yield* corruptClaim(
                  input.binding,
                  "ExistingBindingConflict",
                  "same invocation already has a different immutable RecoveryBindingV1",
                );
              }
              const attempts = yield* run(
                sql.unsafe<{
                  readonly admission_state: string;
                  readonly admission_source: string;
                  readonly admission_time_precision: string;
                  readonly binding_sha256: string | null;
                }>(
                  `SELECT admission_state, admission_source,
                        admission_time_precision, binding_sha256
                   FROM tool_invocation_effect_attempts
                  WHERE invocation_id = ? AND attempt_no = 0`,
                  [input.binding.invocationId],
                ),
              );
              const attempt0 = attempts[0];
              if (
                attempt0?.admission_state !== "NotAdmitted" ||
                attempt0.admission_source !== "P39Claim" ||
                attempt0.admission_time_precision !== "NotAdmitted" ||
                attempt0.binding_sha256 !== bindingSha256
              ) {
                return yield* corruptClaim(
                  input.binding,
                  "ExistingAttempt0Mismatch",
                  "bound invocation is missing its exact attempt-0 claim row",
                );
              }
              return "AlreadyBound" as const;
            }

            const invocations = yield* run(
              sql.unsafe<{
                readonly recovery_binding_state: string;
                readonly recovery_binding_sha256: string | null;
                readonly effect_admission_state: string;
                readonly settled_at: string | null;
                readonly tool_name: string;
                readonly tool_version: string;
                readonly side_effect_semantics: string;
              }>(
                `SELECT recovery_binding_state, recovery_binding_sha256,
                      effect_admission_state, settled_at, tool_name,
                      tool_version, side_effect_semantics
                 FROM tool_invocations WHERE invocation_id = ?`,
                [input.binding.invocationId],
              ),
            );
            const invocation = invocations[0];
            if (
              invocation === undefined ||
              invocation.recovery_binding_state !== "LegacyBindingUnproven" ||
              invocation.recovery_binding_sha256 !== null ||
              invocation.effect_admission_state !== "NotAdmitted" ||
              invocation.settled_at !== null ||
              invocation.tool_name !== input.binding.toolName ||
              invocation.tool_version !== input.binding.toolVersion ||
              invocation.side_effect_semantics !==
                input.binding.sideEffectSemantics
            ) {
              return yield* corruptClaim(
                input.binding,
                "InvocationMissingOrIneligible",
                "new RecoveryBindingV1 claim does not match an active NotAdmitted invocation",
              );
            }

            const priorAttempts = yield* run(
              sql.unsafe<{ readonly invocation_id: string }>(
                `SELECT invocation_id FROM tool_invocation_effect_attempts
                WHERE invocation_id = ? AND attempt_no = 0`,
                [input.binding.invocationId],
              ),
            );
            if (priorAttempts.length > 0) {
              return yield* corruptClaim(
                input.binding,
                "Attempt0AlreadyExists",
                "unbound invocation already has an attempt-0 row",
              );
            }

            yield* run(
              sql.unsafe(
                `INSERT INTO tool_invocation_recovery_bindings (
                 invocation_id, binding_version, canonical_binding_json,
                 binding_sha256, created_at
               ) VALUES (?,1,?,?,?)`,
                [
                  input.binding.invocationId,
                  canonicalJson,
                  bindingSha256,
                  input.createdAt,
                ],
              ),
            );
            yield* run(
              sql.unsafe(
                `UPDATE tool_invocations
                  SET recovery_binding_state = 'Bound',
                      recovery_binding_sha256 = ?
                WHERE invocation_id = ?
                  AND recovery_binding_state = 'LegacyBindingUnproven'
                  AND recovery_binding_sha256 IS NULL
                  AND effect_admission_state = 'NotAdmitted'
                  AND settled_at IS NULL`,
                [bindingSha256, input.binding.invocationId],
              ),
            );
            const boundRows = yield* run(
              sql.unsafe<{
                readonly recovery_binding_state: string;
                readonly recovery_binding_sha256: string | null;
              }>(
                `SELECT recovery_binding_state, recovery_binding_sha256
                 FROM tool_invocations WHERE invocation_id = ?`,
                [input.binding.invocationId],
              ),
            );
            if (
              boundRows[0]?.recovery_binding_state !== "Bound" ||
              boundRows[0]?.recovery_binding_sha256 !== bindingSha256
            ) {
              return yield* corruptClaim(
                input.binding,
                "BoundTransitionMismatch",
                "ToolInvocation did not transition to the exact Bound V1 digest",
              );
            }
            yield* run(
              sql.unsafe(
                `INSERT INTO tool_invocation_effect_attempts (
                 invocation_id, attempt_no, admission_state,
                 tool_definition_hash, side_effect_semantics, profile_id,
                 profile_version, profile_hash, profile_protocol, effect_key,
                 binding_sha256, admitted_at, admission_source,
                 admission_time_precision
               ) VALUES (?,0,'NotAdmitted',?,?,?,?,?,?,?, ?,NULL,'P39Claim','NotAdmitted')`,
                [
                  input.binding.invocationId,
                  input.binding.toolDefinitionHash,
                  input.binding.sideEffectSemantics,
                  input.binding.profileId,
                  input.binding.profileVersion,
                  input.binding.profileHash,
                  input.binding.profileProtocol,
                  input.binding.effectKey,
                  bindingSha256,
                ],
              ),
            );
            if (qualificationProbe !== undefined) {
              yield* Effect.promise(() =>
                qualificationProbe({
                  boundary: "P4P39ClaimBeforeCommit",
                  executionId: input.binding.executionId,
                  invocationId: input.binding.invocationId,
                  providerTurnId: input.binding.providerTurnId,
                  logicalStepNo: input.binding.logicalStepNo,
                  repairAttempt: input.binding.repairAttempt,
                  logicalActionId: input.binding.logicalActionId,
                  actionIndex: input.binding.actionIndex,
                  callRef: input.binding.callRef,
                  toolName: input.binding.toolName,
                  toolVersion: input.binding.toolVersion,
                  approvalId: input.binding.approvalId,
                }),
              );
            }
            return "Bound" as const;
          }),
        findBinding,
        findTerminalUnboundDenial,
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
            if (
              row.selected_attempt_no === null &&
              row.selected_fact_id === null
            ) {
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
              (row.selected_attempt_no !== 0 &&
                row.selected_attempt_no !== 1) ||
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

/** Default production/test layer without diagnostic behavior. */
export const P39RecoveryEvidenceStoreLive = makeP39RecoveryEvidenceStoreLive();
