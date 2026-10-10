import { Effect, Layer, Option } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { describe, expect, it } from "vitest";
import {
  AttentionProjectionStoreLive,
  ClockLive,
  IdGeneratorLive,
  layer,
  makeProjectAttentionProjectionStore,
  P35_MIGRATIONS,
  runMigrations,
  TransactionPortLive,
  WorkspaceResourceActivationStoreLive,
} from "../adapters/persistence-sqlite/src/index.js";
import {
  Actor,
  type DomainEvent,
  EventId,
  ProjectId,
  parse,
  ResourceBoundaryRevision,
  WorkspaceId,
} from "../packages/domain/dist/index.js";
import {
  AttentionProjectionStore,
  TransactionPort,
  WorkspaceResourceActivationStore,
} from "../packages/ports/src/index.js";
import {
  type AttentionReadDeps,
  deriveProjectAttention,
  projectionReadError,
  reconcileProjectActivationAttention,
} from "../packages/projection-runtime/src/index.js";

const projectId = parse(ProjectId)("prj_00000000-0000-7000-8000-000000000020");
const workspaceId = parse(WorkspaceId)(
  "ws_00000000-0000-7000-8000-000000000020",
);
const revision = parse(ResourceBoundaryRevision)(0);
const sourceEventId = "evt_00000000-0000-7000-8000-000000000020";
const activationEventId = "evt_00000000-0000-7000-8000-000000000021";
const sourceFactId = "attention-fact-unrelated";

const makeApp = () => {
  const base = layer({ filename: ":memory:" });
  const infra = Layer.mergeAll(base, ClockLive, IdGeneratorLive);
  const stores = Layer.mergeAll(
    Layer.provide(TransactionPortLive, infra),
    Layer.provide(WorkspaceResourceActivationStoreLive, infra),
    Layer.provide(AttentionProjectionStoreLive, infra),
  );
  return Layer.mergeAll(infra, stores) as Layer.Layer<
    | SqlClient
    | TransactionPort
    | WorkspaceResourceActivationStore
    | AttentionProjectionStore
  >;
};

const run = <A>(
  program: Effect.Effect<
    A,
    unknown,
    | SqlClient
    | TransactionPort
    | WorkspaceResourceActivationStore
    | AttentionProjectionStore
  >,
): Promise<A> =>
  Effect.runPromise(Effect.scoped(Effect.provide(program, makeApp())));

const seedCanonicalProject = Effect.gen(function* () {
  const sql = yield* SqlClient;
  yield* sql.withTransaction(
    Effect.gen(function* () {
      yield* sql.unsafe(
        `INSERT INTO projects (
          project_id, name, root_workspace_id, project_policy,
          project_policy_revision, default_configuration, environment_ref,
          lifecycle, revision, created_at, updated_at
        ) VALUES (?, 'activation test', ?, '{}', 0, '{}', 'local', 'Open', 0, 't0', 't0')`,
        [projectId, workspaceId],
      );
      yield* sql.unsafe(
        `INSERT INTO workspaces (
          workspace_id, project_id, parent_workspace_id, name,
          responsibility_definition, responsibility_revision, resource_boundary,
          resource_boundary_revision, agent_binding, primary_session_id,
          current_work_id, workspace_policy, workspace_policy_revision,
          revision, lifecycle, created_at, updated_at
        ) VALUES (?, ?, NULL, 'root', '{}', 0,
          '{"basisResponsibilityRevision":0,"addresses":[{"_tag":"FileTree","path":"C:/PRIVATE_HOST_PATH"}]}',
          0, '{}', 'ses_00000000-0000-7000-8000-000000000020', NULL,
          '{}', 0, 0, 'Active', 't0', 't0')`,
        [workspaceId, projectId],
      );
      yield* sql.unsafe(
        `INSERT INTO sessions (
          session_id, binding_kind, workspace_id, execution_id,
          context_epoch, created_at
        ) VALUES ('ses_00000000-0000-7000-8000-000000000020',
          'WorkspacePrimary', ?, NULL, 0, 't0')`,
        [workspaceId],
      );
    }),
  );
});

const seedOtherAttentionSource = Effect.gen(function* () {
  const sql = yield* SqlClient;
  yield* sql.withTransaction(
    Effect.gen(function* () {
      yield* sql.unsafe(
        `INSERT INTO commands (
          command_id, project_id, semantic_request_fingerprint, schema_version,
          fingerprint_algorithm_version, resolution, result_json,
          terminal_error_json, created_at, settled_at
        ) VALUES ('cmd_00000000-0000-7000-8000-000000000020', ?, 'fp', '1', 1,
          'Committed', '{}', NULL, 't1', 't1')`,
        [projectId],
      );
      yield* sql.unsafe(
        `INSERT INTO executions (
          execution_id, project_id, binding_kind, workspace_id, episode_kind,
          episode_ref, episode_revision, parent_execution_id, mission,
          session_id, admitted_at,
          stop_requested_at, settlement_kind, settlement_json, settled_at
        ) VALUES ('exe_00000000-0000-7000-8000-000000000020', ?,
          'execution_bound', ?, NULL, NULL, NULL, NULL, 'test',
          'ses_00000000-0000-7000-8000-000000000020', 't1', NULL, NULL, NULL, NULL)`,
        [projectId, workspaceId],
      );
      yield* sql.unsafe(
        `INSERT INTO domain_events (
          event_id, project_id, sequence, event_type, event_version,
          occurred_at, aggregate_ref, actor, caused_by_command_id,
          caused_by_event_id, correlation_ref, payload_json
        ) VALUES (?, ?, 5, 'AssignWorkTargetBindingEscalated', 1, 't2', ?,
          'system:test', 'cmd_00000000-0000-7000-8000-000000000020',
          NULL, NULL, '{}')`,
        [sourceEventId, projectId, workspaceId],
      );
      yield* sql.unsafe(
        `INSERT INTO assign_work_binding_attention_facts (
          attention_fact_id, event_id, project_id, execution_id,
          target_workspace_id, logical_action_id, committed_command_id,
          failure_code, first_detected_at
        ) VALUES (?, ?, ?, 'exe_00000000-0000-7000-8000-000000000020', ?,
          'action-unrelated', 'cmd_00000000-0000-7000-8000-000000000020',
          'MissingBinding', 't2')`,
        [sourceFactId, sourceEventId, projectId, workspaceId],
      );
      yield* sql.unsafe(
        `INSERT INTO attention_projection_rows (
          project_id, dedup_key, source, severity, target_workspace_id,
          summary, failure_code, occurred_at, source_event_id, source_fact_id
        ) VALUES (?, 'unrelated-assign-work', 'AssignWorkTargetBindingFailure',
          'ActionRequired', ?, 'unrelated source marker', 'MissingBinding',
          't2', ?, ?)`,
        [projectId, workspaceId, sourceEventId, sourceFactId],
      );
      yield* sql.unsafe(
        `INSERT INTO project_event_sequences (project_id, last_sequence)
         VALUES (?, 5)`,
        [projectId],
      );
      yield* sql.unsafe(
        `INSERT INTO consumer_offsets (consumer_id, project_id, last_sequence, updated_at)
         VALUES ('p10-attention', ?, 1, 't1')`,
        [projectId],
      );
    }),
  );
});

const pendingIntent = {
  projectId,
  workspaceId,
  resourceBoundaryRevision: revision,
  status: "Pending" as const,
  createdAt: "activation-created-at",
  updatedAt: "activation-created-at",
  activatedAt: null,
};

const reconcile = () =>
  Effect.gen(function* () {
    const tx = yield* TransactionPort;
    const activationIntents = yield* WorkspaceResourceActivationStore;
    const attention = yield* AttentionProjectionStore;
    return yield* reconcileProjectActivationAttention(
      { transactions: tx, activationIntents, attentionProjection: attention },
      projectId,
    );
  });

const projectedAttentionRows = () =>
  Effect.gen(function* () {
    const tx = yield* TransactionPort;
    const attention = yield* AttentionProjectionStore;
    return yield* tx.transact(
      attention.listWorkspaceResourceActivationPending(projectId),
    );
  });

const readOtherSource = () =>
  Effect.gen(function* () {
    const tx = yield* TransactionPort;
    const attention = yield* AttentionProjectionStore;
    return yield* tx.transact(
      attention.listAssignWorkBindingFailures(projectId),
    );
  });

const attentionReadDeps = (): Effect.Effect<
  AttentionReadDeps,
  never,
  TransactionPort | AttentionProjectionStore
> =>
  Effect.gen(function* () {
    const tx = yield* TransactionPort;
    const attention = yield* AttentionProjectionStore;
    const empty = <A>(value: A) => Effect.succeed(value);
    return {
      listWorkspacesByProject: () => empty([]),
      listWorksByWorkspace: () => empty([]),
      listExecutionSettlementFacts: () => empty([]),
      listOpenVerifications: () => empty([]),
      listUnsatisfiedDependencies: () => empty([]),
      findDependency: () => empty(Option.none()),
      readEvents: () => empty([]),
      listProjectedAssignWorkBindingFailures: (targetProjectId) =>
        tx
          .transact(attention.listAssignWorkBindingFailures(targetProjectId))
          .pipe(Effect.mapError(projectionReadError)),
      listProjectedWorkspaceResourceActivations: (targetProjectId) =>
        tx
          .transact(
            attention.listWorkspaceResourceActivationPending(targetProjectId),
          )
          .pipe(Effect.mapError(projectionReadError)),
    };
  });

const activationWakeup = (
  status: "Pending" | "Active",
): DomainEvent<unknown> => ({
  eventId: parse(EventId)(activationEventId),
  projectId,
  sequence: 6 as never,
  eventType: "WorkspaceResourceActivationChanged",
  eventVersion: 1,
  occurredAt: "t3",
  aggregateRef: workspaceId,
  actor: parse(Actor)("system:workspace-resource-activation"),
  payload: {
    _tag: "WorkspaceResourceActivationChanged",
    workspaceId,
    resourceBoundaryRevision: revision,
    status,
  },
});

describe("F21 Wave2 P10 source-only Activation Attention reconciliation", () => {
  it("repairs an absent row below the pruned floor, is idempotent, and preserves other Attention sources", async () => {
    const result = await run(
      Effect.gen(function* () {
        yield* runMigrations(P35_MIGRATIONS);
        yield* seedCanonicalProject;
        yield* seedOtherAttentionSource;
        const tx = yield* TransactionPort;
        const activations = yield* WorkspaceResourceActivationStore;
        yield* tx.transact(activations.insertPending(pendingIntent));
        const otherBefore = yield* readOtherSource();
        yield* reconcile();
        yield* reconcile();
        const activationRows = yield* projectedAttentionRows();
        const otherAfter = yield* readOtherSource();
        const sql = yield* SqlClient;
        const offset = yield* sql.unsafe<{ last_sequence: number }>(
          "SELECT last_sequence FROM consumer_offsets WHERE consumer_id = 'p10-attention' AND project_id = ?",
          [projectId],
        );
        const floor = yield* sql.unsafe<{ floor: number }>(
          "SELECT MIN(sequence) AS floor FROM domain_events WHERE project_id = ?",
          [projectId],
        );
        const activationEvents = yield* sql.unsafe<{ count: number }>(
          `SELECT COUNT(*) AS count FROM domain_events
            WHERE project_id = ? AND event_type = 'WorkspaceResourceActivationChanged'`,
          [projectId],
        );
        const rows = yield* attentionReadDeps();
        const view = yield* deriveProjectAttention(projectId, rows);
        return {
          activationRows,
          otherBefore,
          otherAfter,
          offset: Number(offset[0]?.last_sequence ?? 0),
          floor: Number(floor[0]?.floor ?? 0),
          activationEvents: Number(activationEvents[0]?.count ?? 0),
          view,
        };
      }),
    );
    expect(result.floor).toBe(5);
    expect(result.offset).toBe(1);
    expect(result.activationEvents).toBe(0);
    expect(result.activationRows).toEqual([
      {
        projectId,
        workspaceId,
        resourceBoundaryRevision: revision,
        occurredAt: pendingIntent.createdAt,
      },
    ]);
    expect(result.otherAfter).toEqual(result.otherBefore);
    expect(result.otherAfter).toHaveLength(1);
    expect(result.view).toContainEqual({
      source: "WorkspaceResourceActivationPending",
      severity: "ActionRequired",
      targetWorkspaceId: workspaceId,
      dedupKey: `resource-activation:${projectId}:${workspaceId}:${revision}`,
      summary:
        "Project resource activation is pending; file actions are unavailable.",
      occurredAt: pendingIntent.createdAt,
    });
    expect(JSON.stringify(result.view)).not.toContain("C:/PRIVATE_HOST_PATH");
    expect(Object.keys(result.activationRows[0] ?? {})).toEqual([
      "projectId",
      "workspaceId",
      "resourceBoundaryRevision",
      "occurredAt",
    ]);
  });

  it("re-reads current P1 intent state for stale Pending wakeups and clears Active rows", async () => {
    const result = await run(
      Effect.gen(function* () {
        yield* runMigrations(P35_MIGRATIONS);
        yield* seedCanonicalProject;
        yield* seedOtherAttentionSource;
        const tx = yield* TransactionPort;
        const activations = yield* WorkspaceResourceActivationStore;
        const attention = yield* AttentionProjectionStore;
        yield* tx.transact(activations.insertPending(pendingIntent));
        yield* reconcile();
        const changed = yield* tx.transact(
          activations.compareAndSetActive(
            projectId,
            workspaceId,
            revision,
            "activated-at",
            "activated-at",
          ),
        );
        const p10Projection = makeProjectAttentionProjectionStore(
          projectId,
          { findAssignWorkBindingFailure: () => Effect.succeed(Option.none()) },
          attention,
          activations,
        );
        yield* tx.transact(p10Projection.apply([activationWakeup("Pending")]));
        const activationRows = yield* projectedAttentionRows();
        const otherRows = yield* readOtherSource();
        return { changed, activationRows, otherRows };
      }),
    );
    expect(result.changed).toBe(true);
    expect(result.activationRows).toEqual([]);
    expect(result.otherRows).toHaveLength(1);
    expect(result.otherRows[0]?.source).toBe("AssignWorkTargetBindingFailure");
  });

  it("linearizes Active transition against reconciliation, then converges on a current-source wakeup", async () => {
    const result = await run(
      Effect.gen(function* () {
        yield* runMigrations(P35_MIGRATIONS);
        yield* seedCanonicalProject;
        const tx = yield* TransactionPort;
        const activations = yield* WorkspaceResourceActivationStore;
        const attention = yield* AttentionProjectionStore;
        yield* tx.transact(activations.insertPending(pendingIntent));
        const [changed] = yield* Effect.all(
          [
            tx.transact(
              activations.compareAndSetActive(
                projectId,
                workspaceId,
                revision,
                "activated-at",
                "activated-at",
              ),
            ),
            reconcile(),
          ],
          { concurrency: 2 },
        );
        const p10Projection = makeProjectAttentionProjectionStore(
          projectId,
          { findAssignWorkBindingFailure: () => Effect.succeed(Option.none()) },
          attention,
          activations,
        );
        yield* tx.transact(p10Projection.apply([activationWakeup("Pending")]));
        const activationRows = yield* projectedAttentionRows();
        const all = yield* tx.transact(activations.listAll());
        return { changed, activationRows, all };
      }),
    );
    expect(result.changed).toBe(true);
    expect(result.all[0]?.status).toBe("Active");
    expect(result.activationRows).toEqual([]);
  });
});
