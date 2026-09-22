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
  WorkWaitStoreLive,
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
  causationRef: "scheduler",
};

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
    Layer.provide(WorkWaitStoreLive, infra),
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

const payloadMain = (executionId: ExecutionId): AdmitExecutionPayload => ({
  _tag: "WorkspaceMain",
  executionId,
  workspaceId,
  focus: { _tag: "Coordination" },
});

const payloadBound = (
  executionId: ExecutionId,
  boundSession: SessionId,
): AdmitExecutionPayload => ({
  _tag: "ExecutionBound",
  executionId,
  workspaceId,
  parentExecutionId: parse(ExecutionId)(
    "exe_018f2b3c-4d5e-7abc-8def-0123456789a1",
  ) as ExecutionId,
  mission: "verify",
  sessionId: boundSession,
});

const envelope = (
  commandId: CommandId,
  payload: AdmitExecutionPayload,
): GatewayEnvelope<AdmitExecutionPayload> => ({
  commandType: "AdmitExecution",
  commandId,
  projectId,
  actor,
  issuedAt: "t",
  payload,
});

const authority = (
  commandId: CommandId,
  payload: AdmitExecutionPayload,
  overrides: Partial<VerifiedRuntimeCommandAuthority> = {},
): VerifiedRuntimeCommandAuthority =>
  ({
    _tag: "AdmitExecutionAuthority",
    submissionOrigin: "System",
    principal,
    commandId,
    semanticRequestFingerprint: semanticRequestFingerprint({
      commandType: "AdmitExecution",
      projectId,
      actor,
      schemaVersion: "1",
      payload,
    }),
    projectId,
    commandKind: "AdmitExecution",
    workspaceId: payload.workspaceId,
    bindingKind: payload._tag,
    ...overrides,
  }) as VerifiedRuntimeCommandAuthority;

const run = (program: Effect.Effect<unknown, unknown, never>) =>
  Effect.runPromise(program as Effect.Effect<unknown, never, never>);

describe("P2-009 AdmitExecution", () => {
  it("admits a WorkspaceMain execution and emits ExecutionAdmitted", async () => {
    const app = makeApp();
    const commandId = parse(CommandId)(
      "cmd_018f2b3c-4d5e-7abc-8def-0123456789a1",
    );
    const executionId = parse(ExecutionId)(
      "exe_018f2b3c-4d5e-7abc-8def-0123456789a1",
    ) as ExecutionId;
    const payload = payloadMain(executionId);
    const program = Effect.gen(function* () {
      yield* runMigrations(P2_MIGRATIONS);
      yield* seed;
      const gw = yield* CommandGateway;
      const receipt = yield* gw.execute(
        envelope(commandId, payload),
        systemContext,
        authority(commandId, payload),
      );
      const sql = yield* SqlClient;
      const rows = yield* sql.unsafe<{
        binding_kind: string;
        session_id: string;
      }>(
        "SELECT binding_kind, session_id FROM executions WHERE execution_id = ?",
        [executionId],
      );
      return { receipt, rows };
    });
    const r = await run(Effect.provide(program, app));
    const receipt = (r as { receipt: { resolution: { _tag: string } } })
      .receipt;
    expect(receipt.resolution._tag).toBe("Committed");
    expect(
      (r as { rows: ReadonlyArray<{ binding_kind: string }> }).rows[0]
        ?.binding_kind,
    ).toBe("workspace");
  });

  it("rejects a second active main with ActiveExecutionConflict", async () => {
    const app = makeApp();
    const program = Effect.gen(function* () {
      yield* runMigrations(P2_MIGRATIONS);
      yield* seed;
      const gw = yield* CommandGateway;
      const first = parse(CommandId)(
        "cmd_018f2b3c-4d5e-7abc-8def-0123456789a1",
      );
      const second = parse(CommandId)(
        "cmd_018f2b3c-4d5e-7abc-8def-0123456789a2",
      );
      const p1 = payloadMain(
        parse(ExecutionId)(
          "exe_018f2b3c-4d5e-7abc-8def-0123456789a1",
        ) as ExecutionId,
      );
      const p2 = payloadMain(
        parse(ExecutionId)(
          "exe_018f2b3c-4d5e-7abc-8def-0123456789a2",
        ) as ExecutionId,
      );
      yield* gw.execute(
        envelope(first, p1),
        systemContext,
        authority(first, p1),
      );
      return yield* gw.execute(
        envelope(second, p2),
        systemContext,
        authority(second, p2),
      );
    });
    const r = await run(Effect.provide(program, app));
    const receipt = (
      r as { resolution: { _tag: string; error?: { _tag: string } } }
    ).resolution;
    expect(receipt._tag).toBe("TerminalRejected");
    expect(receipt.error?._tag).toBe("ActiveExecutionConflict");
  });

  it("admits an ExecutionBound execution with an ExecutionScoped session", async () => {
    const app = makeApp();
    const commandId = parse(CommandId)(
      "cmd_018f2b3c-4d5e-7abc-8def-0123456789a3",
    );
    const boundSession = parse(SessionId)(
      "ses_018f2b3c-4d5e-7abc-8def-0123456789b1",
    );
    const payload = payloadBound(
      parse(ExecutionId)(
        "exe_018f2b3c-4d5e-7abc-8def-0123456789b1",
      ) as ExecutionId,
      boundSession,
    );
    const parentCommandId = parse(CommandId)(
      "cmd_018f2b3c-4d5e-7abc-8def-0123456789b9",
    );
    const parentPayload = payloadMain(
      parse(ExecutionId)(
        "exe_018f2b3c-4d5e-7abc-8def-0123456789a1",
      ) as ExecutionId,
    );
    const program = Effect.gen(function* () {
      yield* runMigrations(P2_MIGRATIONS);
      yield* seed;
      const gw = yield* CommandGateway;
      yield* gw.execute(
        envelope(parentCommandId, parentPayload),
        systemContext,
        authority(parentCommandId, parentPayload),
      );
      const receipt = yield* gw.execute(
        envelope(commandId, payload),
        systemContext,
        authority(commandId, payload),
      );
      const sql = yield* SqlClient;
      const rows = yield* sql.unsafe<{ binding_kind: string }>(
        "SELECT binding_kind FROM executions WHERE execution_id = ?",
        [payload._tag === "ExecutionBound" ? payload.executionId : ""],
      );
      const sessions = yield* sql.unsafe<{ count: number }>(
        "SELECT COUNT(*) AS count FROM sessions WHERE session_id = ?",
        [boundSession],
      );
      return { receipt, rows, sessions: Number(sessions[0]?.count ?? 0) };
    });
    const r = await run(Effect.provide(program, app));
    expect(
      (r as { receipt: { resolution: { _tag: string } } }).receipt.resolution
        ._tag,
    ).toBe("Committed");
    expect(
      (r as { rows: ReadonlyArray<{ binding_kind: string }> }).rows[0]
        ?.binding_kind,
    ).toBe("execution_bound");
    expect((r as { sessions: number }).sessions).toBe(1);
  });

  it("admits an ExecutionBound execution without a parent (M-3 inherited evolution)", async () => {
    const app = makeApp();
    const commandId = parse(CommandId)(
      "cmd_018f2b3c-4d5e-7abc-8def-0123456789a6",
    );
    const boundSession = parse(SessionId)(
      "ses_018f2b3c-4d5e-7abc-8def-0123456789c1",
    );
    const payload: AdmitExecutionPayload = {
      _tag: "ExecutionBound",
      executionId: parse(ExecutionId)(
        "exe_018f2b3c-4d5e-7abc-8def-0123456789c1",
      ) as ExecutionId,
      workspaceId,
      parentExecutionId: null,
      mission: "verify:digest",
      sessionId: boundSession,
    };
    const program = Effect.gen(function* () {
      yield* runMigrations(P2_MIGRATIONS);
      yield* seed;
      const gw = yield* CommandGateway;
      const receipt = yield* gw.execute(
        envelope(commandId, payload),
        systemContext,
        authority(commandId, payload),
      );
      const sql = yield* SqlClient;
      const rows = yield* sql.unsafe<{
        binding_kind: string;
        parent_execution_id: string | null;
      }>(
        "SELECT binding_kind, parent_execution_id FROM executions WHERE execution_id = ?",
        [payload._tag === "ExecutionBound" ? payload.executionId : ""],
      );
      return { receipt, rows };
    });
    const r = await run(Effect.provide(program, app));
    expect(
      (r as { receipt: { resolution: { _tag: string } } }).receipt.resolution
        ._tag,
    ).toBe("Committed");
    expect(
      (r as { rows: ReadonlyArray<{ parent_execution_id: string | null }> })
        .rows[0]?.parent_execution_id,
    ).toBeNull();
  });

  it("rejects a missing workspace and a mismatched authority", async () => {
    const app = makeApp();
    const commandId = parse(CommandId)(
      "cmd_018f2b3c-4d5e-7abc-8def-0123456789a4",
    );
    const payload = payloadMain(
      parse(ExecutionId)(
        "exe_018f2b3c-4d5e-7abc-8def-0123456789a4",
      ) as ExecutionId,
    );
    const program = Effect.gen(function* () {
      yield* runMigrations(P2_MIGRATIONS);
      yield* seed;
      const gw = yield* CommandGateway;
      const badAuthority = yield* gw.execute(
        envelope(commandId, payload),
        systemContext,
        authority(commandId, payload, {
          workspaceId: parse(WorkspaceId)(
            "ws_018f2b3c-4d5e-7abc-8def-0123456789ff",
          ),
        }),
      );
      const missing = payloadMain(
        parse(ExecutionId)(
          "exe_018f2b3c-4d5e-7abc-8def-0123456789a5",
        ) as ExecutionId,
      );
      const missingWorkspace = {
        ...missing,
        workspaceId: parse(WorkspaceId)(
          "ws_018f2b3c-4d5e-7abc-8def-0123456789ff",
        ),
      } as AdmitExecutionPayload;
      const missingCommandId = parse(CommandId)(
        "cmd_018f2b3c-4d5e-7abc-8def-0123456789a5",
      );
      const notFound = yield* gw.execute(
        envelope(missingCommandId, missingWorkspace),
        systemContext,
        authority(missingCommandId, missingWorkspace),
      );
      return { badAuthority, notFound };
    });
    const r = await run(Effect.provide(program, app));
    const bad = (
      r as {
        badAuthority: {
          resolution: { _tag: string; error?: { _tag: string } };
        };
      }
    ).badAuthority.resolution;
    expect(bad._tag).toBe("TerminalRejected");
    expect(bad.error?._tag).toBe("AuthorityDenied");
    const nf = (
      r as {
        notFound: { resolution: { _tag: string; error?: { _tag: string } } };
      }
    ).notFound.resolution;
    expect(nf._tag).toBe("TerminalRejected");
    expect(nf.error?._tag).toBe("WorkspaceNotFound");
  });
});
