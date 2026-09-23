import type {
  FreshnessRequirement,
  ProjectId,
  QueryResult,
  ViewId,
  Work,
  WorkId,
  WorkspaceId,
} from "@arbor/domain";
import type {
  ProjectionInvalidRequest,
  ProjectionQueryError,
  ProjectionQueryPortService,
  ProjectionStale,
  ProjectionUnavailable,
} from "@arbor/ports";
import { Effect } from "effect";
import type { AttentionReadDeps } from "./attention-loader.js";
import { deriveProjectAttention } from "./attention-loader.js";
import type { EffectiveFactsDeps } from "./effective-facts.js";
import { deriveEffectiveFacts } from "./effective-facts.js";
import type { ProjectionReadError } from "./errors.js";
import { enforceFreshnessBarrier, withFreshnessEnvelope } from "./freshness.js";
import type {
  InboxReconcileDeps,
  InboxReconcileReport,
} from "./inbox-reconcile.js";
import { reconcileInbox } from "./inbox-reconcile.js";
import type { InboxViewDeps } from "./inbox-view.js";
import { deriveInboxView } from "./inbox-view.js";
import type { TranscriptDeps, TranscriptRequest } from "./transcript.js";
import { deriveTranscriptPage } from "./transcript.js";
import type { TreeViewDeps, TreeViewNode } from "./tree.js";
import { buildTreeView } from "./tree.js";
import type { UsageDeps } from "./usage.js";
import { deriveUsageRows } from "./usage.js";
import type { CurrentWorkDeps } from "./views/current-work.js";
import { deriveCurrentWork } from "./views/current-work.js";
import type { DependencyViewDeps } from "./views/dependency.js";
import { deriveDependencyRows } from "./views/dependency.js";
import type { VerificationViewDeps } from "./views/verification.js";
import { deriveVerificationView } from "./views/verification.js";
import type { WorkspaceDetailDeps } from "./views/workspace-detail.js";
import { deriveWorkspaceDetail } from "./views/workspace-detail.js";

// --- P10 `05` §1 signature freeze: ProjectionQueryPort bindings ---------
//
// The query runtime: per-view derive dispatch + the GQ5 {value,
// watermark, lag} envelope + the explicit freshness barrier (block with
// a bounded catch-up read, else refuse with the typed staleness
// marker). No implicit RYW: without a barrier the caller gets whatever
// the snapshot currently reflects — writes are never awaited. Zero
// canonical mutation (on-read derives over read faces only).

export interface ProjectionQueryRuntimeDeps {
  readonly journalLastSequence: (
    projectId: ProjectId,
  ) => Effect.Effect<number, ProjectionReadError>;
  readonly projectIdOfWorkspace: (
    workspaceId: WorkspaceId,
  ) => Effect.Effect<ProjectId, ProjectionReadError>;
  /** Watermark the derives currently reflect. Default: the canonical
   * journal lastSequence (on-read derives are current by construction;
   * a lagging materialization injects its own watermark here). */
  readonly snapshotWatermark?: (
    projectId: ProjectId,
  ) => Effect.Effect<number, ProjectionReadError>;
  /** Bounded catch-up the barrier blocks on before refusing. Default:
   * no-op (on-read derives need no catch-up; a materialized projection
   * injects its advance here). */
  readonly catchUp?: (
    projectId: ProjectId,
    fromSequence: number,
    toSequence: number,
  ) => Effect.Effect<number, ProjectionReadError>;
  readonly tree: TreeViewDeps;
  readonly attention: AttentionReadDeps;
  readonly workspaceDetail: WorkspaceDetailDeps;
  readonly currentWork: CurrentWorkDeps;
  readonly verification: VerificationViewDeps;
  readonly dependency: DependencyViewDeps;
  readonly transcript: TranscriptDeps;
  readonly usage: UsageDeps;
  readonly inboxView: InboxViewDeps;
  readonly effectiveFacts: EffectiveFactsDeps;
  readonly inboxReconcile: InboxReconcileDeps;
}

const unavailable = (cause: ProjectionReadError): ProjectionUnavailable => ({
  _tag: "ProjectionUnavailable",
  code: "projection/unavailable",
  category: "unavailable",
  correlationId: null,
  retryDisposition: "retryable",
  safeDetails: { cause: cause.cause },
});

const invalidRequest = (
  detail: Record<string, unknown>,
): ProjectionInvalidRequest => ({
  _tag: "ProjectionInvalidRequest",
  code: "projection/invalid-request",
  category: "invalid-request",
  correlationId: null,
  retryDisposition: "non-retryable",
  safeDetails: detail,
});

interface ViewPlan {
  readonly projectId: Effect.Effect<ProjectId, ProjectionReadError>;
  readonly loadValue: (
    projectId: ProjectId,
  ) => Effect.Effect<unknown, ProjectionReadError>;
}

/** Local structural restatement of api-contracts TreeViewRes. Projection
 * runtime intentionally depends only on domain + ports, so this boundary
 * adapter drops derive-only `children` and turns its nullable current-work
 * representation into the frozen wire optional. */
interface TreeViewWireNode {
  readonly workspaceId: WorkspaceId;
  readonly parentWorkspaceId: WorkspaceId | null;
  readonly name: string;
  readonly status: import("@arbor/domain").WorkspaceStatusLabel;
  readonly currentWork?: {
    readonly workId: WorkId;
    readonly objective: string;
    readonly status: Work["lifecycle"];
    readonly revision: Work["revision"];
  };
  readonly subtreeAttention: TreeViewNode["subtreeAttention"];
  readonly usageSummary?: TreeViewNode["usageSummary"];
}

interface TreeViewWireResult {
  readonly nodes: ReadonlyArray<TreeViewWireNode>;
}

/** Flatten the derive-side tree into preorder wire nodes. A workspace without
 * current work omits `currentWork` entirely; no `null` or dummy shape crosses
 * the API boundary. */
const flattenTreeNodes = (
  node: TreeViewNode,
): ReadonlyArray<TreeViewWireNode> => {
  const { children, currentWork, ...wireNode } = node;
  const current =
    currentWork === null ? wireNode : { ...wireNode, currentWork };
  return [current, ...children.flatMap((child) => flattenTreeNodes(child))];
};

/** Derive-input label mapping (derive vocabulary → P10 `05` §1 wire
 * vocabulary; no re-derivation, a rename). */
const wireAttentionSource = (source: string): string =>
  source === "WaitingOnVacantProducer"
    ? "VacantProducer"
    : source === "ReconciliationEscalated"
      ? "RecoveryEscalation"
      : source;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

/** Exhaustive ViewId dispatch: validate the frozen request core, plan
 * the projectId (envelope scope) and the value loader. */
const planView = (
  view: ViewId,
  request: unknown,
  deps: ProjectionQueryRuntimeDeps,
): Effect.Effect<ViewPlan, ProjectionQueryError> => {
  const req = isRecord(request) ? request : {};
  switch (view) {
    case "responsibility-tree": {
      if (typeof req.projectId !== "string") {
        return Effect.fail(
          invalidRequest({ view, message: "projectId required" }),
        );
      }
      const projectId = req.projectId as ProjectId;
      const depth = typeof req.depth === "number" ? req.depth : undefined;
      return Effect.succeed({
        projectId: Effect.succeed(projectId),
        loadValue: () =>
          Effect.map(
            depth !== undefined
              ? buildTreeView({ projectId, depth }, deps.tree)
              : buildTreeView({ projectId }, deps.tree),
            (node): TreeViewWireResult => ({ nodes: flattenTreeNodes(node) }),
          ),
      });
    }
    case "attention": {
      if (typeof req.projectId !== "string") {
        return Effect.fail(
          invalidRequest({ view, message: "projectId required" }),
        );
      }
      const projectId = req.projectId as ProjectId;
      return Effect.succeed({
        projectId: Effect.succeed(projectId),
        loadValue: () =>
          Effect.map(
            deriveProjectAttention(projectId, deps.attention),
            (rows) => ({
              rows: rows.map((row) => ({
                source: wireAttentionSource(row.source),
                severity: row.severity,
                targetWorkspaceId: row.targetWorkspaceId,
                dedupKey: row.dedupKey,
                summaryRef: row.summary,
                occurredAt: row.occurredAt ?? "",
              })),
            }),
          ),
      });
    }
    case "workspace-detail": {
      if (typeof req.workspaceId !== "string") {
        return Effect.fail(
          invalidRequest({ view, message: "workspaceId required" }),
        );
      }
      const workspaceId = req.workspaceId as WorkspaceId;
      return Effect.succeed({
        projectId: deps.projectIdOfWorkspace(workspaceId),
        loadValue: () =>
          deriveWorkspaceDetail(workspaceId, deps.workspaceDetail),
      });
    }
    case "current-work": {
      if (typeof req.workspaceId !== "string") {
        return Effect.fail(
          invalidRequest({ view, message: "workspaceId required" }),
        );
      }
      const workspaceId = req.workspaceId as WorkspaceId;
      return Effect.succeed({
        projectId: deps.projectIdOfWorkspace(workspaceId),
        loadValue: () => deriveCurrentWork(workspaceId, deps.currentWork),
      });
    }
    case "verification": {
      if (typeof req.workId !== "string") {
        return Effect.fail(
          invalidRequest({ view, message: "workId required" }),
        );
      }
      const workId = req.workId as WorkId;
      return Effect.succeed({
        projectId: Effect.flatMap(deps.verification.findWork(workId), (work) =>
          work._tag === "Some"
            ? deps.projectIdOfWorkspace(work.value.workspaceId)
            : Effect.fail({
                _tag: "ProjectionReadFailure" as const,
                cause: `no work ${workId}`,
              }),
        ),
        loadValue: () => deriveVerificationView(workId, deps.verification),
      });
    }
    case "dependency-view": {
      if (typeof req.projectId === "string") {
        const projectId = req.projectId as ProjectId;
        return Effect.succeed({
          projectId: Effect.succeed(projectId),
          loadValue: () =>
            Effect.map(
              deriveDependencyRows({ projectId }, deps.dependency),
              (rows) => ({ rows }),
            ),
        });
      }
      if (typeof req.workspaceId === "string") {
        const workspaceId = req.workspaceId as WorkspaceId;
        return Effect.succeed({
          projectId: deps.projectIdOfWorkspace(workspaceId),
          loadValue: () =>
            Effect.map(
              deriveDependencyRows({ workspaceId }, deps.dependency),
              (rows) => ({ rows }),
            ),
        });
      }
      return Effect.fail(
        invalidRequest({
          view,
          message: "exactly one of projectId|workspaceId required",
        }),
      );
    }
    case "transcript": {
      if (typeof req.workspaceId !== "string") {
        return Effect.fail(
          invalidRequest({ view, message: "workspaceId required" }),
        );
      }
      if (
        typeof req.limit !== "number" ||
        !Number.isInteger(req.limit) ||
        req.limit <= 0
      ) {
        return Effect.fail(
          invalidRequest({ view, message: "limit must be a positive integer" }),
        );
      }
      const transcriptRequest: TranscriptRequest = {
        workspaceId: req.workspaceId as WorkspaceId,
        sessionId: isRecord(request)
          ? (req.sessionId as TranscriptRequest["sessionId"])
          : undefined,
        cursor: isRecord(request)
          ? (req.cursor as TranscriptRequest["cursor"])
          : undefined,
        limit: req.limit,
      };
      return Effect.succeed({
        projectId: deps.projectIdOfWorkspace(transcriptRequest.workspaceId),
        loadValue: () =>
          deriveTranscriptPage(transcriptRequest, deps.transcript),
      });
    }
    case "usage": {
      if (typeof req.projectId !== "string") {
        return Effect.fail(
          invalidRequest({ view, message: "projectId required" }),
        );
      }
      if (
        req.groupBy !== "workspace" &&
        req.groupBy !== "subtree" &&
        req.groupBy !== "project"
      ) {
        return Effect.fail(
          invalidRequest({
            view,
            message: "groupBy must be workspace|subtree|project",
          }),
        );
      }
      const projectId = req.projectId as ProjectId;
      const groupBy = req.groupBy;
      return Effect.succeed({
        projectId: Effect.succeed(projectId),
        loadValue: () =>
          Effect.map(
            deriveUsageRows({ projectId, groupBy }, deps.usage),
            (rows) => ({ rows }),
          ),
      });
    }
    case "inbox-view": {
      if (typeof req.workspaceId !== "string") {
        return Effect.fail(
          invalidRequest({ view, message: "workspaceId required" }),
        );
      }
      const workspaceId = req.workspaceId as WorkspaceId;
      return Effect.succeed({
        projectId: deps.projectIdOfWorkspace(workspaceId),
        loadValue: () => deriveInboxView(workspaceId, deps.inboxView),
      });
    }
  }
};

const isProjectionQueryError = (
  error: unknown,
): error is ProjectionQueryError => {
  if (!isRecord(error)) {
    return false;
  }
  return (
    error._tag === "ProjectionStale" ||
    error._tag === "ProjectionUnavailable" ||
    error._tag === "ProjectionInvalidRequest"
  );
};

const toQueryError = (error: unknown): ProjectionQueryError =>
  isProjectionQueryError(error)
    ? error
    : unavailable(error as ProjectionReadError);

const serveView = (
  deps: ProjectionQueryRuntimeDeps,
  barrier: FreshnessRequirement | undefined,
  plan: ViewPlan,
): Effect.Effect<QueryResult<unknown>, ProjectionQueryError> =>
  Effect.mapError(
    Effect.flatMap(plan.projectId, (projectId) =>
      Effect.flatMap(deps.journalLastSequence(projectId), (last) =>
        enforceFreshnessBarrier({
          barrier,
          // The barrier decision is taken against the canonical frontier
          // observed at query start (monotonic; appends after that are
          // new writes — exactly the no-implicit-RYW boundary).
          lastSequence: last,
          readSnapshot: () =>
            Effect.gen(function* () {
              const watermark = yield* (
                deps.snapshotWatermark ?? deps.journalLastSequence
              )(projectId);
              const value = yield* plan.loadValue(projectId);
              return withFreshnessEnvelope(value, watermark, last);
            }),
          catchUp: (fromSequence, toSequence) =>
            deps.catchUp !== undefined
              ? deps.catchUp(projectId, fromSequence, toSequence)
              : Effect.succeed(0),
        }),
      ),
    ),
    toQueryError,
  );

/** Build the ProjectionQueryPortService over the injected read faces.
 * The `<Req, Res>` generics are the frozen ViewId ↔ request/response
 * pairing (api-contracts ViewRequestMap/ViewResponseMap; the dispatch
 * is exhaustive over ViewId and asserted by the p10 suites). */
export const makeProjectionQueryService = (
  deps: ProjectionQueryRuntimeDeps,
): ProjectionQueryPortService => ({
  query: (<Req, Res>(
    view: ViewId,
    request: Req,
    barrier?: FreshnessRequirement,
  ): Effect.Effect<QueryResult<Res>, ProjectionQueryError> =>
    Effect.flatMap(planView(view, request, deps), (plan) =>
      serveView(deps, barrier, plan),
    ) as Effect.Effect<
      QueryResult<Res>,
      ProjectionQueryError
    >) as ProjectionQueryPortService["query"],
});

// --- EffectiveFacts query face (P10 `03` §1: same envelope + barrier;
// not a ViewId — exposed alongside the port bindings) --------------------

export interface EffectiveFactsQueryFace {
  /** Bare derive — the P3 Context Builder consumption face (GQ2 single
   * source: read this, never re-derive a second copy). */
  readonly read: (
    workspaceId: WorkspaceId,
  ) => Effect.Effect<
    import("./effective-facts.js").EffectiveFactsSnapshot,
    ProjectionReadError
  >;
  /** Enveloped + barrier-gated query (GQ5). */
  readonly query: (
    workspaceId: WorkspaceId,
    barrier?: FreshnessRequirement,
  ) => Effect.Effect<
    QueryResult<import("./effective-facts.js").EffectiveFactsSnapshot>,
    ProjectionReadError | ProjectionQueryError
  >;
}

export const makeEffectiveFactsQueryFace = (
  deps: ProjectionQueryRuntimeDeps,
): EffectiveFactsQueryFace => {
  const derive = (workspaceId: WorkspaceId) =>
    Effect.flatMap(deps.projectIdOfWorkspace(workspaceId), (projectId) =>
      Effect.map(
        deriveEffectiveFacts(workspaceId, deps.effectiveFacts),
        (
          snapshot,
        ): {
          readonly projectId: ProjectId;
          readonly snapshot: import("./effective-facts.js").EffectiveFactsSnapshot;
        } => ({ projectId, snapshot }),
      ),
    );
  return {
    read: (workspaceId) =>
      Effect.map(derive(workspaceId), (loaded) => loaded.snapshot),
    query: (workspaceId, barrier) =>
      Effect.flatMap(derive(workspaceId), (loaded) =>
        Effect.mapError(
          Effect.flatMap(deps.journalLastSequence(loaded.projectId), (last) =>
            enforceFreshnessBarrier({
              barrier,
              lastSequence: last,
              readSnapshot: () =>
                Effect.gen(function* () {
                  const watermark = yield* (
                    deps.snapshotWatermark ?? deps.journalLastSequence
                  )(loaded.projectId);
                  return withFreshnessEnvelope(
                    loaded.snapshot,
                    watermark,
                    last,
                  );
                }),
              catchUp: (fromSequence, toSequence) =>
                deps.catchUp !== undefined
                  ? deps.catchUp(loaded.projectId, fromSequence, toSequence)
                  : Effect.succeed(0),
            }),
          ),
          toQueryError,
        ),
      ),
  };
};

// --- Inbox reconciliation audit face (P10 `04` §2) -----------------------
//
// Audit + drift report only — the pass never writes; repair goes via
// the P6 admission/consumption paths (operator-triggered).

export const runInboxReconciliation = (
  workspaceId: WorkspaceId,
  deps: InboxReconcileDeps,
): Effect.Effect<InboxReconcileReport, ProjectionReadError> =>
  reconcileInbox(workspaceId, deps);

export type { ProjectionStale };
