import type {
  DomainEvent,
  ExecutionSettlement,
  Verification,
  Workspace,
} from "@arbor/domain";
import {
  type ProjectId,
  settlementFingerprint,
  type WorkspaceId,
} from "@arbor/domain";
import {
  AcceptanceRepository,
  DependencyRepository,
  DomainEventJournal,
  EvidenceRepository,
  ExecutionRepository,
  MessageStore,
  ProjectionQueryPort,
  RunnableWorkSource,
  TransactionPort,
  type TransactionScope,
  VerificationRepository,
  WorkRepository,
  WorkspaceRepository,
  WorkWaitStore,
} from "@arbor/ports";
import type {
  AttentionReadDeps,
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
  WorkspaceDetailDeps,
} from "@arbor/projection-runtime";
import {
  deriveProjectAttention,
  makeProjectionQueryService,
  projectionReadError,
} from "@arbor/projection-runtime";
import { Effect, Layer, Option } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";

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
  | TransactionPort
  | WorkspaceRepository
  | WorkRepository
  | ExecutionRepository
  | WorkWaitStore
  | DependencyRepository
  | VerificationRepository
  | EvidenceRepository
  | AcceptanceRepository
  | DomainEventJournal
  | MessageStore
  | RunnableWorkSource;

export const ProjectionQueryPortLive: Layer.Layer<
  ProjectionQueryPort,
  never,
  ProjectionQueryWiringServices
> = Layer.effect(
  ProjectionQueryPort,
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    const tx = yield* TransactionPort;
    const workspaces = yield* WorkspaceRepository;
    const works = yield* WorkRepository;
    const executions = yield* ExecutionRepository;
    const waits = yield* WorkWaitStore;
    const dependencies = yield* DependencyRepository;
    const verifications = yield* VerificationRepository;
    const evidence = yield* EvidenceRepository;
    const acceptances = yield* AcceptanceRepository;
    const journal = yield* DomainEventJournal;
    const messages = yield* MessageStore;
    const source = yield* RunnableWorkSource;

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
          }>(
            "SELECT execution_id, workspace_id, settlement_json, settled_at FROM executions WHERE project_id = ? ORDER BY execution_id",
            [projectId],
          );
          const facts: Array<ExecutionSettlementReadFact> = rows.map((row) => ({
            executionId: row.execution_id,
            workspaceId: row.workspace_id as WorkspaceId,
            settlement:
              row.settlement_json === null
                ? null
                : (JSON.parse(row.settlement_json) as ExecutionSettlement),
            settledAt: row.settled_at,
          }));
          return facts;
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
      listOpenVerifications: () => inTx(verifications.listOpen()),
      listUnsatisfiedDependencies: (projectId) =>
        inTx(dependencies.listUnsatisfiedByProject(projectId)),
      findDependency: (dependencyId) =>
        inTx(dependencies.findById(dependencyId as never)),
      readEvents,
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
            }>(
              "SELECT workspace_id, entry_key, kind, summary, correlation_id, admitted_at FROM inbox_entries WHERE workspace_id = ? AND consumed_at IS NULL ORDER BY admitted_at",
              [workspaceId],
            );
            return rows.map((row) => ({
              recipientWorkspaceId: row.workspace_id as WorkspaceId,
              entryKey: row.entry_key,
              kind: row.kind as never,
              summary: row.summary,
              correlationId: row.correlation_id ?? undefined,
              admittedAt: row.admitted_at,
            }));
          }),
        ),
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
      journalLastSequence,
      projectIdOfWorkspace,
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
          }>(
            "SELECT workspace_id, entry_key, kind, summary, correlation_id, admitted_at, consumed_at FROM inbox_entries WHERE workspace_id = ? ORDER BY admitted_at, entry_key",
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
  }),
);
