import type { Acceptance, Verification, Work, WorkId } from "@arbor/domain";
import type {
  EvidenceRecordRow,
  ProjectionIntegrityFailure,
} from "@arbor/ports";
import { Effect, Option } from "effect";
import type { ProjectionReadError } from "../errors.js";
import { projectionReadError } from "../errors.js";
import type {
  AcceptanceViewView,
  CriterionResultView,
  VerificationViewView,
} from "./shared.js";
import { verificationIdentityView } from "./shared.js";

export type { AcceptanceViewView, CriterionResultView, VerificationViewView };

// --- P10 `01` §1 Verification view (SD §12.4 ⑤; P10 `05` §1 cores) -------
//
// Derive inputs: verifications + evidence + acceptances — frozen. Row
// selection is deterministic: the Open verification of the work at its
// current revision; else any Open verification; else the Concluded
// verification matching the current revision; else the Concluded
// verification with the highest target revision (tie: verificationId).
// With no verification at all the view renders empty optionals — never a
// fabricated verdict.

export interface VerificationViewDeps {
  readonly findWork: (
    workId: WorkId,
  ) => Effect.Effect<Option.Option<Work>, ProjectionReadError>;
  readonly listVerificationsByWork: (
    workId: WorkId,
  ) => Effect.Effect<ReadonlyArray<Verification>, ProjectionReadError>;
  readonly listEvidenceByVerification: (
    verificationId: string,
  ) => Effect.Effect<ReadonlyArray<EvidenceRecordRow>, ProjectionReadError>;
  readonly findAcceptanceByWorkRevision: (
    workId: WorkId,
    targetWorkRevision: number,
  ) => Effect.Effect<Option.Option<Acceptance>, ProjectionReadError>;
}

const rankConcluded = (
  rows: ReadonlyArray<Verification>,
  workRevision: number,
): Verification | undefined => {
  const concluded = rows.filter((row) => row.state.status === "Concluded");
  const atCurrentRevision = concluded.find(
    (row) => row.targetWorkRevision === workRevision,
  );
  if (atCurrentRevision !== undefined) {
    return atCurrentRevision;
  }
  return [...concluded].sort(
    (a, b) =>
      b.targetWorkRevision - a.targetWorkRevision ||
      (a.verificationId < b.verificationId ? -1 : 1),
  )[0];
};

const unknownCriteria = (
  verification: Verification,
): ReadonlyArray<CriterionResultView> =>
  verification.missionSnapshot.criteria.map((criterion) => ({
    criterionId: criterion.criterionId,
    requirement: criterion.requirement,
    required: criterion.required,
    verdict: "Unknown",
  }));

const integrityFailure = (
  verificationId: string,
): ProjectionIntegrityFailure => ({
  _tag: "ProjectionIntegrityFailure",
  code: "projection/unavailable",
  category: "unavailable",
  correlationId: null,
  retryDisposition: "non-retryable",
  safeDetails: {
    view: "verification",
    reasonCode: "AvailableCriterionSnapshotInvalid",
    verificationId,
  },
});

const exactAvailableCriteria = (
  verification: Verification,
  evidence: ReadonlyArray<EvidenceRecordRow>,
): ReadonlyArray<CriterionResultView> | null => {
  const snapshot = verification.criteriaResults;
  if (
    verification.state.status !== "Concluded" ||
    verification.snapshotStatus !== "Available" ||
    verification.state.conclusionReason !== undefined ||
    snapshot === null ||
    snapshot.length !== verification.missionSnapshot.criteria.length
  ) {
    return null;
  }
  const missionIds = new Set<string>();
  for (const criterion of verification.missionSnapshot.criteria) {
    if (missionIds.has(criterion.criterionId)) return null;
    missionIds.add(criterion.criterionId);
  }
  const evidenceById = new Map<string, EvidenceRecordRow>();
  for (const record of evidence) {
    if (
      record.verificationId !== verification.verificationId ||
      evidenceById.has(record.evidenceId) ||
      !missionIds.has(record.criterionId)
    ) {
      return null;
    }
    evidenceById.set(record.evidenceId, record);
  }
  const criteriaResults: Array<CriterionResultView> = [];
  for (const [index, result] of snapshot.entries()) {
    const criterion = verification.missionSnapshot.criteria[index];
    if (
      criterion === undefined ||
      result.criterionId !== criterion.criterionId ||
      result.requirement !== criterion.requirement ||
      result.required !== criterion.required ||
      (result.verdict !== "Pass" &&
        result.verdict !== "Fail" &&
        result.verdict !== "Unknown") ||
      result.evidenceRefs.length === 0 ||
      new Set(result.evidenceRefs).size !== result.evidenceRefs.length
    ) {
      return null;
    }
    for (const evidenceId of result.evidenceRefs) {
      const evidenceRow = evidenceById.get(evidenceId);
      if (
        evidenceRow === undefined ||
        evidenceRow.verificationId !== verification.verificationId ||
        evidenceRow.criterionId !== criterion.criterionId
      ) {
        return null;
      }
    }
    criteriaResults.push({
      criterionId: result.criterionId,
      requirement: result.requirement,
      required: result.required,
      verdict: result.verdict,
    });
  }
  return criteriaResults;
};

/** VerificationRes core derive — read-only. Available criterion snapshots
 * render their exact persisted ordered verdicts. Only Pending and explicitly
 * UnavailableLegacy rows render Unknown; aggregate verdicts never fill gaps. */
export const deriveVerificationView = (
  workId: WorkId,
  deps: VerificationViewDeps,
): Effect.Effect<
  VerificationViewView,
  ProjectionReadError | ProjectionIntegrityFailure
> =>
  Effect.gen(function* () {
    const work = yield* deps.findWork(workId);
    if (Option.isNone(work)) {
      return yield* Effect.fail(projectionReadError(`no work ${workId}`));
    }
    const rows = yield* deps.listVerificationsByWork(workId);
    const accepted = yield* deps.findAcceptanceByWorkRevision(
      workId,
      work.value.revision,
    );
    const acceptedVerification = Option.isSome(accepted)
      ? rows.find((row) => row.verificationId === accepted.value.verificationId)
      : undefined;
    const open = rows.find((row) => row.state.status === "Open");
    const selected =
      acceptedVerification ??
      (Option.isSome(accepted)
        ? undefined
        : (open ??
          rankConcluded(rows, work.value.revision) ??
          (rows.length > 0 ? rows[0] : undefined)));

    if (selected === undefined) {
      return {
        ...verificationIdentityView(undefined),
        verdict: undefined,
        criteriaResults: [],
        evidenceRefs: [],
        acceptance: undefined,
      };
    }

    const evidence = yield* deps.listEvidenceByVerification(
      selected.verificationId,
    );
    const acceptance =
      Option.isSome(accepted) &&
      accepted.value.verificationId === selected.verificationId
        ? accepted
        : yield* deps.findAcceptanceByWorkRevision(
            selected.workId,
            selected.targetWorkRevision,
          );

    let criteriaResults: ReadonlyArray<CriterionResultView>;
    switch (selected.snapshotStatus) {
      case "Pending":
        if (
          selected.state.status !== "Open" ||
          selected.criteriaResults !== null
        ) {
          return yield* Effect.fail(integrityFailure(selected.verificationId));
        }
        criteriaResults = unknownCriteria(selected);
        break;
      case "UnavailableLegacy":
        if (
          selected.state.status !== "Concluded" ||
          selected.criteriaResults !== null
        ) {
          return yield* Effect.fail(integrityFailure(selected.verificationId));
        }
        criteriaResults = unknownCriteria(selected);
        break;
      case "NotApplicableOrphaned":
        if (
          selected.state.status !== "Concluded" ||
          selected.state.verdict !== "Unknown" ||
          selected.state.conclusionReason !== "Orphaned" ||
          selected.criteriaResults === null ||
          selected.criteriaResults.length !== 0 ||
          evidence.length !== 0
        ) {
          return yield* Effect.fail(integrityFailure(selected.verificationId));
        }
        criteriaResults = [];
        break;
      case "Available": {
        const available = exactAvailableCriteria(selected, evidence);
        if (available === null) {
          return yield* Effect.fail(integrityFailure(selected.verificationId));
        }
        criteriaResults = available;
        break;
      }
      default:
        return yield* Effect.fail(integrityFailure(selected.verificationId));
    }

    return {
      ...verificationIdentityView(selected),
      verdict:
        selected.state.status === "Concluded"
          ? selected.state.verdict
          : undefined,
      criteriaResults,
      evidenceRefs: evidence.map((row) => row.evidenceId),
      acceptance:
        Option.isSome(acceptance) &&
        acceptance.value.verificationId === selected.verificationId
          ? {
              acceptanceId: acceptance.value.acceptanceId,
              actor: acceptance.value.actor,
              acceptedAt: acceptance.value.acceptedAt,
            }
          : undefined,
    };
  });
