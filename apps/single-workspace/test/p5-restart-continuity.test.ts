import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CommandGateway,
  semanticRequestFingerprint,
  type VerifiedRuntimeCommandAuthority,
} from "@arbor/application";
import {
  Actor,
  CommandId,
  type CommandSubmissionContext,
  ExecutionId,
  Principal,
  ProjectId,
  parse,
  SessionId,
  WorkId,
  WorkspaceId,
} from "@arbor/domain";
import {
  type AdmitExecutionPayload,
  runExecution,
  runRecovery,
} from "@arbor/execution-runtime";
import { SessionRepository, TransactionPort } from "@arbor/ports";
import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { describe, expect, it } from "vitest";
import { buildSliceLayer, P7_MIGRATIONS, runMigrations } from "../src/index.js";

const projectId = parse(ProjectId)("prj_018f2b3c-4d5e-7abc-8def-0123456789a1");
const workspaceId = parse(WorkspaceId)(
  "ws_018f2b3c-4d5e-7abc-8def-0123456789a1",
);
const sessionId = parse(SessionId)("ses_018f2b3c-4d5e-7abc-8def-0123456789a1");
const exe1 = parse(ExecutionId)(
  "exe_018f2b3c-4d5e-7abc-8def-0123456789a1",
) as ExecutionId;
const exe2 = parse(ExecutionId)(
  "exe_018f2b3c-4d5e-7abc-8def-0123456789a2",
) as ExecutionId;
const exe3 = parse(ExecutionId)(
  "exe_018f2b3c-4d5e-7abc-8def-0123456789a3",
) as ExecutionId;
const workId = parse(WorkId)("wrk_018f2b3c-4d5e-7abc-8def-0123456789a1");
const principal = parse(Principal)("worker:a");
const actor = parse(Actor)("user:test");
const context: CommandSubmissionContext = {
  _tag: "System",
  principal,
  causationRef: "c",
};

const yieldTurn = [
  {
    _tag: "ToolCallProposed" as const,
    callRef: "c1",
    toolName: "arbor_directive",
    argumentsJson: JSON.stringify({
      _tag: "Yield",
      reason: "waiting",
      waitSpec: { mode: "Any", conditions: [{ _tag: "Manual" }] },
    }),
  },
  { _tag: "TurnCompleted" as const, finishReason: "ToolCall" as const },
];

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
        "INSERT INTO workspaces (workspace_id, project_id, parent_workspace_id, name, responsibility_definition, responsibility_revision, resource_boundary, resource_boundary_revision, agent_binding, primary_session_id, current_work_id, workspace_policy, workspace_policy_revision, revision, lifecycle, created_at, updated_at) VALUES (?,?,NULL,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
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
          workId,
          "{}",
          0,
          0,
          "Active",
          "t",
          "t",
        ],
      );
      yield* sql.unsafe(
        "INSERT INTO works (work_id, project_id, workspace_id, objective, why, constraints, completion_expectation, verification_mission, provenance, lifecycle, revision, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
        [
          workId,
          projectId,
          workspaceId,
          "o",
          "w",
          "[]",
          "done",
          "{}",
          "{}",
          "Open",
          0,
          "t",
          "t",
        ],
      );
    }),
  );
});

const admit = (executionId: ExecutionId, commandId: CommandId) =>
  Effect.gen(function* () {
    const gateway = yield* CommandGateway;
    const payload: AdmitExecutionPayload = {
      _tag: "WorkspaceMain",
      executionId,
      workspaceId,
      focus: { _tag: "Work", workId },
    };
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
        payload,
      }),
      projectId,
      commandKind: "AdmitExecution",
      workspaceId,
      bindingKind: "WorkspaceMain",
    };
    return yield* gateway.execute(
      {
        commandType: "AdmitExecution",
        commandId,
        projectId,
        actor,
        issuedAt: "t",
        payload,
      },
      context,
      authority,
    );
  });

const readState = Effect.gen(function* () {
  const sql = yield* SqlClient;
  const executions = yield* sql.unsafe<{
    execution_id: string;
    settlement_kind: string | null;
    session_id: string;
  }>(
    "SELECT execution_id, settlement_kind, session_id FROM executions ORDER BY execution_id",
  );
  const waits = yield* sql.unsafe<{ count: number }>(
    "SELECT COUNT(*) AS count FROM work_waits",
  );
  const entries = yield* sql.unsafe<{ count: number }>(
    "SELECT COUNT(*) AS count FROM session_entries",
  );
  return {
    executions,
    waits: Number(waits[0]?.count ?? 0),
    entries: Number(entries[0]?.count ?? 0),
  };
});

describe("P5 restart continuity", () => {
  it("a fresh layer on the same database recovers and continues the session", async () => {
    const dir = mkdtempSync(join(tmpdir(), "p5-restart-"));
    const databaseFile = join(dir, "slice.db");
    const turns = [yieldTurn];

    const before = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          yield* runMigrations(P7_MIGRATIONS);
          yield* seed;
          yield* admit(
            exe1,
            parse(CommandId)("cmd_018f2b3c-4d5e-7abc-8def-0123456789a1"),
          );
          yield* runExecution(exe1, { _tag: "WorkSelected" }, principal);
          yield* admit(
            exe2,
            parse(CommandId)("cmd_018f2b3c-4d5e-7abc-8def-0123456789a2"),
          );
          const sql = yield* SqlClient;
          yield* sql.unsafe(
            "UPDATE executions SET stop_requested_at = 't' WHERE execution_id = ?",
            [exe2],
          );
          const tx = yield* TransactionPort;
          const sessions = yield* SessionRepository;
          yield* tx.transact(
            sessions.appendEntry(sessionId, {
              entryKind: "Input",
              payload: { x: 1 },
            }),
          );
          return yield* readState;
        }),
        buildSliceLayer({ databaseFile, providerTurns: turns }),
      ) as unknown as Effect.Effect<
        {
          executions: ReadonlyArray<{
            execution_id: string;
            settlement_kind: string | null;
          }>;
          waits: number;
          entries: number;
        },
        unknown,
        never
      >,
    );

    const after = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const recovery = yield* runRecovery(principal);
          yield* admit(
            exe3,
            parse(CommandId)("cmd_018f2b3c-4d5e-7abc-8def-0123456789a3"),
          );
          const state = yield* readState;
          return { recovery, state };
        }),
        buildSliceLayer({ databaseFile }),
      ) as unknown as Effect.Effect<
        {
          recovery: { invalidated: number; settled: ReadonlyArray<string> };
          state: {
            executions: ReadonlyArray<{
              execution_id: string;
              settlement_kind: string | null;
              session_id: string;
            }>;
            waits: number;
            entries: number;
          };
        },
        unknown,
        never
      >,
    );

    const kind = (id: string) =>
      after.state.executions.find((e) => e.execution_id === id)
        ?.settlement_kind;
    expect(
      before.executions.find((e) => e.execution_id === exe1)?.settlement_kind,
    ).toBe("Completed");
    expect(before.waits).toBe(1);
    expect(before.entries).toBe(2);
    expect(after.recovery.settled).toContain(exe2);
    expect(kind(exe2)).toBe("Interrupted");
    expect(kind(exe3)).toBeNull();
    expect(after.state.waits).toBe(1);
    expect(after.state.entries).toBe(2);
    expect(new Set(after.state.executions.map((e) => e.session_id))).toEqual(
      new Set([sessionId]),
    );
  });
});
