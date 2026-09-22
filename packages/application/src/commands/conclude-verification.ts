import {
  type ArtifactId,
  aggregateVerdict,
  type ConclusionReason,
  concludeVerification,
  type EvidenceId,
  type ExecutionId,
  recordVerificationEvidence,
  type VerificationId,
  type VerificationVerdict,
  type WakeReason,
  type WorkId,
  type WorkRevision,
  type WorkspaceId,
} from "@arbor/domain";
import type {
  EvidenceRecordRow,
  EvidenceRepositoryError,
  EvidenceRepositoryService,
  PendingDomainEvent,
  VerificationRepositoryService,
  WorkRepositoryService,
} from "@arbor/ports";
import { Effect, Option } from "effect";
import { commandErr, commandOk } from "../command-result.js";
import type { CommandHandler } from "../gateway.js";

/** P8 `01` §2/§3 + `04` §1/§2: the two verifier-only command faces.
 * RecordVerificationEvidence appends runtime-record evidence (no domain
 * event — DID §3.7); ConcludeVerification records the verdict conclusion
 * snapshot with the required-qualified deterministic aggregation (v1.11
 * G1) and the Orphaned governance path (G5). Verdict is immutable after
 * conclude; the one-Open CAS in the store is the concurrency backstop. */

const VERDICTS: ReadonlySet<string> = new Set(["Pass", "Fail", "Unknown"]);

// --- RecordVerificationEvidence (P8 `01` §2, verifier-only) ---

export interface EvidenceSubmission {
  readonly evidenceId: EvidenceId;
  readonly criterionId: string;
  readonly kind:
    | "ToolObservation"
    | "ArtifactRef"
    | "ReasoningTrace"
    | "ReproductionLog";
  readonly artifactRef?: ArtifactId;
  readonly observedEnvironmentRevision?: string;
  readonly recordedAt: string;
}

export interface RecordVerificationEvidencePayload {
  readonly verificationId: VerificationId;
  readonly evidence: EvidenceSubmission;
}

export interface RecordVerificationEvidenceResult {
  readonly verificationId: VerificationId;
  readonly evidenceId: EvidenceId;
  readonly state: "Recorded";
}

export interface RecordVerificationEvidenceDependencies {
  readonly verifications: Pick<VerificationRepositoryService, "findById">;
  readonly evidence: Pick<
    EvidenceRepositoryService,
    "append" | "listByVerification"
  >;
  /** Optional B-1 seam (SatisfyDependency G6 precedent): verify the
   * authority's executionId is one of this Verification's bound Verifier
   * Executions. Submission-time fact projection guarantees the binding;
   * the callback lets later wiring enforce it without changing the face. */
  readonly verifyVerifierExecution?: (
    verificationId: VerificationId,
    executionId: ExecutionId,
  ) => boolean;
}

export const makeRecordVerificationEvidenceHandler = (
  dependencies: RecordVerificationEvidenceDependencies,
): CommandHandler<
  RecordVerificationEvidencePayload,
  RecordVerificationEvidenceResult
> => ({
  commandType: "RecordVerificationEvidence",
  schemaVersion: "1",
  authority: {
    tag: "VerifierExecutionAuthority",
    // Exact-bound (B-1): the fact carries (verificationId, executionId);
    // the payload match binds verificationId, `executionId` is bound at
    // fact projection to one of the Verification's Verifier Executions.
    targetMatches: (authority, payload) => {
      if (authority._tag !== "VerifierExecutionAuthority") {
        return false;
      }
      if (
        dependencies.verifyVerifierExecution !== undefined &&
        !dependencies.verifyVerifierExecution(
          authority.verificationId,
          authority.executionId,
        )
      ) {
        return false;
      }
      return authority.verificationId === payload.verificationId;
    },
  },
  stopAdmission: { _tag: "NormalExecutionMutation" },
  execute: (envelope, context) =>
    Effect.gen(function* () {
      const payload = envelope.payload;

      // Rejection order (§2): not found → terminal → authority. The P8
      // store channels are not in the gateway error union — defects-only
      // here (semantic-boundary convention).
      const existing = yield* dependencies.verifications
        .findById(payload.verificationId)
        .pipe(Effect.orDie);
      if (Option.isNone(existing)) {
        return commandErr({
          _tag: "VerificationNotFound",
          verificationId: payload.verificationId,
        });
      }

      // The P0-frozen transition is the Open-state authority; its value
      // (the aggregate's evidenceRefs list) is derived at read — the
      // append-only evidence table is the runtime-record truth (`04` §1),
      // so the transition value is not persisted here.
      const transition = recordVerificationEvidence(
        existing.value,
        payload.evidence.evidenceId,
      );
      if (!transition.ok) {
        return commandErr(transition.error);
      }

      // `recordedByExecutionId` comes from the VerifierExecutionAuthority
      // fact (`04` §1); the gateway-validated fact and the submission
      // context agree, and the context is the carrier visible at the
      // handler face — only the bound Verifier Execution's own origin can
      // record (verifier-only, §2).
      if (context._tag !== "ExecutionOrigin") {
        return commandErr({
          _tag: "AuthorityDenied",
          reason:
            "evidence recording requires the bound Verifier Execution submission origin (P8 01 §2)",
        });
      }
      const record: EvidenceRecordRow = {
        evidenceId: payload.evidence.evidenceId,
        verificationId: payload.verificationId,
        criterionId: payload.evidence.criterionId,
        kind: payload.evidence.kind,
        artifactRef: payload.evidence.artifactRef ?? null,
        observedEnvironmentRevision:
          payload.evidence.observedEnvironmentRevision ?? null,
        recordedByExecutionId: context.executionId,
        recordedAt: payload.evidence.recordedAt,
      };

      const result: RecordVerificationEvidenceResult = {
        verificationId: payload.verificationId,
        evidenceId: payload.evidence.evidenceId,
        state: "Recorded",
      };

      // Append-only insert: the only typed insert failure is the
      // evidenceId PK — flip, then decide by existence + content
      // comparison (ProduceDeliverable §10 precedent).
      const insertFailure = yield* dependencies.evidence.append(record).pipe(
        Effect.flip,
        Effect.map(
          (error): Option.Option<EvidenceRepositoryError> => Option.some(error),
        ),
        Effect.catch(() =>
          Effect.succeed(Option.none<EvidenceRepositoryError>()),
        ),
      );
      if (Option.isNone(insertFailure)) {
        return commandOk({ result, events: [] });
      }
      const storedRows = yield* dependencies.evidence
        .listByVerification(payload.verificationId)
        .pipe(Effect.orDie);
      const stored = storedRows.find(
        (row) => row.evidenceId === record.evidenceId,
      );
      if (stored === undefined) {
        return yield* Effect.die(
          new Error(
            `evidence append failed and no existing row to absorb: ${String(
              insertFailure.value._tag,
            )}`,
          ),
        );
      }
      const sameContent =
        stored.criterionId === record.criterionId &&
        stored.kind === record.kind &&
        stored.artifactRef === record.artifactRef &&
        stored.observedEnvironmentRevision ===
          record.observedEnvironmentRevision &&
        stored.recordedByExecutionId === record.recordedByExecutionId;
      if (!sameContent) {
        return commandErr({
          _tag: "IdempotencyConflict",
          commandId: envelope.commandId,
        });
      }
      // Same-evidenceId replay: no-op success, no second row, no event.
      return commandOk({ result, events: [] });
    }),
});

// --- ConcludeVerification (P8 `01` §3, verifier-only + G5 Orphaned) ---

/** v1.11 G1 (GQ2): the conclusion snapshot's criterion-level value
 * object — `requirement`/`required` snapshot the mission criterion
 * verbatim (`04` §2). */
export interface CriterionResultInput {
  readonly criterionId: string;
  readonly requirement: string;
  readonly required: boolean;
  readonly verdict: VerificationVerdict;
  readonly evidenceRefs: ReadonlyArray<EvidenceId>;
}

export interface ConcludeVerificationPayload {
  readonly verificationId: VerificationId;
  readonly verdict: VerificationVerdict;
  readonly criteriaResults: ReadonlyArray<CriterionResultInput>;
  readonly summaryRef: string;
  readonly conclusionReason?: ConclusionReason;
}

/** P8 `03` §3 channel 2: producer-side reevaluate entry — Fail/Unknown
 * only; Pass never wakes this channel (Acceptance is the Parent's
 * cognition, not a wake event). */
export interface ConcludeVerificationWakeSignal {
  readonly workspaceId: WorkspaceId;
  readonly reason: WakeReason;
  readonly detail: {
    readonly verificationId: VerificationId;
    readonly workId: WorkId;
    readonly workRevision: WorkRevision;
    readonly verdict: VerificationVerdict;
  };
}

/** P8 `03` §3 channel 1: any verdict (Pass included) is the fact change a
 * VerificationChanged wait expresses; scan/release consumption is
 * P8-009, this Result only carries the release data. */
export interface Channel1Release {
  readonly workId: WorkId;
  readonly targetWorkRevision: WorkRevision;
}

export interface ConcludeVerificationResult {
  readonly verificationId: VerificationId;
  readonly state: "Concluded";
  readonly verdict: VerificationVerdict;
  readonly conclusionReason: ConclusionReason | undefined;
  readonly wakeSignals: ReadonlyArray<ConcludeVerificationWakeSignal>;
  readonly channel1Release: Channel1Release;
}

export interface ConcludeVerificationDependencies {
  readonly verifications: Pick<
    VerificationRepositoryService,
    "findById" | "concludeIfOpen"
  >;
  readonly evidence: Pick<EvidenceRepositoryService, "listByVerification">;
  readonly works: Pick<WorkRepositoryService, "findById">;
}

export const makeConcludeVerificationHandler = (
  dependencies: ConcludeVerificationDependencies,
): CommandHandler<ConcludeVerificationPayload, ConcludeVerificationResult> => ({
  commandType: "ConcludeVerification",
  schemaVersion: "1",
  authority: {
    tag: "VerifierExecutionAuthority",
    // Dual-face (§3 + G5): the verifier face concludes normal verdicts
    // (never Orphaned); the Orphaned conclusion is a Parent governance
    // chain action submitted under OrphanConclusionAuthority (§3 — explicitly
    // not verifier-only). The conclusionReason pairing keeps the two
    // authority kinds mechanically disjoint at the face.
    alsoTags: ["OrphanConclusionAuthority"],
    targetMatches: (authority, payload) => {
      if (authority._tag === "VerifierExecutionAuthority") {
        return (
          authority.verificationId === payload.verificationId &&
          payload.conclusionReason !== "Orphaned"
        );
      }
      if (authority._tag === "OrphanConclusionAuthority") {
        return (
          authority.verificationId === payload.verificationId &&
          payload.conclusionReason === "Orphaned"
        );
      }
      return false;
    },
  },
  stopAdmission: { _tag: "NormalExecutionMutation" },
  execute: (envelope) =>
    Effect.gen(function* () {
      const payload = envelope.payload;

      const existing = yield* dependencies.verifications
        .findById(payload.verificationId)
        .pipe(Effect.orDie);
      if (Option.isNone(existing)) {
        return commandErr({
          _tag: "VerificationNotFound",
          verificationId: payload.verificationId,
        });
      }
      const verification = existing.value;

      // P0-frozen transition: Open-state + Orphaned↔Unknown pairing (G5).
      const transition = concludeVerification(
        verification,
        payload.verdict,
        payload.conclusionReason,
      );
      if (!transition.ok) {
        return commandErr(transition.error);
      }

      const evidenceRefs: EvidenceId[] = [];

      if (payload.conclusionReason !== "Orphaned") {
        // §3 mission/evidence record valid: criteria-complete, every
        // criterion a faithful snapshot bound to appended evidence
        // (invariant 26), overall verdict == deterministic aggregation.
        // The Orphaned path (G5) waives this block entirely — an orphan
        // has no live Verifier to produce evidence by definition.
        const invalid = (reason: string) =>
          commandErr({
            _tag: "InvalidVerificationMission" as const,
            reason,
          });

        const criteria = verification.missionSnapshot.criteria;
        const resultsByCriterion = new Map(
          payload.criteriaResults.map((result) => [result.criterionId, result]),
        );
        if (resultsByCriterion.size !== payload.criteriaResults.length) {
          return invalid(
            "criteriaResults contains duplicate criterion results",
          );
        }
        for (const criterion of criteria) {
          const result = resultsByCriterion.get(criterion.criterionId);
          if (result === undefined) {
            return invalid(
              `criteriaResults missing criterion ${criterion.criterionId}`,
            );
          }
          if (
            result.requirement !== criterion.requirement ||
            result.required !== criterion.required
          ) {
            return invalid(
              `criterion ${criterion.criterionId} result must snapshot the mission criterion (P8 04 §2)`,
            );
          }
        }
        for (const result of payload.criteriaResults) {
          if (
            !criteria.some(
              (criterion) => criterion.criterionId === result.criterionId,
            )
          ) {
            return invalid(
              `criteriaResults references unknown criterion ${result.criterionId}`,
            );
          }
          if (!VERDICTS.has(result.verdict)) {
            return invalid(
              `criterion ${result.criterionId} verdict must be Pass | Fail | Unknown`,
            );
          }
          if (result.evidenceRefs.length === 0) {
            return invalid(
              `criterion ${result.criterionId} binds no evidence (invariant 26)`,
            );
          }
          evidenceRefs.push(...result.evidenceRefs);
        }
        const appended = yield* dependencies.evidence
          .listByVerification(payload.verificationId)
          .pipe(Effect.orDie);
        const appendedIds = new Set(
          appended.map((row) => row.evidenceId as string),
        );
        for (const evidenceId of evidenceRefs) {
          if (!appendedIds.has(evidenceId)) {
            return invalid(
              `evidenceRef ${evidenceId} is not appended evidence of this verification (invariant 26)`,
            );
          }
        }
        const aggregated = aggregateVerdict(payload.criteriaResults);
        if (payload.verdict !== aggregated) {
          return invalid(
            `verdict mismatch: payload ${payload.verdict} != deterministic aggregation ${aggregated} (v1.11 G1)`,
          );
        }
      }

      // Conclude CAS: only an Open row transitions; a lost race re-reads
      // and classifies (dependency-transitions precedent). After this
      // commit the verdict is immutable — no path rewrites a Concluded row.
      const applied = yield* dependencies.verifications
        .concludeIfOpen(
          payload.verificationId,
          payload.verdict,
          payload.conclusionReason,
        )
        .pipe(Effect.orDie);
      if (Option.isNone(applied)) {
        const reread = yield* dependencies.verifications
          .findById(payload.verificationId)
          .pipe(Effect.orDie);
        const current = Option.isNone(reread) ? verification : reread.value;
        return commandErr({
          _tag: "TerminalLifecycleMutation",
          entity: "Verification",
          lifecycle: current.state.status,
        });
      }

      // Wake production (`03` §3, same commit boundary — wiring in
      // P8-009): channel 2 routes Fail/Unknown to the Workspace owning
      // the target Work; channel 1 releases the (workId,
      // targetWorkRevision) VerificationChanged wait for any verdict.
      // The owner Work row is referential — a verification without its
      // Work row is an integrity break (defect).
      const ownerWork = yield* dependencies.works
        .findById(verification.workId)
        .pipe(Effect.orDie);
      if (Option.isNone(ownerWork)) {
        return yield* Effect.die(
          new Error(
            `verification ${payload.verificationId} has no target work row (${verification.workId})`,
          ),
        );
      }

      const wakeSignals: ReadonlyArray<ConcludeVerificationWakeSignal> =
        payload.verdict === "Pass"
          ? []
          : [
              {
                workspaceId: ownerWork.value.workspaceId,
                reason: { _tag: "VerificationReturned" },
                detail: {
                  verificationId: payload.verificationId,
                  workId: verification.workId,
                  workRevision: verification.targetWorkRevision,
                  verdict: payload.verdict,
                },
              },
            ];

      const events: PendingDomainEvent[] = [
        {
          projectId: envelope.projectId,
          eventType: "VerificationConcluded",
          eventVersion: 1,
          occurredAt: envelope.issuedAt,
          aggregateRef: payload.verificationId,
          actor: envelope.actor,
          causedByCommandId: envelope.commandId,
          payload: {
            verificationId: payload.verificationId,
            workId: verification.workId,
            targetWorkRevision: verification.targetWorkRevision,
            verdict: payload.verdict,
            conclusionReason: payload.conclusionReason ?? "",
            evidenceRefs,
          },
        },
      ];

      return commandOk({
        result: {
          verificationId: payload.verificationId,
          state: "Concluded",
          verdict: payload.verdict,
          conclusionReason: payload.conclusionReason,
          wakeSignals,
          channel1Release: {
            workId: verification.workId,
            targetWorkRevision: verification.targetWorkRevision,
          },
        },
        events,
      });
    }),
});
