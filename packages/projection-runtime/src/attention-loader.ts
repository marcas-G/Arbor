import type {
  Dependency,
  DomainEvent,
  ExecutionSettlement,
  ProjectId,
  Verification,
  Work,
  WorkId,
  Workspace,
  WorkspaceId,
} from "@arbor/domain";
import { Effect, Option } from "effect";
import {
  type AttentionFacts,
  type AttentionRow,
  type DeadlockEventFact,
  deriveAttentionRows,
  type EscalationEventFact,
  type ExecutionSettlementFact,
  type OpenVerificationFact,
  type SafetyStopFact,
  type UnfulfillableEventFact,
  type VacantProducerCandidateFact,
  type WorkOwnerFact,
  type WorkspaceVacancyFact,
} from "./attention.js";
import type { ProjectionReadError } from "./errors.js";

/** Execution settlement read face (the domain Execution carries no
 * settledAt; the read side supplies it). */
export interface ExecutionSettlementReadFact {
  readonly executionId: string;
  readonly workspaceId: WorkspaceId;
  readonly settlement: ExecutionSettlement | null;
  readonly settledAt: string | null;
}

/** Read faces the Attention read-model derives from (read-only over
 * canonical tables + journal; injected — the package itself owns no
 * storage and never writes). */
export interface AttentionReadDeps {
  readonly listWorkspacesByProject: (
    projectId: ProjectId,
  ) => Effect.Effect<ReadonlyArray<Workspace>, ProjectionReadError>;
  readonly listWorksByWorkspace: (
    workspaceId: WorkspaceId,
  ) => Effect.Effect<ReadonlyArray<Work>, ProjectionReadError>;
  readonly listExecutionSettlementFacts: (
    projectId: ProjectId,
  ) => Effect.Effect<
    ReadonlyArray<ExecutionSettlementReadFact>,
    ProjectionReadError
  >;
  readonly listOpenVerifications: () => Effect.Effect<
    ReadonlyArray<Verification>,
    ProjectionReadError
  >;
  readonly listUnsatisfiedDependencies: (
    projectId: ProjectId,
  ) => Effect.Effect<ReadonlyArray<Dependency>, ProjectionReadError>;
  readonly findDependency: (
    dependencyId: string,
  ) => Effect.Effect<Option.Option<Dependency>, ProjectionReadError>;
  readonly readEvents: (
    projectId: ProjectId,
  ) => Effect.Effect<ReadonlyArray<DomainEvent<unknown>>, ProjectionReadError>;
}

const asRecord = (payload: unknown): Record<string, unknown> =>
  typeof payload === "object" && payload !== null
    ? (payload as Record<string, unknown>)
    : {};

const isRuntimeSafetyStop = (settlement: ExecutionSettlement | null): boolean =>
  settlement !== null &&
  settlement._tag === "Interrupted" &&
  settlement.result._tag === "ControlledInterruption" &&
  settlement.result.reason === "RuntimeSafetyStop";

/** Extracts the six-source fact inputs from canonical state + journal
 * (read-only). The GAP-01 vacant-producer join is evaluated here on read
 * — a live join over canonical rows, no materialization (P7-GAP-01
 * ruling). */
export const loadAttentionFacts = (
  projectId: ProjectId,
  deps: AttentionReadDeps,
): Effect.Effect<AttentionFacts, ProjectionReadError> =>
  Effect.gen(function* () {
    const workspaces = yield* deps.listWorkspacesByProject(projectId);
    const executionFacts = yield* deps.listExecutionSettlementFacts(projectId);
    const openVerifications = yield* deps.listOpenVerifications();
    const unsatisfied = yield* deps.listUnsatisfiedDependencies(projectId);
    const events = yield* deps.readEvents(projectId);

    const workOwners: Array<WorkOwnerFact> = [];
    const workspaceVacancies: Array<WorkspaceVacancyFact> = [];
    for (const workspace of workspaces) {
      const works = yield* deps.listWorksByWorkspace(workspace.workspaceId);
      for (const work of works) {
        workOwners.push({
          workId: work.workId,
          workspaceId: workspace.workspaceId,
        });
      }
      workspaceVacancies.push({
        workspaceId: workspace.workspaceId,
        lifecycle: workspace.lifecycle,
        hasOpenWork: works.some((work) => work.lifecycle === "Open"),
      });
    }
    const ownerOf = new Map(workOwners.map((o) => [o.workId, o.workspaceId]));
    const executionWorkspaceOf = new Map(
      executionFacts.map((fact) => [fact.executionId, fact.workspaceId]),
    );

    const unfulfillableEvents: Array<UnfulfillableEventFact> = [];
    const deadlockEvents: Array<DeadlockEventFact> = [];
    const escalationEvents: Array<EscalationEventFact> = [];
    for (const event of events) {
      if (event.eventType === "DependencyMarkedUnfulfillable") {
        const payload = asRecord(event.payload);
        const dependencyId = String(payload.dependencyId ?? "");
        const dependency = yield* deps.findDependency(dependencyId);
        if (Option.isSome(dependency)) {
          unfulfillableEvents.push({
            dependencyId,
            dependencyRevision: Number(payload.dependencyRevision ?? 0),
            consumerWorkId: dependency.value.consumerWorkId,
            occurredAt: event.occurredAt,
          });
        }
      } else if (event.eventType === "DeadlockAttentionRequested") {
        const payload = asRecord(event.payload);
        deadlockEvents.push({
          cycleWorkIds: (Array.isArray(payload.cycleWorkIds)
            ? payload.cycleWorkIds
            : []) as ReadonlyArray<WorkId>,
          dependencyIds: Array.isArray(payload.dependencyIds)
            ? payload.dependencyIds.map(String)
            : [],
          detectedAt:
            typeof payload.detectedAt === "string"
              ? payload.detectedAt
              : event.occurredAt,
        });
      } else if (event.eventType === "ReconciliationEscalated") {
        const payload = asRecord(event.payload);
        const executionId = String(payload.executionId ?? "");
        const workspaceId = executionWorkspaceOf.get(executionId);
        if (workspaceId !== undefined) {
          escalationEvents.push({
            executionId,
            invocationRefsFingerprint: String(
              payload.invocationRefsFingerprint ?? "",
            ),
            workspaceId,
            occurredAt: event.occurredAt,
          });
        }
      }
    }

    const safetyStopSettlements: Array<SafetyStopFact> = executionFacts
      .filter((fact) => isRuntimeSafetyStop(fact.settlement))
      .map((fact) => ({
        executionId: fact.executionId,
        workspaceId: fact.workspaceId,
        settledAt: fact.settledAt,
      }));

    const executionSettlements: ReadonlyArray<ExecutionSettlementFact> =
      executionFacts.map((fact) => ({
        executionId: fact.executionId,
        settled: fact.settlement !== null,
        settledAt: fact.settledAt,
      }));

    const openVerificationFacts: Array<OpenVerificationFact> = [];
    for (const verification of openVerifications) {
      if (verification.state.status !== "Open") {
        continue;
      }
      const owner = ownerOf.get(verification.workId);
      if (owner === undefined) {
        continue;
      }
      openVerificationFacts.push({
        verificationId: verification.verificationId,
        ownerWorkspaceId: owner,
        executionIds: verification.verificationExecutionIds,
      });
    }

    const vacantProducerCandidates: Array<VacantProducerCandidateFact> = [];
    for (const dependency of unsatisfied) {
      if (
        dependency.state !== "Unsatisfied" ||
        dependency.producerBinding._tag !== "WorkspaceBound"
      ) {
        continue;
      }
      vacantProducerCandidates.push({
        dependencyId: dependency.dependencyId,
        producerWorkspaceId: dependency.producerBinding.workspaceId,
        consumerWorkId: dependency.consumerWorkId,
      });
    }

    return {
      unfulfillableEvents,
      deadlockEvents,
      safetyStopSettlements,
      reconciliationEscalatedEvents: escalationEvents,
      openVerifications: openVerificationFacts,
      executionSettlements,
      vacantProducerCandidates,
      workspaceVacancies,
      workOwners,
    };
  });

/** Attention view entry: pure function of canonical state + journal —
 * load facts, derive deduplicated rows (P10 `02` §3). Zero canonical
 * mutation; disposition of any row is a human/parent governance command. */
export const deriveProjectAttention = (
  projectId: ProjectId,
  deps: AttentionReadDeps,
): Effect.Effect<ReadonlyArray<AttentionRow>, ProjectionReadError> =>
  Effect.map(loadAttentionFacts(projectId, deps), deriveAttentionRows);
