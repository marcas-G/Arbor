import { Effect, Exit, Layer, Option } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { describe, expect, it } from "vitest";
import {
  layer,
  P4_MIGRATIONS,
  runMigrations,
  ToolInvocationStoreLive,
  TransactionPortLive,
} from "../../../adapters/persistence-sqlite/src/index.js";
import {
  Actor,
  ExecutionId,
  Principal,
  ProjectId,
  parse,
  SessionId,
  ToolInvocationId,
  WorkspaceId,
} from "../../../packages/domain/src/index.js";
import {
  Clock,
  ProjectEnvironmentPort,
  ResourceAdmission,
  SandboxPort,
  type ToolDefinition,
  ToolDefinitionStore,
  type ToolExecutionContext,
  ToolRuntimePort,
} from "../../../packages/ports/src/index.js";
import {
  actionDigestOf,
  type ToolExecutor,
  ToolRuntimeLive,
} from "../../../packages/tool-runtime/src/index.js";

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
const principal = parse(Principal)("worker:ah7-approval-atomicity");
const actor = parse(Actor)("worker:ah7-approval-atomicity");
const approvalId = "apr_018f2b3c-4d5e-7abc-8def-0123456789a1";
const controlBasisDigest = "ah7-approval-atomicity-basis";

const definition: ToolDefinition = {
  name: "write_once",
  version: "1",
  hash: "write-once-v1",
  description: "Perform an approved non-idempotent side effect.",
  inputSchemaJson: JSON.stringify({ type: "object" }),
  resultSchemaJson: JSON.stringify({ type: "object" }),
  capabilityMetadata: [],
  sideEffectSemantics: "NonIdempotent",
  source: "Builtin",
};

const intent = {
  callRef: "call-ah7-approval-atomicity",
  toolName: definition.name,
  toolVersion: definition.version,
  argumentsJson: "{}",
  invocationId,
  approvalId,
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
    controlBasisDigest,
    expiresAt: "2999-01-01T00:00:00.000Z",
    delegationDepth: 0,
  },
  controlBasisDigest,
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
          "AH7 approval atomicity",
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
          "AH7 approval atomicity workspace",
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

describe("pending AH7 approval / P4 settlement transaction boundary", () => {
  it("keeps approval consumption atomic with settlement when interrupted after the effect", async () => {
    let externalEffects = 0;
    const executor: ToolExecutor = {
      name: definition.name,
      write: true,
      requiresApproval: () => true,
      execute: () => {
        externalEffects += 1;
        return Effect.succeed({
          settlement: { _tag: "Success" },
          observation: { text: "external effect completed", truncated: false },
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
            handleId: "ah7-approval-atomicity-sandbox",
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
            observedEnvironmentRevision: "ah7-approval-atomicity-env",
          }),
      }),
      Layer.succeed(Clock, {
        now: () => Effect.succeed("2026-10-06T00:00:00.000Z"),
      }),
    );
    const runtime = ToolRuntimeLive([executor], {
      qualificationProbe: async (event) => {
        if (event.boundary === "AH7AfterToolEffectBeforeSettlement") {
          throw new Error("injected crash-equivalent interruption");
        }
      },
    });
    const app = Layer.mergeAll(
      runtimeDependencies,
      Layer.provide(runtime, runtimeDependencies),
    );

    const program = Effect.gen(function* () {
      yield* runMigrations(P4_MIGRATIONS);
      yield* seedExecution;
      const sql = yield* SqlClient;
      yield* sql.unsafe(
        "INSERT INTO invocation_approvals (approval_id, tool_name, tool_version, action_digest, target_resource_space_ids_json, control_basis_digest, expires_at, consumed_by) VALUES (?,?,?,?,?,?,?,NULL)",
        [
          approvalId,
          intent.toolName,
          intent.toolVersion,
          actionDigestOf(intent),
          "[]",
          controlBasisDigest,
          "2999-01-01T00:00:00.000Z",
        ],
      );
      const toolRuntime = yield* ToolRuntimePort;
      const exit = yield* Effect.exit(toolRuntime.invoke(intent, context));
      const rows = yield* sql.unsafe<{
        consumed_by: string | null;
        invocation_id: string | null;
        settlement_kind: string | null;
        settled_at: string | null;
      }>(
        "SELECT a.consumed_by, i.invocation_id, i.settlement_kind, i.settled_at FROM invocation_approvals a LEFT JOIN tool_invocations i ON i.invocation_id = ? WHERE a.approval_id = ?",
        [invocationId, approvalId],
      );
      return { exit, row: rows[0] };
    });

    const result = await Effect.runPromise(Effect.provide(program, app));

    expect(Exit.isFailure(result.exit)).toBe(true);
    expect(externalEffects).toBe(1);
    expect(result.row).toEqual({
      consumed_by: null,
      invocation_id: invocationId,
      settlement_kind: null,
      settled_at: null,
    });
  });
});
