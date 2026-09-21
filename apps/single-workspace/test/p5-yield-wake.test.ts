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
} from "@arbor/execution-runtime";
import {
  ExecutionScheduler,
  TransactionPort,
  WorkWaitStore,
} from "@arbor/ports";
import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { describe, expect, it } from "vitest";
import { buildSliceLayer, P7_MIGRATIONS, runMigrations } from "../src/index.js";

const projectId = parse(ProjectId)("prj_018f2b3c-4d5e-7abc-8def-0123456789a1");
const workspaceId = parse(WorkspaceId)(
  "ws_018f2b3c-4d5e-7abc-8def-0123456789a1",
);
const sessionId = parse(SessionId)("ses_018f2b3c-4d5e-7abc-8def-0123456789a1");
const executionId = parse(ExecutionId)(
  "exe_018f2b3c-4d5e-7abc-8def-0123456789a1",
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

const admit = (commandId: CommandId) =>
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

describe("P5 Yield -> WorkWait -> wake", () => {
  it("registers a durable WorkWait on Yield and blocks re-admission until cleared", async () => {
    const dir = mkdtempSync(join(tmpdir(), "p5-yw-"));
    const app = buildSliceLayer({
      databaseFile: join(dir, "slice.db"),
      providerTurns: [yieldTurn],
    });
    const result = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          yield* runMigrations(P7_MIGRATIONS);
          yield* seed;
          yield* admit(
            parse(CommandId)("cmd_018f2b3c-4d5e-7abc-8def-0123456789a1"),
          );
          const settlement = yield* runExecution(
            executionId,
            { _tag: "WorkSelected" },
            principal,
          );
          const sql = yield* SqlClient;
          const waits = yield* sql.unsafe<{ work_id: string }>(
            "SELECT work_id FROM work_waits",
          );
          const scheduler = yield* ExecutionScheduler;
          const blocked = yield* scheduler.reevaluate(workspaceId, {
            _tag: "Recovery",
          });
          const tx = yield* TransactionPort;
          const waitStore = yield* WorkWaitStore;
          yield* tx.transact(waitStore.clear(workId));
          const woken = yield* scheduler.reevaluate(workspaceId, {
            _tag: "Recovery",
          });
          return {
            settlement,
            waits: waits.map((w) => w.work_id),
            blocked: blocked._tag,
            woken: woken._tag,
          };
        }),
        app,
      ) as unknown as Effect.Effect<
        {
          settlement: { _tag: string; result?: { _tag: string } };
          waits: ReadonlyArray<string>;
          blocked: string;
          woken: string;
        },
        unknown,
        never
      >,
    );
    expect(result.settlement._tag).toBe("Completed");
    if (result.settlement._tag === "Completed") {
      expect(result.settlement.result?._tag).toBe("Yielded");
    }
    expect(result.waits).toEqual([workId]);
    expect(result.blocked).toBe("Idle");
    expect(result.woken).toBe("Admit");
  });
});
