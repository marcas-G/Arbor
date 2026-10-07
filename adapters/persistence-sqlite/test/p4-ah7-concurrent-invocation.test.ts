import {
  Actor,
  ExecutionId,
  Principal,
  ProjectId,
  parse,
  SessionId,
  ToolInvocationId,
  WorkspaceId,
} from "@arbor/domain";
import {
  Clock,
  ProjectEnvironmentPort,
  ResourceAdmission,
  SandboxPort,
  type ToolDefinition,
  ToolDefinitionStore,
  type ToolExecutionContext,
  ToolRuntimePort,
} from "@arbor/ports";
import { Effect, Layer, Option } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { describe, expect, it } from "vitest";
import type { ToolExecutor } from "../../../packages/tool-runtime/src/index.js";
import { ToolRuntimeLive } from "../../../packages/tool-runtime/src/index.js";
import {
  layer,
  P4_MIGRATIONS,
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
const invocationId = parse(ToolInvocationId)(
  "tin_018f2b3c-4d5e-7abc-8def-0123456789a1",
);
const principal = parse(Principal)("worker:ah7-sqlite-concurrent");
const actor = parse(Actor)("worker:ah7-sqlite-concurrent");

const definition: ToolDefinition = {
  name: "write_once",
  version: "1",
  hash: "write-once-v1",
  description: "Perform a non-idempotent side effect.",
  inputSchemaJson: JSON.stringify({ type: "object" }),
  resultSchemaJson: JSON.stringify({ type: "object" }),
  capabilityMetadata: [],
  sideEffectSemantics: "NonIdempotent",
  source: "Builtin",
};

const intent = {
  callRef: "call-ah7-sqlite-concurrent",
  toolName: definition.name,
  toolVersion: definition.version,
  argumentsJson: "{}",
  invocationId,
  approvalId: null,
} as const;

const context: ToolExecutionContext = {
  executionId,
  workspaceId,
  sessionId,
  projectId,
  actor,
  authenticatedPrincipal: principal,
  authority: {
    principal,
    workspaceId,
    executionId,
    toolName: intent.toolName,
    toolVersion: intent.toolVersion,
    resourceSpaceIds: [],
    allowedCapabilities: [],
    controlBasisDigest: "ah7-sqlite-concurrent-basis",
    expiresAt: "2999-01-01T00:00:00.000Z",
    delegationDepth: 0,
  },
  controlBasisDigest: "ah7-sqlite-concurrent-basis",
  requestedAt: "2026-10-06T00:00:00.000Z",
};

const seedExecution = Effect.gen(function* () {
  const sql = yield* SqlClient;
  yield* sql.withTransaction(
    Effect.gen(function* () {
      yield* sql.unsafe(
        "INSERT INTO projects (project_id, name, root_workspace_id, project_policy, project_policy_revision, default_configuration, environment_ref, lifecycle, revision, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
        [
          projectId,
          "AH7 concurrent SQLite",
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
          "AH7 concurrent workspace",
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

describe("AH7 SQLite concurrent ToolInvocationId reentry", () => {
  it("keeps one durable intent and settlement and safely admits one non-idempotent effect", async () => {
    let executorEffects = 0;
    const executor: ToolExecutor = {
      name: definition.name,
      write: true,
      requiresApproval: () => false,
      execute: () => {
        executorEffects += 1;
        return Effect.succeed({
          settlement: { _tag: "Success" },
          observation: { text: "effect applied once", truncated: false },
          resultRef: null,
        });
      },
    };

    const sqlite = layer({ filename: ":memory:" });
    const infrastructure = Layer.mergeAll(
      sqlite,
      Layer.provide(TransactionPortLive, sqlite),
      Layer.provide(ToolInvocationStoreLive, sqlite),
    );
    const runtimeDependencies = Layer.mergeAll(
      infrastructure,
      Layer.succeed(ToolDefinitionStore, {
        definition: () => Effect.succeed(Option.some(definition)),
        all: () => Effect.succeed([definition]),
      }),
      Layer.succeed(SandboxPort, {
        open: () =>
          Effect.succeed({
            handleId: "ah7-sqlite-sandbox",
            rootPath: "/repo",
            writableRegions: [],
          }),
        close: () => Effect.void,
      }),
      Layer.succeed(ResourceAdmission, {
        admit: () => Effect.succeed({ _tag: "Admitted" as const }),
      }),
      Layer.succeed(ProjectEnvironmentPort, {
        resolve: () =>
          Effect.succeed({
            regions: [],
            observedEnvironmentRevision: "ah7-sqlite-env",
          }),
      }),
      Layer.succeed(Clock, {
        now: () => Effect.succeed("2026-10-06T00:00:00.000Z"),
      }),
    );
    const app = Layer.mergeAll(
      runtimeDependencies,
      Layer.provide(ToolRuntimeLive([executor]), runtimeDependencies),
    );

    const program = Effect.gen(function* () {
      yield* runMigrations(P4_MIGRATIONS);
      yield* seedExecution;
      const invoke = () =>
        Effect.match(
          Effect.gen(function* () {
            const runtime = yield* ToolRuntimePort;
            return yield* runtime.invoke(intent, context);
          }),
          {
            onFailure: (error) => ({ _tag: "Left" as const, error }),
            onSuccess: (value) => ({ _tag: "Right" as const, value }),
          },
        );
      const outcomes = yield* Effect.all([invoke(), invoke()], {
        concurrency: 2,
      });
      const sql = yield* SqlClient;
      const rows = yield* sql.unsafe<{
        count: number;
        settled_count: number;
        settlement_kind: string | null;
      }>(
        "SELECT COUNT(*) AS count, SUM(CASE WHEN settled_at IS NOT NULL THEN 1 ELSE 0 END) AS settled_count, MIN(settlement_kind) AS settlement_kind FROM tool_invocations WHERE invocation_id = ?",
        [invocationId],
      );
      return { outcomes, row: rows[0] };
    });

    const result = await Effect.runPromise(Effect.provide(program, app));
    const successes = result.outcomes.filter(
      (outcome) => outcome._tag === "Right" && outcome.value._tag === "Success",
    );
    const other = result.outcomes.filter(
      (outcome) =>
        !(outcome._tag === "Right" && outcome.value._tag === "Success"),
    );

    expect(executorEffects).toBe(1);
    expect(result.row).toMatchObject({
      count: 1,
      settled_count: 1,
      settlement_kind: "Success",
    });
    expect(successes).toHaveLength(1);
    expect(other).toHaveLength(1);
    const duplicate = other[0];
    expect(duplicate).toBeDefined();
    if (duplicate?._tag === "Right") {
      expect(duplicate.value._tag).toBe("OutcomeUnknown");
    } else {
      expect(duplicate?.error).toMatchObject({
        _tag: "ToolRuntimeOperationalFailure",
        stage: "IntentJournal",
      });
    }
  });
});
