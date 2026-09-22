import type {
  Acceptance,
  Dependency,
  DomainEvent,
  EventTypeName,
  Execution,
  InboxEntry,
  ProjectId,
  ResourceBoundary,
  ResponsibilityDefinition,
  Verification,
  Work,
  WorkId,
  Workspace,
  WorkspaceId,
} from "@arbor/domain";
import type { EvidenceRecordRow } from "@arbor/ports";
import { Effect, Option } from "effect";
import type { ProjectionReadError } from "../errors.js";
import { projectionReadError } from "../errors.js";
import type {
  AuditTimelineEntryView,
  CurrentWorkSummaryView,
  DependencyRowView,
  ExecutionSummaryView,
  InboxUnconsumedEntryView,
  PendingWorkRefView,
  VerificationViewView,
} from "./shared.js";

export type {
  AuditTimelineEntryView,
  CurrentWorkSummaryView,
  DependencyRowView,
  ExecutionSummaryView,
  InboxUnconsumedEntryView,
  PendingWorkRefView,
  VerificationViewView,
};

// --- P10 `01` §1 Workspace Detail (SD §12.4 ①–⑥) ------------------------
//
// Shapes mirror the frozen api-contracts cores (P10 `05` §1,
// WorkspaceDetailReq/Res) — projection-runtime depends on domain + ports
// only, so the cores are restated verbatim here and asserted structurally
// in the test suite. ⑥ = audit timeline from domain_events (the frozen
// Memory/Decisions-store substitute — P10 `00` boundary list).

export interface WorkspaceDetailView {
  readonly responsibility: ResponsibilityDefinition;
  readonly boundary: ResourceBoundary;
  readonly currentWork?: CurrentWorkSummaryView | undefined;
  readonly pendingWorks: ReadonlyArray<PendingWorkRefView>;
  readonly executionSummary?: ExecutionSummaryView | undefined;
  readonly dependencies: ReadonlyArray<DependencyRowView>;
  readonly inboxUnconsumed: ReadonlyArray<InboxUnconsumedEntryView>;
  readonly verification?: VerificationViewView | undefined;
  readonly auditTimeline: ReadonlyArray<AuditTimelineEntryView>;
}

/** Read faces the Workspace Detail derives from (P10 `01` §1 derive
 * inputs: workspaces / works / executions / dependencies+messages+inbox /
 * verification+evidence / journal). Injected; read-only; never writes. */
export interface WorkspaceDetailDeps {
  readonly findWorkspace: (
    workspaceId: WorkspaceId,
  ) => Effect.Effect<Option.Option<Workspace>, ProjectionReadError>;
  readonly findWork: (
    workId: WorkId,
  ) => Effect.Effect<Option.Option<Work>, ProjectionReadError>;
  readonly listWorksByWorkspace: (
    workspaceId: WorkspaceId,
  ) => Effect.Effect<ReadonlyArray<Work>, ProjectionReadError>;
  readonly findActiveMainExecution: (
    workspaceId: WorkspaceId,
  ) => Effect.Effect<Option.Option<Execution>, ProjectionReadError>;
  readonly listDependenciesByWorkspace: (
    workspaceId: WorkspaceId,
  ) => Effect.Effect<ReadonlyArray<Dependency>, ProjectionReadError>;
  readonly listUnconsumedInbox: (
    workspaceId: WorkspaceId,
  ) => Effect.Effect<ReadonlyArray<InboxEntry>, ProjectionReadError>;
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
  readonly journalLastSequence: (
    projectId: ProjectId,
  ) => Effect.Effect<number, ProjectionReadError>;
  readonly readEventsAfter: (
    projectId: ProjectId,
    sequence: number,
    limit: number,
  ) => Effect.Effect<ReadonlyArray<DomainEvent<unknown>>, ProjectionReadError>;
  /** DecisionRecorded carries only the proposal id — the originating
   * workspace resolves through the formation-proposal parent. */
  readonly proposalOriginWorkspace: (
    proposalId: string,
  ) => Effect.Effect<Option.Option<WorkspaceId>, ProjectionReadError>;
}

// --- ⑥ audit timeline (P10 `06` §3: intervention facts, journal order) ---

/** The frozen intervention/governance event filter (P10 `00` boundary:
 * audit timeline renders intervention facts in order). */
export const AUDIT_TIMELINE_EVENT_TYPES: ReadonlyArray<EventTypeName> = [
  "HumanInterventionApplied",
  "WorkSteered",
  "DecisionRecorded",
];

const asRecord = (payload: unknown): Record<string, unknown> =>
  typeof payload === "object" && payload !== null
    ? (payload as Record<string, unknown>)
    : {};

/** Journal-sequenced audit timeline scoped to one workspace: an event
 * renders when its payload targets the workspace (targetWorkspaceId), a
 * work of the workspace (workId), or its aggregate is a formation
 * proposal originating at the workspace (DecisionRecorded). */
export const deriveAuditTimeline = (
  workspaceId: WorkspaceId,
  events: ReadonlyArray<DomainEvent<unknown>>,
  workIdsOfWorkspace: ReadonlySet<WorkId>,
  proposalOrigin: (proposalId: string) => WorkspaceId | null,
): ReadonlyArray<AuditTimelineEntryView> => {
  const timeline: Array<AuditTimelineEntryView> = [];
  for (const event of events) {
    if (!AUDIT_TIMELINE_EVENT_TYPES.includes(event.eventType)) {
      continue;
    }
    const payload = asRecord(event.payload);
    const targetWorkspaceId =
      typeof payload.targetWorkspaceId === "string"
        ? payload.targetWorkspaceId
        : null;
    const workId = typeof payload.workId === "string" ? payload.workId : null;
    const proposalId =
      typeof payload.proposalId === "string" ? payload.proposalId : null;
    const scoped =
      targetWorkspaceId === workspaceId ||
      (workId !== null && workIdsOfWorkspace.has(workId as WorkId)) ||
      (proposalId !== null && proposalOrigin(proposalId) === workspaceId);
    if (scoped) {
      timeline.push({
        sequence: Number(event.sequence),
        eventType: event.eventType,
        at: event.occurredAt,
      });
    }
  }
  timeline.sort((a, b) => a.sequence - b.sequence);
  return timeline;
};

const readAllEvents = (
  projectId: ProjectId,
  deps: WorkspaceDetailDeps,
): Effect.Effect<ReadonlyArray<DomainEvent<unknown>>, ProjectionReadError> =>
  Effect.gen(function* () {
    const events: Array<DomainEvent<unknown>> = [];
    const limit = 500;
    let cursor = 0;
    while (true) {
      const page = yield* deps.readEventsAfter(projectId, cursor, limit);
      events.push(...page);
      if (page.length < limit) {
        return events;
      }
      cursor = Number(page[page.length - 1]?.sequence ?? cursor);
    }
  });

/** Workspace Detail derive — read-only over canonical tables + journal. */
export const deriveWorkspaceDetail = (
  workspaceId: WorkspaceId,
  deps: WorkspaceDetailDeps,
): Effect.Effect<WorkspaceDetailView, ProjectionReadError> =>
  Effect.gen(function* () {
    const found = yield* deps.findWorkspace(workspaceId);
    if (Option.isNone(found)) {
      return yield* Effect.fail(
        projectionReadError(`no workspace ${workspaceId}`),
      );
    }
    const workspace = found.value;

    const works = yield* deps.listWorksByWorkspace(workspaceId);
    const ownedWorkIds = new Set(works.map((work) => work.workId));
    const openWorks = works.filter((work) => work.lifecycle === "Open");

    const activeMain = yield* deps.findActiveMainExecution(workspaceId);
    const executionSummary: ExecutionSummaryView | undefined = Option.isSome(
      activeMain,
    )
      ? {
          executionId: activeMain.value.executionId,
          admittedAt: activeMain.value.admittedAt,
        }
      : undefined;

    let currentWork: CurrentWorkSummaryView | undefined;
    if (workspace.currentWorkId !== null) {
      const work = yield* deps.findWork(workspace.currentWorkId);
      if (Option.isSome(work)) {
        currentWork = {
          workId: work.value.workId,
          objective: work.value.objective,
          status: work.value.lifecycle,
          activeExecution: executionSummary,
        };
      }
    }

    const dependencies = yield* deps.listDependenciesByWorkspace(workspaceId);
    const inbox = yield* deps.listUnconsumedInbox(workspaceId);
    const watermark = yield* deps.journalLastSequence(workspace.projectId);

    // ⑤ verification: the Open verification of the current work first,
    // else any Open verification of the workspace's works; a workspace
    // with no Open verification renders none (the per-work Verification
    // view covers concluded history).
    const verificationTargets =
      workspace.currentWorkId !== null
        ? [workspace.currentWorkId, ...works.map((work) => work.workId)]
        : works.map((work) => work.workId);
    let verificationView: VerificationViewView | undefined;
    for (const workId of verificationTargets) {
      const rows = yield* deps.listVerificationsByWork(workId);
      const open = rows.find((row) => row.state.status === "Open");
      if (open === undefined) {
        continue;
      }
      const evidence = yield* deps.listEvidenceByVerification(
        open.verificationId,
      );
      const acceptance = yield* deps.findAcceptanceByWorkRevision(
        open.workId,
        open.targetWorkRevision,
      );
      verificationView = {
        verificationId: open.verificationId,
        verdict: undefined,
        criteriaResults: open.missionSnapshot.criteria.map((criterion) => ({
          criterionId: criterion.criterionId,
          requirement: criterion.requirement,
          required: criterion.required,
          // Canonical persistence carries the aggregate verdict only
          // (P8 frozen stores): per-criterion verdicts are not persisted,
          // so an Open verification renders Unknown per criterion rather
          // than inventing one.
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
      break;
    }

    const events = yield* readAllEvents(workspace.projectId, deps);
    const proposalOrigins = new Map<string, WorkspaceId>();
    for (const event of events) {
      if (event.eventType !== "DecisionRecorded") {
        continue;
      }
      const proposalId = asRecord(event.payload).proposalId;
      if (typeof proposalId === "string" && !proposalOrigins.has(proposalId)) {
        const origin = yield* deps.proposalOriginWorkspace(proposalId);
        if (Option.isSome(origin)) {
          proposalOrigins.set(proposalId, origin.value);
        }
      }
    }
    const auditTimeline = deriveAuditTimeline(
      workspaceId,
      events,
      ownedWorkIds,
      (proposalId) => proposalOrigins.get(proposalId) ?? null,
    );

    return {
      responsibility: workspace.responsibilityDefinition,
      boundary: workspace.resourceBoundary,
      currentWork,
      pendingWorks: openWorks
        .filter(
          (work) =>
            workspace.currentWorkId === null ||
            work.workId !== workspace.currentWorkId,
        )
        .map((work) => ({ workId: work.workId, objective: work.objective })),
      executionSummary,
      dependencies: dependencies.map((dependency) => ({
        dependencyId: dependency.dependencyId,
        consumerWorkId: dependency.consumerWorkId,
        binding: dependency.producerBinding,
        state: dependency.state,
        satisfiedBy: dependency.satisfiedByDeliverableId ?? undefined,
      })),
      inboxUnconsumed: inbox.map((entry) => ({
        entryKey: entry.entryKey,
        kind: entry.kind,
        summary: entry.summary,
        watermark,
      })),
      verification: verificationView,
      auditTimeline,
    };
  });
