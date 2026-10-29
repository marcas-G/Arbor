import type {
  AttentionReq,
  AttentionRes,
  WorkDetailReq,
  WorkDetailRes,
} from "@arbor/api-contracts";
import { ProjectId, parse, WorkId, WorkspaceId } from "@arbor/domain";
import {
  ProjectionQueryPort,
  type ReadmissionBlockingSource,
  TransactionPort,
  WorkReadmissionGateStore,
} from "@arbor/ports";
import { Effect, Exit, Option } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import { P10_ATTENTION_CONSUMER_ID } from "../../../adapters/persistence-sqlite/src/index.js";
import { insertWorkRow } from "../../../tests/support/p10-fixture.js";
import { createCurrentSchemaTestDatabaseFactory } from "../../../tests/support/schema44-database.js";
import { buildSingleWorkspaceLayer } from "../src/index.js";

const projectId = parse(ProjectId)("prj_00000000-0000-7000-8000-000000000101");
const workspaceId = parse(WorkspaceId)(
  "ws_00000000-0000-7000-8000-000000000101",
);
const sessionId = "ses_00000000-0000-7000-8000-000000000101";
const workId = parse(WorkId)("wrk_00000000-0000-7000-8000-000000000101");
const cancelledWorkId = parse(WorkId)(
  "wrk_00000000-0000-7000-8000-000000000102",
);
const HISTORY_SIZE = 200;
const MANIFEST_CANARY = "private-provider-manifest-canary";

let databaseFactory:
  | Awaited<ReturnType<typeof createCurrentSchemaTestDatabaseFactory>>
  | undefined;
let database:
  | ReturnType<NonNullable<typeof databaseFactory>["create"]>
  | undefined;

beforeAll(async () => {
  databaseFactory = await createCurrentSchemaTestDatabaseFactory({
    prefix: ".rai-terminal-history-projection-",
  });
}, 120_000);

beforeEach(() => {
  if (databaseFactory === undefined) {
    throw new Error("Current schema test database factory is not ready");
  }
  database = databaseFactory.create();
});

afterEach(() => {
  database?.cleanup();
  database = undefined;
}, 120_000);

afterAll(() => {
  databaseFactory?.cleanup();
  databaseFactory = undefined;
}, 120_000);

const runProduction = <A>(
  databaseFilename: string,
  program: Effect.Effect<
    A,
    unknown,
    SqlClient | ProjectionQueryPort | TransactionPort | WorkReadmissionGateStore
  >,
) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.provide(
        program,
        buildSingleWorkspaceLayer({
          databaseFile: databaseFilename,
          projectId,
        }),
      ),
    ),
  );

const suffix = (index: number): string => index.toString(16).padStart(12, "0");

const executionIdAt = (index: number): string =>
  `exe_00000000-0000-7000-8000-${suffix(index)}`;

const providerTurnIdAt = (index: number): string =>
  `ptn_00000000-0000-7000-8000-${suffix(index)}`;

const manifestIdAt = (index: number): string => `mft_${suffix(index)}`;

const timesAt = (index: number) => {
  const admittedAt = new Date(Date.UTC(2026, 9, 25, 0, 0, index)).toISOString();
  return {
    admittedAt,
    attemptSettledAt: new Date(Date.parse(admittedAt) + 1_000).toISOString(),
    executionSettledAt: new Date(Date.parse(admittedAt) + 2_000).toISOString(),
  };
};

const terminalSettlement = JSON.stringify({
  _tag: "Failed",
  failure: {
    _tag: "ExecutionFailure",
    reason: "ProviderFailure:RequestRejected",
  },
});

const insertTerminalChain = (input: {
  readonly index: number;
  readonly workId: WorkId;
  readonly targetWorkRevision: number;
  readonly malformedManifest?: boolean;
  readonly invalidOccurrenceTime?: boolean;
}) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    const executionId = executionIdAt(input.index);
    const providerTurnId = providerTurnIdAt(input.index);
    const manifestId = manifestIdAt(input.index);
    const time = timesAt(input.index);
    const compiledRequestHash = "b".repeat(64);
    const outputContractRef = "agent-action-v1";
    const manifestJson = JSON.stringify({
      providerTurnId,
      executionId,
      sessionId,
      logicalStepNo: 0,
      repairAttempt: 0,
      compiledRequestHash,
      outputContractRef: input.malformedManifest
        ? "conflicting-output-contract"
        : outputContractRef,
      resolvedModelBindingFingerprint: `p16fp_${"a".repeat(64)}`,
    });

    yield* sql.unsafe(
      `INSERT INTO executions (
        execution_id, project_id, binding_kind, workspace_id,
        episode_kind, episode_ref, episode_revision, parent_execution_id,
        mission, session_id, admitted_at, stop_requested_at,
        settlement_kind, settlement_json, settled_at
      ) VALUES (?, ?, 'workspace', ?, 'WorkEpisode', ?, ?, NULL, NULL, ?, ?,
                NULL, 'Failed', ?, ?)`,
      [
        executionId,
        projectId,
        workspaceId,
        input.workId,
        input.targetWorkRevision,
        sessionId,
        time.admittedAt,
        terminalSettlement,
        time.executionSettledAt,
      ],
    );
    yield* sql.unsafe(
      `INSERT INTO agent_execution_state (
        execution_id, episode_json, wake_reason, current_mode,
        active_skill_refs_json, turn_no, recent_directive_refs_json,
        recent_action_fingerprints_json, updated_at
      ) VALUES (?, ?, 'Initial', NULL, '[]', 0, '[]', '[]', ?)`,
      [
        executionId,
        JSON.stringify({
          _tag: "WorkEpisode",
          workId: input.workId,
          targetWorkRevision: input.targetWorkRevision,
        }),
        time.admittedAt,
      ],
    );
    yield* sql.unsafe(
      `INSERT INTO provider_turns (
        provider_turn_id, execution_id, session_id, context_epoch,
        model_ref, output_contract_ref, manifest_id, started_at,
        settled_at, finish_reason, usage_json, created_at,
        execution_policy_json, turn_deadline_at
      ) VALUES (?, ?, ?, 0, 'model-a', ?, ?, ?, ?, 'Failed', '{}', ?, NULL, NULL)`,
      [
        providerTurnId,
        executionId,
        sessionId,
        outputContractRef,
        manifestId,
        time.admittedAt,
        time.executionSettledAt,
        time.admittedAt,
      ],
    );
    yield* sql.unsafe(
      `INSERT INTO model_context_manifests (
        manifest_id, provider_turn_id, execution_id, session_id,
        context_epoch, model_ref, compiled_request_hash, manifest_json,
        created_at, portable_request_json
      ) VALUES (?, ?, ?, ?, 0, 'model-a', ?, ?, ?, NULL)`,
      [
        manifestId,
        providerTurnId,
        executionId,
        sessionId,
        compiledRequestHash,
        manifestJson,
        time.admittedAt,
      ],
    );
    yield* sql.unsafe(
      `INSERT INTO provider_attempts (
        provider_turn_id, attempt_no, started_at, settled_at, outcome,
        provider_error_kind, failure_taxonomy_version, retry_safety,
        retry_decision, retry_reason
      ) VALUES (?, 0, ?, ?, 'TerminalFailure', 'RequestRejected',
                'phase1-v2', 'UnsafeReplay', 'Stop', 'terminal failure')`,
      [
        providerTurnId,
        time.admittedAt,
        input.invalidOccurrenceTime
          ? "not-a-canonical-instant"
          : time.attemptSettledAt,
      ],
    );
    yield* sql.unsafe(
      `INSERT INTO agent_loop_steps (
        execution_id, logical_step_no, repair_attempt, provider_turn_id,
        manifest_id, state, next_action_index, settlement_json, revision,
        updated_at
      ) VALUES (?, 0, 0, ?, ?, 'SettlementProposed', 0, ?, 0, ?)`,
      [
        executionId,
        providerTurnId,
        manifestId,
        terminalSettlement,
        time.executionSettledAt,
      ],
    );
  });

const seedCanonical = () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* sql.unsafe(
          `INSERT INTO projects (
            project_id, name, root_workspace_id, project_policy,
            project_policy_revision, default_configuration, environment_ref,
            lifecycle, revision, created_at, updated_at
          ) VALUES (?, 'RAI history projection', ?, '{}', 0, '{}', 'local',
                    'Open', 0, 't0', 't0')`,
          [projectId, workspaceId],
        );
        yield* sql.unsafe(
          `INSERT INTO sessions (
            session_id, binding_kind, workspace_id, execution_id,
            context_epoch, created_at
          ) VALUES (?, 'WorkspacePrimary', ?, NULL, 0, 't0')`,
          [sessionId, workspaceId],
        );
        yield* sql.unsafe(
          `INSERT INTO workspaces (
            workspace_id, project_id, parent_workspace_id, name,
            responsibility_definition, responsibility_revision,
            resource_boundary, resource_boundary_revision, agent_binding,
            primary_session_id, current_work_id, workspace_policy,
            workspace_policy_revision, revision, lifecycle, created_at,
            updated_at
          ) VALUES (?, ?, NULL, 'Root', '{}', 0, '{}', 0, '{}', ?, NULL,
                    '{}', 0, 0, 'Active', 't0', 't0')`,
          [workspaceId, projectId, sessionId],
        );
        yield* insertWorkRow(
          { workId, workspaceId, objective: "terminal history" },
          projectId,
        );
        yield* insertWorkRow(
          { workId: cancelledWorkId, workspaceId, objective: "cancel path" },
          projectId,
        );
        yield* sql.unsafe(
          "UPDATE workspaces SET current_work_id = ? WHERE workspace_id = ?",
          [workId, workspaceId],
        );
        for (let index = HISTORY_SIZE - 1; index >= 0; index -= 1) {
          yield* insertTerminalChain({
            index,
            workId,
            targetWorkRevision: 0,
          });
        }
      }),
    );
  });

const readViews = () =>
  Effect.gen(function* () {
    const query = yield* ProjectionQueryPort;
    const attention = yield* query.query<AttentionReq, AttentionRes>(
      "attention",
      { projectId },
    );
    const detail = yield* query.query<WorkDetailReq, WorkDetailRes>(
      "work-detail",
      { projectId, workspaceId, workId },
    );
    return { attention: attention.value, detail: detail.value };
  });

describe("RAI-DG-02 production terminal history projection", () => {
  it("projects one earliest witness from 200 real chains and keeps the P2 hold across P10 ACK, reads, and restart-equivalent wiring", async () => {
    if (database === undefined) throw new Error("fresh database missing");
    const filename = database.databaseFilename;

    const initial = await runProduction(
      filename,
      Effect.gen(function* () {
        yield* seedCanonical();
        const views = yield* readViews();
        const gate = yield* WorkReadmissionGateStore;
        const tx = yield* TransactionPort;
        const blocking = yield* tx.transact(
          gate.hasBlockingSource({
            projectId,
            workspaceId,
            workId,
            workRevision: 0 as never,
          }),
        );
        const sql = yield* SqlClient;
        yield* sql.unsafe(
          `INSERT INTO domain_events (
            event_id, project_id, sequence, event_type, event_version,
            occurred_at, aggregate_ref, actor, caused_by_command_id,
            caused_by_event_id, correlation_ref, payload_json
          ) VALUES (?, ?, 1, 'WorkAssigned', 1, '2026-10-26T00:00:00.000Z',
                    ?, 'system', NULL, NULL, NULL, '{}')`,
          ["evt_00000000-0000-7000-8000-000000000101", projectId, workId],
        );
        yield* sql.unsafe(
          `INSERT INTO project_event_sequences (project_id, last_sequence)
           VALUES (?, 1)`,
          [projectId],
        );
        yield* sql.unsafe(
          `INSERT INTO consumer_offsets (
            consumer_id, project_id, last_sequence, updated_at
          ) VALUES (?, ?, 1, '2026-10-26T00:00:00.000Z')
          ON CONFLICT (consumer_id, project_id) DO UPDATE SET
            last_sequence = excluded.last_sequence,
            updated_at = excluded.updated_at`,
          [P10_ATTENTION_CONSUMER_ID, projectId],
        );
        const afterAck = yield* readViews();
        return { views, afterAck, blocking };
      }),
    );

    expect(Option.isSome(initial.blocking)).toBe(true);
    if (Option.isNone(initial.blocking)) return;
    expect(initial.blocking.value.sourceKind).toBe(
      "TerminalProviderFailureSettlement",
    );
    const blockingSource = initial.blocking.value as Extract<
      ReadmissionBlockingSource,
      { readonly sourceKind: "TerminalProviderFailureSettlement" }
    >;
    expect(blockingSource.executionId).toBe(executionIdAt(0));
    expect(blockingSource.logicalStepNo).toBe(0);
    expect(blockingSource.repairAttempt).toBe(0);

    const rows = initial.views.attention.rows.filter(
      (row) => row.source === "TerminalProviderFailure",
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      source: "TerminalProviderFailure",
      severity: "ActionRequired",
      targetWorkspaceId: workspaceId,
      dedupKey: `terminal-provider-failure:${workId}:0:${blockingSource.failureFingerprint}`,
      occurredAt: timesAt(0).attemptSettledAt,
      terminalProviderFailure: {
        kind: "TerminalProviderFailure",
        workId,
        workRevision: 0,
        occurredAt: timesAt(0).attemptSettledAt,
        failureCode: "RequestRejected",
      },
    });
    expect(initial.views.detail.terminalProviderFailure).toMatchObject({
      kind: "TerminalProviderFailure",
      workId,
      workRevision: 0,
      occurredAt: timesAt(0).attemptSettledAt,
      failureCode: "RequestRejected",
    });
    expect(initial.afterAck.attention.rows).toEqual(
      initial.views.attention.rows,
    );
    expect(initial.afterAck.detail.terminalProviderFailure).toEqual(
      initial.views.detail.terminalProviderFailure,
    );

    const restarted = await runProduction(filename, readViews());
    expect(
      restarted.attention.rows.filter(
        (row) => row.source === "TerminalProviderFailure",
      ),
    ).toEqual(rows);
    expect(restarted.detail.terminalProviderFailure).toEqual(
      initial.views.detail.terminalProviderFailure,
    );

    const stillHeldAfterReads = await runProduction(
      filename,
      Effect.gen(function* () {
        const gate = yield* WorkReadmissionGateStore;
        const tx = yield* TransactionPort;
        return yield* tx.transact(
          gate.hasBlockingSource({
            projectId,
            workspaceId,
            workId,
            workRevision: 0 as never,
          }),
        );
      }),
    );
    expect(Option.isSome(stillHeldAfterReads)).toBe(true);
  }, 120_000);

  it("maps a malformed later chain to bounded integrity, invalid time to no row, and old revisions/lifecycles inactive", async () => {
    if (database === undefined) throw new Error("fresh database missing");
    const filename = database.databaseFilename;
    await runProduction(
      filename,
      Effect.gen(function* () {
        yield* seedCanonical();
        const sql = yield* SqlClient;
        const query = yield* ProjectionQueryPort;

        yield* sql.unsafe(
          "UPDATE model_context_manifests SET manifest_json = ? WHERE manifest_id = ?",
          [MANIFEST_CANARY, manifestIdAt(HISTORY_SIZE - 1)],
        );
        const malformedManifest = yield* query.query<
          AttentionReq,
          AttentionRes
        >("attention", { projectId });
        const integrity = malformedManifest.value.rows.filter(
          (row) => row.source === "TerminalProviderFailureIntegrity",
        );
        expect(integrity).toHaveLength(1);
        expect(integrity[0]).toMatchObject({
          severity: "ActionRequired",
          targetWorkspaceId: workspaceId,
          dedupKey: `terminal-provider-failure-integrity:${executionIdAt(HISTORY_SIZE - 1)}:0:0:SourceManifestMismatch`,
          occurredAt: timesAt(HISTORY_SIZE - 1).attemptSettledAt,
          terminalProviderFailure: {
            kind: "TerminalProviderFailureIntegrity",
            workId,
            workRevision: 0,
            failureCode: "SourceManifestMismatch",
          },
        });
        expect(JSON.stringify(malformedManifest)).not.toContain(
          MANIFEST_CANARY,
        );
        const malformedDetail = yield* query.query<
          WorkDetailReq,
          WorkDetailRes
        >("work-detail", { projectId, workspaceId, workId });
        expect(malformedDetail.value.terminalProviderFailure).toMatchObject({
          kind: "TerminalProviderFailureIntegrity",
          workId,
          workRevision: 0,
          occurredAt: timesAt(HISTORY_SIZE - 1).attemptSettledAt,
          failureCode: "SourceManifestMismatch",
        });

        yield* sql.unsafe(
          "UPDATE model_context_manifests SET manifest_json = ? WHERE manifest_id = ?",
          [
            JSON.stringify({
              providerTurnId: providerTurnIdAt(HISTORY_SIZE - 1),
              executionId: executionIdAt(HISTORY_SIZE - 1),
              sessionId,
              logicalStepNo: 0,
              repairAttempt: 0,
              compiledRequestHash: "b".repeat(64),
              outputContractRef: "agent-action-v1",
              resolvedModelBindingFingerprint: `p16fp_${"a".repeat(64)}`,
            }),
            manifestIdAt(HISTORY_SIZE - 1),
          ],
        );
        yield* sql.unsafe(
          "UPDATE provider_attempts SET settled_at = ? WHERE provider_turn_id = ?",
          ["not-a-canonical-instant", providerTurnIdAt(HISTORY_SIZE - 1)],
        );
        const invalidTime = yield* Effect.exit(
          query.query<AttentionReq, AttentionRes>("attention", { projectId }),
        );
        expect(Exit.isFailure(invalidTime)).toBe(true);
        expect(JSON.stringify(invalidTime)).toContain(
          "FailureOccurrenceTimeInvalid",
        );
        expect(JSON.stringify(invalidTime)).not.toContain(
          "not-a-canonical-instant",
        );
        const invalidTimeDetail = yield* Effect.exit(
          query.query<WorkDetailReq, WorkDetailRes>("work-detail", {
            projectId,
            workspaceId,
            workId,
          }),
        );
        expect(Exit.isFailure(invalidTimeDetail)).toBe(true);
        expect(JSON.stringify(invalidTimeDetail)).toContain(
          "FailureOccurrenceTimeInvalid",
        );
        expect(JSON.stringify(invalidTimeDetail)).not.toContain(
          "not-a-canonical-instant",
        );

        yield* sql.unsafe(
          "UPDATE provider_attempts SET settled_at = ? WHERE provider_turn_id = ?",
          [
            timesAt(HISTORY_SIZE - 1).attemptSettledAt,
            providerTurnIdAt(HISTORY_SIZE - 1),
          ],
        );

        yield* sql.unsafe("UPDATE works SET revision = 1 WHERE work_id = ?", [
          workId,
        ]);
        const afterSteer = yield* readViews();
        expect(
          afterSteer.attention.rows.some(
            (row) =>
              row.source === "TerminalProviderFailure" &&
              row.terminalProviderFailure?.workId === workId,
          ),
        ).toBe(false);
        expect(afterSteer.detail.terminalProviderFailure).toBeUndefined();

        yield* insertTerminalChain({
          index: 251,
          workId,
          targetWorkRevision: 1,
        });
        const currentRevision = yield* readViews();
        expect(
          currentRevision.attention.rows.filter(
            (row) => row.source === "TerminalProviderFailure",
          ),
        ).toHaveLength(1);
        expect(currentRevision.detail.terminalProviderFailure).toMatchObject({
          workRevision: 1,
          occurredAt: timesAt(251).attemptSettledAt,
        });

        yield* sql.unsafe(
          `INSERT INTO verifications (
            verification_id, project_id, work_id, target_work_revision,
            owner_workspace_id, mission_snapshot, target_deliverables,
            target_artifact_versions, target_environment_revision,
            environment_snapshot_ref, verification_execution_ids, state,
            verdict, conclusion_reason, summary_ref, criteria_results,
            snapshot_status, created_at, updated_at
          ) VALUES (?, ?, ?, 1, ?, ?, '[]', '[]', NULL, NULL, '[]',
                    'Concluded', 'Pass', NULL, ?, NULL, 'UnavailableLegacy', ?, ?)`,
          [
            "ver_00000000-0000-7000-8000-000000000101",
            projectId,
            workId,
            workspaceId,
            JSON.stringify({
              goal: "terminal history",
              criteria: [
                {
                  criterionId: "completion",
                  requirement: "terminal history covered",
                  required: true,
                },
              ],
              riskRequirements: [],
            }),
            "sha256:rai-terminal-history-summary",
            "2026-10-26T00:00:00.000Z",
            "2026-10-26T00:00:00.000Z",
          ],
        );
        yield* sql.unsafe(
          `INSERT INTO work_acceptances (
            acceptance_id, project_id, work_id, target_work_revision,
            verification_id, actor, accepted_at
          ) VALUES (?, ?, ?, 1, ?, 'user:governor', ?)`,
          [
            "acc_00000000-0000-7000-8000-000000000101",
            projectId,
            workId,
            "ver_00000000-0000-7000-8000-000000000101",
            "2026-10-26T00:00:00.000Z",
          ],
        );
        yield* sql.unsafe(
          "UPDATE works SET lifecycle = 'Completed' WHERE work_id = ?",
          [workId],
        );
        const completed = yield* readViews();
        expect(
          completed.attention.rows.some(
            (row) =>
              row.source.startsWith("TerminalProviderFailure") &&
              row.terminalProviderFailure?.workId === workId,
          ),
        ).toBe(false);
        expect(completed.detail.terminalProviderFailure).toBeUndefined();

        yield* insertTerminalChain({
          index: 1_000,
          workId: cancelledWorkId,
          targetWorkRevision: 0,
        });
        const beforeCancelAttention = yield* query.query<
          AttentionReq,
          AttentionRes
        >("attention", { projectId });
        expect(
          beforeCancelAttention.value.rows.some(
            (row) =>
              row.source === "TerminalProviderFailure" &&
              row.terminalProviderFailure?.workId === cancelledWorkId,
          ),
        ).toBe(true);
        yield* sql.unsafe(
          "UPDATE works SET lifecycle = 'Cancelled' WHERE work_id = ?",
          [cancelledWorkId],
        );
        const cancelledDetail = yield* query.query<
          WorkDetailReq,
          WorkDetailRes
        >("work-detail", { projectId, workspaceId, workId: cancelledWorkId });
        const cancelledAttention = yield* query.query<
          AttentionReq,
          AttentionRes
        >("attention", { projectId });
        expect(cancelledDetail.value.terminalProviderFailure).toBeUndefined();
        expect(
          cancelledAttention.value.rows.some(
            (row) =>
              row.source.startsWith("TerminalProviderFailure") &&
              row.terminalProviderFailure?.workId === cancelledWorkId,
          ),
        ).toBe(false);
      }),
    );
  }, 120_000);
});
