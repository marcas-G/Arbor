import type {
  Acceptance,
  ProjectId,
  Verification,
  Work,
  WorkId,
  WorkspaceId,
} from "@arbor/domain";
import type {
  ProjectionIntegrityFailure,
  ProjectionNotFound,
} from "@arbor/ports";
import { Effect, Option } from "effect";
import type { ProjectionReadError } from "../errors.js";

export interface WorkDetailRequest {
  readonly projectId: ProjectId;
  readonly workspaceId: WorkspaceId;
  readonly workId: WorkId;
}

export interface AcceptedWorkResultView {
  readonly acceptanceId: Acceptance["acceptanceId"];
  readonly verificationId: Acceptance["verificationId"];
  readonly targetWorkRevision: Acceptance["targetWorkRevision"];
  readonly verdict: "Pass";
  readonly actor: Acceptance["actor"];
  readonly acceptedAt: string;
}

export interface WorkDetailView extends WorkDetailRequest {
  readonly objective: string;
  readonly why: string;
  readonly completionExpectation: string;
  readonly lifecycle: Work["lifecycle"];
  readonly revision: Work["revision"];
  readonly acceptedResult?: AcceptedWorkResultView;
}

export interface WorkDetailDeps {
  readonly findWork: (
    workId: WorkId,
  ) => Effect.Effect<Option.Option<Work>, ProjectionReadError>;
  readonly findAcceptanceByWorkRevision: (
    workId: WorkId,
    revision: number,
  ) => Effect.Effect<Option.Option<Acceptance>, ProjectionReadError>;
  readonly findVerification: (
    verificationId: Verification["verificationId"],
  ) => Effect.Effect<Option.Option<Verification>, ProjectionReadError>;
}

const notFound: ProjectionNotFound = {
  _tag: "ProjectionNotFound",
  code: "projection/work-not-found",
  category: "not-found",
  correlationId: null,
  retryDisposition: "non-retryable",
  safeDetails: {},
};

const integrityFailure: ProjectionIntegrityFailure = {
  _tag: "ProjectionIntegrityFailure",
  code: "projection/unavailable",
  category: "unavailable",
  correlationId: null,
  retryDisposition: "non-retryable",
  safeDetails: {
    sourceTag: "ProjectionIntegrityFailure",
    view: "work-detail",
  },
};

/** Exact identity lookup. A missing target and a target outside the requested
 * project/workspace share one outward not-found response. */
export const deriveWorkDetail = (
  request: WorkDetailRequest,
  deps: WorkDetailDeps,
): Effect.Effect<
  WorkDetailView,
  ProjectionReadError | ProjectionNotFound | ProjectionIntegrityFailure
> =>
  Effect.gen(function* () {
    const found = yield* deps.findWork(request.workId);
    if (
      Option.isNone(found) ||
      found.value.projectId !== request.projectId ||
      found.value.workspaceId !== request.workspaceId
    ) {
      return yield* Effect.fail(notFound);
    }
    const work = found.value;
    const acceptance = yield* deps.findAcceptanceByWorkRevision(
      work.workId,
      work.revision,
    );
    let acceptedResult: AcceptedWorkResultView | undefined;
    if (Option.isSome(acceptance)) {
      const exactAcceptance = acceptance.value;
      const verification = yield* deps.findVerification(
        exactAcceptance.verificationId,
      );
      if (Option.isSome(verification)) {
        const exactVerification = verification.value;
        if (
          exactAcceptance.workId === work.workId &&
          exactAcceptance.targetWorkRevision === work.revision &&
          exactVerification.verificationId === exactAcceptance.verificationId &&
          exactVerification.workId === work.workId &&
          exactVerification.targetWorkRevision === work.revision &&
          exactVerification.state.status === "Concluded" &&
          exactVerification.state.verdict === "Pass"
        ) {
          acceptedResult = {
            acceptanceId: exactAcceptance.acceptanceId,
            verificationId: exactVerification.verificationId,
            targetWorkRevision: exactAcceptance.targetWorkRevision,
            verdict: "Pass",
            actor: exactAcceptance.actor,
            acceptedAt: exactAcceptance.acceptedAt,
          };
        }
      }
    }
    if (work.lifecycle === "Completed" && acceptedResult === undefined) {
      return yield* Effect.fail(integrityFailure);
    }
    return {
      workId: work.workId,
      projectId: work.projectId,
      workspaceId: work.workspaceId,
      objective: work.objective,
      why: work.why,
      completionExpectation: work.completionExpectation,
      lifecycle: work.lifecycle,
      revision: work.revision,
      ...(acceptedResult === undefined ? {} : { acceptedResult }),
    };
  });
