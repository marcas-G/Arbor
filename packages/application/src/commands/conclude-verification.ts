import {
  type ArtifactId,
  aggregateVerdict,
  type ConclusionReason,
  concludeVerification,
  type EvidenceId,
  type ExecutionId,
  recordVerificationEvidence,
  type VerificationCriterionResult,
  type VerificationId,
  type VerificationMission,
  type VerificationVerdict,
  type WakeReason,
  type WorkId,
  type WorkRevision,
  type WorkspaceId,
} from "@arbor/domain";
import type {
  DomainEventJournalService,
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
  readonly toolInvocationId?: import("@arbor/domain").ToolInvocationId;
  readonly observationRef?: string;
  readonly callRef?: string;
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
  validateReceiptReplay: (receipt, payload, _envelope, context) =>
    Effect.gen(function* () {
      if (receipt.resolution._tag !== "Committed") return;
      if (receipt.schemaVersion !== "1" || context._tag !== "ExecutionOrigin") {
        return yield* Effect.fail({
          _tag: "PersistenceCorruption" as const,
          repository: "CommandStore" as const,
          operation: "record-verification-evidence-replay-binding",
          reason: "evidence receipt has no exact verifier execution binding",
        });
      }
      const verification = yield* dependencies.verifications.findById(
        payload.verificationId,
      );
      if (Option.isNone(verification)) {
        return yield* Effect.fail({
          _tag: "PersistenceCorruption" as const,
          repository: "CommandStore" as const,
          operation: "record-verification-evidence-replay-binding",
          reason: "evidence receipt verification row is missing",
        });
      }
      const rows = yield* dependencies.evidence.listByVerification(
        payload.verificationId,
      );
      const stored = rows.find(
        (row) => row.evidenceId === payload.evidence.evidenceId,
      );
      const source = payload.evidence;
      if (
        stored === undefined ||
        !verification.value.verificationExecutionIds.includes(
          context.executionId,
        ) ||
        stored.verificationId !== payload.verificationId ||
        stored.criterionId !== source.criterionId ||
        stored.kind !== source.kind ||
        stored.artifactRef !== (source.artifactRef ?? null) ||
        stored.observedEnvironmentRevision !==
          (source.observedEnvironmentRevision ?? null) ||
        stored.recordedByExecutionId !== context.executionId ||
        stored.recordedAt !== source.recordedAt ||
        (stored.toolInvocationId ?? null) !==
          (source.toolInvocationId ?? null) ||
        (stored.observationRef ?? null) !== (source.observationRef ?? null) ||
        (stored.callRef ?? null) !== (source.callRef ?? null)
      ) {
        return yield* Effect.fail({
          _tag: "PersistenceCorruption" as const,
          repository: "CommandStore" as const,
          operation: "record-verification-evidence-replay-binding",
          reason: "evidence receipt does not match the canonical evidence row",
        });
      }
    }),
  execute: (envelope, context) =>
    Effect.gen(function* () {
      const payload = envelope.payload;

      // Rejection order (§2): not found → terminal → authority. The P8
      // Repository failures remain typed through the gateway.
      const existing = yield* dependencies.verifications.findById(
        payload.verificationId,
      );
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
      if (
        !existing.value.verificationExecutionIds.includes(context.executionId)
      ) {
        return commandErr({
          _tag: "AuthorityDenied",
          reason:
            "evidence recording execution is not bound to this Verification",
        });
      }
      if (
        payload.evidence.kind === "ToolObservation" &&
        (payload.evidence.toolInvocationId === undefined ||
          payload.evidence.observationRef === undefined ||
          payload.evidence.callRef === undefined)
      ) {
        return commandErr({
          _tag: "AuthorityDenied",
          reason:
            "ToolObservation requires Runtime-bound toolInvocationId, observationRef, and callRef",
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
        toolInvocationId: payload.evidence.toolInvocationId ?? null,
        observationRef: payload.evidence.observationRef ?? null,
        callRef: payload.evidence.callRef ?? null,
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
      const storedRows = yield* dependencies.evidence.listByVerification(
        payload.verificationId,
      );
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
      const sameSourceIdentity =
        (stored.toolInvocationId ?? null) ===
          (record.toolInvocationId ?? null) &&
        (stored.observationRef ?? null) === (record.observationRef ?? null) &&
        (stored.callRef ?? null) === (record.callRef ?? null);
      if (!sameContent || !sameSourceIdentity) {
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
export type CriterionResultInput = VerificationCriterionResult;

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
  readonly summaryRef: string;
  readonly missionSnapshot: VerificationMission;
  readonly criteriaResults: ReadonlyArray<CriterionResultInput>;
  readonly snapshotStatus: "Available" | "NotApplicableOrphaned";
  readonly conclusionReason: ConclusionReason | null;
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
  readonly journal?: Pick<
    DomainEventJournalService,
    "lastSequence" | "readAfter"
  >;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const hasExactKeys = (
  value: unknown,
  keys: ReadonlyArray<string>,
): value is Record<string, unknown> =>
  isRecord(value) &&
  Object.keys(value).length === keys.length &&
  keys.every((key) => Object.hasOwn(value, key));

const conclusionReplayFailure = () =>
  Effect.fail({
    _tag: "PersistenceCorruption" as const,
    repository: "CommandStore" as const,
    operation: "conclude-verification-replay-binding",
    reason:
      "ConcludeVerification receipt does not match canonical row/event/evidence truth",
  });

export const makeConcludeVerificationHandler = (
  dependencies: ConcludeVerificationDependencies,
): CommandHandler<ConcludeVerificationPayload, ConcludeVerificationResult> => ({
  commandType: "ConcludeVerification",
  schemaVersion: "2",
  priorReceiptSchemaVersions: ["1"],
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
  validateReceiptReplay: (receipt, payload, envelope, _context) =>
    Effect.gen(function* () {
      if (receipt.resolution._tag !== "Committed") return;
      const journal = dependencies.journal;
      if (journal === undefined) return yield* conclusionReplayFailure();
      const result = receipt.resolution.result as ConcludeVerificationResult;
      const found = yield* dependencies.verifications.findById(
        payload.verificationId,
      );
      if (Option.isNone(found)) return yield* conclusionReplayFailure();
      const verification = found.value;
      const evidence = yield* dependencies.evidence.listByVerification(
        payload.verificationId,
      );
      const evidenceById = new Map(
        evidence.map((record) => [record.evidenceId as string, record]),
      );
      const referenced =
        payload.conclusionReason === "Orphaned"
          ? []
          : payload.criteriaResults.flatMap((criterion) =>
              criterion.evidenceRefs.map((evidenceId) => ({
                criterionId: criterion.criterionId,
                evidenceId: evidenceId as string,
              })),
            );
      const expectedEvidenceRefs = referenced.map(
        ({ evidenceId }) => evidenceId,
      );
      if (
        verification.state.status !== "Concluded" ||
        verification.state.verdict !== payload.verdict ||
        verification.summaryRef !== payload.summaryRef ||
        verification.state.conclusionReason !== payload.conclusionReason ||
        (receipt.schemaVersion === "2" &&
          (verification.snapshotStatus !==
            (payload.conclusionReason === "Orphaned"
              ? "NotApplicableOrphaned"
              : "Available") ||
            JSON.stringify(verification.criteriaResults) !==
              JSON.stringify(
                payload.conclusionReason === "Orphaned"
                  ? []
                  : payload.criteriaResults,
              ))) ||
        (receipt.schemaVersion === "1" &&
          (verification.snapshotStatus !== "UnavailableLegacy" ||
            verification.criteriaResults !== null)) ||
        referenced.some(
          ({ criterionId, evidenceId }) =>
            evidenceById.get(evidenceId)?.criterionId !== criterionId,
        )
      ) {
        return yield* conclusionReplayFailure();
      }
      const finalSequence = yield* journal.lastSequence(receipt.projectId);
      const events = [];
      let sequence = 0;
      while (sequence < finalSequence) {
        const page = yield* journal.readAfter(
          receipt.projectId,
          sequence,
          1000,
        );
        if (page.length === 0) break;
        events.push(...page);
        const next = Number(page[page.length - 1]?.sequence ?? sequence);
        if (next <= sequence) return yield* conclusionReplayFailure();
        sequence = next;
      }
      const matching = events.filter(
        (event) =>
          event.eventType === "VerificationConcluded" &&
          event.causedByCommandId === receipt.commandId,
      );
      const event = matching[0];
      const eventPayload = event?.payload;
      const baseFields = [
        "verificationId",
        "workId",
        "targetWorkRevision",
        "verdict",
        "conclusionReason",
        "evidenceRefs",
        "summaryRef",
      ];
      const eventKeys =
        receipt.schemaVersion === "2"
          ? [
              ...baseFields,
              "missionSnapshot",
              "criteriaResults",
              "snapshotStatus",
            ]
          : baseFields;
      if (
        matching.length !== 1 ||
        event === undefined ||
        event.projectId !== receipt.projectId ||
        String(event.actor) !== String(envelope.actor) ||
        event.aggregateRef !== payload.verificationId ||
        event.eventVersion !== (receipt.schemaVersion === "2" ? 2 : 1) ||
        !hasExactKeys(eventPayload, eventKeys) ||
        eventPayload.verificationId !== payload.verificationId ||
        eventPayload.workId !== verification.workId ||
        eventPayload.targetWorkRevision !== verification.targetWorkRevision ||
        eventPayload.verdict !== payload.verdict ||
        eventPayload.conclusionReason !==
          (receipt.schemaVersion === "2"
            ? (payload.conclusionReason ?? null)
            : (payload.conclusionReason ?? "")) ||
        eventPayload.summaryRef !== payload.summaryRef ||
        JSON.stringify(eventPayload.evidenceRefs) !==
          JSON.stringify(expectedEvidenceRefs)
      ) {
        return yield* conclusionReplayFailure();
      }
      if (receipt.schemaVersion === "2") {
        const expectedCriteria =
          payload.conclusionReason === "Orphaned"
            ? []
            : payload.criteriaResults;
        if (
          JSON.stringify(eventPayload.missionSnapshot) !==
            JSON.stringify(verification.missionSnapshot) ||
          JSON.stringify(eventPayload.criteriaResults) !==
            JSON.stringify(expectedCriteria) ||
          eventPayload.snapshotStatus !== verification.snapshotStatus
        ) {
          return yield* conclusionReplayFailure();
        }
      }
      if (
        result.verificationId !== payload.verificationId ||
        result.state !== "Concluded" ||
        result.verdict !== payload.verdict ||
        result.summaryRef !== payload.summaryRef ||
        result.conclusionReason !==
          (receipt.schemaVersion === "2"
            ? (payload.conclusionReason ?? null)
            : payload.conclusionReason) ||
        result.channel1Release.workId !== verification.workId ||
        result.channel1Release.targetWorkRevision !==
          verification.targetWorkRevision
      ) {
        return yield* conclusionReplayFailure();
      }
      if (receipt.schemaVersion === "2") {
        const ownerWork = yield* dependencies.works.findById(
          verification.workId,
        );
        if (Option.isNone(ownerWork)) return yield* conclusionReplayFailure();
        const expectedWakeSignals: ReadonlyArray<ConcludeVerificationWakeSignal> =
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
        if (
          JSON.stringify(result.missionSnapshot) !==
            JSON.stringify(verification.missionSnapshot) ||
          JSON.stringify(result.criteriaResults) !==
            JSON.stringify(verification.criteriaResults) ||
          result.snapshotStatus !== verification.snapshotStatus ||
          JSON.stringify(result.wakeSignals) !==
            JSON.stringify(expectedWakeSignals)
        ) {
          return yield* conclusionReplayFailure();
        }
      }
    }),
  execute: (envelope, context) =>
    Effect.gen(function* () {
      const payload = envelope.payload;

      const existing = yield* dependencies.verifications.findById(
        payload.verificationId,
      );
      if (Option.isNone(existing)) {
        return commandErr({
          _tag: "VerificationNotFound",
          verificationId: payload.verificationId,
        });
      }
      const verification = existing.value;

      if (
        payload.conclusionReason !== "Orphaned" &&
        (context._tag !== "ExecutionOrigin" ||
          !verification.verificationExecutionIds.includes(context.executionId))
      ) {
        return commandErr({
          _tag: "AuthorityDenied",
          reason:
            "verification conclusion execution is not bound to this Verification",
        });
      }

      // P0-frozen transition: Open-state + Orphaned↔Unknown pairing (G5).
      const transition = concludeVerification(
        verification,
        payload.verdict,
        payload.summaryRef,
        payload.conclusionReason,
        payload.criteriaResults,
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
        for (const [index, criterion] of criteria.entries()) {
          const result = resultsByCriterion.get(criterion.criterionId);
          if (result === undefined) {
            return invalid(
              `criteriaResults missing criterion ${criterion.criterionId}`,
            );
          }
          if (
            payload.criteriaResults[index]?.criterionId !==
            criterion.criterionId
          )
            return invalid("criteriaResults must preserve mission order");
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
          if (
            new Set(result.evidenceRefs).size !== result.evidenceRefs.length ||
            result.evidenceRefs.some((evidenceId, index) => {
              const previous = result.evidenceRefs[index - 1];
              return (
                index > 0 && previous !== undefined && previous > evidenceId
              );
            })
          ) {
            return invalid(
              `criterion ${result.criterionId} evidenceRefs must be duplicate-free and lexicographically ordered (P8 04 §2)`,
            );
          }
          evidenceRefs.push(...result.evidenceRefs);
        }
        const appended = yield* dependencies.evidence.listByVerification(
          payload.verificationId,
        );
        const appendedById = new Map(
          appended.map((row) => [row.evidenceId as string, row]),
        );
        for (const result of payload.criteriaResults) {
          for (const evidenceId of result.evidenceRefs) {
            const record = appendedById.get(evidenceId);
            if (
              record === undefined ||
              record.criterionId !== result.criterionId
            ) {
              return invalid(
                `evidenceRef ${evidenceId} is not appended evidence for criterion ${result.criterionId} (invariant 26)`,
              );
            }
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
      const criteriaSnapshot =
        payload.conclusionReason === "Orphaned" ? [] : payload.criteriaResults;
      const applied = yield* dependencies.verifications.concludeIfOpen(
        payload.verificationId,
        payload.verdict,
        payload.summaryRef,
        payload.conclusionReason,
        criteriaSnapshot,
      );
      if (Option.isNone(applied)) {
        const reread = yield* dependencies.verifications.findById(
          payload.verificationId,
        );
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
      const ownerWork = yield* dependencies.works.findById(verification.workId);
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
          eventVersion: 2,
          occurredAt: envelope.issuedAt,
          aggregateRef: payload.verificationId,
          actor: envelope.actor,
          causedByCommandId: envelope.commandId,
          payload: {
            verificationId: payload.verificationId,
            workId: verification.workId,
            targetWorkRevision: verification.targetWorkRevision,
            verdict: payload.verdict,
            conclusionReason: payload.conclusionReason ?? null,
            evidenceRefs,
            summaryRef: payload.summaryRef,
            missionSnapshot: verification.missionSnapshot,
            criteriaResults: criteriaSnapshot,
            snapshotStatus:
              payload.conclusionReason === "Orphaned"
                ? "NotApplicableOrphaned"
                : "Available",
          },
        },
      ];

      return commandOk({
        result: {
          verificationId: payload.verificationId,
          state: "Concluded",
          verdict: payload.verdict,
          summaryRef: payload.summaryRef,
          missionSnapshot: verification.missionSnapshot,
          criteriaResults: criteriaSnapshot,
          snapshotStatus:
            payload.conclusionReason === "Orphaned"
              ? "NotApplicableOrphaned"
              : "Available",
          conclusionReason: payload.conclusionReason ?? null,
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
