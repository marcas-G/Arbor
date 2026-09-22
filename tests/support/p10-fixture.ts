import { Effect, Layer, Option } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import {
  AcceptanceRepositoryLive,
  ClockLive,
  DependencyRepositoryLive,
  DomainEventJournalLive,
  EvidenceRepositoryLive,
  ExecutionRepositoryLive,
  IdGeneratorLive,
  InboxProjectionStoreLive,
  layer,
  MessageStoreLive,
  P8_MIGRATIONS,
  runMigrations,
  TransactionPortLive,
  VerificationRepositoryLive,
  WorkRepositoryLive,
  WorkspaceRepositoryLive,
  WorkWaitStoreLive,
} from "../../adapters/persistence-sqlite/src/index.js";
import { DependencyAwareRunnableWorkSourceLive } from "../../apps/single-workspace/src/runnable-source-p7.js";
import type {
  DomainEvent,
  ExecutionSettlement,
  Verification,
  Workspace,
} from "../../packages/domain/dist/index.js";
import {
  ProjectId,
  parse,
  settlementFingerprint,
  type WorkId,
  WorkspaceId,
} from "../../packages/domain/dist/index.js";
import {
  AcceptanceRepository,
  DependencyRepository,
  DomainEventJournal,
  EvidenceRepository,
  ExecutionRepository,
  MessageStore,
  RunnableWorkSource,
  TransactionPort,
  VerificationRepository,
  WorkRepository,
  WorkspaceRepository,
  WorkWaitStore,
} from "../../packages/ports/src/index.js";
import type { TransactionScope } from "../../packages/ports/src/session.js";
import type {
  AttentionReadDeps,
  CurrentWorkDeps,
  DependencyViewDeps,
  EffectiveFactsDeps,
  ExecutionSettlementReadFact,
  InboxReconcileDeps,
  InboxRowFact,
  InboxViewDeps,
  SpecialistSettlementFact,
  TranscriptDeps,
  TreeViewDeps,
  UsageDeps,
  VerificationViewDeps,
  WorkspaceDetailDeps,
} from "../../packages/projection-runtime/src/index.js";
import {
  deriveProjectAttention,
  projectionReadError,
} from "../../packages/projection-runtime/src/index.js";

export const p10Project = parse(ProjectId)(
  "prj_00000000-0000-7000-8000-000000000010",
);
export const p10Root = parse(WorkspaceId)(
  "ws_00000000-0000-7000-8000-000000000001",
);
export const p10Child = parse(WorkspaceId)(
  "ws_00000000-0000-7000-8000-000000000002",
);
export const p10Leaf = parse(WorkspaceId)(
  "ws_00000000-0000-7000-8000-000000000003",
);
export const p10Retired = parse(WorkspaceId)(
  "ws_00000000-0000-7000-8000-000000000004",
);
export const p10Flagged = parse(WorkspaceId)(
  "ws_00000000-0000-7000-8000-000000000005",
);

/** sqlite infra + the P7 classification source; no command gateway (fixtures
 * seed canonical rows directly via SQL — the p8-ddl precedent). */
export const makeP10App = () => {
  const base = layer({ filename: ":memory:" });
  const infra = Layer.mergeAll(base, ClockLive, IdGeneratorLive);
  const stores = Layer.mergeAll(
    Layer.provide(TransactionPortLive, infra),
    Layer.provide(WorkspaceRepositoryLive, infra),
    Layer.provide(WorkRepositoryLive, infra),
    Layer.provide(ExecutionRepositoryLive, infra),
    Layer.provide(WorkWaitStoreLive, infra),
    Layer.provide(DependencyRepositoryLive, infra),
    Layer.provide(VerificationRepositoryLive, infra),
    Layer.provide(EvidenceRepositoryLive, infra),
    Layer.provide(AcceptanceRepositoryLive, infra),
    Layer.provide(DomainEventJournalLive, infra),
    Layer.provide(MessageStoreLive, infra),
    Layer.provide(InboxProjectionStoreLive, infra),
  );
  return Layer.mergeAll(
    infra,
    stores,
    Layer.provide(DependencyAwareRunnableWorkSourceLive, stores),
  ) as unknown as Layer.Layer<SqlClient>;
};

export const runP10 = <A, R>(
  program: Effect.Effect<A, unknown, SqlClient | R>,
  app: Layer.Layer<SqlClient>,
): Promise<A> =>
  Effect.runPromise(
    Effect.scoped(
      Effect.provide(program as Effect.Effect<A, unknown, SqlClient>, app),
    ),
  );

// --- read-only deps assembled from canonical faces + minimal SQL ---

export interface P10FixtureDeps {
  readonly tree: TreeViewDeps;
  readonly attention: AttentionReadDeps;
  readonly workspaceDetail: WorkspaceDetailDeps;
  readonly currentWork: CurrentWorkDeps;
  readonly verificationView: VerificationViewDeps;
  readonly dependencyView: DependencyViewDeps;
  readonly transcript: TranscriptDeps;
  readonly usage: UsageDeps;
  readonly inboxView: InboxViewDeps;
  readonly effectiveFacts: EffectiveFactsDeps;
  readonly inboxReconcile: InboxReconcileDeps;
  readonly projectIdOfWorkspace: (
    workspaceId: WorkspaceId,
  ) => Effect.Effect<ProjectId, ReturnType<typeof projectionReadError>>;
  readonly journalLastSequence: (
    projectId: ProjectId,
  ) => Effect.Effect<number, ReturnType<typeof projectionReadError>>;
}

export const makeP10Deps = (): Effect.Effect<
  P10FixtureDeps,
  never,
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
  | RunnableWorkSource
> =>
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

    return {
      tree,
      attention,
      workspaceDetail,
      currentWork,
      verificationView,
      dependencyView,
      transcript,
      usage,
      inboxView,
      effectiveFacts,
      inboxReconcile,
      projectIdOfWorkspace,
      journalLastSequence,
    };
  });

// --- canonical-row seeding (SQL, the p7/p8 precedent) ---

const RESPONSIBILITY = JSON.stringify({
  purpose: "p10",
  ownedResponsibilities: [],
  obligations: [],
  includes: [],
  excludes: [],
  interfaces: [],
});
const BOUNDARY = JSON.stringify({
  basisResponsibilityRevision: 0,
  addresses: [],
});
const MISSION = JSON.stringify({
  goal: "g",
  criteria: [],
  riskRequirements: [],
});

export interface WorkspaceSeed {
  readonly workspaceId: WorkspaceId;
  readonly parentWorkspaceId: WorkspaceId | null;
  readonly name: string;
  readonly lifecycle?: "Active" | "Retired";
}

export const insertProjectRootRow = (
  rootWorkspaceId: WorkspaceId,
  projectId: ProjectId,
): Effect.Effect<void, unknown, SqlClient> =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    yield* sql.unsafe(
      "INSERT INTO projects (project_id, name, root_workspace_id, project_policy, project_policy_revision, default_configuration, environment_ref, lifecycle, revision, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
      [
        projectId,
        "p10",
        rootWorkspaceId,
        "{}",
        0,
        "{}",
        "local",
        "Open",
        0,
        "t0",
        "t0",
      ],
    );
  });

export const insertSessionRow = (
  sessionId: string,
  workspaceId: WorkspaceId | null,
  executionId: string | null,
): Effect.Effect<void, unknown, SqlClient> =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    yield* sql.unsafe(
      "INSERT INTO sessions (session_id, binding_kind, workspace_id, execution_id, context_epoch, created_at) VALUES (?,?,?,?,?,?)",
      [
        sessionId,
        workspaceId !== null ? "WorkspacePrimary" : "ExecutionScoped",
        workspaceId,
        executionId,
        0,
        "t0",
      ],
    );
  });

export const insertWorkspaceRow = (
  seed: WorkspaceSeed,
  projectId: ProjectId,
): Effect.Effect<void, unknown, SqlClient> =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    yield* sql.unsafe(
      "INSERT INTO workspaces (workspace_id, project_id, parent_workspace_id, name, responsibility_definition, responsibility_revision, resource_boundary, resource_boundary_revision, agent_binding, primary_session_id, current_work_id, workspace_policy, workspace_policy_revision, revision, lifecycle, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
      [
        seed.workspaceId,
        projectId,
        seed.parentWorkspaceId,
        seed.name,
        RESPONSIBILITY,
        0,
        BOUNDARY,
        0,
        JSON.stringify({
          _tag: "ResponsibilityBound",
          workspaceId: seed.workspaceId,
        }),
        `ses:${seed.workspaceId}`,
        null,
        "{}",
        0,
        0,
        seed.lifecycle ?? "Active",
        "t0",
        "t0",
      ],
    );
    yield* insertSessionRow(`ses:${seed.workspaceId}`, seed.workspaceId, null);
  });

export interface WorkSeed {
  readonly workId: WorkId;
  readonly workspaceId: WorkspaceId;
  readonly objective: string;
  readonly lifecycle?: "Open" | "Completed" | "Cancelled";
  readonly revision?: number;
}

export const insertWorkRow = (
  seed: WorkSeed,
  projectId: ProjectId,
): Effect.Effect<void, unknown, SqlClient> =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    yield* sql.unsafe(
      "INSERT INTO works (work_id, project_id, workspace_id, objective, why, constraints, completion_expectation, verification_mission, provenance, lifecycle, revision, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
      [
        seed.workId,
        projectId,
        seed.workspaceId,
        seed.objective,
        "p10",
        "[]",
        "green",
        MISSION,
        JSON.stringify({ predecessorWorkId: null, reason: "seed" }),
        seed.lifecycle ?? "Open",
        seed.revision ?? 0,
        "t0",
        "t0",
      ],
    );
  });

export const setCurrentWork = (
  workspaceId: WorkspaceId,
  workId: WorkId,
): Effect.Effect<void, unknown, SqlClient> =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    yield* sql.unsafe(
      "UPDATE workspaces SET current_work_id = ? WHERE workspace_id = ?",
      [workId, workspaceId],
    );
  });

export interface ExecutionSeed {
  readonly executionId: string;
  readonly workspaceId: WorkspaceId;
  readonly focusWorkId?: WorkId | null;
  readonly settlement?: ExecutionSettlement | null;
  readonly settledAt?: string | null;
}

export const insertExecutionRow = (
  seed: ExecutionSeed,
  projectId: ProjectId,
): Effect.Effect<void, unknown, SqlClient> =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    yield* insertSessionRow(
      `ses:exec:${seed.executionId}`,
      null,
      seed.executionId,
    );
    yield* sql.unsafe(
      "INSERT INTO executions (execution_id, project_id, binding_kind, workspace_id, focus_kind, focus_work_id, parent_execution_id, mission, session_id, admitted_at, stop_requested_at, settlement_kind, settlement_json, settled_at) VALUES (?,?, 'workspace', ?, ?, ?, null, null, ?, 't0', null, ?, ?, ?)",
      [
        seed.executionId,
        projectId,
        seed.workspaceId,
        seed.focusWorkId === null || seed.focusWorkId === undefined
          ? "coordination"
          : "work",
        seed.focusWorkId ?? null,
        `ses:exec:${seed.executionId}`,
        seed.settlement?._tag ?? null,
        seed.settlement === null || seed.settlement === undefined
          ? null
          : JSON.stringify(seed.settlement),
        seed.settledAt ?? null,
      ],
    );
  });

export const insertEventRow = (input: {
  readonly eventId: string;
  readonly projectId: ProjectId;
  readonly eventType: string;
  readonly payload: unknown;
  readonly occurredAt: string;
}): Effect.Effect<void, unknown, SqlClient> =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    const rows = yield* sql.unsafe<{ last_sequence: number }>(
      "INSERT INTO project_event_sequences (project_id, last_sequence) VALUES (?, 1) ON CONFLICT(project_id) DO UPDATE SET last_sequence = last_sequence + 1 RETURNING last_sequence",
      [input.projectId],
    );
    const sequence = Number(rows[0]?.last_sequence ?? 1);
    yield* sql.unsafe(
      "INSERT INTO domain_events (event_id, project_id, sequence, event_type, event_version, occurred_at, aggregate_ref, actor, caused_by_command_id, caused_by_event_id, correlation_ref, payload_json) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
      [
        input.eventId,
        input.projectId,
        sequence,
        input.eventType,
        1,
        input.occurredAt,
        input.eventType,
        "user:gov",
        null,
        null,
        null,
        JSON.stringify(input.payload),
      ],
    );
  });

export const insertVerificationRow = (input: {
  readonly verificationId: string;
  readonly workId: WorkId;
  readonly targetWorkRevision: number;
  readonly ownerWorkspaceId: WorkspaceId;
  readonly executionIds: ReadonlyArray<string>;
  readonly state?: "Open" | "Concluded";
  readonly verdict?: "Pass" | "Fail" | "Unknown";
  readonly criteria?: ReadonlyArray<{
    readonly criterionId: string;
    readonly requirement: string;
    readonly required: boolean;
  }>;
}): Effect.Effect<void, unknown, SqlClient> =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    const mission = JSON.parse(MISSION) as {
      goal: string;
      criteria: unknown[];
      riskRequirements: string[];
    };
    yield* sql.unsafe(
      "INSERT INTO verifications (verification_id, project_id, work_id, target_work_revision, owner_workspace_id, mission_snapshot, target_deliverables, target_artifact_versions, target_environment_revision, environment_snapshot_ref, verification_execution_ids, state, verdict, conclusion_reason, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
      [
        input.verificationId,
        p10Project,
        input.workId,
        input.targetWorkRevision,
        input.ownerWorkspaceId,
        JSON.stringify({
          ...mission,
          criteria: input.criteria ?? mission.criteria,
        }),
        "[]",
        "[]",
        null,
        null,
        JSON.stringify(input.executionIds),
        input.state ?? "Open",
        input.verdict ?? null,
        null,
        "t0",
        "t0",
      ],
    );
  });

export const insertDependencyRow = (input: {
  readonly dependencyId: string;
  readonly consumerWorkId: WorkId;
  readonly producerWorkspaceId: WorkspaceId;
  readonly state?: "Unsatisfied" | "Satisfied" | "Withdrawn" | "Unfulfillable";
  readonly revision?: number;
}): Effect.Effect<void, unknown, SqlClient> =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    yield* sql.unsafe(
      "INSERT INTO dependencies (dependency_id, project_id, consumer_work_id, producer_binding, expected_deliverable, revision, state, satisfied_by_deliverable_id, satisfied_at_dependency_revision, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
      [
        input.dependencyId,
        p10Project,
        input.consumerWorkId,
        JSON.stringify({
          _tag: "WorkspaceBound",
          workspaceId: input.producerWorkspaceId,
        }),
        JSON.stringify({ kind: "report", requiredArtifactRoles: ["summary"] }),
        input.revision ?? 0,
        input.state ?? "Unsatisfied",
        null,
        null,
        "t0",
        "t0",
      ],
    );
  });

export const insertWaitRow = (
  workId: WorkId,
  conditions: ReadonlyArray<unknown>,
): Effect.Effect<void, unknown, SqlClient> =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    yield* sql.unsafe(
      "INSERT INTO work_waits (work_id, wait_mode, conditions_json, registered_at, updated_at) VALUES (?,?,?,?,?)",
      [workId, "Any", JSON.stringify(conditions), "t0", "t0"],
    );
  });

// --- P10-007..008 seeding helpers (SQL, same precedent) ---

export const insertSessionEntryRow = (input: {
  readonly sessionId: string;
  readonly entryKind:
    | "Input"
    | "ModelOutput"
    | "Observation"
    | "CheckpointReference"
    | "ContextUpdate";
  readonly payload: unknown;
  readonly createdAt: string;
}): Effect.Effect<void, unknown, SqlClient> =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    yield* sql.unsafe(
      "INSERT INTO session_entries (session_id, sequence, entry_kind, payload_json, created_at) VALUES (?, COALESCE((SELECT MAX(sequence) + 1 FROM session_entries WHERE session_id = ?), 0), ?, ?, ?)",
      [
        input.sessionId,
        input.sessionId,
        input.entryKind,
        JSON.stringify(input.payload),
        input.createdAt,
      ],
    );
  });

export const insertProviderTurnRow = (input: {
  readonly providerTurnId: string;
  readonly executionId: string;
  readonly sessionId: string;
  readonly usage: unknown;
  readonly settledAt: string | null;
}): Effect.Effect<void, unknown, SqlClient> =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    yield* sql.unsafe(
      "INSERT INTO provider_turns (provider_turn_id, execution_id, session_id, context_epoch, model_ref, output_contract_ref, manifest_id, started_at, settled_at, finish_reason, usage_json, created_at) VALUES (?,?,?,0,'m','c',?,?,?,?,?,?)",
      [
        input.providerTurnId,
        input.executionId,
        input.sessionId,
        `man:${input.providerTurnId}`,
        input.settledAt ?? "t0",
        input.settledAt,
        input.settledAt === null ? null : "Stop",
        input.settledAt === null ? null : JSON.stringify(input.usage),
        input.settledAt ?? "t0",
      ],
    );
  });

export const insertMessageRow = (input: {
  readonly messageId: string;
  readonly senderWorkspaceId: WorkspaceId;
  readonly recipientWorkspaceId: WorkspaceId;
  readonly kind: string;
  readonly bodyRef: string;
  readonly correlationId?: string | null;
  readonly sentAt: string;
}): Effect.Effect<void, unknown, SqlClient> =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    yield* sql.unsafe(
      "INSERT INTO messages (message_id, sender_workspace_id, recipient_workspace_id, kind, body_ref, correlation_id, causation_id, sent_at) VALUES (?,?,?,?,?,?,NULL,?)",
      [
        input.messageId,
        input.senderWorkspaceId,
        input.recipientWorkspaceId,
        input.kind,
        input.bodyRef,
        input.correlationId ?? null,
        input.sentAt,
      ],
    );
  });

export const insertInboxRow = (input: {
  readonly workspaceId: WorkspaceId;
  readonly entryKey: string;
  readonly kind: string;
  readonly summary: string;
  readonly correlationId?: string | null;
  readonly admittedAt: string;
  readonly consumedAt?: string | null;
}): Effect.Effect<void, unknown, SqlClient> =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    yield* sql.unsafe(
      "INSERT INTO inbox_entries (workspace_id, entry_key, kind, summary, correlation_id, admitted_at, consumed_at) VALUES (?,?,?,?,?,?,?)",
      [
        input.workspaceId,
        input.entryKey,
        input.kind,
        input.summary,
        input.correlationId ?? null,
        input.admittedAt,
        input.consumedAt ?? null,
      ],
    );
  });

export const insertEvidenceRow = (input: {
  readonly evidenceId: string;
  readonly verificationId: string;
  readonly criterionId: string;
  readonly kind: string;
  readonly recordedByExecutionId: string;
  readonly recordedAt: string;
}): Effect.Effect<void, unknown, SqlClient> =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    yield* sql.unsafe(
      "INSERT INTO verification_evidence (evidence_id, verification_id, criterion_id, kind, artifact_ref, observed_environment_revision, recorded_by_execution_id, recorded_at) VALUES (?,?,?,?,NULL,NULL,?,?)",
      [
        input.evidenceId,
        input.verificationId,
        input.criterionId,
        input.kind,
        input.recordedByExecutionId,
        input.recordedAt,
      ],
    );
  });

export const insertAcceptanceRow = (input: {
  readonly acceptanceId: string;
  readonly workId: WorkId;
  readonly targetWorkRevision: number;
  readonly verificationId: string;
  readonly actor: string;
  readonly acceptedAt: string;
}): Effect.Effect<void, unknown, SqlClient> =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    yield* sql.unsafe(
      "INSERT INTO work_acceptances (acceptance_id, project_id, work_id, target_work_revision, verification_id, actor, accepted_at) VALUES (?,?,?,?,?,?,?)",
      [
        input.acceptanceId,
        p10Project,
        input.workId,
        input.targetWorkRevision,
        input.verificationId,
        input.actor,
        input.acceptedAt,
      ],
    );
  });

export const insertProposalRow = (input: {
  readonly proposalId: string;
  readonly parentWorkspaceId: WorkspaceId;
  readonly revision?: number;
}): Effect.Effect<void, unknown, SqlClient> =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    yield* sql.unsafe(
      "INSERT INTO formation_proposals (proposal_id, parent_workspace_id, proposal_json, revision, state, created_at, updated_at) VALUES (?,?,?,?, 'Pending', 't0', 't0')",
      [input.proposalId, input.parentWorkspaceId, "{}", input.revision ?? 1],
    );
  });

/** Migrations first (the p1/p7 pattern). */
export const migrate = Effect.gen(function* () {
  yield* runMigrations(P8_MIGRATIONS);
});

/** Deferred FKs (projects→workspaces, workspaces→works/sessions) require a
 * transaction around seeding. */
export const seedCanonical = <A>(
  program: Effect.Effect<A, unknown, SqlClient | TransactionScope>,
): Effect.Effect<A, unknown, SqlClient | TransactionPort> =>
  Effect.gen(function* () {
    const tx = yield* TransactionPort;
    return yield* tx.transact(program);
  });

/** Canonical-state digest for the zero-mutation snapshot assertions: every
 * table, every row, deterministic order. */
export const snapshotDatabase = (): Effect.Effect<string, unknown, SqlClient> =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    const tables = yield* sql.unsafe<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    );
    const parts: Array<string> = [];
    for (const table of tables) {
      const rows = yield* sql.unsafe<Record<string, unknown>>(
        `SELECT * FROM "${table.name}" ORDER BY rowid`,
      );
      parts.push(`${table.name}:${JSON.stringify(rows)}`);
    }
    return parts.join(";");
  });
