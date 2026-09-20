import {
  ExecutionId,
  parse,
  ToolInvocationId,
  WorkspaceId,
} from "@arbor/domain";
import { ToolInvocationStore, TransactionPort } from "@arbor/ports";
import { Effect, Layer } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { describe, expect, it } from "vitest";
import {
  layer,
  P4_MIGRATIONS,
  runMigrations,
  ToolInvocationStoreLive,
  TransactionPortLive,
} from "../src/index.js";

const projectId = "prj_018f2b3c-4d5e-7abc-8def-0123456789a1";
const workspaceId = parse(WorkspaceId)(
  "ws_018f2b3c-4d5e-7abc-8def-0123456789a1",
);
const sessionId = "ses_018f2b3c-4d5e-7abc-8def-0123456789a1";
const executionId = parse(ExecutionId)(
  "exe_018f2b3c-4d5e-7abc-8def-0123456789a1",
);
const invocationId = parse(ToolInvocationId)(
  "tin_018f2b3c-4d5e-7abc-8def-0123456789a1",
);

const makeApp = () => {
  const base = layer({ filename: ":memory:" });
  const infra = Layer.mergeAll(base);
  return Layer.mergeAll(
    infra,
    Layer.provide(TransactionPortLive, infra),
    Layer.provide(ToolInvocationStoreLive, infra),
  );
};

const seed = Effect.gen(function* () {
  const sql = yield* SqlClient;
  yield* sql.withTransaction(
    Effect.gen(function* () {
      yield* sql.unsafe(
        "INSERT INTO projects (project_id, name, root_workspace_id, project_policy, project_policy_revision, default_configuration, environment_ref, lifecycle, revision, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
        [
          projectId,
          "p",
          workspaceId,
          "{}",
          0,
          "{}",
          "local",
          "Open",
          0,
          "t",
          "t",
        ],
      );
      yield* sql.unsafe(
        "INSERT INTO sessions (session_id, binding_kind, workspace_id, execution_id, context_epoch, created_at) VALUES (?,?,?,NULL,?,?)",
        [sessionId, "WorkspacePrimary", workspaceId, 0, "t"],
      );
      yield* sql.unsafe(
        "INSERT INTO workspaces (workspace_id, project_id, parent_workspace_id, name, responsibility_definition, responsibility_revision, resource_boundary, resource_boundary_revision, agent_binding, primary_session_id, current_work_id, workspace_policy, workspace_policy_revision, revision, lifecycle, created_at, updated_at) VALUES (?,?,NULL,?,?,?,?,?,?,?,NULL,?,?,?,?,?,?)",
        [
          workspaceId,
          projectId,
          "w",
          "{}",
          0,
          "{}",
          0,
          "{}",
          sessionId,
          "{}",
          0,
          0,
          "Active",
          "t",
          "t",
        ],
      );
      yield* sql.unsafe(
        "INSERT INTO executions (execution_id, project_id, binding_kind, workspace_id, focus_kind, focus_work_id, parent_execution_id, mission, session_id, admitted_at, stop_requested_at, settlement_kind, settlement_json, settled_at) VALUES (?,?,?,?,?,NULL,NULL,NULL,?,?,NULL,NULL,NULL,NULL)",
        [
          executionId,
          projectId,
          "workspace",
          workspaceId,
          "coordination",
          sessionId,
          "t",
        ],
      );
    }),
  );
});

describe("P4 tool invocation store", () => {
  it("persists intent before settlement and detects a dangling intent", async () => {
    const app = makeApp();
    const program = Effect.gen(function* () {
      yield* runMigrations(P4_MIGRATIONS);
      yield* seed;
      const tx = yield* TransactionPort;
      const store = yield* ToolInvocationStore;
      yield* tx.transact(
        store.recordIntent({
          invocationId,
          executionId,
          workspaceId,
          toolName: "shell",
          toolVersion: "1",
          sideEffectSemantics: "Reconcilable",
          argumentsJson: '{"command":"ls"}',
          resolvedRegions: [],
          approvalId: null,
          intentAt: "t1",
        }),
      );
      const dangling = yield* tx.transact(store.findUnsettled(executionId));
      yield* tx.transact(
        store.settle(invocationId, { _tag: "Success" }, null, "t2"),
      );
      const after = yield* tx.transact(store.findUnsettled(executionId));
      const sql = yield* SqlClient;
      const rows = yield* sql.unsafe<{ settlement_kind: string | null }>(
        "SELECT settlement_kind FROM tool_invocations WHERE invocation_id = ?",
        [invocationId],
      );
      return { dangling, after, kind: rows[0]?.settlement_kind };
    });
    const r = await Effect.runPromise(
      Effect.provide(program, app) as Effect.Effect<unknown, unknown, never>,
    );
    expect((r as { dangling: ReadonlyArray<unknown> }).dangling).toHaveLength(
      1,
    );
    expect((r as { after: ReadonlyArray<unknown> }).after).toHaveLength(0);
    expect((r as { kind: string | null }).kind).toBe("Success");
  });
});
