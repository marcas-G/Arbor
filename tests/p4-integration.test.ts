import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer, Option } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { describe, expect, it } from "vitest";
import {
  ArtifactMetadataRepositoryLive,
  ClockLive,
  layer,
  P4_MIGRATIONS,
  runMigrations,
  ToolInvocationStoreLive,
  TransactionPortLive,
} from "../adapters/persistence-sqlite/src/index.js";
import { SandboxPortLive } from "../adapters/sandbox-local/src/index.js";
import {
  Actor,
  ExecutionId,
  Principal,
  ProjectId,
  parse,
  SessionId,
  ToolInvocationId,
  WorkspaceId,
} from "../packages/domain/dist/index.js";
import {
  Clock,
  ProjectEnvironmentPort,
  ResourceAdmission,
  SandboxPort,
  ToolDefinitionStore,
  ToolInvocationStore,
  ToolRuntimePort,
  TransactionPort,
  TransactionScope,
} from "../packages/ports/src/index.js";
import {
  BUILTIN_EXECUTORS,
  ToolDefinitionStoreLive,
  ToolRuntimeLive,
} from "../packages/tool-runtime/src/index.js";

const workspaceId = parse(WorkspaceId)(
  "ws_018f2b3c-4d5e-7abc-8def-0123456789a1",
);
const executionId = parse(ExecutionId)(
  "exe_018f2b3c-4d5e-7abc-8def-0123456789a1",
);
const projectId = parse(ProjectId)("prj_018f2b3c-4d5e-7abc-8def-0123456789a1");
const sessionId = parse(SessionId)("ses_018f2b3c-4d5e-7abc-8def-0123456789a1");
const principal = parse(Principal)("worker:a");
const actor = parse(Actor)("worker:a");
const invocationId = parse(ToolInvocationId)(
  "tin_018f2b3c-4d5e-7abc-8def-0123456789a1",
);

const root = mkdtempSync(join(tmpdir(), "p4-int-"));
writeFileSync(join(root, "a.txt"), "integration read");

const authority = {
  principal,
  workspaceId,
  executionId,
  toolName: "read",
  toolVersion: "1",
  resourceSpaceIds: ["filesystem"],
  allowedCapabilities: ["fs:read"],
  controlBasisDigest: "d",
  expiresAt: "2999-01-01T00:00:00.000Z",
  delegationDepth: 0,
};
const context = {
  executionId,
  workspaceId,
  sessionId,
  projectId,
  actor,
  authenticatedPrincipal: principal,
  authority,
  controlBasisDigest: "d",
  requestedAt: "t",
} as import("../packages/ports/src/index.js").ToolExecutionContext;
const intent = (toolName: string, argumentsJson: string) => ({
  callRef: "c",
  toolName,
  toolVersion: "1",
  argumentsJson,
  invocationId,
  approvalId: null,
});

const seed = Effect.gen(function* () {
  const sql = yield* SqlClient;
  yield* sql.withTransaction(
    Effect.gen(function* () {
      yield* sql.unsafe(
        "INSERT OR IGNORE INTO projects (project_id, name, root_workspace_id, project_policy, project_policy_revision, default_configuration, environment_ref, lifecycle, revision, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
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
        "INSERT OR IGNORE INTO sessions (session_id, binding_kind, workspace_id, execution_id, context_epoch, created_at) VALUES (?,?,?,NULL,?,?)",
        [sessionId, "WorkspacePrimary", workspaceId, 0, "t"],
      );
      yield* sql.unsafe(
        "INSERT OR IGNORE INTO workspaces (workspace_id, project_id, parent_workspace_id, name, responsibility_definition, responsibility_revision, resource_boundary, resource_boundary_revision, agent_binding, primary_session_id, current_work_id, workspace_policy, workspace_policy_revision, revision, lifecycle, created_at, updated_at) VALUES (?,?,NULL,?,?,?,?,?,?,?,NULL,?,?,?,?,?,?)",
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
        "INSERT OR IGNORE INTO executions (execution_id, project_id, binding_kind, workspace_id, focus_kind, focus_work_id, parent_execution_id, mission, session_id, admitted_at, stop_requested_at, settlement_kind, settlement_json, settled_at) VALUES (?,?,?,?,?,NULL,NULL,NULL,?,?,NULL,NULL,NULL,NULL)",
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

const makeApp = () => {
  const base = layer({ filename: join(root, "p4-int.db") });
  const infra = Layer.mergeAll(base, ClockLive);
  const sandbox = Layer.succeed(SandboxPort, {
    open: () =>
      Effect.succeed({ handleId: "s", rootPath: root, writableRegions: [] }),
    close: () => Effect.void,
  });
  const deps = Layer.mergeAll(
    Layer.provide(TransactionPortLive, infra),
    Layer.provide(ToolInvocationStoreLive, infra),
    Layer.provide(ArtifactMetadataRepositoryLive, infra),
    ToolDefinitionStoreLive,
    sandbox,
    Layer.succeed(ResourceAdmission, {
      admit: () => Effect.succeed({ _tag: "Admitted" as const }),
    } as never),
    Layer.succeed(ProjectEnvironmentPort, {
      resolve: (_p, addresses) =>
        Effect.succeed({
          regions: addresses.map((a) => ({
            resourceSpaceId: "filesystem",
            normalizedRegion: a,
          })),
          observedEnvironmentRevision: "rev",
        }),
    }),
  );
  const all = Layer.mergeAll(deps, infra);
  return Layer.mergeAll(
    infra,
    deps,
    Layer.provide(ToolRuntimeLive(BUILTIN_EXECUTORS), all),
  );
};

const run = (
  app: Layer.Layer<any, any, any>,
  toolName: string,
  argumentsJson: string,
) =>
  Effect.runPromise(
    Effect.provide(
      Effect.gen(function* () {
        yield* runMigrations(P4_MIGRATIONS);
        yield* seed;
        const runtime = yield* ToolRuntimePort;
        return yield* runtime.invoke(
          intent(toolName, argumentsJson) as never,
          context,
        );
      }),
      app,
    ) as Effect.Effect<
      { _tag: string; observation?: { text: string } },
      unknown,
      never
    >,
  );

describe("P4 integration — tool runtime end to end", () => {
  const migrate = (app: Layer.Layer<any, any, any>) =>
    Effect.runPromise(
      Effect.provide(runMigrations(P4_MIGRATIONS), app) as Effect.Effect<
        number,
        unknown,
        never
      >,
    );

  it("executes the read tool through the full pipeline", async () => {
    const app = makeApp();
    await migrate(app);
    const result = await run(
      app,
      "read",
      JSON.stringify({ path: { path: "a.txt" } }),
    );
    expect(result._tag).toBe("Success");
    expect(JSON.parse(result.observation?.text ?? "{}").text).toBe(
      "integration read",
    );
  });

  it("denies an unknown tool and reports invalid input", async () => {
    const app = makeApp();
    await migrate(app);
    const denied = await run(app, "nope", "{}");
    expect(denied._tag).toBe("Denied");
    const invalid = await run(app, "read", "{}");
    expect(invalid._tag).toBe("ExpectedFailure");
  });

  void ToolDefinitionStore;
  void ToolInvocationStore;
  void TransactionPort;
  void TransactionScope;
  void Clock;
  void SandboxPortLive;
  void Option;
});
