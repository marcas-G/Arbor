import {
  type Execution,
  ExecutionId,
  ProjectId,
  parse,
  SessionId,
  WorkspaceId,
} from "@arbor/domain";
import {
  ExecutionRepository,
  SessionRepository,
  TransactionPort,
} from "@arbor/ports";
import { Effect, Layer, Option } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { describe, expect, it } from "vitest";
import {
  ClockLive,
  ExecutionRepositoryLive,
  layer,
  P19_MIGRATIONS,
  runMigrations,
  SessionRepositoryLive,
  TransactionPortLive,
} from "../src/index.js";

const projectId = parse(ProjectId)("prj_018f2b3c-4d5e-7abc-8def-0123456789b1");
const workspaceId = parse(WorkspaceId)(
  "ws_018f2b3c-4d5e-7abc-8def-0123456789b1",
);
const sessionId = parse(SessionId)("ses_018f2b3c-4d5e-7abc-8def-0123456789b1");
const executionId = parse(ExecutionId)(
  "exe_018f2b3c-4d5e-7abc-8def-0123456789b1",
) as ExecutionId;

const app = () => {
  const base = layer({ filename: ":memory:" });
  const infra = Layer.mergeAll(base, ClockLive);
  return Layer.mergeAll(
    infra,
    Layer.provide(TransactionPortLive, infra),
    Layer.provide(ExecutionRepositoryLive, infra),
    Layer.provide(SessionRepositoryLive, infra),
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
        "INSERT INTO sessions (session_id, binding_kind, workspace_id, execution_id, context_epoch, created_at) VALUES (?,?,?,NULL,0,?)",
        [sessionId, "WorkspacePrimary", workspaceId, "t"],
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

describe("SCRC typed Session store", () => {
  it("idempotently appends typed items and returns the active frontier", async () => {
    const program = Effect.gen(function* () {
      yield* runMigrations(P19_MIGRATIONS);
      yield* seed;
      const tx = yield* TransactionPort;
      const executions = yield* ExecutionRepository;
      const sessions = yield* SessionRepository;
      yield* tx.transact(executions.tryAdmitMainExecution(execution));
      yield* tx.transact(
        executions.tryAcquireLease(
          executionId,
          "worker:scrc",
          "inc:scrc",
          "2999-01-01T00:00:00.000Z",
        ),
      );
      const fence = {
        executionId,
        workerId: "worker:scrc",
        workerIncarnationId: "inc:scrc",
        fencingGeneration: 0 as never,
      };
      const write = {
        item: {
          _tag: "UserMessage" as const,
          source: {
            _tag: "InboxEntry" as const,
            workspaceId,
            entryKey: "msg:one",
            kind: "Message" as const,
          },
          contentRef: "inbox:msg:one",
          text: "hello",
          trust: "DataOnly" as const,
          delivery: "Queue" as const,
        },
        contextEpoch: 0 as never,
        source: { kind: "InboxEntry", ref: "msg:one" },
        contentHash: "hash-one",
      };
      const first = yield* tx.transact(
        sessions.appendItemIdempotent(sessionId, write, fence),
      );
      const replay = yield* tx.transact(
        sessions.appendItemIdempotent(sessionId, write, fence),
      );
      const conflict = yield* tx
        .transact(
          sessions.appendItemIdempotent(
            sessionId,
            { ...write, contentHash: "hash-changed" },
            fence,
          ),
        )
        .pipe(Effect.flip);
      const frontier = yield* tx.transact(
        sessions.listActiveFrontier(sessionId, 0 as never, 20),
      );
      return { first, replay, conflict, frontier };
    });

    const result = await Effect.runPromise(Effect.provide(program, app()));
    expect(result.first).toEqual({ sequence: 0, inserted: true });
    expect(result.replay).toEqual({ sequence: 0, inserted: false });
    expect((result.conflict as { _tag: string })._tag).toBe(
      "SessionSourceConflict",
    );
    expect(result.frontier).toHaveLength(1);
    expect(result.frontier[0]).toMatchObject({
      itemType: "UserMessage",
      schemaVersion: 2,
      contextEpoch: 0,
      item: { _tag: "UserMessage", text: "hello" },
    });
  });

  it("atomically commits a checkpoint and epoch with idempotent replay", async () => {
    const program = Effect.gen(function* () {
      yield* runMigrations(P19_MIGRATIONS);
      yield* seed;
      const tx = yield* TransactionPort;
      const executions = yield* ExecutionRepository;
      const sessions = yield* SessionRepository;
      yield* tx.transact(executions.tryAdmitMainExecution(execution));
      yield* tx.transact(
        executions.tryAcquireLease(
          executionId,
          "worker:scrc",
          "inc:scrc",
          "2999-01-01T00:00:00.000Z",
        ),
      );
      const fence = {
        executionId,
        workerId: "worker:scrc",
        workerIncarnationId: "inc:scrc",
        fencingGeneration: 0 as never,
      };
      const input = {
        expectedEpoch: 0 as never,
        nextEpoch: 1 as never,
        checkpoint: {
          _tag: "CompactionCheckpoint" as const,
          implementation: "Summary" as const,
          fromEpoch: 0 as never,
          toEpoch: 1 as never,
          retainedFrontierRef: "frontier:0:10",
          summaryRef: "blob:summary-1",
          bindingFingerprint: null,
        },
        source: { kind: "CompactionTurn", ref: "ptn:compact-1" },
        contentHash: "hash-checkpoint",
      };
      const first = yield* tx.transact(
        sessions.commitCompaction(sessionId, input, fence),
      );
      const replay = yield* tx.transact(
        sessions.commitCompaction(sessionId, input, fence),
      );
      const loaded = yield* tx.transact(sessions.findById(sessionId));
      return { first, replay, loaded };
    });

    const result = await Effect.runPromise(Effect.provide(program, app()));
    expect(result.first).toEqual({ sequence: 0, inserted: true, newEpoch: 1 });
    expect(result.replay).toEqual({
      sequence: 0,
      inserted: false,
      newEpoch: 1,
    });
    expect(Option.isSome(result.loaded)).toBe(true);
    if (Option.isSome(result.loaded)) {
      expect(result.loaded.value.contextEpoch).toBe(1);
    }
  });
});
