import type { ToolInvocationId } from "@arbor/domain";
import {
  reconciliationFactId,
  ToolReconciliationFactStore,
  TransactionScope,
  validateToolReconciliationResult,
} from "@arbor/ports";
import { Effect, Layer } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";
import {
  persistenceCorruption,
  repositoryFailure,
} from "./repository-error.js";

interface InvocationRow {
  readonly recovery_binding_state: string;
  readonly recovery_binding_sha256: string | null;
  readonly settled_at: string | null;
}

interface AttemptRow {
  readonly admission_state: string;
  readonly binding_sha256: string | null;
  readonly profile_hash: string | null;
  readonly effect_key: string | null;
}

interface ArtifactRow {
  readonly content_hash: string;
}

export const ToolReconciliationFactStoreLive: Layer.Layer<
  ToolReconciliationFactStore,
  never,
  SqlClient
> = Layer.effect(
  ToolReconciliationFactStore,
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    const failure = repositoryFailure("ToolReconciliationFactStore", "record");
    const run = <A>(effect: Effect.Effect<A, SqlError>) =>
      effect.pipe(Effect.mapError(failure));

    return ToolReconciliationFactStore.of({
      record: (request, result, observedAt) =>
        Effect.gen(function* () {
          yield* TransactionScope;
          if (
            !observedAt.trim() ||
            !validateToolReconciliationResult(request, result)
          ) {
            return yield* Effect.fail(
              persistenceCorruption(
                "ToolReconciliationFactStore",
                "record",
                "proof is incomplete or does not bind to the requested attempt",
              ),
            );
          }

          const invocations = yield* run(
            sql.unsafe<InvocationRow>(
              `SELECT recovery_binding_state, recovery_binding_sha256, settled_at
                 FROM tool_invocations WHERE invocation_id = ?`,
              [request.invocationId],
            ),
          );
          const invocation = invocations[0];
          const attempts = yield* run(
            sql.unsafe<AttemptRow>(
              `SELECT admission_state, binding_sha256, profile_hash, effect_key
                 FROM tool_invocation_effect_attempts
                WHERE invocation_id = ? AND attempt_no = ?`,
              [request.invocationId, request.attemptNo],
            ),
          );
          const attempt = attempts[0];
          if (
            invocation === undefined ||
            attempt === undefined ||
            invocation.recovery_binding_state !== "Bound" ||
            invocation.recovery_binding_sha256 !== request.bindingSha256 ||
            attempt.admission_state !== "MayHaveStarted" ||
            attempt.binding_sha256 !== request.bindingSha256 ||
            attempt.profile_hash !== request.profileHash ||
            attempt.effect_key !== request.effectKey
          ) {
            return yield* Effect.fail(
              persistenceCorruption(
                "ToolReconciliationFactStore",
                "record",
                "invocation or attempt is not bound to this proof",
              ),
            );
          }

          const factDisposition =
            invocation.settled_at === null
              ? "RecoveryInput"
              : "PostTerminalEvidence";
          if (
            factDisposition === "PostTerminalEvidence" &&
            (result._tag !== "StillUnknown" ||
              result.reasonCode !== "EvidenceBindingMismatch")
          ) {
            return yield* Effect.fail(
              persistenceCorruption(
                "ToolReconciliationFactStore",
                "record",
                "terminal invocations accept only contradictory post-terminal evidence",
              ),
            );
          }

          const evidenceRef =
            result._tag === "StillUnknown"
              ? result.evidenceRef
              : result.proof.evidenceRef;
          let evidenceSha256: string | null = null;
          if (evidenceRef !== null) {
            const artifacts = yield* run(
              sql.unsafe<ArtifactRow>(
                "SELECT content_hash FROM artifacts WHERE artifact_id = ?",
                [evidenceRef],
              ),
            );
            if (artifacts[0] === undefined) {
              return yield* Effect.fail(
                persistenceCorruption(
                  "ToolReconciliationFactStore",
                  "record",
                  "proof evidence artifact is missing",
                ),
              );
            }
            evidenceSha256 = artifacts[0].content_hash;
          }
          if (
            result._tag !== "StillUnknown" &&
            evidenceSha256 !== result.proof.evidenceSha256
          ) {
            return yield* Effect.fail(
              persistenceCorruption(
                "ToolReconciliationFactStore",
                "record",
                "proof evidence digest does not match its Artifact",
              ),
            );
          }
          if (result._tag === "Occurred") {
            const results = yield* run(
              sql.unsafe<ArtifactRow>(
                "SELECT content_hash FROM artifacts WHERE artifact_id = ?",
                [result.resultRef],
              ),
            );
            if (results[0] === undefined) {
              return yield* Effect.fail(
                persistenceCorruption(
                  "ToolReconciliationFactStore",
                  "record",
                  "Occurred proof has no reconstructable result Artifact",
                ),
              );
            }
          }

          const factId = reconciliationFactId({
            request,
            result,
            factDisposition,
            evidenceSha256,
          });
          const outcome = result._tag;
          const reasonCode =
            result._tag === "StillUnknown" ? result.reasonCode : null;
          const resultRef =
            result._tag === "Occurred" ? result.resultRef : null;
          yield* run(
            sql.unsafe(
              `INSERT INTO tool_reconciliation_facts (
                fact_id, invocation_id, attempt_no, binding_sha256, profile_hash,
                effect_key, fact_origin, legacy_reason, fact_disposition,
                outcome, reason_code, evidence_ref, evidence_sha256, result_ref,
                observed_at
              ) VALUES (?,?,?,?,?,?,'ProfileReconciliation',NULL,?,?,?,?,?,?,?)
              ON CONFLICT(fact_id) DO NOTHING`,
              [
                factId,
                request.invocationId,
                request.attemptNo,
                request.bindingSha256,
                request.profileHash,
                request.effectKey,
                factDisposition,
                outcome,
                reasonCode,
                evidenceRef,
                evidenceSha256,
                resultRef,
                result._tag === "StillUnknown"
                  ? observedAt
                  : result.proof.observedAt,
              ],
            ),
          );

          const facts = yield* run(
            sql.unsafe<{
              readonly fact_id: string;
              readonly fact_disposition:
                | "RecoveryInput"
                | "PostTerminalEvidence";
              readonly outcome: "NotOccurred" | "Occurred" | "StillUnknown";
            }>(
              `SELECT fact_id, fact_disposition, outcome
                 FROM tool_reconciliation_facts
                WHERE fact_id = ? AND invocation_id = ? AND attempt_no = ?`,
              [factId, request.invocationId, request.attemptNo],
            ),
          );
          const fact = facts[0];
          if (fact === undefined) {
            return yield* Effect.fail(
              persistenceCorruption(
                "ToolReconciliationFactStore",
                "record",
                "immutable proof fact could not be read back",
              ),
            );
          }
          return {
            factId: fact.fact_id,
            invocationId: request.invocationId as ToolInvocationId,
            attemptNo: request.attemptNo,
            factDisposition: fact.fact_disposition,
            outcome: fact.outcome,
          };
        }),
    });
  }),
);

