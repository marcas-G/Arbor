import type { ConversationResponseStatus } from "@arbor/api-contracts";
import type {
  DomainEvent,
  ExecutionSettlement,
  SandboxPolicyGrantIssuerConfigSnapshotV1,
  Verification,
  Workspace,
} from "@arbor/domain";
import {
  encodeExecutionEpisodeBinding,
  executionEpisode,
  type ProjectId,
  sandboxPolicyCommittedViewOf,
  settlementFingerprint,
  type WorkId,
  type WorkRevision,
  type WorkspaceId,
} from "@arbor/domain";
import {
  AcceptanceRepository,
  AgentLoopStepStore,
  AttentionProjectionStore,
  Clock,
  CurrentSandboxAuthoritySnapshotPort,
  DependencyRepository,
  DomainEventJournal,
  EvidenceRepository,
  ExecutableApprovalStore,
  ExecutionRepository,
  MessageStore,
  P4SandboxOutcomeReadPort,
  ProjectionQueryPort,
  ProviderTurnStore,
  RecoveryAttentionFactStore,
  RetryVerificationOriginRepository,
  RunnableWorkSource,
  SandboxPolicyCandidateBoundaryReadPort,
  SandboxPolicyDecisionStore,
  SandboxPolicyRequirementReadPort,
  type SandboxPolicyRequirementV1,
  SandboxProviderUnavailableStore,
  sha256Hex,
  ToolCatalogPort,
  TransactionPort,
  type TransactionScope,
  VerificationRepository,
  WorkBlockerStore,
  WorkRepository,
  WorkspaceRepository,
  WorkWaitStore,
} from "@arbor/ports";
import type {
  AttentionReadDeps,
  AttentionSourceExecutionBinding,
  ConversationHistoryCursor,
  ConversationHistoryPage,
  CurrentWorkDeps,
  DependencyViewDeps,
  EffectiveFactsDeps,
  ExecutionSettlementReadFact,
  InboxReconcileDeps,
  InboxRowFact,
  InboxViewDeps,
  ProjectionQueryRuntimeDeps,
  SpecialistSettlementFact,
  TranscriptDeps,
  TreeViewDeps,
  UsageDeps,
  VerificationViewDeps,
  WorkDetailDeps,
  WorkspaceDetailDeps,
} from "@arbor/projection-runtime";
import {
  deriveProjectAttention,
  makeProjectionQueryService,
  projectionReadError,
} from "@arbor/projection-runtime";
import { Effect, Layer, Option } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { buildSandboxPolicyCandidateReadV1 } from "./sandbox-policy-candidate-read.js";

interface ConversationJobViewRow {
  readonly message_id: string;
  readonly job_state: string | null;
  readonly job_revision: number | null;
  readonly active_execution_id: string | null;
  readonly next_attempt_no: number | null;
  readonly next_eligible_at: string | null;
  readonly attention_reason: string | null;
  readonly response_execution_id: string | null;
}

const responseStatusOf = (
  row: ConversationJobViewRow,
): ConversationResponseStatus | undefined => {
  const revision = Number(row.job_revision ?? 0);
  switch (row.job_state) {
    case "Queued":
      return { state: "Queued", revision };
    case "Running":
      return {
        state: "Running",
        revision,
        executionId: row.active_execution_id ?? "",
        attemptNo: Math.max(0, Number(row.next_attempt_no ?? 1) - 1),
      };
    case "RetryScheduled":
      return {
        state: "RetryScheduled",
        revision,
        nextEligibleAt: row.next_eligible_at ?? "",
        safeReason: row.attention_reason ?? "Provider 暂时不可用",
      };
    case "NeedsAttention":
      return {
        state: "NeedsAttention",
        revision,
        reason: row.attention_reason ?? "UnknownFailure",
        canResume: true,
      };
    case "Answered":
      return {
        state: "Answered",
        revision,
        executionId: row.response_execution_id ?? "",
      };
    case "Cancelled":
      return {
        state: "Cancelled",
        revision,
        reason: row.attention_reason ?? "ControlledStop",
      };
    default:
      return undefined;
  }
};

const sameSandboxPolicyRequirement = (
  left: SandboxPolicyRequirementV1,
  right: SandboxPolicyRequirementV1,
): boolean =>
  left.projectId === right.projectId &&
  left.workspaceId === right.workspaceId &&
  left.executionId === right.executionId &&
  encodeExecutionEpisodeBinding(left.episodeBinding) ===
    encodeExecutionEpisodeBinding(right.episodeBinding) &&
  left.expectedEpisodeRevision === right.expectedEpisodeRevision &&
  left.invocationId === right.invocationId &&
  left.providerTurnId === right.providerTurnId &&
  left.logicalStepNo === right.logicalStepNo &&
  left.repairAttempt === right.repairAttempt &&
  left.logicalActionId === right.logicalActionId &&
  left.actionIndex === right.actionIndex &&
  left.callRef === right.callRef &&
  left.recoveryBindingDigest === right.recoveryBindingDigest;

/**
 * B-7 — the production `ProjectionQueryPort` wiring.
 *
 * The P10 read faces are injected dependencies (P10 `05` §1): the query
 * runtime owns no SQL. This composition-root module is the production binding
 * of those read faces to the canonical repositories + the frozen SQLite read
 * projections, exactly as the P10 acceptance fixture binds them in tests. It
 * is wiring only: no view semantics are re-derived here (the derives live in
 * `projection-runtime`).
 */

export type ProjectionQueryWiringServices =
  | SqlClient
  | Clock
  | TransactionPort
  | WorkspaceRepository
  | WorkRepository
  | ExecutionRepository
  | WorkWaitStore
  | WorkBlockerStore
  | DependencyRepository
  | VerificationRepository
  | EvidenceRepository
  | AcceptanceRepository
  | DomainEventJournal
  | RecoveryAttentionFactStore
  | SandboxPolicyDecisionStore
  | SandboxPolicyCandidateBoundaryReadPort
  | SandboxPolicyRequirementReadPort
  | CurrentSandboxAuthoritySnapshotPort
  | SandboxProviderUnavailableStore
  | AttentionProjectionStore
  | MessageStore
  | RunnableWorkSource
  | ExecutableApprovalStore
  | AgentLoopStepStore
  | ProviderTurnStore
  | ToolCatalogPort;

/** @internal Pure reader seam for the P10 manifest-binding projection tests. */
export const approvedToolHashFromManifest = (input: {
  readonly manifestJson: string;
  readonly providerTurnId: string;
  readonly executionId: string;
  readonly logicalStepNo: number;
  readonly repairAttempt: number;
  readonly toolName: string;
  readonly toolVersion: string;
}): string | null => {
  try {
    const manifest = JSON.parse(input.manifestJson) as {
      readonly providerTurnId?: unknown;
      readonly executionId?: unknown;
      readonly logicalStepNo?: unknown;
      readonly repairAttempt?: unknown;
      readonly toolRefs?: unknown;
      readonly toolRoutes?: unknown;
    };
    if (
      manifest.providerTurnId !== input.providerTurnId ||
      manifest.executionId !== input.executionId ||
      manifest.logicalStepNo !== input.logicalStepNo ||
      manifest.repairAttempt !== input.repairAttempt ||
      !Array.isArray(manifest.toolRoutes) ||
      !Array.isArray(manifest.toolRefs)
    ) {
      return null;
    }
    const sameNameRoutes = manifest.toolRoutes.filter(
      (route): route is Record<string, unknown> =>
        typeof route === "object" &&
        route !== null &&
        "name" in route &&
        route.name === input.toolName,
    );
    if (sameNameRoutes.length !== 1) return null;
    const route = sameNameRoutes[0];
    if (
      route === undefined ||
      route.route !== "Executable" ||
      route.version !== input.toolVersion ||
      typeof route.hash !== "string" ||
      route.hash.length === 0
    ) {
      return null;
    }
    const exactRef = `Executable:${input.toolName}@${input.toolVersion}#${route.hash}`;
    const refs = manifest.toolRefs.filter((ref) => typeof ref === "string");
    if (refs.filter((ref) => ref === exactRef).length !== 1) return null;
    return route.hash;
  } catch {
    return null;
  }
};

const projectionQueryService = (
  catalogProjectId?: ProjectId,
  sandboxAuthoritySnapshot?: SandboxPolicyGrantIssuerConfigSnapshotV1,
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    const clock = yield* Clock;
    const tx = yield* TransactionPort;
    const workspaces = yield* WorkspaceRepository;
    const works = yield* WorkRepository;
    const executions = yield* ExecutionRepository;
    const waits = yield* WorkWaitStore;
    const blockersOption = yield* Effect.serviceOption(WorkBlockerStore);
    const blockers = Option.getOrUndefined(blockersOption);
    const dependencies = yield* DependencyRepository;
    const verifications = yield* VerificationRepository;
    const evidence = yield* EvidenceRepository;
    const acceptances = yield* AcceptanceRepository;
    const retryVerificationOrigins = yield* Effect.serviceOption(
      RetryVerificationOriginRepository,
    );
    const journal = yield* DomainEventJournal;
    const bindingAttention = yield* RecoveryAttentionFactStore;
    const attentionProjection = yield* AttentionProjectionStore;
    const sandboxPolicyStore = yield* Effect.serviceOption(
      SandboxPolicyDecisionStore,
    );
    const sandboxPolicyCandidateBoundary = yield* Effect.serviceOption(
      SandboxPolicyCandidateBoundaryReadPort,
    );
    const sandboxPolicyRequirement = yield* Effect.serviceOption(
      SandboxPolicyRequirementReadPort,
    );
    const currentSandboxAuthority = yield* Effect.serviceOption(
      CurrentSandboxAuthoritySnapshotPort,
    );
    const p4SandboxOutcomeReadPort = yield* Effect.serviceOption(
      P4SandboxOutcomeReadPort,
    );
    const sandboxUnavailableStore = yield* Effect.serviceOption(
      SandboxProviderUnavailableStore,
    );
    const messages = yield* MessageStore;
    const source = yield* RunnableWorkSource;
    const executableApprovals = yield* ExecutableApprovalStore;
    const agentLoopSteps = yield* AgentLoopStepStore;
    const providerTurns = yield* ProviderTurnStore;
    const toolCatalog = yield* ToolCatalogPort;

    const inTx = <A>(body: Effect.Effect<A, unknown, TransactionScope>) =>
      tx.transact(body).pipe(Effect.mapError(projectionReadError));

    const listWorkspacesByProject = (projectId: ProjectId) =>
      inTx(
        Effect.gen(function* () {
          const rows = yield* sql.unsafe<{ workspace_id: string }>(
            "SELECT workspace_id FROM workspaces WHERE project_id = ? ORDER BY workspace_id",
            [projectId],
          );
          const out: Array<Workspace> = [];
          for (const row of rows) {
            const found = yield* workspaces.findById(
              row.workspace_id as WorkspaceId,
            );
            if (Option.isSome(found)) {
              out.push(found.value);
            }
          }
          return out;
        }),
      );

    const listExecutionSettlementFacts = (projectId: ProjectId) =>
      inTx(
        Effect.gen(function* () {
          const rows = yield* sql.unsafe<{
            execution_id: string;
            workspace_id: string;
            settlement_json: string | null;
            settled_at: string | null;
            settlement_kind: string | null;
          }>(
            "SELECT execution_id, workspace_id, settlement_json, settled_at, settlement_kind FROM executions WHERE project_id = ? ORDER BY execution_id",
            [projectId],
          );
          const facts: Array<ExecutionSettlementReadFact> = rows.map((row) => {
            let settlement: ExecutionSettlement | null = null;
            let settlementMalformed =
              row.settlement_kind !== null && row.settlement_json === null;
            if (row.settlement_json !== null) {
              try {
                settlement = JSON.parse(
                  row.settlement_json,
                ) as ExecutionSettlement;
              } catch {
                settlementMalformed = true;
              }
            }
            return {
              executionId: row.execution_id,
              workspaceId: row.workspace_id as WorkspaceId,
              settlement,
              settledAt: row.settled_at,
              settlementKind: row.settlement_kind,
              settlementMalformed,
            };
          });
          return facts;
        }),
      );

    const listAttentionSourceExecutionBindings = (
      _projectId: ProjectId,
      executionIds: ReadonlyArray<string>,
    ) =>
      inTx(
        Effect.gen(function* () {
          if (executionIds.length === 0) {
            return [] as ReadonlyArray<AttentionSourceExecutionBinding>;
          }
          const executions = yield* sql.unsafe<{
            readonly execution_id: string;
            readonly project_id: string;
            readonly workspace_id: string;
            readonly episode_json: string | null;
          }>(
            `SELECT e.execution_id, e.project_id, e.workspace_id,
                    state.episode_json
               FROM executions AS e
               LEFT JOIN agent_execution_state AS state
                 ON state.execution_id = e.execution_id
              WHERE e.execution_id IN (${executionIds.map(() => "?").join(",")})
              ORDER BY e.execution_id`,
            [...executionIds],
          );
          const workIds = new Set<string>();
          for (const row of executions) {
            if (row.episode_json === null) continue;
            try {
              const episode: unknown = JSON.parse(row.episode_json);
              if (
                typeof episode === "object" &&
                episode !== null &&
                (episode as { readonly _tag?: unknown })._tag ===
                  "WorkEpisode" &&
                typeof (episode as { readonly workId?: unknown }).workId ===
                  "string"
              ) {
                workIds.add((episode as { readonly workId: string }).workId);
              }
            } catch {
              // P10 validates the original opaque episode and returns its
              // bounded ProjectionIntegrityFailure; malformed text is never
              // used as a query selector.
            }
          }
          const workRows =
            workIds.size === 0
              ? []
              : yield* sql.unsafe<{
                  readonly work_id: string;
                  readonly project_id: string;
                  readonly workspace_id: string;
                  readonly revision: number;
                }>(
                  `SELECT work_id, project_id, workspace_id, revision
                     FROM works
                    WHERE work_id IN (${[...workIds].map(() => "?").join(",")})`,
                  [...workIds],
                );
          const workById = new Map(workRows.map((row) => [row.work_id, row]));
          return executions.map((row) => {
            let episodeWorkId: string | null = null;
            if (row.episode_json !== null) {
              try {
                const episode: unknown = JSON.parse(row.episode_json);
                if (
                  typeof episode === "object" &&
                  episode !== null &&
                  (episode as { readonly _tag?: unknown })._tag ===
                    "WorkEpisode" &&
                  typeof (episode as { readonly workId?: unknown }).workId ===
                    "string"
                ) {
                  episodeWorkId = (episode as { readonly workId: string })
                    .workId;
                }
              } catch {
                // Preserve the invalid episode as null data for the P10
                // validator; do not infer another Work binding.
              }
            }
            const work =
              episodeWorkId === null ? undefined : workById.get(episodeWorkId);
            return {
              executionId: row.execution_id,
              projectId: row.project_id as ProjectId,
              workspaceId: row.workspace_id as WorkspaceId,
              episodeJson: row.episode_json,
              workId: work?.work_id ?? null,
              workProjectId:
                (work?.project_id as ProjectId | undefined) ?? null,
              workWorkspaceId:
                (work?.workspace_id as WorkspaceId | undefined) ?? null,
              workRevision: work === undefined ? null : Number(work.revision),
            };
          });
        }),
      );

    const readEvents = (projectId: ProjectId) =>
      inTx(
        Effect.gen(function* () {
          const last = yield* journal.lastSequence(projectId);
          if (last === 0) {
            return [] as ReadonlyArray<DomainEvent<unknown>>;
          }
          return yield* journal.readAfter(projectId, 0, last);
        }),
      );

    const journalLastSequence = (projectId: ProjectId) =>
      inTx(journal.lastSequence(projectId));

    const workspaceProjectIdSql = (
      workspaceId: WorkspaceId,
    ): Effect.Effect<ProjectId, unknown, TransactionScope> =>
      Effect.gen(function* () {
        const rows = yield* sql.unsafe<{ project_id: string }>(
          "SELECT project_id FROM workspaces WHERE workspace_id = ?",
          [workspaceId],
        );
        return rows[0]?.project_id as ProjectId;
      });

    const projectIdOfWorkspace = (workspaceId: WorkspaceId) =>
      inTx(workspaceProjectIdSql(workspaceId));

    const listUsageTurns = (projectId: ProjectId) =>
      inTx(
        Effect.gen(function* () {
          const rows = yield* sql.unsafe<{
            workspace_id: string;
            usage_json: string | null;
            settled_at: string | null;
          }>(
            "SELECT e.workspace_id AS workspace_id, pt.usage_json AS usage_json, pt.settled_at AS settled_at FROM provider_turns pt JOIN executions e ON e.execution_id = pt.execution_id WHERE e.project_id = ? ORDER BY pt.provider_turn_id",
            [projectId],
          );
          return rows.map((row) => ({
            workspaceId: row.workspace_id as WorkspaceId,
            usageJson: row.usage_json,
            settledAt: row.settled_at,
          }));
        }),
      );

    const listDependenciesByWorkspace = (workspaceId: WorkspaceId) =>
      inTx(
        Effect.gen(function* () {
          const projectId = yield* workspaceProjectIdSql(workspaceId);
          const all = yield* dependencies.listByProject(projectId);
          const owned = yield* works.listByWorkspace(workspaceId);
          const ownedIds = new Set(owned.map((work) => work.workId));
          return all.filter((dependency) =>
            ownedIds.has(dependency.consumerWorkId),
          );
        }),
      );

    const listVerificationsByWorkspace = (workspaceId: WorkspaceId) =>
      inTx(
        Effect.gen(function* () {
          const rows = yield* sql.unsafe<{ verification_id: string }>(
            "SELECT v.verification_id FROM verifications v JOIN works w ON w.work_id = v.work_id WHERE w.workspace_id = ? ORDER BY v.verification_id",
            [workspaceId],
          );
          const out: Array<Verification> = [];
          for (const row of rows) {
            const found = yield* verifications.findById(
              row.verification_id as never,
            );
            if (Option.isSome(found)) {
              out.push(found.value);
            }
          }
          return out;
        }),
      );

    const attention: AttentionReadDeps = {
      listWorkspacesByProject,
      listWorksByWorkspace: (workspaceId) =>
        inTx(works.listByWorkspace(workspaceId)),
      listExecutionSettlementFacts,
      listAttentionSourceExecutionBindings,
      listOpenVerifications: () => inTx(verifications.listOpen()),
      listUnsatisfiedDependencies: (projectId) =>
        inTx(dependencies.listUnsatisfiedByProject(projectId)),
      findDependency: (dependencyId) =>
        inTx(dependencies.findById(dependencyId as never)),
      readEvents,
      findAssignWorkBindingFailure: (attentionFactId) =>
        inTx(bindingAttention.findAssignWorkBindingFailure(attentionFactId)),
      findSubmittedDecisionBindingFailure: (attentionFactId) =>
        bindingAttention.findSubmittedDecisionBindingFailure === undefined
          ? Effect.succeed(Option.none())
          : inTx(
              bindingAttention.findSubmittedDecisionBindingFailure(
                attentionFactId,
              ),
            ),
      ...(bindingAttention.findLegacyAdoptionFailure === undefined
        ? {}
        : {
            findLegacyAdoptionFailure: (attentionFactId: string) =>
              inTx(
                bindingAttention.findLegacyAdoptionFailure?.(attentionFactId) ??
                  Effect.succeed(Option.none()),
              ),
          }),
      ...(bindingAttention.findLegacyAdoptionResolution === undefined
        ? {}
        : {
            findLegacyAdoptionResolution: (attentionFactId: string) =>
              inTx(
                bindingAttention.findLegacyAdoptionResolution?.(
                  attentionFactId,
                ) ?? Effect.succeed(Option.none()),
              ),
          }),
      listProjectedAssignWorkBindingFailures: (projectId) =>
        inTx(attentionProjection.listAssignWorkBindingFailures(projectId)),
      listProjectedDeliverReplayFailures: (projectId) =>
        inTx(attentionProjection.listDeliverReplayFailures(projectId)),
      ...(attentionProjection.listSubmittedDecisionBindingFailures === undefined
        ? {}
        : {
            listProjectedSubmittedDecisionBindingFailures: (projectId) =>
              inTx(
                Effect.gen(function* () {
                  const factsReady =
                    bindingAttention.isSubmittedDecisionBindingAvailable;
                  const markersReady =
                    attentionProjection.isSubmittedDecisionBindingAvailable;
                  if (factsReady === undefined || markersReady === undefined) {
                    return yield* Effect.fail({
                      _tag: "PersistenceUnavailable" as const,
                      repository: "AttentionProjectionStore" as const,
                      operation: "submitted-decision-binding-readiness",
                      retryDisposition: "non-retryable" as const,
                      sourceTag: "P41AvailabilityProbeUnavailable",
                      cause:
                        "P41 fact and marker availability probes are required before projection reads",
                    });
                  }
                  const [factsAvailable, markersAvailable] = yield* Effect.all([
                    factsReady(),
                    markersReady(),
                  ]);
                  if (factsAvailable !== markersAvailable) {
                    return yield* Effect.fail({
                      _tag: "PersistenceCorruption" as const,
                      repository: "AttentionProjectionStore" as const,
                      operation: "submitted-decision-binding-readiness",
                      reason:
                        "P41 RecoveryAttentionFactStore and AttentionProjectionStore availability differs",
                    });
                  }
                  if (!factsAvailable) return [];
                  const listSubmitted =
                    attentionProjection.listSubmittedDecisionBindingFailures;
                  if (listSubmitted === undefined) return [];
                  return yield* listSubmitted(projectId);
                }),
              ),
          }),
      ...(attentionProjection.listLegacyAdoptionFailures === undefined
        ? {}
        : {
            listProjectedLegacyAdoptionFailures: (projectId: ProjectId) =>
              inTx(
                attentionProjection.listLegacyAdoptionFailures?.(projectId) ??
                  Effect.succeed([]),
              ),
          }),
      listProjectedWorkspaceResourceActivations: (projectId) =>
        inTx(
          attentionProjection.listWorkspaceResourceActivationPending(projectId),
        ),
      ...(blockers === undefined
        ? {}
        : {
            listWorkBlockersByWorkRevision: (
              workId: WorkId,
              revision: number,
            ) =>
              inTx(
                blockers.listByWorkRevision(workId, revision as WorkRevision),
              ),
          }),
      hasActiveWorkEpisode: (workId, revision) =>
        inTx(
          Effect.gen(function* () {
            const work = yield* works.findById(workId);
            if (Option.isNone(work) || work.value.revision !== revision)
              return false;
            const active = yield* executions.findActiveMainByWorkspace(
              work.value.workspaceId,
            );
            if (Option.isNone(active)) return false;
            const episode = executionEpisode(active.value);
            return (
              episode?._tag === "WorkEpisode" &&
              episode.workId === workId &&
              episode.targetWorkRevision === revision
            );
          }),
        ),
      listProjectedToolObservationReplayFailures: (projectId) =>
        attentionProjection.listToolObservationReplayFailures === undefined
          ? Effect.succeed([])
          : inTx(
              attentionProjection.listToolObservationReplayFailures(projectId),
            ),
      listProjectedSandboxProviderUnavailableFailures: (projectId) =>
        attentionProjection.listProjectedSandboxProviderUnavailableFailures ===
        undefined
          ? Effect.succeed([])
          : inTx(
              Effect.gen(function* () {
                return yield* attentionProjection.listProjectedSandboxProviderUnavailableFailures?.(
                  projectId,
                  yield* clock.now(),
                ) ?? Effect.succeed([]);
              }),
            ),
      listSandboxRecoveryBindingFailures: (projectId) =>
        attentionProjection.listSandboxRecoveryBindingFailures === undefined
          ? Effect.succeed([])
          : inTx(
              Effect.gen(function* () {
                return yield* attentionProjection.listSandboxRecoveryBindingFailures?.(
                  projectId,
                  yield* clock.now(),
                ) ?? Effect.succeed([]);
              }),
            ),
      listSandboxPolicyDecisionRequired: (projectId) =>
        attentionProjection.listSandboxPolicyDecisionRequired === undefined
          ? Effect.succeed([])
          : inTx(
              Effect.gen(function* () {
                return yield* attentionProjection.listSandboxPolicyDecisionRequired?.(
                  projectId,
                  yield* clock.now(),
                ) ?? Effect.succeed([]);
              }),
            ),
    };

    const tree: TreeViewDeps = {
      listWorkspacesByProject,
      findWork: (workId) => inTx(works.findById(workId)),
      listWorksByWorkspace: (workspaceId) =>
        inTx(works.listByWorkspace(workspaceId)),
      findActiveMainExecution: (workspaceId) =>
        inTx(executions.findActiveMainByWorkspace(workspaceId)),
      listActiveWaits: () => inTx(waits.listActive()),
      listOpenVerifications: () => inTx(verifications.listOpen()),
      classify: (workspaceId) =>
        source
          .classify(workspaceId)
          .pipe(Effect.mapError((cause) => projectionReadError(cause))),
      readAttentionRows: (projectId) =>
        deriveProjectAttention(projectId, attention),
      listUsageTurns,
    };

    const proposalOriginWorkspace = (proposalId: string) =>
      inTx(
        Effect.gen(function* () {
          const rows = yield* sql.unsafe<{ parent_workspace_id: string }>(
            "SELECT parent_workspace_id FROM formation_proposals WHERE proposal_id = ?",
            [proposalId],
          );
          const parent = rows[0]?.parent_workspace_id as
            | WorkspaceId
            | undefined;
          return parent !== undefined ? Option.some(parent) : Option.none();
        }),
      );

    const workspaceDetail: WorkspaceDetailDeps = {
      findWorkspace: (workspaceId) => inTx(workspaces.findById(workspaceId)),
      findWork: (workId) => inTx(works.findById(workId)),
      listWorksByWorkspace: (workspaceId) =>
        inTx(works.listByWorkspace(workspaceId)),
      findActiveMainExecution: (workspaceId) =>
        inTx(executions.findActiveMainByWorkspace(workspaceId)),
      sandboxPolicyForExecution: (execution) =>
        Effect.gen(function* () {
          const pendingRequirement = Option.isSome(sandboxPolicyRequirement)
            ? yield* inTx(
                sandboxPolicyRequirement.value
                  .findPendingByExecution({
                    projectId: execution.projectId,
                    workspaceId: execution.workspaceId,
                    executionId: execution.executionId,
                  })
                  .pipe(Effect.mapError(projectionReadError)),
              )
            : Option.none();
          if (Option.isSome(pendingRequirement)) {
            const requirementReadPort = Option.isSome(sandboxPolicyRequirement)
              ? sandboxPolicyRequirement.value
              : undefined;
            if (requirementReadPort === undefined)
              return yield* Effect.fail(
                projectionReadError({
                  _tag: "SandboxPolicyCandidateReadPortUnavailable",
                }),
              );
            const authorityResult = Option.isSome(currentSandboxAuthority)
              ? yield* currentSandboxAuthority.value.loadCurrentVerifiedV2()
              : {
                  _tag: "Unavailable" as const,
                  failure: "SourceMissing" as const,
                };
            if (authorityResult._tag !== "Available")
              return yield* Effect.fail(
                projectionReadError({
                  _tag: "SandboxPolicyCandidateAuthorityUnavailable",
                  failure: authorityResult.failure,
                }),
              );
            return yield* inTx(
              Effect.gen(function* () {
                const requirement = yield* requirementReadPort
                  .findPendingByExecution({
                    projectId: execution.projectId,
                    workspaceId: execution.workspaceId,
                    executionId: execution.executionId,
                  })
                  .pipe(Effect.mapError(projectionReadError));
                if (
                  Option.isNone(requirement) ||
                  !sameSandboxPolicyRequirement(
                    pendingRequirement.value,
                    requirement.value,
                  )
                )
                  return yield* Effect.fail(
                    projectionReadError({
                      _tag: "SandboxPolicyCandidateRequirementChanged",
                    }),
                  );
                const currentExecution = yield* executions.findById(
                  execution.executionId,
                );
                if (
                  Option.isNone(currentExecution) ||
                  currentExecution.value.state.status !== "Active"
                )
                  return yield* Effect.fail(
                    projectionReadError({
                      _tag: "SandboxPolicyCandidateExecutionUnavailable",
                    }),
                  );
                const currentEpisode = executionEpisode(currentExecution.value);
                const suppliedEpisode = executionEpisode(execution);
                if (
                  currentEpisode === undefined ||
                  suppliedEpisode === undefined ||
                  encodeExecutionEpisodeBinding(currentEpisode) !==
                    encodeExecutionEpisodeBinding(suppliedEpisode)
                )
                  return yield* Effect.fail(
                    projectionReadError({
                      _tag: "SandboxPolicyCandidateExecutionChanged",
                    }),
                  );
                const episodeRevision = yield* executions.findEpisodeRevision(
                  execution.executionId,
                );
                if (
                  Option.isNone(episodeRevision) ||
                  episodeRevision.value !==
                    requirement.value.expectedEpisodeRevision
                )
                  return yield* Effect.fail(
                    projectionReadError({
                      _tag: "SandboxPolicyCandidateEpisodeRevisionChanged",
                    }),
                  );
                if (
                  Option.isNone(sandboxPolicyStore) ||
                  Option.isNone(sandboxPolicyCandidateBoundary)
                )
                  return yield* Effect.fail(
                    projectionReadError({
                      _tag: "SandboxPolicyCandidateReadPortUnavailable",
                    }),
                  );
                const currentDecision =
                  yield* sandboxPolicyStore.value.findCurrentForExecution(
                    currentExecution.value.projectId,
                    currentExecution.value.workspaceId,
                    currentExecution.value.executionId,
                  );
                const boundary = yield* sandboxPolicyCandidateBoundary.value
                  .readCurrentForWorkspace({
                    projectId: currentExecution.value.projectId,
                    workspaceId: currentExecution.value.workspaceId,
                  })
                  .pipe(Effect.mapError(projectionReadError));
                const built = buildSandboxPolicyCandidateReadV1({
                  reason: Option.isSome(currentDecision)
                    ? "RefreshStaleCommittedPolicy"
                    : "InitialDecision",
                  execution: currentExecution.value,
                  requirement: requirement.value,
                  latestCommittedPolicyRevision: Option.isSome(currentDecision)
                    ? currentDecision.value.decision.policyRevision
                    : 0,
                  expectedEpisodeRevision: episodeRevision.value,
                  boundary,
                  authority: authorityResult.snapshot,
                  currentHost: authorityResult.currentHost,
                });
                if (built._tag !== "Ready")
                  return yield* Effect.fail(projectionReadError(built));
                return {
                  ...(Option.isSome(currentDecision)
                    ? {
                        sandboxPolicy: {
                          ...sandboxPolicyCommittedViewOf(
                            currentDecision.value.result,
                          ),
                          status: "NeedsDecision" as const,
                        },
                      }
                    : {}),
                  sandboxPolicyCandidateRead: built.value,
                };
              }),
            );
          }
          return yield* inTx(
            Effect.gen(function* () {
              if (
                Option.isNone(sandboxPolicyStore) ||
                Option.isNone(sandboxUnavailableStore)
              ) {
                return {};
              }
              const episode = executionEpisode(execution);
              if (episode === undefined) return {};
              const decision =
                yield* sandboxPolicyStore.value.findCurrentForExecution(
                  execution.projectId,
                  execution.workspaceId,
                  execution.executionId,
                );
              if (Option.isNone(decision)) return {};
              const { decision: committed, result } = decision.value;
              const snapshot = result.effectivePolicySnapshot;
              if (
                committed.projectId !== execution.projectId ||
                committed.workspaceId !== execution.workspaceId ||
                committed.executionId !== execution.executionId ||
                encodeExecutionEpisodeBinding(committed.episodeBinding) !==
                  encodeExecutionEpisodeBinding(episode) ||
                snapshot.projectId !== execution.projectId ||
                snapshot.workspaceId !== execution.workspaceId ||
                snapshot.executionId !== execution.executionId ||
                encodeExecutionEpisodeBinding(snapshot.episodeBinding) !==
                  encodeExecutionEpisodeBinding(episode)
              ) {
                return yield* Effect.fail(
                  projectionReadError({
                    _tag: "SandboxProviderUnavailableDecisionMismatch",
                  }),
                );
              }
              const unavailable =
                yield* sandboxUnavailableStore.value.findByExecutionAndRevision(
                  execution.executionId,
                  committed.policyRevision,
                );
              const exactUnavailable =
                unavailable !== undefined &&
                unavailable.projectId === execution.projectId &&
                unavailable.workspaceId === execution.workspaceId &&
                encodeExecutionEpisodeBinding(unavailable.episodeBinding) ===
                  encodeExecutionEpisodeBinding(committed.episodeBinding) &&
                unavailable.policyDigest === committed.policyDigest &&
                snapshot.kind === "OsEnforced" &&
                unavailable.profileId === snapshot.profile &&
                unavailable.providerId === snapshot.providerId &&
                unavailable.providerVersion === snapshot.providerVersion;
              if (unavailable !== undefined && !exactUnavailable) {
                return yield* Effect.fail(
                  projectionReadError({
                    _tag: "SandboxProviderUnavailableDecisionMismatch",
                  }),
                );
              }
              const now = yield* clock.now();
              const committedView = sandboxPolicyCommittedViewOf(result);
              if (
                unavailable === undefined &&
                Option.isSome(p4SandboxOutcomeReadPort)
              ) {
                const outcomes = yield* p4SandboxOutcomeReadPort.value
                  .findUnavailableByExecutionAndRevision(
                    execution.executionId,
                    committed.policyRevision,
                  )
                  .pipe(Effect.mapError(projectionReadError));
                const exactOutcome = outcomes.find(
                  (candidate) =>
                    snapshot.kind === "OsEnforced" &&
                    candidate.policyRevision === committed.policyRevision &&
                    candidate.policyDigest === committed.policyDigest &&
                    candidate.profile === snapshot.profile &&
                    candidate.providerId === snapshot.providerId &&
                    candidate.providerVersion === snapshot.providerVersion &&
                    String(snapshot.capabilityRevision) ===
                      candidate.capabilityRevision,
                );
                if (
                  outcomes.length > 1 ||
                  (outcomes.length > 0 && exactOutcome === undefined)
                ) {
                  return yield* Effect.fail(
                    projectionReadError({
                      _tag: "SandboxProviderUnavailableDecisionMismatch",
                    }),
                  );
                }
                if (exactOutcome !== undefined) {
                  return yield* Effect.fail({
                    _tag: "SandboxProviderUnavailableProjection" as const,
                    code: "sandbox/provider-unavailable" as const,
                    category: "unavailable" as const,
                    correlationId: null,
                    retryDisposition: "retryable" as const,
                    message:
                      "required sandbox capability was unavailable or could not be verified; execution did not start" as const,
                    safeDetails: {
                      executionId: execution.executionId,
                      workspaceId: execution.workspaceId,
                      policyRevision: committed.policyRevision,
                    },
                  });
                }
              }
              const workspace = yield* workspaces.findById(
                execution.workspaceId,
              );
              if (Option.isNone(workspace)) return {};
              const episodeRevisionRows = yield* sql.unsafe<{
                readonly episode_revision: number;
              }>(
                "SELECT episode_revision FROM executions WHERE execution_id = ?",
                [execution.executionId],
              );
              const expectedEpisodeRevision =
                episodeRevisionRows[0]?.episode_revision;
              if (
                expectedEpisodeRevision === undefined ||
                !Number.isSafeInteger(expectedEpisodeRevision) ||
                expectedEpisodeRevision < 0
              ) {
                return yield* Effect.fail(
                  projectionReadError({
                    _tag: "SandboxProviderUnavailableDecisionMismatch",
                  }),
                );
              }
              const authoritySnapshot = sandboxAuthoritySnapshot;
              const preconditions =
                authoritySnapshot === undefined
                  ? undefined
                  : {
                      kind:
                        snapshot.kind === "OsEnforced"
                          ? ("OsEnforced" as const)
                          : ("TrustedLocalUnconfinedV1" as const),
                      expectedEpisodeRevision,
                      latestCommittedPolicyRevision: committed.policyRevision,
                      episodeBinding: episode,
                      workspaceRevision: workspace.value.revision,
                      resourceBoundaryRevision:
                        workspace.value.resourceBoundaryRevision,
                      sandboxHandleBindingDigest:
                        snapshot.sandboxHandleBindingDigest,
                      authorityBundleRevision:
                        authoritySnapshot.authorityBundleRevision,
                      authorityBundleDigest:
                        authoritySnapshot.authorityBundleDigest,
                      operatorConfigRevision: authoritySnapshot.config.revision,
                      operatorConfigDigest: authoritySnapshot.configDigest,
                      ...(snapshot.kind === "OsEnforced"
                        ? {
                            providerRegistryRevision:
                              authoritySnapshot.providerRegistryRevision,
                            providerRegistryDigest:
                              authoritySnapshot.providerRegistryDigest,
                          }
                        : {}),
                    };
              const sourceCurrent =
                snapshot.workspaceRevision === workspace.value.revision &&
                snapshot.resourceBoundaryRevision ===
                  workspace.value.resourceBoundaryRevision &&
                authoritySnapshot !== undefined &&
                snapshot.authorityBundleRevision ===
                  authoritySnapshot.authorityBundleRevision &&
                snapshot.authorityBundleDigest ===
                  authoritySnapshot.authorityBundleDigest &&
                snapshot.operatorConfigRevision ===
                  authoritySnapshot.config.revision &&
                snapshot.operatorConfigDigest ===
                  authoritySnapshot.configDigest &&
                (snapshot.kind !== "OsEnforced" ||
                  (snapshot.providerRegistryRevision ===
                    authoritySnapshot.providerRegistryRevision &&
                    snapshot.providerRegistryDigest ===
                      authoritySnapshot.providerRegistryDigest));
              if (!sourceCurrent || snapshot.expiresAt <= now) {
                const pendingPolicyRequired =
                  attentionProjection.listSandboxPolicyDecisionRequired ===
                  undefined
                    ? []
                    : yield* attentionProjection.listSandboxPolicyDecisionRequired(
                        execution.projectId,
                        now,
                      );
                const hasPendingAction = pendingPolicyRequired.some(
                  (pending) =>
                    pending.executionId === execution.executionId &&
                    pending.workspaceId === execution.workspaceId,
                );
                if (!hasPendingAction) return {};
                return {
                  sandboxPolicy: {
                    ...committedView,
                    status: "NeedsDecision" as const,
                  },
                  ...(preconditions === undefined
                    ? {}
                    : { sandboxPolicyPreconditions: preconditions }),
                };
              }
              return {
                sandboxPolicy: {
                  ...committedView,
                  status: exactUnavailable
                    ? ("Unavailable" as const)
                    : ("Committed" as const),
                },
                ...(preconditions === undefined
                  ? {}
                  : { sandboxPolicyPreconditions: preconditions }),
              };
            }),
          );
        }),
      listDependenciesByWorkspace,
      listUnconsumedInbox: (workspaceId) =>
        inTx(
          Effect.gen(function* () {
            const rows = yield* sql.unsafe<{
              workspace_id: string;
              entry_key: string;
              kind: string;
              summary: string;
              correlation_id: string | null;
              admitted_at: string;
              revision: number;
              updated_at: string;
            }>(
              "SELECT workspace_id, entry_key, kind, summary, correlation_id, admitted_at, revision, updated_at FROM inbox_entries WHERE workspace_id = ? AND consumed_at IS NULL ORDER BY admitted_at",
              [workspaceId],
            );
            return rows.map((row) => ({
              recipientWorkspaceId: row.workspace_id as WorkspaceId,
              entryKey: row.entry_key,
              kind: row.kind as never,
              summary: row.summary,
              correlationId: row.correlation_id ?? undefined,
              admittedAt: row.admitted_at,
              revision: Number(row.revision),
              updatedAt: row.updated_at,
            }));
          }),
        ),
      listUnboundLegacyInbox: (workspaceId) =>
        Option.isSome(retryVerificationOrigins)
          ? inTx(
              retryVerificationOrigins.value.listCurrentUnboundLegacyInbox(
                workspaceId,
              ),
            )
          : Effect.succeed([]),
      listVerificationsByWork: (workId) =>
        inTx(verifications.listByWork(workId)),
      listEvidenceByVerification: (verificationId) =>
        inTx(evidence.listByVerification(verificationId as never)),
      findAcceptanceByWorkRevision: (workId, targetWorkRevision) =>
        inTx(acceptances.findByWorkRevision(workId, targetWorkRevision)),
      journalLastSequence,
      readEventsAfter: (projectId, sequence, limit) =>
        inTx(journal.readAfter(projectId, sequence, limit)),
      proposalOriginWorkspace,
    };

    const currentWork: CurrentWorkDeps = {
      findWorkspace: (workspaceId) => inTx(workspaces.findById(workspaceId)),
      findWork: (workId) => inTx(works.findById(workId)),
      findActiveMainExecution: (workspaceId) =>
        inTx(executions.findActiveMainByWorkspace(workspaceId)),
    };

    const verificationView: VerificationViewDeps = {
      findWork: (workId) => inTx(works.findById(workId)),
      listVerificationsByWork: (workId) =>
        inTx(verifications.listByWork(workId)),
      listEvidenceByVerification: (verificationId) =>
        inTx(evidence.listByVerification(verificationId as never)),
      findAcceptanceByWorkRevision: (workId, targetWorkRevision) =>
        inTx(acceptances.findByWorkRevision(workId, targetWorkRevision)),
    };

    const workDetail: WorkDetailDeps = {
      findWork: (workId) => inTx(works.findById(workId)),
      findAcceptanceByWorkRevision: (workId, revision) =>
        inTx(acceptances.findByWorkRevision(workId, revision)),
      findVerification: (verificationId) =>
        inTx(verifications.findById(verificationId)),
      ...(blockers === undefined
        ? {}
        : {
            listWorkBlockersByWorkRevision: (
              workId: WorkId,
              revision: number,
            ) =>
              inTx(
                blockers.listByWorkRevision(workId, revision as WorkRevision),
              ),
          }),
      findExecutionSettlement: (executionId) =>
        inTx(
          Effect.map(executions.findById(executionId), (found) =>
            Option.flatMap(found, (execution) =>
              execution.state.status === "Settled"
                ? Option.some(execution.state.settlement)
                : Option.none(),
            ),
          ),
        ),
    };

    const dependencyView: DependencyViewDeps = {
      listDependenciesByProject: (projectId) =>
        inTx(dependencies.listByProject(projectId)),
      listWorksByWorkspace: (workspaceId) =>
        inTx(works.listByWorkspace(workspaceId)),
      findWorkspace: (workspaceId) =>
        inTx(
          Effect.map(workspaces.findById(workspaceId), (found) =>
            Option.map(found, (workspace) => ({
              projectId: workspace.projectId,
            })),
          ),
        ),
    };

    const transcript: TranscriptDeps = {
      listSessionsByWorkspace: (workspaceId) =>
        inTx(
          Effect.gen(function* () {
            const rows = yield* sql.unsafe<{ session_id: string }>(
              "SELECT session_id FROM sessions WHERE workspace_id = ? UNION SELECT s.session_id FROM sessions s JOIN executions e ON e.session_id = s.session_id WHERE e.workspace_id = ? ORDER BY session_id",
              [workspaceId, workspaceId],
            );
            return rows.map((row) => row.session_id as never);
          }),
        ),
      conversationTurns: (workspaceId) =>
        inTx(
          Effect.gen(function* () {
            const rows = yield* sql.unsafe<
              ConversationJobViewRow & {
                message_id: string;
                body_ref: string;
                created_at: string;
                response_body: string | null;
                response_updated_at: string | null;
              }
            >(
              `SELECT hm.message_id, hm.body_ref, hm.created_at,
                 job.state AS job_state, job.revision AS job_revision,
                 job.active_execution_id, job.next_attempt_no,
                 job.next_eligible_at, job.attention_reason,
                 job.response_execution_id, job.response_body,
                 job.updated_at AS response_updated_at
               FROM human_messages hm
               LEFT JOIN conversation_response_jobs job
                 ON job.message_id = hm.message_id
               WHERE hm.root_workspace_id = ?
               ORDER BY hm.created_at ASC, hm.message_id ASC`,
              [workspaceId],
            );
            const turns: Array<{
              kind: "HumanConversationTurn" | "AssistantConversationTurn";
              messageId?: string;
              executionId?: string;
              body: string;
              occurredAt: string;
              responseStatus?: ConversationResponseStatus;
            }> = [];
            for (const row of rows) {
              const responseStatus = responseStatusOf(row);
              turns.push({
                kind: "HumanConversationTurn",
                messageId: row.message_id,
                body: row.body_ref,
                occurredAt: row.created_at,
                ...(responseStatus === undefined ? {} : { responseStatus }),
              });
              if (
                row.job_state === "Answered" &&
                row.response_updated_at !== null &&
                row.response_body !== null
              ) {
                turns.push({
                  kind: "AssistantConversationTurn",
                  executionId: row.response_execution_id ?? "",
                  body: row.response_body,
                  occurredAt: row.response_updated_at,
                  messageId: row.message_id,
                });
              }
            }
            return turns as never;
          }),
        ),
      conversationHistoryPage: (workspaceId, before, limit) =>
        inTx(
          Effect.gen(function* () {
            const beforeClause =
              before === null
                ? ""
                : `WHERE occurred_at < ?
                    OR (occurred_at = ? AND (
                      message_id < ?
                      OR (message_id = ? AND turn_order < ?)
                    ))`;
            const beforeParams =
              before === null
                ? []
                : [
                    before.occurredAt,
                    before.occurredAt,
                    before.messageId,
                    before.messageId,
                    before.turnOrder,
                  ];
            const rows = yield* sql.unsafe<{
              message_id: string;
              execution_id: string | null;
              turn_kind: "human" | "assistant";
              turn_order: 0 | 1;
              body: string;
              occurred_at: string;
            }>(
              `WITH turns AS (
                 SELECT
                   message_id,
                   NULL AS execution_id,
                   'human' AS turn_kind,
                   0 AS turn_order,
                   body_ref AS body,
                   created_at AS occurred_at
                 FROM human_messages
                 WHERE root_workspace_id = ?
                 UNION ALL
                 SELECT
                   hm.message_id,
                   job.response_execution_id AS execution_id,
                   'assistant' AS turn_kind,
                   1 AS turn_order,
                   job.response_body AS body,
                   job.updated_at AS occurred_at
                 FROM human_messages hm
                 JOIN conversation_response_jobs job
                   ON job.message_id = hm.message_id
                 WHERE hm.root_workspace_id = ?
                   AND job.state = 'Answered'
                   AND job.response_execution_id IS NOT NULL
                   AND job.response_body IS NOT NULL
               )
               SELECT
                 message_id,
                 execution_id,
                 turn_kind,
                 turn_order,
                 body,
                 occurred_at
               FROM turns
               ${beforeClause}
               ORDER BY occurred_at DESC, message_id DESC, turn_order DESC
               LIMIT ?`,
              [workspaceId, workspaceId, ...beforeParams, limit + 1],
            );
            const hasMore = rows.length > limit;
            const pageRows = rows.slice(0, limit);
            const oldest = pageRows[pageRows.length - 1];
            const messageIds = [
              ...new Set(pageRows.map((row) => row.message_id)),
            ];
            const jobRows =
              messageIds.length === 0
                ? []
                : yield* sql.unsafe<ConversationJobViewRow>(
                    `SELECT message_id, state AS job_state,
                       revision AS job_revision, active_execution_id,
                       next_attempt_no, next_eligible_at, attention_reason,
                       response_execution_id
                     FROM conversation_response_jobs
                     WHERE message_id IN (${messageIds.map(() => "?").join(",")})`,
                    messageIds,
                  );
            const statusByMessage = new Map(
              jobRows.map((row) => [row.message_id, responseStatusOf(row)]),
            );
            const turns = pageRows.reverse().map((row) => {
              if (row.turn_kind === "human") {
                const responseStatus = statusByMessage.get(row.message_id);
                return {
                  kind: "HumanConversationTurn" as const,
                  messageId: row.message_id,
                  body: row.body,
                  occurredAt: row.occurred_at,
                  ...(responseStatus === undefined ? {} : { responseStatus }),
                };
              }
              return {
                kind: "AssistantConversationTurn" as const,
                executionId: row.execution_id ?? "",
                body: row.body,
                occurredAt: row.occurred_at,
                messageId: row.message_id,
              };
            });
            const oldestCursor: ConversationHistoryCursor | undefined =
              hasMore && oldest !== undefined
                ? {
                    occurredAt: oldest.occurred_at,
                    messageId: oldest.message_id,
                    turnOrder: oldest.turn_order,
                  }
                : undefined;
            const page: ConversationHistoryPage = {
              turns,
              hasMore,
              ...(oldestCursor !== undefined ? { oldestCursor } : {}),
            };
            return page;
          }),
        ),
      listEntries: (sessionId, afterSequence, limit) =>
        inTx(
          Effect.gen(function* () {
            const rows = yield* sql.unsafe<{
              session_id: string;
              sequence: number;
              entry_kind: string;
              payload_json: string;
              created_at: string;
            }>(
              "SELECT session_id, sequence, entry_kind, payload_json, created_at FROM session_entries WHERE session_id = ? AND sequence > ? ORDER BY sequence LIMIT ?",
              [sessionId, afterSequence, limit],
            );
            return rows.map((row) => ({
              sessionId: row.session_id as never,
              sequence: Number(row.sequence),
              entryKind: row.entry_kind as never,
              payload: JSON.parse(row.payload_json) as unknown,
              createdAt: row.created_at,
            }));
          }),
        ),
      journalLastSequence,
    };

    const usage: UsageDeps = {
      listUsageTurns,
      listWorkspacesByProject,
    };

    const inboxView: InboxViewDeps = {
      listUnconsumedInbox: workspaceDetail.listUnconsumedInbox,
      listUnboundLegacyInbox:
        workspaceDetail.listUnboundLegacyInbox ?? (() => Effect.succeed([])),
      journalLastSequence,
      projectIdOfWorkspace,
      findExecutableApproval: (approvalId) =>
        inTx(executableApprovals.findById(approvalId)),
      findToolDefinitionHash: (approval) =>
        inTx(
          Effect.gen(function* () {
            const identity = {
              executionId: approval.executionId,
              logicalStepNo: approval.logicalStepNo,
              repairAttempt: approval.repairAttempt,
            };
            const stepOption = yield* agentLoopSteps.find(identity);
            if (Option.isNone(stepOption)) return Option.none();
            const step = stepOption.value;
            if (
              step.state !== "ActionsInProgress" ||
              step.manifestId === undefined
            ) {
              return Option.none();
            }
            const actions = yield* agentLoopSteps.listActions(identity);
            const matchingActions = actions.filter(
              (action) => action.actionIndex === approval.actionIndex,
            );
            if (
              matchingActions.length !== 1 ||
              matchingActions[0] === undefined
            ) {
              return Option.none();
            }
            const action = matchingActions[0];
            if (
              action.state !== "Pending" ||
              action.routeKind !== "Executable" ||
              action.logicalActionId !== approval.logicalActionId ||
              action.callRef !== approval.callRef ||
              action.actionKind !== approval.toolName ||
              action.inputHash !== sha256Hex(approval.argumentsJson)
            ) {
              return Option.none();
            }
            const manifestRecord = yield* providerTurns.findManifestByTurn(
              step.providerTurnId,
            );
            if (
              manifestRecord === null ||
              manifestRecord.manifestId !== step.manifestId
            ) {
              return Option.none();
            }
            const hash = approvedToolHashFromManifest({
              manifestJson: manifestRecord.manifestJson,
              providerTurnId: step.providerTurnId,
              executionId: approval.executionId,
              logicalStepNo: approval.logicalStepNo,
              repairAttempt: approval.repairAttempt,
              toolName: approval.toolName,
              toolVersion: approval.toolVersion,
            });
            return hash === null ? Option.none() : Option.some(hash);
          }),
        ),
      resolveToolDefinition: (
        projectId,
        toolName,
        toolVersion,
        toolDefinitionHash,
      ) =>
        Effect.gen(function* () {
          // ToolCatalogPort is composed for this application's project (or
          // builtins only when unconfigured). Never disclose project-scoped
          // tool metadata for a different Workspace project.
          if (
            catalogProjectId !== undefined &&
            projectId !== catalogProjectId
          ) {
            return Option.none();
          }
          const refs = yield* toolCatalog.visibleRefs();
          const matches = refs.filter(
            (ref) =>
              ref.name === toolName &&
              ref.version === toolVersion &&
              ref.hash === toolDefinitionHash,
          );
          if (matches.length !== 1 || matches[0] === undefined) {
            return Option.none();
          }
          const definition = yield* toolCatalog
            .resolveForModel(matches[0])
            .pipe(Effect.mapError(projectionReadError));
          return Option.some(definition);
        }),
    };

    const effectiveFacts: EffectiveFactsDeps = {
      findWorkspace: (workspaceId) => inTx(workspaces.findById(workspaceId)),
      findWork: (workId) => inTx(works.findById(workId)),
      listWorksByWorkspace: (workspaceId) =>
        inTx(works.listByWorkspace(workspaceId)),
      listDependenciesByWorkspace,
      listVerificationsByWorkspace,
      listUnconsumedInbox: workspaceDetail.listUnconsumedInbox,
      journalLastSequence,
    };

    const listInboxRows = (workspaceId: WorkspaceId) =>
      inTx(
        Effect.gen(function* () {
          const rows = yield* sql.unsafe<{
            workspace_id: string;
            entry_key: string;
            kind: string;
            summary: string;
            correlation_id: string | null;
            admitted_at: string;
            consumed_at: string | null;
            revision: number;
            updated_at: string;
          }>(
            "SELECT workspace_id, entry_key, kind, summary, correlation_id, admitted_at, consumed_at, revision, updated_at FROM inbox_entries WHERE workspace_id = ? ORDER BY admitted_at, entry_key",
            [workspaceId],
          );
          return rows.map(
            (row): InboxRowFact => ({
              entryKey: row.entry_key,
              kind: row.kind as never,
              summary: row.summary,
              correlationId: row.correlation_id,
              admittedAt: row.admitted_at,
              consumedAt: row.consumed_at,
            }),
          );
        }),
      );

    const inboxReconcile: InboxReconcileDeps = {
      listInboxRows,
      listMessagesForRecipient: (workspaceId) =>
        inTx(messages.listByRecipient(workspaceId)),
      listSpecialistSettlementFacts: (workspaceId) =>
        inTx(
          Effect.gen(function* () {
            const rows = yield* sql.unsafe<{
              execution_id: string;
              settlement_json: string;
            }>(
              "SELECT e.execution_id AS execution_id, e.settlement_json AS settlement_json FROM executions e JOIN workspaces w ON w.workspace_id = e.workspace_id WHERE w.parent_workspace_id = ? AND e.settlement_json IS NOT NULL ORDER BY e.execution_id",
              [workspaceId],
            );
            return rows.map(
              (row): SpecialistSettlementFact => ({
                specialistExecutionId: row.execution_id,
                settlementFingerprint: settlementFingerprint(
                  JSON.parse(row.settlement_json) as ExecutionSettlement,
                ),
              }),
            );
          }),
        ),
    };

    const deps: ProjectionQueryRuntimeDeps = {
      journalLastSequence,
      projectIdOfWorkspace,
      tree,
      attention,
      workspaceDetail,
      workDetail,
      currentWork,
      verification: verificationView,
      dependency: dependencyView,
      transcript,
      usage,
      inboxView,
      effectiveFacts,
      inboxReconcile,
    };

    return ProjectionQueryPort.of(makeProjectionQueryService(deps));
  });

export const ProjectionQueryPortLive = (
  catalogProjectId?: ProjectId,
  sandboxAuthoritySnapshot?: SandboxPolicyGrantIssuerConfigSnapshotV1,
): Layer.Layer<ProjectionQueryPort, never, ProjectionQueryWiringServices> =>
  Layer.effect(
    ProjectionQueryPort,
    projectionQueryService(catalogProjectId, sandboxAuthoritySnapshot),
  );
