import { Effect, Layer } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { describe, expect, it } from "vitest";
import {
  AgentExecutionStateStoreLive,
  ClockLive,
  CommandStoreLive,
  DomainEventJournalLive,
  EnvironmentRevisionStoreLive,
  ExecutionRepositoryLive,
  IdGeneratorLive,
  LeaseServiceLive,
  layer,
  P12_MIGRATIONS,
  ProjectRepositoryLive,
  ProviderTurnStoreLive,
  runMigrations,
  SessionRepositoryLive,
  TransactionPortLive,
  WorkspaceRepositoryLive,
  WorkWaitStoreLive,
} from "../adapters/persistence-sqlite/src/index.js";
import { FakeProviderLive } from "../adapters/provider-fake/src/index.js";
import { WorkerDispatchPortLive } from "../adapters/worker-local/src/index.js";
import { AgentDriverLive } from "../packages/agent-runtime/src/index.js";
import {
  CommandGateway,
  CommandGatewayLive,
  semanticRequestFingerprint,
  type VerifiedRuntimeCommandAuthority,
} from "../packages/application/src/index.js";
import {
  Actor,
  CommandId,
  ExecutionId,
  Principal,
  ProjectId,
  parse,
  SessionId,
  WorkspaceId,
} from "../packages/domain/dist/index.js";
import {
  type AdmitExecutionPayload,
  FenceStopCheckLive,
  P2CommandHandlerRegistryLive,
  RuntimeSafetyGateLive,
  runExecution,
} from "../packages/execution-runtime/src/index.js";
import { ModelContextLive } from "../packages/model-context/src/index.js";
import {
  ModelCapabilityPort,
  SkillRegistry,
  ToolCatalogPort,
} from "../packages/ports/src/index.js";
import { ProviderRuntimeLive } from "../packages/provider-runtime/src/index.js";
import { FixedSecretStoreLive } from "../packages/testkit/src/index.js";

const projectId = parse(ProjectId)("prj_018f2b3c-4d5e-7abc-8def-0123456789a1");
const workspaceId = parse(WorkspaceId)(
  "ws_018f2b3c-4d5e-7abc-8def-0123456789a1",
);
const sessionId = parse(SessionId)("ses_018f2b3c-4d5e-7abc-8def-0123456789a1");
const executionId = parse(ExecutionId)(
  "exe_018f2b3c-4d5e-7abc-8def-0123456789a1",
) as ExecutionId;
const actor = parse(Actor)("user:test");
const principal = parse(Principal)("worker:a");

const claimTurn = [
  {
    _tag: "ToolCallProposed" as const,
    callRef: "c1",
    toolName: "arbor_directive",
    argumentsJson: JSON.stringify({
      _tag: "CompletionClaim",
      claim: { claimRef: "claim-1", workRevision: 0 },
    }),
  },
  { _tag: "TurnCompleted" as const, finishReason: "ToolCall" as const },
];

const capability = Layer.succeed(ModelCapabilityPort, {
  resolve: () =>
    Effect.succeed({
      modelRef: "model-a",
      family: "f",
      contextWindow: 8000,
      outputCeiling: 512,
      toolProtocol: "json",
    }),
});
const skills = Layer.succeed(SkillRegistry, {
  available: () => Effect.succeed([]),
  load: () => Effect.die("x"),
});
const tools = Layer.succeed(ToolCatalogPort, {
  visibleRefs: () => Effect.succeed([]),
  resolveForModel: () => Effect.die("no tools in test"),
});

const makeApp = () => {
  const base = layer({ filename: ":memory:" });
  const infra = Layer.mergeAll(base, ClockLive, IdGeneratorLive);
  const repo = Layer.provide(ExecutionRepositoryLive, infra);
  const fence = Layer.provide(FenceStopCheckLive, Layer.merge(infra, repo));
  const provider = FakeProviderLive({ turns: [claimTurn] });
  const providerRuntime = Layer.provide(
    ProviderRuntimeLive(3),
    Layer.mergeAll(
      provider,
      Layer.provide(ProviderTurnStoreLive, infra),
      Layer.provide(TransactionPortLive, infra),
      FixedSecretStoreLive(),
      infra,
    ),
  );
  const modelContext = Layer.provide(
    ModelContextLive,
    Layer.mergeAll(capability, skills, tools),
  );
  const repos = Layer.mergeAll(
    Layer.provide(TransactionPortLive, infra),
    Layer.provide(CommandStoreLive, infra),
    Layer.provide(DomainEventJournalLive, infra),
    Layer.provide(ProjectRepositoryLive, infra),
    Layer.provide(WorkspaceRepositoryLive, infra),
    Layer.provide(SessionRepositoryLive, infra),
    Layer.provide(WorkWaitStoreLive, infra),
    Layer.provide(AgentExecutionStateStoreLive, infra),
    Layer.provide(ProviderTurnStoreLive, infra),
    repo,
    Layer.provide(LeaseServiceLive, Layer.merge(infra, repo)),
  );
  const driver = Layer.provide(
    AgentDriverLive(),
    Layer.mergeAll(
      modelContext,
      providerRuntime,
      capability,
      repos,
      infra,
      Layer.provide(EnvironmentRevisionStoreLive, infra),
    ),
  );
  const all = Layer.mergeAll(
    infra,
    repos,
    fence,
    provider,
    providerRuntime,
    modelContext,
    driver,
    WorkerDispatchPortLive,
    RuntimeSafetyGateLive(),
    capability,
    skills,
    tools,
    Layer.provide(P2CommandHandlerRegistryLive, repos),
  );
  return Layer.mergeAll(all, Layer.provide(CommandGatewayLive, all));
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
    }),
  );
});

const admitPayload: AdmitExecutionPayload = {
  _tag: "WorkspaceMain",
  executionId,
  workspaceId,
  focus: { _tag: "Coordination" },
};

const run = <A>(
  program: Effect.Effect<A, any, any>,
  app: Layer.Layer<any, any, any>,
) =>
  Effect.runPromise(
    Effect.provide(program, app) as Effect.Effect<A, any, never>,
  );

describe("P3 integration — end-to-end driver + P2 settle pipeline", () => {
  it("admits, leases, drives, and settles a CompletionClaim through the pipeline", async () => {
    const app = makeApp();
    const program = Effect.gen(function* () {
      yield* runMigrations(P12_MIGRATIONS);
      yield* seed;
      const gateway = yield* CommandGateway;
      const admitId = parse(CommandId)(
        "cmd_018f2b3c-4d5e-7abc-8def-0123456789a1",
      );
      const authority: VerifiedRuntimeCommandAuthority = {
        _tag: "AdmitExecutionAuthority",
        submissionOrigin: "System",
        principal,
        commandId: admitId,
        semanticRequestFingerprint: semanticRequestFingerprint({
          commandType: "AdmitExecution",
          projectId,
          actor,
          schemaVersion: "1",
          payload: admitPayload,
        }),
        projectId,
        commandKind: "AdmitExecution",
        workspaceId,
        bindingKind: "WorkspaceMain",
      };
      yield* gateway.execute(
        {
          commandType: "AdmitExecution",
          commandId: admitId,
          projectId,
          actor,
          issuedAt: "t",
          payload: admitPayload,
        },
        { _tag: "System", principal, causationRef: "c" },
        authority,
      );
      const settlement = yield* runExecution(
        executionId,
        { _tag: "WorkSelected" },
        principal,
      );
      const sql = yield* SqlClient;
      const rows = yield* sql.unsafe<{
        settlement_kind: string | null;
        settlement_json: string | null;
      }>(
        "SELECT settlement_kind, settlement_json FROM executions WHERE execution_id = ?",
        [executionId],
      );
      const providerTurns = yield* sql.unsafe<{ count: number }>(
        "SELECT COUNT(*) AS count FROM provider_turns",
      );
      const events = yield* sql.unsafe<{ event_type: string }>(
        "SELECT event_type FROM domain_events WHERE event_type = 'ExecutionSettled'",
      );
      return {
        settlement,
        rows,
        turns: Number(providerTurns[0]?.count ?? 0),
        settledEvents: events.length,
      };
    });
    const r = await run(program, app);
    expect((r as { settlement: { _tag: string } }).settlement._tag).toBe(
      "Completed",
    );
    const rows = (
      r as {
        rows: ReadonlyArray<{
          settlement_kind: string | null;
          settlement_json: string | null;
        }>;
      }
    ).rows;
    expect(rows[0]?.settlement_kind).toBe("Completed");
    expect(rows[0]?.settlement_json).toContain("CompletionClaimed");
    expect((r as { turns: number }).turns).toBeGreaterThanOrEqual(1);
    expect((r as { settledEvents: number }).settledEvents).toBe(1);
  });
});
