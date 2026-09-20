import {
  ExecutionId,
  parse,
  ToolInvocationId,
  WorkspaceId,
} from "@arbor/domain";
import {
  ReconciliationSource,
  ToolInvocationStore,
  TransactionPort,
} from "@arbor/ports";
import { Effect, Layer } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { describe, expect, it } from "vitest";
import { ReconciliationSourceLive } from "../../../packages/tool-runtime/src/index.js";
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

const makeApp = () => {
  const base = layer({ filename: ":memory:" });
  const infra = Layer.mergeAll(base);
  const deps = Layer.mergeAll(
    Layer.provide(TransactionPortLive, infra),
    Layer.provide(ToolInvocationStoreLive, infra),
  );
  return Layer.mergeAll(
    infra,
    deps,
    Layer.provide(ReconciliationSourceLive, deps),
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

const intent = (id: string, semantics: string) => ({
  invocationId: parse(ToolInvocationId)(id) as ToolInvocationId,
  executionId,
  workspaceId,
  toolName: "shell",
  toolVersion: "1",
  sideEffectSemantics: semantics as never,
  argumentsJson: "{}",
  resolvedRegions: [],
  approvalId: null,
  intentAt: "t",
});

describe("P4 reconciliation source", () => {
  it("reports only reconcilable unsettled invocations", async () => {
    const app = makeApp();
    const program = Effect.gen(function* () {
      yield* runMigrations(P4_MIGRATIONS);
      yield* seed;
      const tx = yield* TransactionPort;
      const store = yield* ToolInvocationStore;
      const source = yield* ReconciliationSource;
      yield* tx.transact(
        store.recordIntent(
          intent("tin_018f2b3c-4d5e-7abc-8def-0123456789a1", "Reconcilable"),
        ),
      );
      yield* tx.transact(
        store.recordIntent(
          intent("tin_018f2b3c-4d5e-7abc-8def-0123456789a2", "ReadOnly"),
        ),
      );
      yield* tx.transact(
        store.recordIntent(
          intent("tin_018f2b3c-4d5e-7abc-8def-0123456789a3", "NonIdempotent"),
        ),
      );
      return yield* tx.transact(source.pending(executionId));
    });
    const pending = await Effect.runPromise(
      Effect.provide(program, app) as Effect.Effect<
        ReadonlyArray<string>,
        unknown,
        never
      >,
    );
    expect([...pending].sort()).toEqual([
      "tin_018f2b3c-4d5e-7abc-8def-0123456789a1",
      "tin_018f2b3c-4d5e-7abc-8def-0123456789a3",
    ]);
  });
});
