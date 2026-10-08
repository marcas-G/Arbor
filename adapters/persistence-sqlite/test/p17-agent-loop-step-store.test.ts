import {
  type Execution,
  ExecutionId,
  ProjectId,
  ProviderTurnId,
  parse,
  SessionId,
  WorkspaceId,
} from "@arbor/domain";
import {
  AgentLoopStepStore,
  ExecutionRepository,
  TransactionPort,
} from "@arbor/ports";
import { Effect, Layer, Option } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { describe, expect, it } from "vitest";
import {
  AgentLoopStepStoreLive,
  ClockLive,
  ExecutionRepositoryLive,
  layer,
  P17_MIGRATIONS,
  P20_MIGRATIONS,
  runMigrations,
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
const providerTurnId = parse(ProviderTurnId)(
  "ptn_018f2b3c-4d5e-7abc-8def-0123456789a1",
);

const makeApp = () => {
  const base = layer({ filename: ":memory:" });
  const infra = Layer.mergeAll(base, ClockLive);
  return Layer.mergeAll(
    infra,
    Layer.provide(TransactionPortLive, infra),
    Layer.provide(ExecutionRepositoryLive, infra),
    Layer.provide(AgentLoopStepStoreLive, infra),
  );
};

const execution: Execution = {
  executionId,
  projectId,
  workspaceId,
  binding: {
    _tag: "WorkspaceExecution",
    workspaceId,
    focus: { _tag: "Coordination" },
  },
  sessionId,
  admittedAt: "t",
  stopRequestedAt: null,
  state: { status: "Active", settlement: null },
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

const fence = {
  executionId,
  workerId: "worker:a",
  workerIncarnationId: "inc-a",
  fencingGeneration: 0 as never,
};

const prepared = {
  identity: { executionId, logicalStepNo: 0, repairAttempt: 0 },
  providerTurnId,
  state: "Prepared" as const,
  nextActionIndex: 0,
  revision: 0,
  updatedAt: "t1",
};

describe("P17/P20 AgentLoopStepStore", () => {
  it("creates idempotently and advances by fenced state/revision CAS", async () => {
    const program = Effect.gen(function* () {
      yield* runMigrations(P17_MIGRATIONS);
      yield* seed;
      const tx = yield* TransactionPort;
      const executions = yield* ExecutionRepository;
      const steps = yield* AgentLoopStepStore;
      yield* tx.transact(executions.tryAdmitMainExecution(execution));
      yield* tx.transact(
        executions.tryAcquireLease(
          executionId,
          fence.workerId,
          fence.workerIncarnationId,
          "2999-01-01T00:00:00.000Z",
        ),
      );

      const first = yield* tx.transact(steps.createPrepared(prepared, fence));
      const replay = yield* tx.transact(steps.createPrepared(prepared, fence));
      const advanced = yield* tx.transact(
        steps.transition(
          {
            identity: prepared.identity,
            expectedRevision: 0,
            expectedState: "Prepared",
            next: {
              ...prepared,
              state: "ProviderResultAvailable",
              decoderVersion: "decoder-v1",
              revision: 1,
              updatedAt: "t2",
            },
          },
          fence,
        ),
      );
      const stale = yield* tx
        .transact(
          steps.transition(
            {
              identity: prepared.identity,
              expectedRevision: 0,
              expectedState: "Prepared",
              next: { ...prepared, revision: 1, updatedAt: "t3" },
            },
            fence,
          ),
        )
        .pipe(Effect.flip);
      const loaded = yield* tx.transact(steps.find(prepared.identity));
      return { first, replay, advanced, stale, loaded };
    });

    const result = await Effect.runPromise(Effect.provide(program, makeApp()));
    expect(result.first).toEqual(prepared);
    expect(result.replay).toEqual(prepared);
    expect(result.advanced.state).toBe("ProviderResultAvailable");
    expect((result.stale as { _tag: string })._tag).toBe(
      "AgentLoopStepInvariantConflict",
    );
    expect(Option.isSome(result.loaded)).toBe(true);
    if (Option.isSome(result.loaded)) {
      expect(result.loaded.value.revision).toBe(1);
    }
  });

  it("persists and advances an ordered action ledger", async () => {
    const program = Effect.gen(function* () {
      yield* runMigrations(P17_MIGRATIONS);
      yield* seed;
      const tx = yield* TransactionPort;
      const executions = yield* ExecutionRepository;
      const steps = yield* AgentLoopStepStore;
      yield* tx.transact(executions.tryAdmitMainExecution(execution));
      yield* tx.transact(
        executions.tryAcquireLease(
          executionId,
          fence.workerId,
          fence.workerIncarnationId,
          "2999-01-01T00:00:00.000Z",
        ),
      );
      yield* tx.transact(steps.createPrepared(prepared, fence));
      const pending = {
        identity: prepared.identity,
        actionIndex: 0,
        logicalActionId: `lac_${"a".repeat(64)}`,
        callRef: "call-1",
        routeKind: "Executable" as const,
        actionKind: "read",
        inputHash: "input-hash",
        state: "Pending" as const,
        revision: 0,
        updatedAt: "t2",
      };
      yield* tx.transact(steps.createAction(pending, fence));
      const applied = yield* tx.transact(
        steps.transitionAction(
          {
            identity: prepared.identity,
            actionIndex: 0,
            expectedRevision: 0,
            expectedState: "Pending",
            next: {
              ...pending,
              state: "Applied",
              resultRef: "result-1",
              observationSourceRef: "obs-1",
              revision: 1,
              updatedAt: "t3",
            },
          },
          fence,
        ),
      );
      const actions = yield* tx.transact(steps.listActions(prepared.identity));
      return { applied, actions };
    });

    const result = await Effect.runPromise(Effect.provide(program, makeApp()));
    expect(result.applied.state).toBe("Applied");
    expect(result.actions).toHaveLength(1);
    expect(result.actions[0]?.observationSourceRef).toBe("obs-1");
  });

  it("finds the unique P20 ProviderTurn link by its durable identity", async () => {
    const nativeTurnId = parse(ProviderTurnId)(
      "ptn_018f2b3c-4d5e-7abc-8def-0123456789a2",
    );
    const link = {
      identity: prepared.identity,
      overflowOrdinal: 0 as const,
      role: "OverflowCompaction" as const,
      providerTurnId: nativeTurnId,
      predecessorProviderTurnId: providerTurnId,
      contextEpoch: 0 as never,
      state: "SettledSuccess" as const,
      createdAt: "t2",
    };
    const program = Effect.gen(function* () {
      yield* runMigrations(P20_MIGRATIONS);
      yield* seed;
      const tx = yield* TransactionPort;
      const executions = yield* ExecutionRepository;
      const steps = yield* AgentLoopStepStore;
      yield* tx.transact(executions.tryAdmitMainExecution(execution));
      yield* tx.transact(
        executions.tryAcquireLease(
          executionId,
          fence.workerId,
          fence.workerIncarnationId,
          "2999-01-01T00:00:00.000Z",
        ),
      );
      yield* tx.transact(steps.createPrepared(prepared, fence));
      yield* tx.transact(steps.ensureProviderTurnLink(link, fence));
      const found = yield* tx.transact(
        steps.findProviderTurnLinkByProviderTurnId(nativeTurnId),
      );
      const missing = yield* tx.transact(
        steps.findProviderTurnLinkByProviderTurnId(
          parse(ProviderTurnId)("ptn_018f2b3c-4d5e-7abc-8def-0123456789a3"),
        ),
      );
      return { found, missing };
    });

    const result = await Effect.runPromise(Effect.provide(program, makeApp()));
    expect(Option.isSome(result.found)).toBe(true);
    if (Option.isSome(result.found)) expect(result.found.value).toEqual(link);
    expect(Option.isNone(result.missing)).toBe(true);
  });
});
