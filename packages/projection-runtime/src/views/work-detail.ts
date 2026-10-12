import type {
  Acceptance,
  ExecutionSettlement,
  ProjectId,
  TerminalActionDenial,
  Verification,
  Work,
  WorkBlocker,
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
  readonly blockedEpisode?: BlockedWorkEpisodeView;
}

export interface BlockedWorkEpisodeView {
  readonly sourceExecutionId: WorkBlocker["openCycleId"];
  readonly blockers: ReadonlyArray<{
    readonly blockerId: WorkBlocker["blockerId"];
    readonly disposition: "Blocked";
    readonly failedActions: ReadonlyArray<{
      readonly actionId: string;
      readonly actionKind: "Executable" | "P4NoEffectDenied";
      readonly status: "Denied";
      readonly denialCategory:
        | Extract<
            TerminalActionDenial,
            { readonly _tag: "P4NoEffectDenied" }
          >["reasonCode"]
        | "HandlerRejected";
      readonly request: string;
      readonly observationRef: string;
    }>;
    readonly recoveryGuidance: string;
  }>;
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
  readonly listWorkBlockersByWorkRevision?: (
    workId: WorkId,
    revision: number,
  ) => Effect.Effect<ReadonlyArray<WorkBlocker>, ProjectionReadError>;
  readonly findExecutionSettlement?: (
    executionId: WorkBlocker["openCycleId"],
  ) => Effect.Effect<Option.Option<ExecutionSettlement>, ProjectionReadError>;
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
    let blockedEpisode: BlockedWorkEpisodeView | undefined;
    if (
      work.lifecycle === "Open" &&
      deps.listWorkBlockersByWorkRevision !== undefined
    ) {
      const blockers = yield* deps.listWorkBlockersByWorkRevision(
        work.workId,
        work.revision,
      );
      const current = blockers.filter(
        (blocker) =>
          blocker.state === "Open" &&
          blocker.projectId === work.projectId &&
          blocker.workspaceId === work.workspaceId &&
          blocker.workId === work.workId &&
          blocker.targetWorkRevision === work.revision,
      );
      if (current.length > 0) {
        if (
          current.some(
            (blocker) => blocker.openCycleId !== current[0]?.openCycleId,
          )
        ) {
          return yield* Effect.fail(integrityFailure);
        }
        if (deps.findExecutionSettlement === undefined) {
          return yield* Effect.fail(integrityFailure);
        }
        const projected: Array<BlockedWorkEpisodeView["blockers"][number]> = [];
        for (const blocker of current) {
          const settlement = yield* deps.findExecutionSettlement(
            blocker.openCycleId,
          );
          const blockedResult =
            Option.isSome(settlement) &&
            settlement.value._tag === "Completed" &&
            settlement.value.result._tag === "Blocked"
              ? settlement.value.result
              : undefined;
          const request = (
            blockedResult as unknown as
              | { readonly request?: unknown }
              | undefined
          )?.request;
          if (
            blockedResult === undefined ||
            blockedResult.blockerId !== blocker.blockerId ||
            blockedResult.workId !== work.workId ||
            blockedResult.targetWorkRevision !== work.revision ||
            request !== blocker.latestRequestRef ||
            JSON.stringify(blockedResult.failedActionRefs) !==
              JSON.stringify(blocker.failedActionRefs)
          ) {
            return yield* Effect.fail(integrityFailure);
          }
          projected.push({
            blockerId: blocker.blockerId,
            disposition: "Blocked" as const,
            failedActions: blocker.failedActionRefs.map((action) => ({
              actionId: action.logicalActionId,
              actionKind:
                action.terminalDenial._tag === "P4NoEffectDenied"
                  ? "P4NoEffectDenied"
                  : action.terminalDenial.routeKind,
              status: "Denied" as const,
              denialCategory:
                action.terminalDenial._tag === "P4NoEffectDenied"
                  ? action.terminalDenial.reasonCode
                  : "HandlerRejected",
              request: request as string,
              observationRef: action.observationSourceRef,
            })),
            recoveryGuidance:
              "Review the denied action and update or resolve the Work through an authorized Work control.",
          });
        }
        blockedEpisode = {
          sourceExecutionId: current[0]
            ?.openCycleId as WorkBlocker["openCycleId"],
          blockers: projected,
        };
      }
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
      ...(blockedEpisode === undefined ? {} : { blockedEpisode }),
    };
  });
