import { Effect, Exit, Layer, Option } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import {
  ExecutionId,
  type LeaseGeneration,
  type ToolInvocationId,
  parse,
  ProjectId,
  SessionId,
  WorkspaceId,
} from "@arbor/domain";
import {
  ToolInvocationStore,
  TransactionPort,
  type ToolExecutionContext,
  type ToolInvocationIntent,
} from "@arbor/ports";
import { describe, expect, it } from "vitest";
import * as migrationExports from "../src/migrations.js";
import {
  layer,
  runMigrations,
  ToolInvocationStoreLive,
  TransactionPortLive,
} from "../src/index.js";

const projectId = parse(ProjectId)("prj_018f2b3c-4d5e-7abc-8def-0123456789a1");
const workspaceId = parse(WorkspaceId)(
  "ws_018f2b3c-4d5e-7abc-8def-0123456789a1",
);
const sessionId = parse(SessionId)("ses_018f2b3c-4d5e-7abc-8def-0123456789a1");
const executionId = parse(ExecutionId)(
  "exe_018f2b3c-4d5e-7abc-8def-0123456789a1",
);
const invocationA = "tin_018f2b3c-4d5e-7abc-8def-0123456789a1" as ToolInvocationId;
const invocationB = "tin_118f2b3c-4d5e-7abc-8def-0123456789a1" as ToolInvocationId;
const invocationC = "tin_218f2b3c-4d5e-7abc-8def-0123456789a1" as ToolInvocationId;
const invocationE = "tin_318f2b3c-4d5e-7abc-8def-0123456789a1" as ToolInvocationId;
const approvalId = "apr_018f2b3c-4d5e-7abc-8def-0123456789a1";
const workerId = "worker:ah7-dg03";
const workerIncarnationId = "incarnation:ah7-dg03";
const fence = {
  executionId,
  workerId,
  workerIncarnationId,
  fencingGeneration: 0 as LeaseGeneration,
} as NonNullable<ToolExecutionContext["executionFence"]>;
const fenceNow = "2026-10-11T00:00:01.000Z";
const intent = (id: ToolInvocationId, withApproval: boolean): ToolInvocationIntent => ({
  invocationId: id,
  executionId,
  workspaceId,
  toolName: "write_once",
  toolVersion: "1",
  sideEffectSemantics: "NonIdempotent",
  argumentsJson: "{}",
  resolvedRegions: [],
  approvalId: withApproval ? approvalId : null,
  intentAt: fenceNow,
});

const makeApp = () => {
  const sqlite = layer({ filename: ":memory:" });
  return Layer.mergeAll(
    sqlite,
    Layer.provide(TransactionPortLive, sqlite),
    Layer.provide(ToolInvocationStoreLive, sqlite),
  );
};

const seedExecution = Effect.gen(function* () {
  const sql = yield* SqlClient;
  yield* sql.withTransaction(
    Effect.gen(function* () {
      yield* sql.unsafe(
        `INSERT INTO projects (
          project_id, name, root_workspace_id, project_policy,
          project_policy_revision, default_configuration, environment_ref,
          lifecycle, revision, created_at, updated_at
        ) VALUES (?, 'AH7 DG03', ?, '{}', 0, '{}', 'local', 'Open', 0, 't0', 't0')`,
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
          workspace_policy_revision, revision, lifecycle, created_at, updated_at
        ) VALUES (?, ?, NULL, 'root', '{}', 0, '{}', 0, '{}', ?, NULL, '{}', 0, 0, 'Active', 't0', 't0')`,
        [workspaceId, projectId, sessionId],
      );
      yield* sql.unsafe(
        `INSERT INTO executions (
          execution_id, project_id, binding_kind, workspace_id,
          episode_kind, episode_ref, episode_revision, parent_execution_id,
          mission, session_id, admitted_at, stop_requested_at,
          settlement_kind, settlement_json, settled_at
        ) VALUES (?, ?, 'execution_bound', ?, NULL, NULL, NULL, NULL,
          'fixture', ?, 't0', NULL, NULL, NULL, NULL)`,
        [executionId, projectId, workspaceId, sessionId],
      );
      yield* sql.unsafe(
        `INSERT INTO execution_leases (
          execution_id, worker_id, worker_incarnation_id, generation,
          expires_at, updated_at
        ) VALUES (?, ?, ?, 0, '2999-01-01T00:00:00.000Z', 't0')`,
        [executionId, workerId, workerIncarnationId],
      );
    }),
  );
});

const seedApproval = Effect.gen(function* () {
  const sql = yield* SqlClient;
  yield* sql.unsafe(
    `INSERT INTO action_approvals (
      approval_id, route_kind, project_id, workspace_id, execution_id,
      subject_ref, stable_action_id, action_version, side_effect_semantics,
      action_digest, arguments_json, target_ref, target_resource_space_ids_json,
      control_basis_digest, state, revision, requested_at, expires_at,
      decided_at, decided_by, decision_reason, consumed_at, consumed_by,
      binding_proven, source_state
    ) VALUES (?, 'Executable', ?, ?, ?, 'human:test', 'write_once', '1',
      'NonIdempotent', 'digest', '{}', 'workspace', '[]', 'basis',
      'Approved', 1, 't0', '2999-01-01T00:00:00.000Z', 't0', 'human:test',
      NULL, NULL, NULL, 1, 'Approved')`,
    [approvalId, projectId, workspaceId, executionId],
  );
});

const p36Migrations = () =>
  (
    migrationExports as typeof migrationExports & {
      readonly P36_MIGRATIONS?: ReadonlyArray<{
        readonly id: number;
        readonly name: string;
        readonly sql: string;
        readonly foreignKeysOff?: boolean;
      }>;
    }
  ).P36_MIGRATIONS;

describe("AH7-DG-03 P4 SQLite store contract", () => {
  it("provides the P36 forward migration and fenced no-effect store operations", () => {
    expect(p36Migrations(), "P36 migration must be exported").toBeDefined();
  });

  it("exposes fenced intent, denial, interruption and effect-admission store operations", async () => {
    const app = makeApp();
    const store = await Effect.runPromise(
      Effect.provide(Effect.gen(function* () {
        return (yield* ToolInvocationStore) as unknown as Record<string, unknown>;
      }), app),
    );
    expect(typeof store.recordIntent).toBe("function");
    expect(typeof store.consumeApproval).toBe("function");
    expect(typeof store.recordNoEffectDenial).toBe("function");
    expect(typeof store.recordNoEffectInterruption).toBe("function");
    expect(typeof store.admitEffect).toBe("function");
  });

  it("commits intent and approval claim together, and rolls both back on claim failure", async () => {
    const migrations = p36Migrations();
    expect(migrations).toBeDefined();
    if (migrations === undefined) return;
    const app = makeApp();
    const program = Effect.gen(function* () {
      yield* runMigrations(migrations);
      yield* seedExecution;
      yield* seedApproval;
      const tx = yield* TransactionPort;
      const store = (yield* ToolInvocationStore) as unknown as {
        recordIntent: (...args: ReadonlyArray<unknown>) => Effect.Effect<void, unknown, never>;
        consumeApproval: (...args: ReadonlyArray<unknown>) => Effect.Effect<boolean, unknown, never>;
      };
      const sql = yield* SqlClient;

      const failedClaim = yield* Effect.exit(
        tx.transact(
          Effect.gen(function* () {
            yield* store.recordIntent(intent(invocationA, true), fence, fenceNow);
            const consumed = yield* store.consumeApproval(approvalId, invocationA, fence, fenceNow);
            if (!consumed) return yield* Effect.fail(new Error("approval claim lost"));
            return yield* Effect.fail(new Error("injected claim rollback"));
          }),
        ),
      );
      const rolledBack = yield* sql.unsafe<{
        intents: number;
        consumed_by: string | null;
      }>(
        `SELECT (SELECT COUNT(*) FROM tool_invocations WHERE invocation_id = ?) AS intents,
                (SELECT consumed_by FROM action_approvals WHERE approval_id = ?) AS consumed_by`,
        [invocationA, approvalId],
      );

      const claimWon = yield* tx.transact(
        Effect.gen(function* () {
          yield* store.recordIntent(intent(invocationA, true), fence, fenceNow);
          return yield* store.consumeApproval(approvalId, invocationA, fence, fenceNow);
        }),
      );
      const committed = yield* sql.unsafe<{
        invocation_id: string;
        effect_admission_state: string;
        consumed_by: string | null;
      }>(
        `SELECT i.invocation_id, i.effect_admission_state, a.consumed_by
           FROM tool_invocations i
           JOIN action_approvals a ON a.approval_id = i.approval_id
          WHERE i.invocation_id = ?`,
        [invocationA],
      );

      const loser = yield* Effect.exit(
        tx.transact(
          Effect.gen(function* () {
            yield* store.recordIntent(intent(invocationB, true), fence, fenceNow);
            const consumed = yield* store.consumeApproval(approvalId, invocationB, fence, fenceNow);
            if (consumed) return yield* Effect.fail(new Error("unexpected approval winner"));
            return yield* Effect.fail(new Error("roll back losing claim intent"));
          }),
        ),
      );
      const loserRows = yield* sql.unsafe<{ count: number }>(
        "SELECT COUNT(*) AS count FROM tool_invocations WHERE invocation_id = ?",
        [invocationB],
      );
      return { failedClaim, rolledBack: rolledBack[0], claimWon, committed: committed[0], loser, loserRows: loserRows[0] };
    });
    const result = await Effect.runPromise(Effect.provide(program, app));
    expect(Exit.isFailure(result.failedClaim)).toBe(true);
    expect(result.rolledBack).toEqual({ intents: 0, consumed_by: null });
    expect(result.claimWon).toBe(true);
    expect(result.committed).toEqual({
      invocation_id: invocationA,
      effect_admission_state: "NotAdmitted",
      consumed_by: invocationA,
    });
    expect(Exit.isFailure(result.loser)).toBe(true);
    expect(result.loserRows?.count).toBe(0);
  });

  it("stores Denied/Interrupted only while NotAdmitted and rejects a stale fence", async () => {
    const migrations = p36Migrations();
    expect(migrations).toBeDefined();
    if (migrations === undefined) return;
    const app = makeApp();
    const program = Effect.gen(function* () {
      yield* runMigrations(migrations);
      yield* seedExecution;
      yield* seedApproval;
      const tx = yield* TransactionPort;
      const store = (yield* ToolInvocationStore) as unknown as {
        recordIntent: (...args: ReadonlyArray<unknown>) => Effect.Effect<void, unknown, never>;
        recordNoEffectDenial: (...args: ReadonlyArray<unknown>) => Effect.Effect<unknown, unknown, never>;
        recordNoEffectInterruption: (...args: ReadonlyArray<unknown>) => Effect.Effect<boolean, unknown, never>;
        admitEffect: (...args: ReadonlyArray<unknown>) => Effect.Effect<unknown, unknown, never>;
        consumeApproval: (...args: ReadonlyArray<unknown>) => Effect.Effect<boolean, unknown, never>;
        settle: (...args: ReadonlyArray<unknown>) => Effect.Effect<boolean, unknown, never>;
      };
      const sql = yield* SqlClient;
      const staleFence = { ...fence, fencingGeneration: 1 as LeaseGeneration };

      const staleWrite = yield* Effect.exit(
        tx.transact(
          store.recordIntent(intent(invocationC, false), staleFence, fenceNow),
        ),
      );
      const staleRows = yield* sql.unsafe<{ count: number }>(
        "SELECT COUNT(*) AS count FROM tool_invocations WHERE invocation_id = ?",
        [invocationC],
      );
      yield* tx.transact(store.recordIntent(intent(invocationC, true), fence, fenceNow));
      const staleConsume = yield* Effect.exit(
        tx.transact(store.consumeApproval(approvalId, invocationC, staleFence, fenceNow)),
      );
      const approvalAfterStaleConsume = yield* tx.transact(
        (yield* ToolInvocationStore).findApproval(approvalId),
      );
      const staleDenial = yield* Effect.exit(
        tx.transact(
          store.recordNoEffectDenial(
            intent(invocationE, false),
            "InvocationAuthorityDenied",
            fenceNow,
            staleFence,
            fenceNow,
          ),
        ),
      );
      const staleDenialRows = yield* sql.unsafe<{ count: number }>(
        "SELECT COUNT(*) AS count FROM tool_invocations WHERE invocation_id = ?",
        [invocationE],
      );

      yield* tx.transact(store.recordIntent(intent(invocationE, false), fence, fenceNow));
      const authority = {
        principal: "worker:ah7-dg03",
        workspaceId,
        executionId,
        toolName: "write_once",
        toolVersion: "1",
        resourceSpaceIds: [],
        allowedCapabilities: [],
        controlBasisDigest: "basis",
        expiresAt: "2999-01-01T00:00:00.000Z",
        delegationDepth: 0,
      };
      const staleAdmission = yield* Effect.exit(
        tx.transact(store.admitEffect(invocationE, authority, fenceNow, staleFence)),
      );
      const stateAfterStaleAdmission = yield* sql.unsafe<{
        effect_admission_state: string;
      }>(
        "SELECT effect_admission_state FROM tool_invocations WHERE invocation_id = ?",
        [invocationE],
      );
      const admitted = yield* tx.transact(
        store.admitEffect(invocationE, authority, fenceNow, fence),
      );
      const staleSettlement = yield* Effect.exit(
        tx.transact(
          store.settle(
            invocationE,
            { _tag: "Success" },
            null,
            fenceNow,
            staleFence,
            fenceNow,
          ),
        ),
      );
      const afterStaleSettlement = yield* sql.unsafe<{
        settlement_kind: string | null;
        effect_admission_state: string;
      }>(
        "SELECT settlement_kind, effect_admission_state FROM tool_invocations WHERE invocation_id = ?",
        [invocationE],
      );

      const denial = yield* tx.transact(
        store.recordNoEffectDenial(
          intent(invocationA, true),
          "InvocationAuthorityDenied",
          fenceNow,
          fence,
          fenceNow,
        ),
      );
      const denialRow = yield* sql.unsafe<{
        effect_admission_state: string;
        settlement_kind: string;
        consumed_by: string | null;
      }>(
        `SELECT i.effect_admission_state, i.settlement_kind, a.consumed_by
           FROM tool_invocations i
           JOIN action_approvals a ON a.approval_id = i.approval_id
          WHERE i.invocation_id = ?`,
        [invocationA],
      );

      yield* tx.transact(store.recordIntent(intent(invocationB, false), fence, fenceNow));
      yield* sql.unsafe(
        "UPDATE executions SET stop_requested_at = ? WHERE execution_id = ?",
        [fenceNow, executionId],
      );
      const stoppedGate = yield* tx.transact(
        store.admitEffect(invocationB, { controlBasisDigest: "basis" }, fenceNow, fence),
      );
      const interrupted = yield* tx.transact(
        store.recordNoEffectInterruption(invocationB, fenceNow, fence, fenceNow),
      );
      const interruptionRow = yield* sql.unsafe<{
        effect_admission_state: string;
        settlement_kind: string | null;
      }>(
        "SELECT effect_admission_state, settlement_kind FROM tool_invocations WHERE invocation_id = ?",
        [invocationB],
      );

      return {
        staleWrite,
        staleRows: staleRows[0],
        staleConsume,
        approvalAfterStaleConsume,
        staleDenial,
        staleDenialRows: staleDenialRows[0],
        staleAdmission,
        stateAfterStaleAdmission: stateAfterStaleAdmission[0],
        admitted,
        staleSettlement,
        afterStaleSettlement: afterStaleSettlement[0],
        denial,
        denialRow: denialRow[0],
        stoppedGate,
        interrupted,
        interruptionRow: interruptionRow[0],
      };
    });
    const result = await Effect.runPromise(Effect.provide(program, app));
    expect(Exit.isFailure(result.staleWrite)).toBe(true);
    expect(result.staleRows?.count).toBe(0);
    expect(Exit.isFailure(result.staleConsume)).toBe(true);
    expect(
      Option.isSome(result.approvalAfterStaleConsume) &&
        result.approvalAfterStaleConsume.value.consumedBy,
    ).toBeNull();
    expect(Exit.isFailure(result.staleDenial)).toBe(true);
    expect(result.staleDenialRows?.count).toBe(0);
    expect(Exit.isFailure(result.staleAdmission)).toBe(true);
    expect(result.stateAfterStaleAdmission?.effect_admission_state).toBe("NotAdmitted");
    expect(result.admitted).toEqual({ _tag: "Admitted" });
    expect(Exit.isFailure(result.staleSettlement)).toBe(true);
    expect(result.afterStaleSettlement).toEqual({
      settlement_kind: null,
      effect_admission_state: "MayHaveStarted",
    });
    expect(result.denial).toBeDefined();
    expect(result.denialRow).toEqual({
      effect_admission_state: "NotAdmitted",
      settlement_kind: "Denied",
      consumed_by: null,
    });
    expect(result.stoppedGate).toEqual({ _tag: "ExecutionStopping" });
    expect(result.interrupted).toBe(true);
    expect(result.interruptionRow).toEqual({
      effect_admission_state: "NotAdmitted",
      settlement_kind: "Interrupted",
    });
    expect(Exit.isFailure(result.staleWrite)).toBe(true);
    expect(result.staleRows?.count).toBe(0);
  });
});
