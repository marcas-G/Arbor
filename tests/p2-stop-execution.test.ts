import { Effect, Layer } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { describe, expect, it } from "vitest";
import {
  ClockLive,
  CommandStoreLive,
  DomainEventJournalLive,
  ExecutionRepositoryLive,
  IdGeneratorLive,
  layer,
  P2_MIGRATIONS,
  ProjectRepositoryLive,
  runMigrations,
  SessionRepositoryLive,
  TransactionPortLive,
  WorkspaceRepositoryLive,
} from "../adapters/persistence-sqlite/src/index.js";
import {
  CommandGateway,
  CommandGatewayLive,
  FenceStopCheckInertLive,
  type GatewayEnvelope,
  semanticRequestFingerprint,
  type VerifiedRuntimeCommandAuthority,
} from "../packages/application/src/index.js";
import {
  Actor,
  CommandId,
  type CommandSubmissionContext,
  ExecutionId,
  Principal,
  ProjectId,
  parse,
  SessionId,
  WorkspaceId,
} from "../packages/domain/dist/index.js";
import {
  type AdmitExecutionPayload,
  P2CommandHandlerRegistryLive,
  type StopExecutionPayload,
} from "../packages/execution-runtime/src/index.js";

const projectId = parse(ProjectId)("prj_018f2b3c-4d5e-7abc-8def-0123456789a1");
const workspaceId = parse(WorkspaceId)(
  "ws_018f2b3c-4d5e-7abc-8def-0123456789a1",
);
const sessionId = parse(SessionId)("ses_018f2b3c-4d5e-7abc-8def-0123456789a1");
const actor = parse(Actor)("user:test");
const principal = parse(Principal)("runtime:system");
const systemContext: CommandSubmissionContext = {
  _tag: "System",
  principal,
  causationRef: "c",
};
const executionId = parse(ExecutionId)(
  "exe_018f2b3c-4d5e-7abc-8def-0123456789a1",
) as ExecutionId;

const makeApp = () => {
  const base = layer({ filename: ":memory:" });
  const infra = Layer.mergeAll(base, ClockLive, IdGeneratorLive);
  const repos = Layer.mergeAll(
    Layer.provide(TransactionPortLive, infra),
    Layer.provide(CommandStoreLive, infra),
    Layer.provide(DomainEventJournalLive, infra),
    Layer.provide(ProjectRepositoryLive, infra),
    Layer.provide(WorkspaceRepositoryLive, infra),
    Layer.provide(SessionRepositoryLive, infra),
    Layer.provide(ExecutionRepositoryLive, infra),
  );
  const all = Layer.mergeAll(
    infra,
    repos,
    FenceStopCheckInertLive,
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
const admitEnvelope = (
  commandId: CommandId,
): GatewayEnvelope<AdmitExecutionPayload> => ({
  commandType: "AdmitExecution",
  commandId,
  projectId,
  actor,
  issuedAt: "t",
  payload: admitPayload,
});
const admitAuthority = (
  commandId: CommandId,
): VerifiedRuntimeCommandAuthority => ({
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
});

const stopPayload: StopExecutionPayload = { executionId };
const stopEnvelope = (
  commandId: CommandId,
): GatewayEnvelope<StopExecutionPayload> => ({
  commandType: "StopExecution",
  commandId,
  projectId,
  actor,
  issuedAt: "t1",
  payload: stopPayload,
});
const stopAuthority = (
  commandId: CommandId,
): VerifiedRuntimeCommandAuthority => ({
  _tag: "StopExecutionAuthority",
  submissionOrigin: "System",
  principal,
  commandId,
  semanticRequestFingerprint: semanticRequestFingerprint({
    commandType: "StopExecution",
    projectId,
    actor,
    schemaVersion: "1",
    payload: stopPayload,
  }),
  projectId,
  commandKind: "StopExecution",
  executionId,
});

const admit = (commandId: CommandId) =>
  Effect.gen(function* () {
    const gw = yield* CommandGateway;
    yield* gw.execute(
      admitEnvelope(commandId),
      systemContext,
      admitAuthority(commandId),
    );
  });

describe("P2-010 StopExecution", () => {
  it("sets the stop fact and emits ExecutionStopRequested", async () => {
    const app = makeApp();
    const admitId = parse(CommandId)(
      "cmd_018f2b3c-4d5e-7abc-8def-0123456789a1",
    );
    const stopId = parse(CommandId)("cmd_018f2b3c-4d5e-7abc-8def-0123456789a2");
    const program = Effect.gen(function* () {
      yield* runMigrations(P2_MIGRATIONS);
      yield* seed;
      yield* admit(admitId);
      const gw = yield* CommandGateway;
      const receipt = yield* gw.execute(
        stopEnvelope(stopId),
        systemContext,
        stopAuthority(stopId),
      );
      const sql = yield* SqlClient;
      const events = yield* sql.unsafe<{ event_type: string }>(
        "SELECT event_type FROM domain_events WHERE event_type = 'ExecutionStopRequested'",
      );
      const rows = yield* sql.unsafe<{ stop_requested_at: string | null }>(
        "SELECT stop_requested_at FROM executions WHERE execution_id = ?",
        [executionId],
      );
      return {
        receipt,
        events: events.length,
        stop: rows[0]?.stop_requested_at,
      };
    });
    const r = await Effect.runPromise(Effect.provide(program, app));
    const receipt = (r as { receipt: { resolution: { _tag: string } } })
      .receipt;
    expect(receipt.resolution._tag).toBe("Committed");
    expect((r as { events: number }).events).toBe(1);
    expect((r as { stop: string | null }).stop).toBe("t1");
  });

  it("is idempotent on a second stop and rejects a missing execution", async () => {
    const app = makeApp();
    const admitId = parse(CommandId)(
      "cmd_018f2b3c-4d5e-7abc-8def-0123456789a1",
    );
    const stop1 = parse(CommandId)("cmd_018f2b3c-4d5e-7abc-8def-0123456789a2");
    const stop2 = parse(CommandId)("cmd_018f2b3c-4d5e-7abc-8def-0123456789a3");
    const program = Effect.gen(function* () {
      yield* runMigrations(P2_MIGRATIONS);
      yield* seed;
      yield* admit(admitId);
      const gw = yield* CommandGateway;
      const first = yield* gw.execute(
        stopEnvelope(stop1),
        systemContext,
        stopAuthority(stop1),
      );
      const second = yield* gw.execute(
        stopEnvelope(stop2),
        systemContext,
        stopAuthority(stop2),
      );
      const sql = yield* SqlClient;
      const events = yield* sql.unsafe<{ count: number }>(
        "SELECT COUNT(*) AS count FROM domain_events WHERE event_type = 'ExecutionStopRequested'",
      );
      const missingPayload: StopExecutionPayload = {
        executionId: parse(ExecutionId)(
          "exe_018f2b3c-4d5e-7abc-8def-0123456789ff",
        ) as ExecutionId,
      };
      const missingId = parse(CommandId)(
        "cmd_018f2b3c-4d5e-7abc-8def-0123456789a4",
      );
      const missing = yield* gw.execute(
        {
          commandType: "StopExecution",
          commandId: missingId,
          projectId,
          actor,
          issuedAt: "t",
          payload: missingPayload,
        },
        systemContext,
        {
          _tag: "StopExecutionAuthority",
          submissionOrigin: "System",
          principal,
          commandId: missingId,
          semanticRequestFingerprint: semanticRequestFingerprint({
            commandType: "StopExecution",
            projectId,
            actor,
            schemaVersion: "1",
            payload: missingPayload,
          }),
          projectId,
          commandKind: "StopExecution",
          executionId: missingPayload.executionId,
        } as VerifiedRuntimeCommandAuthority,
      );
      return { first, second, events: Number(events[0]?.count ?? 0), missing };
    });
    const r = await Effect.runPromise(Effect.provide(program, app));
    const first = (r as { first: { resolution: { _tag: string } } }).first
      .resolution;
    const second = (
      r as {
        second: {
          resolution: { _tag: string; result?: { stopRequestedAt: string } };
        };
      }
    ).second.resolution;
    expect(first._tag).toBe("Committed");
    expect(second._tag).toBe("Committed");
    expect(second.result?.stopRequestedAt).toBe("t1");
    expect((r as { events: number }).events).toBe(1);
    const missing = (
      r as {
        missing: { resolution: { _tag: string; error?: { _tag: string } } };
      }
    ).missing.resolution;
    expect(missing._tag).toBe("TerminalRejected");
    expect(missing.error?._tag).toBe("ExecutionNotFound");
  });
});
