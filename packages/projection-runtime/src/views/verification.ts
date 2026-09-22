import type { Acceptance, Verification, Work, WorkId } from "@arbor/domain";
import type { EvidenceRecordRow } from "@arbor/ports";
import { Effect, Option } from "effect";
import type { ProjectionReadError } from "../errors.js";
import { projectionReadError } from "../errors.js";
import type {
  AcceptanceViewView,
  CriterionResultView,
  VerificationViewView,
} from "./shared.js";

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

/** VerificationRes core derive — read-only. Per-criterion verdicts:
 * canonical persistence carries the aggregate verdict only (P8 frozen
 * stores; the Conclusion command validates per-criterion inputs but does
 * not persist them), so per-criterion verdicts are not reconstructible
 * and render Unknown — the view never invents a criterion verdict from
 * the aggregate (optional criteria may Fail under an aggregate Pass). */
export const deriveVerificationView = (
  workId: WorkId,
  deps: VerificationViewDeps,
): Effect.Effect<VerificationViewView, ProjectionReadError> =>
  Effect.gen(function* () {
    const work = yield* deps.findWork(workId);
    if (Option.isNone(work)) {
      return yield* Effect.fail(projectionReadError(`no work ${workId}`));
    }
    const rows = yield* deps.listVerificationsByWork(workId);
    const open = rows.find((row) => row.state.status === "Open");
    const selected =
      open ??
      rankConcluded(rows, work.value.revision) ??
      (rows.length > 0 ? rows[0] : undefined);

    if (selected === undefined) {
      return {
        verificationId: undefined,
        verdict: undefined,
        criteriaResults: [],
        evidenceRefs: [],
        acceptance: undefined,
      };
    }

    const evidence = yield* deps.listEvidenceByVerification(
      selected.verificationId,
    );
    const acceptance = yield* deps.findAcceptanceByWorkRevision(
      selected.workId,
      selected.targetWorkRevision,
    );

    return {
      verificationId: selected.verificationId,
      verdict:
        selected.state.status === "Concluded"
          ? selected.state.verdict
          : undefined,
      criteriaResults: selected.missionSnapshot.criteria.map((criterion) => ({
        criterionId: criterion.criterionId,
        requirement: criterion.requirement,
        required: criterion.required,
        verdict: "Unknown",
      })),
      evidenceRefs: evidence.map((row) => row.evidenceId),
      acceptance: Option.isSome(acceptance)
        ? {
            acceptanceId: acceptance.value.acceptanceId,
            actor: acceptance.value.actor,
            acceptedAt: acceptance.value.acceptedAt,
          }
        : undefined,
    };
  });
