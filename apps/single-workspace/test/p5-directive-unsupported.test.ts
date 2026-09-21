import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  Actor,
  type CommandSubmissionContext,
  type Execution,
  ExecutionId,
  Principal,
  ProjectId,
  parse,
  SessionId,
  WorkspaceId,
} from "@arbor/domain";
import {
  ExecutionDriverPort,
  LeaseService,
  RuntimeSafetyGate,
  TransactionPort,
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
const principal = parse(Principal)("worker:a");
const actor = parse(Actor)("worker:a");

const directive = (tag: string, extra: Record<string, unknown> = {}) => ({
  _tag: "ToolCallProposed" as const,
  callRef: `c-${tag}`,
  toolName: "arbor_directive",
  argumentsJson: JSON.stringify({ _tag: tag, ...extra }),
});

const turns = [
  [
    directive("DeclareDependency", { spec: {} }), // P7 owns it; ProposeChildWorkspace is P6-live now
    { _tag: "TurnCompleted" as const, finishReason: "ToolCall" as const },
  ],
  [
    directive("Yield", {
      reason: "done",
      waitSpec: { mode: "Any", conditions: [{ _tag: "Manual" }] },
    }),
    { _tag: "TurnCompleted" as const, finishReason: "ToolCall" as const },
  ],
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
      yield* sql.unsafe(
        "INSERT INTO executions (execution_id, project_id, binding_kind, workspace_id, focus_kind, focus_work_id, parent_execution_id, mission, session_id, admitted_at, stop_requested_at, settlement_kind, settlement_json, settled_at) VALUES (?,?,?,?,?,NULL,NULL,NULL,?,?,NULL,NULL,NULL,NULL)",
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
const context: CommandSubmissionContext = {
  _tag: "ExecutionOrigin",
  principal,
  executionId,
  fencingGeneration: 0 as never,
};

describe("P5 DirectiveUnsupported", () => {
  it("returns a non-fatal DirectiveUnsupported observation and continues the loop", async () => {
    const dir = mkdtempSync(join(tmpdir(), "p5-du-"));
    const app = buildSliceLayer({
      databaseFile: join(dir, "slice.db"),
      providerTurns: turns,
    });
    const result = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          yield* runMigrations(P7_MIGRATIONS);
          yield* seed;
          const tx = yield* TransactionPort;
          const leases = yield* LeaseService;
          yield* tx.transact(leases.acquire(executionId, "worker:a"));
          const driver = yield* ExecutionDriverPort;
          const gate = yield* RuntimeSafetyGate;
          const settlement = yield* driver.drive({
            execution,
            agentExecutionState: {
              executionId,
              focus: { _tag: "Coordination" },
              wakeReason: { _tag: "WorkSelected" },
              currentMode: "execute",
              activeSkillRefs: [],
              turnNo: 0,
              recentDirectiveRefs: [],
              recentActionFingerprints: [],
              updatedAt: "t",
            },
            wakeReason: { _tag: "WorkSelected" },
            context,
            safetyGate: gate,
          });
          const sql = yield* SqlClient;
          const entries = yield* sql.unsafe<{ payload_json: string }>(
            "SELECT payload_json FROM session_entries WHERE session_id = ?",
            [sessionId],
          );
          return { settlement, entries: entries.map((e) => e.payload_json) };
        }),
        app,
      ) as unknown as Effect.Effect<
        {
          settlement: { _tag: string; result?: { _tag: string } };
          entries: ReadonlyArray<string>;
        },
        unknown,
        never
      >,
    );
    expect(result.settlement._tag).toBe("Completed");
    if (result.settlement._tag === "Completed") {
      expect(result.settlement.result?._tag).toBe("Yielded");
    }
    expect(
      result.entries.some((entry) => entry.includes("DirectiveUnsupported")),
    ).toBe(true);
    void actor;
  });
});
