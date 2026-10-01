import type { ConversationResponseStatus } from "@arbor/api-contracts";
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
  WorkspaceDetailDeps,
} from "@arbor/projection-runtime";
import {
  deriveProjectAttention,
  makeProjectionQueryService,
  projectionReadError,
} from "@arbor/projection-runtime";
import { Effect, Layer, Option } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";

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
