import { Effect, Layer } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { describe, expect, it } from "vitest";
import {
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
import {
  CommandGateway,
  CommandGatewayLive,
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
  FenceStopCheckLive,
  P2CommandHandlerRegistryLive,
  type SettleExecutionPayload,
} from "../packages/execution-runtime/src/index.js";
import { LeaseService, TransactionPort } from "../packages/ports/src/index.js";

const projectId = parse(ProjectId)("prj_018f2b3c-4d5e-7abc-8def-0123456789a1");
const workspaceId = parse(WorkspaceId)(
  "ws_018f2b3c-4d5e-7abc-8def-0123456789a1",
);
const sessionId = parse(SessionId)("ses_018f2b3c-4d5e-7abc-8def-0123456789a1");
const actor = parse(Actor)("user:test");
const principal = parse(Principal)("runtime:system");
const executionId = parse(ExecutionId)(
  "exe_018f2b3c-4d5e-7abc-8def-0123456789a1",
) as ExecutionId;

const makeApp = () => {
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
    repo,
    Layer.provide(LeaseServiceLive, Layer.merge(infra, repo)),
  );
  const all = Layer.mergeAll(
    infra,
    repos,
    fence,
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
  id: CommandId,
): GatewayEnvelope<AdmitExecutionPayload> => ({
  commandType: "AdmitExecution",
  commandId: id,
  projectId,
  actor,
  issuedAt: "t",
  payload: admitPayload,
});
const admitAuthority = (id: CommandId): VerifiedRuntimeCommandAuthority => ({
  _tag: "AdmitExecutionAuthority",
  submissionOrigin: "System",
  principal,
  commandId: id,
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

const settlePayload = (
  settlement: SettleExecutionPayload["settlement"],
): SettleExecutionPayload => ({
  executionId,
  settlement,
  expectedFencingGeneration: 0 as never,
});
const settleEnvelope = (
  id: CommandId,
  payload: SettleExecutionPayload,
): GatewayEnvelope<SettleExecutionPayload> => ({
  commandType: "SettleExecution",
  commandId: id,
  projectId,
  actor,
  issuedAt: "t2",
  payload,
});
const settleAuthority = (
  id: CommandId,
  payload: SettleExecutionPayload,
  origin: "ExecutionOrigin" | "RecoveryController",
): VerifiedRuntimeCommandAuthority => ({
  _tag: "SettleExecutionAuthority",
  submissionOrigin: origin,
  principal,
  commandId: id,
  semanticRequestFingerprint: semanticRequestFingerprint({
    commandType: "SettleExecution",
    projectId,
    actor,
    schemaVersion: "1",
    payload,
  }),
  projectId,
  commandKind: "SettleExecution",
  executionId,
  fencingGeneration: 0 as never,
});

const executionOrigin: CommandSubmissionContext = {
  _tag: "ExecutionOrigin",
  principal,
  executionId,
  fencingGeneration: 0 as never,
};
const recoveryOrigin: CommandSubmissionContext = {
  _tag: "RecoveryController",
  principal,
  causationRef: "recovery",
};

const bootstrap = (admitId: CommandId) =>
  Effect.gen(function* () {
    const gw = yield* CommandGateway;
    yield* gw.execute(
      admitEnvelope(admitId),
      { _tag: "System", principal, causationRef: "c" },
      admitAuthority(admitId),
    );
    const tx = yield* TransactionPort;
    const leases = yield* LeaseService;
    yield* tx.transact(leases.acquire(executionId, "worker:a", "inc-a"));
  });

const completed: SettleExecutionPayload["settlement"] = {
  _tag: "Completed",
  result: { _tag: "CoordinationCompleted" },
};

describe("P2-011 SettleExecution", () => {
  it("settles on the ExecutionOrigin path and emits ExecutionSettled", async () => {
    const app = makeApp();
    const admitId = parse(CommandId)(
      "cmd_018f2b3c-4d5e-7abc-8def-0123456789a1",
    );
    const settleId = parse(CommandId)(
      "cmd_018f2b3c-4d5e-7abc-8def-0123456789a2",
    );
    const payload = settlePayload(completed);
    const program = Effect.gen(function* () {
      yield* runMigrations(P12_MIGRATIONS);
      yield* seed;
      yield* bootstrap(admitId);
      const gw = yield* CommandGateway;
      const receipt = yield* gw.execute(
        settleEnvelope(settleId, payload),
        executionOrigin,
        settleAuthority(settleId, payload, "ExecutionOrigin"),
      );
      const sql = yield* SqlClient;
      const rows = yield* sql.unsafe<{ settlement_kind: string | null }>(
        "SELECT settlement_kind FROM executions WHERE execution_id = ?",
        [executionId],
      );
      return { receipt, kind: rows[0]?.settlement_kind };
    });
    const r = await Effect.runPromise(
      Effect.provide(program, app) as Effect.Effect<unknown, unknown, never>,
    );
    expect(
      (r as { receipt: { resolution: { _tag: string } } }).receipt.resolution
        ._tag,
    ).toBe("Committed");
    expect((r as { kind: string | null }).kind).toBe("Completed");
  });

  it("rejects a stale generation and admits a RecoveryController settle", async () => {
    const app = makeApp();
    const admitId = parse(CommandId)(
      "cmd_018f2b3c-4d5e-7abc-8def-0123456789a1",
    );
    const staleId = parse(CommandId)(
      "cmd_018f2b3c-4d5e-7abc-8def-0123456789a3",
    );
    const recoveryId = parse(CommandId)(
      "cmd_018f2b3c-4d5e-7abc-8def-0123456789a4",
    );
    const payload = settlePayload(completed);
    const program = Effect.gen(function* () {
      yield* runMigrations(P12_MIGRATIONS);
      yield* seed;
      yield* bootstrap(admitId);
      const gw = yield* CommandGateway;
      const stale = yield* gw.execute(
        settleEnvelope(staleId, payload),
        {
          _tag: "ExecutionOrigin",
          principal,
          executionId,
          fencingGeneration: 9 as never,
        },
        settleAuthority(staleId, payload, "ExecutionOrigin"),
      );
      const recovery = yield* gw.execute(
        settleEnvelope(recoveryId, payload),
        recoveryOrigin,
        settleAuthority(recoveryId, payload, "RecoveryController"),
      );
      return { stale, recovery };
    });
    const r = await Effect.runPromise(
      Effect.provide(program, app) as Effect.Effect<unknown, unknown, never>,
    );
    const stale = (
      r as { stale: { resolution: { _tag: string; error?: { _tag: string } } } }
    ).stale.resolution;
    expect(stale._tag).toBe("TerminalRejected");
    expect(stale.error?._tag).toBe("FencingRejected");
    const recovery = (r as { recovery: { resolution: { _tag: string } } })
      .recovery.resolution;
    expect(recovery._tag).toBe("Committed");
  });

  it("rejects malformed settlements as defects", async () => {
    const app = makeApp();
    const admitId = parse(CommandId)(
      "cmd_018f2b3c-4d5e-7abc-8def-0123456789a1",
    );
    const settleId = parse(CommandId)(
      "cmd_018f2b3c-4d5e-7abc-8def-0123456789a5",
    );
    const payload = settlePayload({
      _tag: "Completed",
      result: {
        _tag: "Yielded",
        reason: "r",
        waitSpec: { mode: "Any", conditions: [] },
      },
    });
    const program = Effect.gen(function* () {
      yield* runMigrations(P12_MIGRATIONS);
      yield* seed;
      yield* bootstrap(admitId);
      const gw = yield* CommandGateway;
      return yield* gw
        .execute(
          settleEnvelope(settleId, payload),
          executionOrigin,
          settleAuthority(settleId, payload, "ExecutionOrigin"),
        )
        .pipe(Effect.exit);
    });
    const exit = await Effect.runPromise(
      Effect.provide(program, app) as Effect.Effect<unknown, unknown, never>,
    );
    expect((exit as { _tag: string })._tag).toBe("Failure");
  });
});
