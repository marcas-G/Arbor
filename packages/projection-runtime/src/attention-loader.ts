import type {
  Dependency,
  DomainEvent,
  ExecutionSettlement,
  ProjectId,
  Verification,
  Work,
  WorkBlocker,
  WorkId,
  Workspace,
  WorkspaceId,
} from "@arbor/domain";
import type {
  AssignWorkBindingAttentionFact,
  AssignWorkBindingAttentionProjectionRow,
  DeliverReplayAttentionProjectionRow,
  ToolObservationReplayAttentionProjectionRow,
  SubmittedDecisionBindingAttentionFact,
  SubmittedDecisionBindingAttentionProjectionRow,
  WorkspaceResourceActivationAttentionProjectionRow,
} from "@arbor/ports";
import { Effect, Option } from "effect";
import {
  type AssignWorkBindingFailureEventFact,
  type AttentionFacts,
  type AttentionRow,
  type DeadlockEventFact,
  deriveAttentionRows,
  type EscalationEventFact,
  type ExecutionSettlementFact,
  type OpenVerificationFact,
  type SafetyStopFact,
  type SubmittedDecisionBindingFailureEventFact,
  type UnfulfillableEventFact,
  type VacantProducerCandidateFact,
  type WorkOwnerFact,
  type WorkspaceVacancyFact,
} from "./attention.js";
import type {
  ProjectionIntegrityFailure,
  ProjectionReadError,
  ProjectionReadResultError,
} from "./errors.js";

/** Execution settlement read face (the domain Execution carries no
 * settledAt; the read side supplies it). */
export interface ExecutionSettlementReadFact {
  readonly executionId: string;
  readonly workspaceId: WorkspaceId;
  readonly settlement: ExecutionSettlement | null;
  readonly settledAt: string | null;
  readonly settlementKind?: string | null;
  readonly settlementMalformed?: boolean;
}

/** Internal canonical source binding used only to decide whether a
 * Work-bound Attention source belongs to the current Work revision. The
 * serialized episode remains opaque here so malformed/unknown versions fail
 * closed in the projection rather than being guessed by an adapter. */
export interface AttentionSourceExecutionBinding {
  readonly executionId: string;
  readonly projectId: ProjectId;
  readonly workspaceId: WorkspaceId;
  readonly episodeJson: string | null;
  readonly workId: string | null;
  readonly workProjectId: ProjectId | null;
  readonly workWorkspaceId: WorkspaceId | null;
  readonly workRevision: number | null;
}

type AttentionWorkBoundSourceKind =
  | "RuntimeSafetyEnvelope"
  | "ReconciliationEscalated"
  | "AssignWorkTargetBindingFailure"
  | "DeliverReplayFailure";

type AttentionSourceIntegrityReason =
  | "SourceExecutionMissing"
  | "SourceExecutionNonUnique"
  | "SourceEpisodeStateMissing"
  | "SourceEpisodeStateNonUnique"
  | "EpisodeMalformed"
  | "EpisodeVersionUnsupported"
  | "SourceFactEventMismatch"
  | "SourceEventExecutionMismatch"
  | "SourceProjectMismatch"
  | "SourceWorkspaceMismatch"
  | "SourceTargetMismatch"
  | "WorkMissing"
  | "WorkScopeMismatch"
  | "FutureWorkRevision"
  | "SettlementMalformed";

export interface AttentionProjectionIntegrityFailure
  extends ProjectionIntegrityFailure {
  readonly projectId: ProjectId;
  readonly workspaceId: WorkspaceId;
  readonly workId?: WorkId;
  readonly executionId: string;
  readonly sourceKind: AttentionWorkBoundSourceKind;
  readonly reasonCode: AttentionSourceIntegrityReason;
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
  readonly listAttentionSourceExecutionBindings: (
    projectId: ProjectId,
    executionIds: ReadonlyArray<string>,
  ) => Effect.Effect<
    ReadonlyArray<AttentionSourceExecutionBinding>,
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
  readonly findAssignWorkBindingFailure?: (
    attentionFactId: string,
  ) => Effect.Effect<
    Option.Option<AssignWorkBindingAttentionFact>,
    ProjectionReadError
  >;
  readonly findSubmittedDecisionBindingFailure?: (
    attentionFactId: string,
  ) => Effect.Effect<
    Option.Option<SubmittedDecisionBindingAttentionFact>,
    ProjectionReadError
  >;
  /** Production P10 materialization. Other historical Attention sources
   * continue to use their existing read derivation. */
  readonly listProjectedAssignWorkBindingFailures?: (
    projectId: ProjectId,
  ) => Effect.Effect<
    ReadonlyArray<AssignWorkBindingAttentionProjectionRow>,
    ProjectionReadError
  >;
  readonly listProjectedDeliverReplayFailures?: (
    projectId: ProjectId,
  ) => Effect.Effect<
    ReadonlyArray<DeliverReplayAttentionProjectionRow>,
    ProjectionReadError
  >;
  readonly listProjectedSubmittedDecisionBindingFailures?: (
    projectId: ProjectId,
  ) => Effect.Effect<
    ReadonlyArray<SubmittedDecisionBindingAttentionProjectionRow>,
    ProjectionReadError
  >;
  readonly listProjectedWorkspaceResourceActivations?: (
    projectId: ProjectId,
  ) => Effect.Effect<
    ReadonlyArray<WorkspaceResourceActivationAttentionProjectionRow>,
    ProjectionReadError
  >;
  /** Current-state Blocked source; implementations must read the canonical
   * WorkBlocker ledger rather than reconstructing it from retained events. */
  readonly listWorkBlockersByWorkRevision?: (
    workId: WorkId,
    workRevision: number,
  ) => Effect.Effect<ReadonlyArray<WorkBlocker>, ProjectionReadError>;
  /** True only for an active exact WorkEpisode at this Work revision. */
  readonly hasActiveWorkEpisode?: (
    workId: WorkId,
    workRevision: number,
  ) => Effect.Effect<boolean, ProjectionReadError>;
  readonly listProjectedToolObservationReplayFailures?: (
    projectId: ProjectId,
  ) => Effect.Effect<
    ReadonlyArray<ToolObservationReplayAttentionProjectionRow>,
    ProjectionReadError
  >;
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

const isValidInterruptedSettlement = (
  settlement: ExecutionSettlement | null,
): boolean =>
  settlement !== null &&
  settlement._tag === "Interrupted" &&
  (settlement.result._tag === "StopRequested" ||
    (settlement.result._tag === "ControlledInterruption" &&
      typeof settlement.result.reason === "string"));

const integrityFailure = (input: {
  readonly projectId: ProjectId;
  readonly workspaceId: WorkspaceId;
  readonly executionId: string;
  readonly sourceKind: AttentionWorkBoundSourceKind;
  readonly reasonCode: AttentionSourceIntegrityReason;
  readonly workId?: WorkId;
}): AttentionProjectionIntegrityFailure => {
  const safeDetails = {
    projectId: input.projectId,
    workspaceId: input.workspaceId,
    executionId: input.executionId,
    sourceKind: input.sourceKind,
    reasonCode: input.reasonCode,
    ...(input.workId === undefined ? {} : { workId: input.workId }),
  };
  return {
    _tag: "ProjectionIntegrityFailure",
    code: "projection/unavailable",
    category: "unavailable",
    correlationId: null,
    retryDisposition: "non-retryable",
    safeDetails,
    ...input,
  };
};

const sameWorkEpisode = (
  raw: string,
):
  | { readonly workId: string; readonly targetWorkRevision: number }
  | { readonly reason: "EpisodeMalformed" | "EpisodeVersionUnsupported" } => {
  try {
    const episode: unknown = JSON.parse(raw);
    if (typeof episode !== "object" || episode === null) {
      return { reason: "EpisodeMalformed" };
    }
    const value = episode as Record<string, unknown>;
    if (value._tag !== "WorkEpisode") {
      return { reason: "EpisodeVersionUnsupported" };
    }
    if (
      typeof value.workId !== "string" ||
      !Number.isSafeInteger(value.targetWorkRevision) ||
      Number(value.targetWorkRevision) < 0
    ) {
      return { reason: "EpisodeMalformed" };
    }
    return {
      workId: value.workId,
      targetWorkRevision: Number(value.targetWorkRevision),
    };
  } catch {
    return { reason: "EpisodeMalformed" };
  }
};

interface WorkBoundAttentionReference {
  readonly executionId: string;
  readonly workspaceId: WorkspaceId;
  readonly targetWorkspaceId?: WorkspaceId;
  readonly sourceKind: AttentionWorkBoundSourceKind;
}

const activeWorkBoundExecutions = (
  projectId: ProjectId,
  references: ReadonlyArray<WorkBoundAttentionReference>,
  deps: AttentionReadDeps,
): Effect.Effect<ReadonlySet<string>, ProjectionReadResultError> =>
  Effect.gen(function* () {
    if (references.length === 0) return new Set<string>();
    const executionIds = [
      ...new Set(references.map((source) => source.executionId)),
    ];
    const bindings = yield* deps.listAttentionSourceExecutionBindings(
      projectId,
      executionIds,
    );
    const active = new Set<string>();
    for (const source of references) {
      const matching = bindings.filter(
        (binding) => binding.executionId === source.executionId,
      );
      const fail = (
        reasonCode: AttentionSourceIntegrityReason,
        workId?: WorkId,
      ) =>
        integrityFailure({
          projectId,
          workspaceId: source.workspaceId,
          executionId: source.executionId,
          sourceKind: source.sourceKind,
          reasonCode,
          ...(workId === undefined ? {} : { workId }),
        });
      if (matching.length === 0) {
        return yield* Effect.fail(fail("SourceExecutionMissing"));
      }
      if (matching.length !== 1) {
        return yield* Effect.fail(fail("SourceExecutionNonUnique"));
      }
      const binding = matching[0];
      if (binding === undefined) {
        return yield* Effect.fail(fail("SourceExecutionMissing"));
      }
      if (binding.projectId !== projectId) {
        return yield* Effect.fail(fail("SourceProjectMismatch"));
      }
      if (binding.workspaceId !== source.workspaceId) {
        return yield* Effect.fail(
          fail(
            source.targetWorkspaceId === undefined
              ? "SourceWorkspaceMismatch"
              : "SourceTargetMismatch",
          ),
        );
      }
      if (
        source.targetWorkspaceId !== undefined &&
        source.targetWorkspaceId !== binding.workspaceId
      ) {
        return yield* Effect.fail(fail("SourceTargetMismatch"));
      }
      if (binding.episodeJson === null) {
        return yield* Effect.fail(fail("SourceEpisodeStateMissing"));
      }
      const episode = sameWorkEpisode(binding.episodeJson);
      if ("reason" in episode) {
        return yield* Effect.fail(fail(episode.reason));
      }
      const workId = episode.workId as WorkId;
      if (binding.workId === null || binding.workRevision === null) {
        return yield* Effect.fail(fail("WorkMissing", workId));
      }
      if (
        binding.workId !== episode.workId ||
        binding.workProjectId !== projectId ||
        binding.workWorkspaceId !== source.workspaceId
      ) {
        return yield* Effect.fail(fail("WorkScopeMismatch", workId));
      }
      if (episode.targetWorkRevision > binding.workRevision) {
        return yield* Effect.fail(fail("FutureWorkRevision", workId));
      }
      if (episode.targetWorkRevision === binding.workRevision) {
        active.add(source.executionId);
      }
    }
    return active;
  });

/** Extracts the six-source fact inputs from canonical state + journal
 * (read-only). The GAP-01 vacant-producer join is evaluated here on read
 * — a live join over canonical rows, no materialization (P7-GAP-01
 * ruling). */
export const loadAttentionFacts = (
  projectId: ProjectId,
  deps: AttentionReadDeps,
): Effect.Effect<AttentionFacts, ProjectionReadResultError> =>
  Effect.gen(function* () {
    const workspaces = yield* deps.listWorkspacesByProject(projectId);
    const executionFacts = yield* deps.listExecutionSettlementFacts(projectId);
    const openVerifications = yield* deps.listOpenVerifications();
    const unsatisfied = yield* deps.listUnsatisfiedDependencies(projectId);
    const events = yield* deps.readEvents(projectId);

    const workOwners: Array<WorkOwnerFact> = [];
    const workspaceVacancies: Array<WorkspaceVacancyFact> = [];
    const workBlockers: Array<WorkBlocker> = [];
    const activeWorkEpisodeIds: Array<WorkId> = [];
    for (const workspace of workspaces) {
      const works = yield* deps.listWorksByWorkspace(workspace.workspaceId);
      for (const work of works) {
        workOwners.push({
          workId: work.workId,
          workspaceId: workspace.workspaceId,
        });
        if (
          work.lifecycle === "Open" &&
          deps.listWorkBlockersByWorkRevision !== undefined
        ) {
          const currentBlockers = yield* deps.listWorkBlockersByWorkRevision(
            work.workId,
            work.revision,
          );
          workBlockers.push(
            ...currentBlockers.filter(
              (blocker) =>
                blocker.projectId === projectId &&
                blocker.workspaceId === workspace.workspaceId &&
                blocker.workId === work.workId &&
                blocker.targetWorkRevision === work.revision &&
                blocker.state === "Open",
            ),
          );
          if (
            deps.hasActiveWorkEpisode !== undefined &&
            (yield* deps.hasActiveWorkEpisode(work.workId, work.revision))
          ) {
            activeWorkEpisodeIds.push(work.workId);
          }
        }
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
    const assignWorkBindingFailureEvents: Array<AssignWorkBindingFailureEventFact> =
      [];
    const sourceReferences: Array<WorkBoundAttentionReference> = [];
    const submittedDecisionBindingFailureEvents: Array<SubmittedDecisionBindingFailureEventFact> =
      [];
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
        if (
          executionId.length === 0 ||
          event.eventVersion !== 1 ||
          event.projectId !== projectId ||
          event.aggregateRef !== executionId
        ) {
          return yield* Effect.fail(
            integrityFailure({
              projectId,
              workspaceId: workspaceId ?? ("" as WorkspaceId),
              executionId,
              sourceKind: "ReconciliationEscalated",
              reasonCode: "SourceEventExecutionMismatch",
            }),
          );
        }
        if (workspaceId === undefined) {
          const candidates = yield* deps.listAttentionSourceExecutionBindings(
            projectId,
            [executionId],
          );
          if (candidates.length === 0) {
            return yield* Effect.fail(
              integrityFailure({
                projectId,
                workspaceId: "" as WorkspaceId,
                executionId,
                sourceKind: "ReconciliationEscalated",
                reasonCode: "SourceExecutionMissing",
              }),
            );
          }
          if (candidates.length !== 1) {
            return yield* Effect.fail(
              integrityFailure({
                projectId,
                workspaceId: candidates[0]?.workspaceId ?? ("" as WorkspaceId),
                executionId,
                sourceKind: "ReconciliationEscalated",
                reasonCode: "SourceExecutionNonUnique",
              }),
            );
          }
          const candidate = candidates[0];
          if (candidate?.projectId !== projectId) {
            return yield* Effect.fail(
              integrityFailure({
                projectId,
                workspaceId: candidate?.workspaceId ?? ("" as WorkspaceId),
                executionId,
                sourceKind: "ReconciliationEscalated",
                reasonCode: "SourceProjectMismatch",
              }),
            );
          }
          return yield* Effect.fail(
            integrityFailure({
              projectId,
              workspaceId: candidate.workspaceId,
              executionId,
              sourceKind: "ReconciliationEscalated",
              reasonCode: "SourceExecutionMissing",
            }),
          );
        }
        sourceReferences.push({
          executionId,
          workspaceId,
          sourceKind: "ReconciliationEscalated",
        });
        escalationEvents.push({
          executionId,
          invocationRefsFingerprint: String(
            payload.invocationRefsFingerprint ?? "",
          ),
          workspaceId,
          occurredAt: event.occurredAt,
        });
      } else if (event.eventType === "AssignWorkTargetBindingEscalated") {
        const payload = asRecord(event.payload);
        const attentionFactId = String(payload.attentionFactId ?? "");
        const executionId = String(payload.executionId ?? "");
        const targetWorkspaceId = String(
          payload.targetWorkspaceId ?? event.aggregateRef,
        ) as WorkspaceId;
        if (
          attentionFactId.length === 0 ||
          executionId.length === 0 ||
          deps.findAssignWorkBindingFailure === undefined
        ) {
          return yield* Effect.fail(
            integrityFailure({
              projectId,
              workspaceId: targetWorkspaceId,
              executionId,
              sourceKind: "AssignWorkTargetBindingFailure",
              reasonCode: "SourceFactEventMismatch",
            }),
          );
        }
        const source =
          yield* deps.findAssignWorkBindingFailure(attentionFactId);
        if (Option.isNone(source)) {
          return yield* Effect.fail(
            integrityFailure({
              projectId,
              workspaceId: targetWorkspaceId,
              executionId,
              sourceKind: "AssignWorkTargetBindingFailure",
              reasonCode: "SourceFactEventMismatch",
            }),
          );
        }
        const fact = source.value;
        const payloadKeys = Object.keys(payload).sort();
        const expectedPayloadKeys = [
          "attentionFactId",
          "committedCommandId",
          "executionId",
          "failureCode",
          "logicalActionId",
          "targetWorkspaceId",
        ];
        if (
          fact.eventId !== event.eventId ||
          fact.projectId !== projectId ||
          event.eventVersion !== 1 ||
          event.actor !== "system:recovery" ||
          event.causedByEventId !== undefined ||
          event.aggregateRef !== fact.targetWorkspaceId ||
          event.correlationRef !== fact.logicalActionId ||
          event.causedByCommandId !== fact.committedCommandId ||
          event.occurredAt !== fact.firstDetectedAt ||
          fact.executionId !== String(payload.executionId ?? "") ||
          fact.targetWorkspaceId !== String(payload.targetWorkspaceId ?? "") ||
          fact.logicalActionId !== String(payload.logicalActionId ?? "") ||
          fact.committedCommandId !==
            String(payload.committedCommandId ?? "") ||
          fact.failureCode !== String(payload.failureCode ?? "") ||
          String(payload.attentionFactId ?? "") !== fact.attentionFactId ||
          payloadKeys.length !== expectedPayloadKeys.length ||
          payloadKeys.some((key, index) => key !== expectedPayloadKeys[index])
        ) {
          return yield* Effect.fail(
            integrityFailure({
              projectId,
              workspaceId: fact.targetWorkspaceId,
              executionId: fact.executionId,
              sourceKind: "AssignWorkTargetBindingFailure",
              reasonCode: "SourceFactEventMismatch",
            }),
          );
        }
        sourceReferences.push({
          executionId: fact.executionId,
          workspaceId:
            executionWorkspaceOf.get(fact.executionId) ??
            fact.targetWorkspaceId,
          targetWorkspaceId: fact.targetWorkspaceId,
          sourceKind: "AssignWorkTargetBindingFailure",
        });
        assignWorkBindingFailureEvents.push({
          attentionFactId: fact.attentionFactId,
          executionId: fact.executionId,
          targetWorkspaceId: fact.targetWorkspaceId,
          logicalActionId: fact.logicalActionId,
          committedCommandId: fact.committedCommandId,
          failureCode: fact.failureCode,
          occurredAt: event.occurredAt,
        });
      } else if (event.eventType === "SubmittedDecisionBindingEscalated") {
        if (deps.findSubmittedDecisionBindingFailure === undefined) continue;
        const payload = asRecord(event.payload);
        const attentionFactId = String(payload.attentionFactId ?? "");
        if (attentionFactId.length === 0) continue;
        const source =
          yield* deps.findSubmittedDecisionBindingFailure(attentionFactId);
        if (Option.isNone(source)) continue;
        const fact = source.value;
        if (
          fact.eventId !== event.eventId ||
          fact.projectId !== projectId ||
          fact.attentionFactId !== attentionFactId ||
          fact.executionId !== String(payload.executionId ?? "") ||
          fact.workspaceId !== String(payload.workspaceId ?? "") ||
          fact.logicalStepNo !== Number(payload.logicalStepNo) ||
          fact.repairAttempt !== Number(payload.repairAttempt) ||
          fact.providerTurnId !== String(payload.providerTurnId ?? "") ||
          fact.logicalActionId !== String(payload.logicalActionId ?? "") ||
          fact.failureCode !== String(payload.failureCode ?? "")
        ) {
          continue;
        }
        submittedDecisionBindingFailureEvents.push({
          attentionFactId: fact.attentionFactId,
          executionId: fact.executionId,
          workspaceId: fact.workspaceId,
          firstDetectedAt: fact.firstDetectedAt,
        });
      }
    }

    const safetyStopSettlements: Array<SafetyStopFact> = executionFacts
      .filter((fact) => isRuntimeSafetyStop(fact.settlement))
      .map((fact) => ({
        executionId: fact.executionId,
        workspaceId: fact.workspaceId,
        settledAt: fact.settledAt,
      }));

    for (const fact of executionFacts) {
      if (
        fact.settlementKind !== "Interrupted" ||
        (fact.settlementMalformed !== true &&
          isValidInterruptedSettlement(fact.settlement))
      ) {
        continue;
      }
      return yield* Effect.fail(
        integrityFailure({
          projectId,
          workspaceId: fact.workspaceId,
          executionId: fact.executionId,
          sourceKind: "RuntimeSafetyEnvelope",
          reasonCode: "SettlementMalformed",
        }),
      );
    }

    for (const fact of safetyStopSettlements) {
      sourceReferences.push({
        executionId: fact.executionId,
        workspaceId: fact.workspaceId,
        sourceKind: "RuntimeSafetyEnvelope",
      });
    }

    const activeExecutions = yield* activeWorkBoundExecutions(
      projectId,
      sourceReferences,
      deps,
    );

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
        workId: verification.workId,
        targetWorkRevision: verification.targetWorkRevision,
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
      safetyStopSettlements: safetyStopSettlements.filter((fact) =>
        activeExecutions.has(fact.executionId),
      ),
      reconciliationEscalatedEvents: escalationEvents.filter((fact) =>
        activeExecutions.has(fact.executionId),
      ),
      assignWorkBindingFailureEvents: assignWorkBindingFailureEvents.filter(
        (fact) => activeExecutions.has(fact.executionId),
      ),
      submittedDecisionBindingFailureEvents,
      openVerifications: openVerificationFacts,
      executionSettlements,
      vacantProducerCandidates,
      workspaceVacancies,
      workOwners,
      workBlockers,
      activeWorkEpisodeIds,
    };
  });

/** Attention view entry: pure function of canonical state + journal —
 * load facts, derive deduplicated rows (P10 `02` §3). Zero canonical
 * mutation; disposition of any row is a human/parent governance command. */
export const deriveProjectAttention = (
  projectId: ProjectId,
  deps: AttentionReadDeps,
): Effect.Effect<ReadonlyArray<AttentionRow>, ProjectionReadResultError> =>
  Effect.gen(function* () {
    const derived = deriveAttentionRows(
      yield* loadAttentionFacts(projectId, deps),
    );
    let rows = derived;
    if (deps.listProjectedAssignWorkBindingFailures !== undefined) {
      const materialized =
        yield* deps.listProjectedAssignWorkBindingFailures(projectId);
      const active = yield* activeWorkBoundExecutions(
        projectId,
        materialized.map((row) => ({
          executionId: row.sourceExecutionId,
          workspaceId: row.targetWorkspaceId,
          targetWorkspaceId: row.targetWorkspaceId,
          sourceKind: "AssignWorkTargetBindingFailure" as const,
        })),
        deps,
      );
      rows = [
        ...rows.filter(
          (row) => row.source !== "AssignWorkTargetBindingFailure",
        ),
        ...materialized
          .filter((row) => active.has(row.sourceExecutionId))
          .map((row) => ({
            source: row.source,
            severity: row.severity,
            targetWorkspaceId: row.targetWorkspaceId,
            dedupKey: row.dedupKey,
            summary: row.summary,
            occurredAt: row.occurredAt,
          })),
      ];
    }
    if (deps.listProjectedDeliverReplayFailures !== undefined) {
      const materialized =
        yield* deps.listProjectedDeliverReplayFailures(projectId);
      const active = yield* activeWorkBoundExecutions(
        projectId,
        materialized.map((row) => ({
          executionId: row.sourceExecutionId,
          workspaceId: row.targetWorkspaceId,
          targetWorkspaceId: row.targetWorkspaceId,
          sourceKind: "DeliverReplayFailure" as const,
        })),
        deps,
      );
      rows = [
        ...rows.filter((row) => row.source !== "DeliverReplayFailure"),
        ...materialized
          .filter((row) => active.has(row.sourceExecutionId))
          .map((row) => ({
            source: row.source,
            severity: row.severity,
            targetWorkspaceId: row.targetWorkspaceId,
            dedupKey: row.dedupKey,
            summary: row.summary,
            occurredAt: row.occurredAt,
            failureCode: row.failureCode,
          })),
      ];
    }
    if (deps.listProjectedSubmittedDecisionBindingFailures !== undefined) {
      const materialized =
        yield* deps.listProjectedSubmittedDecisionBindingFailures(projectId);
      rows = [
        ...rows.filter(
          (row) => row.source !== "SubmittedDecisionBindingFailure",
        ),
        ...materialized.map((row) => ({
          source: "SubmittedDecisionBindingFailure" as const,
          severity: "ActionRequired" as const,
          targetWorkspaceId: row.workspaceId,
          dedupKey: row.attentionFactId,
          summary:
            "A Scheduler decision action could not be safely recovered; review is required.",
          occurredAt: row.firstDetectedAt,
        })),
      ];
    }
    if (deps.listProjectedWorkspaceResourceActivations !== undefined) {
      const activationRows =
        yield* deps.listProjectedWorkspaceResourceActivations(projectId);
      rows = [
        ...rows,
        ...activationRows.map((row) => ({
          source: "WorkspaceResourceActivationPending" as const,
          severity: "ActionRequired" as const,
          targetWorkspaceId: row.workspaceId,
          dedupKey: `resource-activation:${row.projectId}:${row.workspaceId}:${row.resourceBoundaryRevision}`,
          summary:
            "Project resource activation is pending; file actions are unavailable.",
          occurredAt: row.occurredAt,
        })),
      ];
    }
    if (deps.listProjectedToolObservationReplayFailures !== undefined) {
      const replayRows =
        yield* deps.listProjectedToolObservationReplayFailures(projectId);
      rows = [
        ...rows,
        ...replayRows.map((row) => ({
          source: row.source,
          severity: row.severity,
          targetWorkspaceId: row.targetWorkspaceId,
          dedupKey: row.dedupKey,
          summary: row.summary,
          occurredAt: row.occurredAt,
        })),
      ];
    }
    return rows;
  });
