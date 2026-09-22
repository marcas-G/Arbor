import { Effect, Layer } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { describe, expect, it } from "vitest";
import {
  AgentExecutionStateStoreLive,
  ClockLive,
  CommandStoreLive,
  DomainEventJournalLive,
  ExecutionRepositoryLive,
  IdGeneratorLive,
  LeaseServiceLive,
  layer,
  P12_MIGRATIONS,
  ProjectRepositoryLive,
  runMigrations,
  SessionRepositoryLive,
  TransactionPortLive,
  WorkspaceRepositoryLive,
  WorkWaitStoreLive,
} from "../adapters/persistence-sqlite/src/index.js";
import { WorkerDispatchPortLive } from "../adapters/worker-local/src/index.js";
import {
  CommandGateway,
  CommandGatewayLive,
  type GatewayEnvelope,
  semanticRequestFingerprint,
  type VerifiedRuntimeCommandAuthority,
} from "../packages/application/src/index.js";
import type { ExecutionSettlement } from "../packages/domain/dist/index.js";
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
import { RuntimeSafetyGate } from "../packages/ports/src/index.js";
import { FakeDriverLive } from "../packages/testkit/src/index.js";

const projectId = parse(ProjectId)("prj_018f2b3c-4d5e-7abc-8def-0123456789a1");
const workspaceId = parse(WorkspaceId)(
  "ws_018f2b3c-4d5e-7abc-8def-0123456789a1",
);
const sessionId = parse(SessionId)("ses_018f2b3c-4d5e-7abc-8def-0123456789a1");
const actor = parse(Actor)("user:test");
const principal = parse(Principal)("worker:a");
const executionId = parse(ExecutionId)(
  "exe_018f2b3c-4d5e-7abc-8def-0123456789a1",
) as ExecutionId;

const makeApp = (settlement: ExecutionSettlement) => {
  const base = layer({ filename: ":memory:" });
  const infra = Layer.mergeAll(base, ClockLive, IdGeneratorLive);
  const repo = Layer.provide(ExecutionRepositoryLive, infra);
  const fence = Layer.provide(FenceStopCheckLive, Layer.merge(infra, repo));
  const repos = Layer.mergeAll(
    Layer.provide(TransactionPortLive, infra),
    Layer.provide(CommandStoreLive, infra),
    Layer.provide(DomainEventJournalLive, infra),
    Layer.provide(ProjectRepositoryLive, infra),
    Layer.provide(WorkspaceRepositoryLive, infra),
    Layer.provide(SessionRepositoryLive, infra),
    Layer.provide(WorkWaitStoreLive, infra),
    Layer.provide(AgentExecutionStateStoreLive, infra),
    repo,
    Layer.provide(LeaseServiceLive, Layer.merge(infra, repo)),
  );
  const all = Layer.mergeAll(
    infra,
    repos,
    fence,
    WorkerDispatchPortLive,
    FakeDriverLive(settlement),
    RuntimeSafetyGateLive(),
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

const admit = Effect.gen(function* () {
  const gateway = yield* CommandGateway;
  const commandId = parse(CommandId)(
    "cmd_018f2b3c-4d5e-7abc-8def-0123456789a1",
  );
  const authority: VerifiedRuntimeCommandAuthority = {
    _tag: "AdmitExecutionAuthority",
    submissionOrigin: "System",
    principal,
    commandId,
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
  const envelope: GatewayEnvelope<AdmitExecutionPayload> = {
    commandType: "AdmitExecution",
    commandId,
    projectId,
    actor,
    issuedAt: "t",
    payload: admitPayload,
  };
  yield* gateway.execute(
    envelope,
    { _tag: "System", principal, causationRef: "c" },
    authority,
  );
});

const run = <A>(
  program: Effect.Effect<A, any, any>,
  app: Layer.Layer<any, any, any>,
): Promise<A> =>
  Effect.runPromise(
    Effect.provide(program, app) as Effect.Effect<A, any, never>,
  );

describe("P2-014 driver / dispatch / safety", () => {
  it("settles the driver's proposal through the command pipeline", async () => {
    const app = makeApp({
      _tag: "Completed",
      result: { _tag: "CoordinationCompleted" },
    });
    const program = Effect.gen(function* () {
      yield* runMigrations(P12_MIGRATIONS);
      yield* seed;
      yield* admit;
      const settlement = yield* runExecution(
        executionId,
        { _tag: "Recovery" },
        principal,
      );
      const sql = yield* SqlClient;
      const rows = yield* sql.unsafe<{ settlement_kind: string | null }>(
        "SELECT settlement_kind FROM executions WHERE execution_id = ?",
        [executionId],
      );
      return { settlement, kind: rows[0]?.settlement_kind };
    });
    const r = await run(program, app);
    expect((r as { settlement: { _tag: string } }).settlement._tag).toBe(
      "Completed",
    );
    expect((r as { kind: string | null }).kind).toBe("Completed");
  });

  it("stops repeated action fingerprints at the safety gate", async () => {
    const app = makeApp({
      _tag: "Completed",
      result: { _tag: "CoordinationCompleted" },
    });
    const program = Effect.gen(function* () {
      yield* runMigrations(P12_MIGRATIONS);
      const gate = yield* RuntimeSafetyGate;
      const decisions: string[] = [];
      for (let index = 0; index < 4; index += 1) {
        decisions.push(
          yield* gate.admitActivity(executionId, {
            _tag: "ToolInvocation",
            fingerprint: "fp",
          }),
        );
      }
      return decisions;
    });
    const decisions = await run(program, app);
    expect(decisions).toEqual(["Continue", "Continue", "Continue", "Stop"]);
  });
});
