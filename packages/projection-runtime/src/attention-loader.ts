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
import { decodeExecutionEpisodeBinding } from "@arbor/domain";
import type {
  AssignWorkBindingAttentionFact,
  AssignWorkBindingAttentionProjectionRow,
  DeliverReplayAttentionProjectionRow,
  LegacyAdoptionAttentionFact,
  LegacyAdoptionAttentionProjectionRow,
  LegacyAdoptionAttentionResolutionFact,
  ReadmissionGateIntegrityFailure,
  SandboxProviderUnavailableAttentionProjectionRow,
  SandboxRecoveryBindingFailureProjectionRow,
  SubmittedDecisionBindingAttentionFact,
  SubmittedDecisionBindingAttentionProjectionRow,
  TerminalProviderFailureSource,
  ToolObservationReplayAttentionProjectionRow,
  VerificationSignalReconciliationAttentionProjectionRow,
  WorkspaceResourceActivationAttentionProjectionRow,
} from "@arbor/ports";
import {
  canonicalizeLegacyActionDispositionSummaryV1,
  deriveLegacyAdoptionResolutionCodeV1,
  legacyAdoptionResolutionFactIdV1,
  sha256Hex,
} from "@arbor/ports";
import { Effect, Option } from "effect";
import {
  type AnyProducerSettledWaitFact,
  type AssignWorkBindingFailureEventFact,
  type AttentionFacts,
  type AttentionRow,
  type DeadlockEventFact,
  deriveAttentionRows,
  type EscalationEventFact,
  type ExecutionSettlementFact,
  type LegacyAdoptionEvidenceFailureEventFact,
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

/** Internal canonical source binding used to determine exact Work-revision
 * freshness, with the P10 RuntimeSafetyEnvelope workspace-scoped exception
 * for valid non-Work EGP episodes. The serialized episode remains opaque to
 * adapters so malformed/unknown versions fail closed in the projection. */
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
  | "DeliverReplayFailure"
  | "LegacyAdoptionEvidenceInsufficient";

type AttentionSourceIntegrityKind =
  | AttentionWorkBoundSourceKind
  | "SubmittedDecisionBindingFailure"
  | "LegacyAdoptionEvidenceInsufficient";

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
  readonly sourceKind: AttentionSourceIntegrityKind;
  readonly reasonCode: AttentionSourceIntegrityReason;
}

export interface TerminalProviderFailureAttentionFact {
  readonly projectId: ProjectId;
  readonly workspaceId: WorkspaceId;
  readonly workId: WorkId;
  readonly workRevision: number;
  readonly source: TerminalProviderFailureSource;
  readonly occurredAt: string;
}

export interface TerminalProviderFailureIntegrityAttentionFact {
  readonly projectId: ProjectId;
  readonly workspaceId: WorkspaceId;
  readonly workId: WorkId;
  readonly workRevision: number;
  readonly executionId: string;
  readonly logicalStepNo: number;
  readonly repairAttempt: number;
  readonly occurredAt: string;
  readonly failureCode: ReadmissionGateIntegrityFailure["reasonCode"];
}

export type TerminalProviderFailureReadFact =
  | TerminalProviderFailureAttentionFact
  | TerminalProviderFailureIntegrityAttentionFact;

/** Read faces the Attention read-model derives from (read-only over
 * canonical tables + journal; injected — the package itself owns no
 * storage and never writes). */
export interface AttentionReadDeps {
  readonly listTerminalProviderFailures?: (
    projectId: ProjectId,
  ) => Effect.Effect<
    ReadonlyArray<TerminalProviderFailureReadFact>,
    ProjectionReadResultError
  >;
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
  readonly listAnyProducerSettledWaits?: (
    projectId: ProjectId,
  ) => Effect.Effect<
    ReadonlyArray<AnyProducerSettledWaitFact>,
    ProjectionReadError
  >;
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
  readonly findLegacyAdoptionFailure?: (
    attentionFactId: string,
  ) => Effect.Effect<
    Option.Option<LegacyAdoptionAttentionFact>,
    ProjectionReadError
  >;
  readonly findLegacyAdoptionResolution?: (
    attentionFactId: string,
  ) => Effect.Effect<
    Option.Option<LegacyAdoptionAttentionResolutionFact>,
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
  readonly listProjectedLegacyAdoptionFailures?: (
    projectId: ProjectId,
  ) => Effect.Effect<
    ReadonlyArray<LegacyAdoptionAttentionProjectionRow>,
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
  readonly listProjectedVerificationSignalReconciliationFailures?: (
    projectId: ProjectId,
  ) => Effect.Effect<
    ReadonlyArray<VerificationSignalReconciliationAttentionProjectionRow>,
    ProjectionReadError
  >;
  readonly listProjectedSandboxProviderUnavailableFailures?: (
    projectId: ProjectId,
  ) => Effect.Effect<
    ReadonlyArray<SandboxProviderUnavailableAttentionProjectionRow>,
    ProjectionReadError
  >;
  readonly listSandboxRecoveryBindingFailures?: (
    projectId: ProjectId,
  ) => Effect.Effect<
    ReadonlyArray<SandboxRecoveryBindingFailureProjectionRow>,
    ProjectionReadError
  >;
  readonly listSandboxPolicyDecisionRequired?: (
    projectId: ProjectId,
  ) => Effect.Effect<
    ReadonlyArray<
      import("@arbor/ports").SandboxPolicyDecisionRequiredProjectionRow
    >,
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
  readonly sourceKind: AttentionSourceIntegrityKind;
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

const decodeAttentionSourceEpisode = (
  raw: string,
):
  | { readonly workId: string; readonly targetWorkRevision: number }
  | { readonly workspaceScoped: true }
  | { readonly reason: "EpisodeMalformed" | "EpisodeVersionUnsupported" } => {
  const supportedEpisodeTags = new Set([
    "WorkEpisode",
    "ConversationResponseEpisode",
    "InboxEpisode",
    "DecisionEpisode",
  ]);
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch {
    return { reason: "EpisodeMalformed" };
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { reason: "EpisodeMalformed" };
  }
  const tag = (value as { readonly _tag?: unknown })._tag;
  if (typeof tag !== "string") return { reason: "EpisodeMalformed" };
  const episode = decodeExecutionEpisodeBinding(value);
  if (episode === undefined) {
    return {
      reason: supportedEpisodeTags.has(tag)
        ? "EpisodeMalformed"
        : "EpisodeVersionUnsupported",
    };
  }
  if (episode._tag !== "WorkEpisode") return { workspaceScoped: true };
  return {
    workId: episode.workId,
    targetWorkRevision: episode.targetWorkRevision,
  };
};

interface WorkBoundAttentionReference {
  readonly executionId: string;
  readonly workspaceId: WorkspaceId;
  readonly targetWorkspaceId?: WorkspaceId;
  readonly sourceKind: AttentionWorkBoundSourceKind;
  /** Valid non-Work EGP episodes keep RuntimeSafetyEnvelope workspace scoped. */
  readonly allowWorkspaceEpisode?: boolean;
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
      const episode = decodeAttentionSourceEpisode(binding.episodeJson);
      if ("reason" in episode) {
        return yield* Effect.fail(fail(episode.reason));
      }
      if ("workspaceScoped" in episode) {
        if (source.allowWorkspaceEpisode !== true) {
          return yield* Effect.fail(fail("EpisodeVersionUnsupported"));
        }
        if (
          binding.workId !== null ||
          binding.workProjectId !== null ||
          binding.workWorkspaceId !== null ||
          binding.workRevision !== null
        ) {
          return yield* Effect.fail(fail("WorkScopeMismatch"));
        }
        active.add(source.executionId);
        continue;
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
    const legacyAdoptionEvidenceFailureEvents: Array<LegacyAdoptionEvidenceFailureEventFact> =
      [];
    const resolvedLegacyAdoptionAttentionIds = new Set<string>();
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
        const payload = asRecord(event.payload);
        const attentionFactId = String(payload.attentionFactId ?? "");
        const eventExecutionId = String(payload.executionId ?? "");
        const eventWorkspaceId = String(
          payload.workspaceId ?? "",
        ) as WorkspaceId;
        if (deps.findSubmittedDecisionBindingFailure === undefined) {
          return yield* Effect.fail(
            integrityFailure({
              projectId,
              workspaceId: eventWorkspaceId,
              executionId: eventExecutionId,
              sourceKind: "SubmittedDecisionBindingFailure",
              reasonCode: "SourceFactEventMismatch",
            }),
          );
        }
        const source =
          yield* deps.findSubmittedDecisionBindingFailure(attentionFactId);
        if (Option.isNone(source)) {
          return yield* Effect.fail(
            integrityFailure({
              projectId,
              workspaceId: eventWorkspaceId,
              executionId: eventExecutionId,
              sourceKind: "SubmittedDecisionBindingFailure",
              reasonCode: "SourceFactEventMismatch",
            }),
          );
        }
        const fact = source.value;
        const expectedPayloadKeys = [
          "attentionFactId",
          "executionId",
          "workspaceId",
          "logicalStepNo",
          "repairAttempt",
          "providerTurnId",
          "logicalActionId",
          "failureCode",
        ].sort();
        const payloadKeys = Object.keys(payload).sort();
        if (
          event.eventVersion !== 1 ||
          event.actor !== "system:recovery" ||
          event.aggregateRef !== fact.workspaceId ||
          event.correlationRef !== fact.logicalActionId ||
          event.causedByCommandId !== undefined ||
          event.causedByEventId !== undefined ||
          event.occurredAt !== fact.firstDetectedAt ||
          fact.eventId !== event.eventId ||
          fact.projectId !== projectId ||
          fact.attentionFactId !== attentionFactId ||
          fact.executionId !== payload.executionId ||
          fact.workspaceId !== payload.workspaceId ||
          fact.logicalStepNo !== payload.logicalStepNo ||
          fact.repairAttempt !== payload.repairAttempt ||
          fact.providerTurnId !== payload.providerTurnId ||
          fact.logicalActionId !== payload.logicalActionId ||
          fact.failureCode !== payload.failureCode ||
          payloadKeys.length !== expectedPayloadKeys.length ||
          payloadKeys.some((key, index) => key !== expectedPayloadKeys[index])
        ) {
          return yield* Effect.fail(
            integrityFailure({
              projectId,
              workspaceId: fact.workspaceId,
              executionId: fact.executionId,
              sourceKind: "SubmittedDecisionBindingFailure",
              reasonCode: "SourceFactEventMismatch",
            }),
          );
        }
        submittedDecisionBindingFailureEvents.push({
          attentionFactId: fact.attentionFactId,
          executionId: fact.executionId,
          workspaceId: fact.workspaceId,
          firstDetectedAt: fact.firstDetectedAt,
        });
      } else if (event.eventType === "LegacyAdoptionEvidenceEscalated") {
        const payload = asRecord(event.payload);
        const attentionFactId = String(payload.attentionFactId ?? "");
        const executionId = String(payload.executionId ?? "");
        const targetWorkspaceId = String(
          payload.targetWorkspaceId ?? "",
        ) as WorkspaceId;
        if (
          attentionFactId.length === 0 ||
          executionId.length === 0 ||
          deps.findLegacyAdoptionFailure === undefined
        ) {
          return yield* Effect.fail(
            integrityFailure({
              projectId,
              workspaceId: targetWorkspaceId,
              executionId,
              sourceKind: "LegacyAdoptionEvidenceInsufficient",
              reasonCode: "SourceFactEventMismatch",
            }),
          );
        }
        const source = yield* deps.findLegacyAdoptionFailure(attentionFactId);
        if (Option.isNone(source)) {
          return yield* Effect.fail(
            integrityFailure({
              projectId,
              workspaceId: targetWorkspaceId,
              executionId,
              sourceKind: "LegacyAdoptionEvidenceInsufficient",
              reasonCode: "SourceFactEventMismatch",
            }),
          );
        }
        const fact = source.value;
        const expectedPayloadKeys = [
          "factId",
          "attentionFactId",
          "projectId",
          "executionId",
          "targetWorkspaceId",
          "providerTurnId",
          "logicalStepNo",
          "repairAttempt",
          "failureCode",
          "evidenceSha256",
          "firstDetectedAt",
        ].sort();
        const payloadKeys = Object.keys(payload).sort();
        if (
          event.eventVersion !== 1 ||
          event.actor !== "system:recovery" ||
          event.aggregateRef !== fact.executionId ||
          event.correlationRef !== fact.attentionFactId ||
          event.causedByCommandId !== undefined ||
          event.causedByEventId !== undefined ||
          event.occurredAt !== fact.firstDetectedAt ||
          fact.eventId !== event.eventId ||
          fact.projectId !== projectId ||
          fact.executionId !== executionId ||
          fact.workspaceId !== targetWorkspaceId ||
          executionWorkspaceOf.get(fact.executionId) !== fact.workspaceId ||
          fact.providerTurnId !== payload.providerTurnId ||
          fact.logicalStepNo !== payload.logicalStepNo ||
          fact.repairAttempt !== payload.repairAttempt ||
          fact.failureCode !== payload.failureCode ||
          fact.evidenceSha256 !== payload.evidenceSha256 ||
          fact.attentionFactId !== attentionFactId ||
          payload.factId !== fact.attentionFactId ||
          payload.projectId !== fact.projectId ||
          payload.executionId !== fact.executionId ||
          payload.targetWorkspaceId !== fact.workspaceId ||
          payload.firstDetectedAt !== fact.firstDetectedAt ||
          payloadKeys.length !== expectedPayloadKeys.length ||
          payloadKeys.some((key, index) => key !== expectedPayloadKeys[index])
        ) {
          return yield* Effect.fail(
            integrityFailure({
              projectId,
              workspaceId: fact.workspaceId,
              executionId: fact.executionId,
              sourceKind: "LegacyAdoptionEvidenceInsufficient",
              reasonCode: "SourceFactEventMismatch",
            }),
          );
        }
        sourceReferences.push({
          executionId: fact.executionId,
          workspaceId: fact.workspaceId,
          targetWorkspaceId: fact.workspaceId,
          sourceKind: "LegacyAdoptionEvidenceInsufficient",
        });
        legacyAdoptionEvidenceFailureEvents.push({
          attentionFactId: fact.attentionFactId,
          executionId: fact.executionId,
          targetWorkspaceId: fact.workspaceId,
          failureCode: fact.failureCode,
          firstDetectedAt: fact.firstDetectedAt,
        });
      } else if (event.eventType === "LegacyAdoptionEvidenceResolved") {
        const payload = asRecord(event.payload);
        const attentionFactId = String(payload.attentionFactId ?? "");
        const executionId = String(payload.executionId ?? "");
        const workspaceId = String(
          payload.targetWorkspaceId ?? "",
        ) as WorkspaceId;
        if (
          attentionFactId.length === 0 ||
          deps.findLegacyAdoptionFailure === undefined ||
          deps.findLegacyAdoptionResolution === undefined
        ) {
          return yield* Effect.fail(
            integrityFailure({
              projectId,
              workspaceId,
              executionId,
              sourceKind: "LegacyAdoptionEvidenceInsufficient",
              reasonCode: "SourceFactEventMismatch",
            }),
          );
        }
        const [failureSource, resolutionSource] = yield* Effect.all([
          deps.findLegacyAdoptionFailure(attentionFactId),
          deps.findLegacyAdoptionResolution(attentionFactId),
        ]);
        if (Option.isNone(failureSource) || Option.isNone(resolutionSource)) {
          return yield* Effect.fail(
            integrityFailure({
              projectId,
              workspaceId,
              executionId,
              sourceKind: "LegacyAdoptionEvidenceInsufficient",
              reasonCode: "SourceFactEventMismatch",
            }),
          );
        }
        const failureFact = failureSource.value;
        const resolution = resolutionSource.value;
        const expectedPayloadKeys = [
          "factId",
          "attentionFactId",
          "projectId",
          "executionId",
          "targetWorkspaceId",
          "providerTurnId",
          "originalEvidenceSha256",
          "resolutionEvidenceSha256",
          "resolutionCode",
          "resolvedAt",
        ].sort();
        const payloadKeys = Object.keys(payload).sort();
        let summaryIsValid = false;
        try {
          const summary = JSON.parse(
            resolution.actionDispositionSummaryJson,
          ) as unknown;
          if (
            Array.isArray(summary) &&
            summary.length > 0 &&
            summary.every((row, index) => {
              if (
                typeof row !== "object" ||
                row === null ||
                Array.isArray(row)
              ) {
                return false;
              }
              const record = row as Record<string, unknown>;
              const keys = Object.keys(record).sort();
              const expected = [
                "actionOrdinal",
                "logicalActionId",
                "callRef",
                "toolName",
                "toolSchemaVersion",
                "inputHash",
                "disposition",
              ].sort();
              return (
                keys.length === expected.length &&
                keys.every((key, keyIndex) => key === expected[keyIndex]) &&
                record.actionOrdinal === index &&
                typeof record.logicalActionId === "string" &&
                typeof record.callRef === "string" &&
                typeof record.toolName === "string" &&
                typeof record.toolSchemaVersion === "string" &&
                typeof record.inputHash === "string" &&
                /^[0-9a-f]{64}$/u.test(record.inputHash) &&
                (record.disposition === "Applied" ||
                  record.disposition === "NotAdmitted")
              );
            })
          ) {
            const canonical = canonicalizeLegacyActionDispositionSummaryV1(
              summary as ReadonlyArray<{
                readonly actionOrdinal: number;
                readonly logicalActionId: string;
                readonly callRef: string;
                readonly toolName: string;
                readonly toolSchemaVersion: string;
                readonly inputHash: string;
                readonly disposition: "Applied" | "NotAdmitted";
              }>,
            );
            summaryIsValid =
              canonical === resolution.actionDispositionSummaryJson &&
              sha256Hex(canonical) ===
                resolution.actionDispositionSummarySha256 &&
              deriveLegacyAdoptionResolutionCodeV1(
                summary.map((row) =>
                  String((row as Record<string, unknown>).disposition),
                ),
              ) === resolution.resolutionCode &&
              legacyAdoptionResolutionFactIdV1({
                attentionFactId: resolution.attentionFactId,
                originalEvidenceSha256: resolution.originalEvidenceSha256,
                resolutionEvidenceSha256: resolution.resolutionEvidenceSha256,
                resolutionCode: resolution.resolutionCode,
              }) === resolution.resolutionFactId;
          }
        } catch {
          summaryIsValid = false;
        }
        if (
          event.eventVersion !== 1 ||
          event.actor !== "system:recovery" ||
          event.aggregateRef !== failureFact.executionId ||
          event.correlationRef !== failureFact.attentionFactId ||
          event.causedByCommandId !== undefined ||
          event.causedByEventId !== failureFact.eventId ||
          event.occurredAt !== resolution.resolvedAt ||
          failureFact.projectId !== projectId ||
          resolution.eventId !== event.eventId ||
          resolution.attentionFactId !== failureFact.attentionFactId ||
          resolution.projectId !== projectId ||
          resolution.executionId !== failureFact.executionId ||
          resolution.workspaceId !== failureFact.workspaceId ||
          resolution.providerTurnId !== failureFact.providerTurnId ||
          resolution.originalEvidenceSha256 !== failureFact.evidenceSha256 ||
          resolution.resolvedAt !== event.occurredAt ||
          payload.factId !== resolution.resolutionFactId ||
          payload.attentionFactId !== failureFact.attentionFactId ||
          payload.projectId !== resolution.projectId ||
          payload.executionId !== resolution.executionId ||
          payload.targetWorkspaceId !== resolution.workspaceId ||
          payload.providerTurnId !== resolution.providerTurnId ||
          payload.originalEvidenceSha256 !==
            resolution.originalEvidenceSha256 ||
          payload.resolutionEvidenceSha256 !==
            resolution.resolutionEvidenceSha256 ||
          payload.resolutionCode !== resolution.resolutionCode ||
          payload.resolvedAt !== resolution.resolvedAt ||
          payloadKeys.length !== expectedPayloadKeys.length ||
          payloadKeys.some(
            (key, index) => key !== expectedPayloadKeys[index],
          ) ||
          !summaryIsValid
        ) {
          return yield* Effect.fail(
            integrityFailure({
              projectId,
              workspaceId: failureFact.workspaceId,
              executionId: failureFact.executionId,
              sourceKind: "LegacyAdoptionEvidenceInsufficient",
              reasonCode: "SourceFactEventMismatch",
            }),
          );
        }
        resolvedLegacyAdoptionAttentionIds.add(failureFact.attentionFactId);
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
        allowWorkspaceEpisode: true,
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

    const anyProducerSettledWaits =
      deps.listAnyProducerSettledWaits === undefined
        ? []
        : yield* deps.listAnyProducerSettledWaits(projectId);

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
      legacyAdoptionEvidenceFailureEvents:
        legacyAdoptionEvidenceFailureEvents.filter(
          (fact) =>
            !resolvedLegacyAdoptionAttentionIds.has(fact.attentionFactId),
        ),
      openVerifications: openVerificationFacts,
      executionSettlements,
      vacantProducerCandidates,
      anyProducerSettledWaits,
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
    if (deps.listProjectedLegacyAdoptionFailures !== undefined) {
      const materialized =
        yield* deps.listProjectedLegacyAdoptionFailures(projectId);
      const active = yield* activeWorkBoundExecutions(
        projectId,
        materialized.map((row) => ({
          executionId: row.sourceExecutionId,
          workspaceId: row.workspaceId,
          targetWorkspaceId: row.workspaceId,
          sourceKind: "LegacyAdoptionEvidenceInsufficient" as const,
        })),
        deps,
      );
      rows = [
        ...rows.filter(
          (row) => row.source !== "LegacyAdoptionEvidenceInsufficient",
        ),
        ...materialized
          .filter((row) => active.has(row.sourceExecutionId))
          .map((row) => ({
            source: "LegacyAdoptionEvidenceInsufficient" as const,
            severity: "ActionRequired" as const,
            targetWorkspaceId: row.workspaceId,
            dedupKey: row.attentionFactId,
            summary:
              "Legacy action outcome cannot be proven; operator review is required.",
            occurredAt: row.firstDetectedAt,
            failureCode: row.failureCode,
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
    if (
      deps.listProjectedVerificationSignalReconciliationFailures !== undefined
    ) {
      const reconciliation =
        yield* deps.listProjectedVerificationSignalReconciliationFailures(
          projectId,
        );
      rows = [
        ...rows.filter(
          (row) => row.source !== "F18VerificationSignalReconciliation",
        ),
        ...reconciliation.map((row) => ({
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
    if (deps.listProjectedSandboxProviderUnavailableFailures !== undefined) {
      const unavailable =
        yield* deps.listProjectedSandboxProviderUnavailableFailures(projectId);
      rows = [
        ...rows.filter((row) => row.source !== "SandboxProviderUnavailable"),
        ...unavailable.map((row) => ({
          source: "SandboxProviderUnavailable" as const,
          severity: "ActionRequired" as const,
          targetWorkspaceId: row.workspaceId,
          dedupKey: row.attentionFactId,
          summary:
            "Required sandbox capabilities are unavailable; execution did not start.",
          occurredAt: row.firstDetectedAt,
        })),
      ];
    }
    if (deps.listSandboxRecoveryBindingFailures !== undefined) {
      const failures =
        yield* deps.listSandboxRecoveryBindingFailures(projectId);
      rows = [
        ...rows,
        ...failures.map((row) => ({
          source: "SandboxRecoveryBindingFailure" as const,
          severity: "ActionRequired" as const,
          targetWorkspaceId: row.workspaceId,
          dedupKey: row.attentionFactId,
          summary:
            "Sandbox recovery binding evidence is missing or invalid; execution is paused.",
          occurredAt: row.intentAt,
        })),
      ];
    }
    if (deps.listSandboxPolicyDecisionRequired !== undefined) {
      const pending = yield* deps.listSandboxPolicyDecisionRequired(projectId);
      rows = [
        ...rows,
        ...pending.map((row) => ({
          source: "SandboxPolicyDecisionRequired" as const,
          severity: "ActionRequired" as const,
          targetWorkspaceId: row.workspaceId,
          dedupKey: row.attentionFactId,
          summary:
            "A sandbox policy decision is required before execution can continue.",
          occurredAt: row.intentAt,
        })),
      ];
    }
    if (deps.listTerminalProviderFailures !== undefined) {
      const failures = yield* deps.listTerminalProviderFailures(projectId);
      rows = [
        ...rows.filter(
          (row) =>
            row.source !== "TerminalProviderFailure" &&
            row.source !== "TerminalProviderFailureIntegrity",
        ),
        ...failures.map((fact) =>
          "source" in fact
            ? {
                source: "TerminalProviderFailure" as const,
                severity: "ActionRequired" as const,
                targetWorkspaceId: fact.workspaceId,
                dedupKey: `terminal-provider-failure:${fact.workId}:${String(fact.workRevision)}:${fact.source.failureFingerprint}`,
                summary:
                  "The model provider rejected this Work execution. Review the provider configuration or request compatibility, then explicitly steer the Work to retry.",
                occurredAt: fact.occurredAt,
                failureCode: fact.source.failureKind,
                workId: fact.workId,
                targetWorkRevision: fact.workRevision,
                terminalProviderFailure: {
                  kind: "TerminalProviderFailure" as const,
                  workId: fact.workId,
                  workRevision: fact.workRevision,
                  occurredAt: fact.occurredAt,
                  failureCode: fact.source.failureKind,
                  failureFingerprint: fact.source.failureFingerprint,
                },
              }
            : {
                source: "TerminalProviderFailureIntegrity" as const,
                severity: "ActionRequired" as const,
                targetWorkspaceId: fact.workspaceId,
                dedupKey: `terminal-provider-failure-integrity:${fact.executionId}:${fact.logicalStepNo}:${fact.repairAttempt}:${fact.failureCode}`,
                summary:
                  "Arbor cannot safely verify a terminal provider-failure recovery record. Execution remains blocked; inspect the bounded integrity code before retrying.",
                occurredAt: fact.occurredAt,
                failureCode: fact.failureCode,
                workId: fact.workId,
                targetWorkRevision: fact.workRevision,
                terminalProviderFailure: {
                  kind: "TerminalProviderFailureIntegrity" as const,
                  workId: fact.workId,
                  workRevision: fact.workRevision,
                  occurredAt: fact.occurredAt,
                  failureCode: fact.failureCode,
                },
              },
        ),
      ];
    }
    return rows;
  });
