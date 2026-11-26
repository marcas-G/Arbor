// Shared scenario fixtures for the model-decision tests: the persisted rows
// (sessions/projects/workspaces/executions) and the in-memory execution
// state that `ModelDecisionService.forExecution` binds against. Extracted
// from tests/p11-controlbasis.test.ts when the assembly moved to the
// TestKit model-decision harness (test-effectiveness B3).
import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import type { AgentActionHandler } from "../../packages/agent-runtime/src/index.js";
import {
  type AgentExecutionState,
  type CommandSubmissionContext,
  type Execution,
  ExecutionId,
  Principal,
  ProjectId,
  parse,
  SessionId,
  WorkspaceId,
} from "../../packages/domain/dist/index.js";
import type {
  CanonicalProviderEvent,
  RuntimeSafetyGateService,
} from "../../packages/ports/src/index.js";
import { ensureLegacyProjectResourceSourceFixture } from "./legacy-project-resource-source.js";

export const projectId = parse(ProjectId)(
  "prj_018f2b3c-4d5e-7abc-8def-0123456789b1",
);
// Same project (anchor is project-scoped), one workspace per execution:
// the schema allows only one unsettled workspace-binding execution per workspace.
export const workspaceIds = [
  parse(WorkspaceId)("ws_018f2b3c-4d5e-7abc-8def-0123456789b1"),
  parse(WorkspaceId)("ws_018f2b3c-4d5e-7abc-8def-0123456789b2"),
] as const;
export const sessionIds = [
  parse(SessionId)("ses_018f2b3c-4d5e-7abc-8def-0123456789b1"),
  parse(SessionId)("ses_018f2b3c-4d5e-7abc-8def-0123456789b2"),
] as const;
export const executionIds = [
  parse(ExecutionId)("exe_018f2b3c-4d5e-7abc-8def-0123456789b1"),
  parse(ExecutionId)("exe_018f2b3c-4d5e-7abc-8def-0123456789b2"),
] as const;
export const principal = parse(Principal)("worker:a");

export const executionOf = (index: 0 | 1): Execution => ({
  executionId: executionIds[index],
  projectId,
  workspaceId: workspaceIds[index],
  binding: {
    _tag: "WorkspaceExecution",
    workspaceId: workspaceIds[index],
    episode: {
      _tag: "InboxEpisode",
      entryKey: `control-basis-${index}`,
      inputKind: "TestInput",
    },
  },
  sessionId: sessionIds[index],
  admittedAt: "t",
  stopRequestedAt: null,
  state: { status: "Active", settlement: null },
});

export const stateOf = (index: 0 | 1): AgentExecutionState => ({
  executionId: executionIds[index],
  episode: {
    _tag: "InboxEpisode",
    entryKey: `control-basis-${index}`,
    inputKind: "TestInput",
  },
  wakeReason: { _tag: "WorkSelected" },
  currentMode: "execute",
  activeSkillRefs: [],
  turnNo: 0,
  recentDirectiveRefs: [],
  recentActionFingerprints: [],
  updatedAt: "t",
});

export const contextOf = (index: 0 | 1): CommandSubmissionContext => ({
  _tag: "ExecutionOrigin",
  principal,
  executionId: executionIds[index],
  fencingGeneration: 0 as never,
});

export const allowGate: RuntimeSafetyGateService = {
  admitActivity: () => Effect.succeed("Continue" as const),
};

export const sendHandler: AgentActionHandler = {
  action: "SendMessage",
  handle: () =>
    Effect.succeed({
      _tag: "Settle",
      settlement: {
        _tag: "Completed",
        result: { _tag: "CoordinationCompleted" },
      },
    }),
};

export const sendMessageTurn = (
  body: string,
): ReadonlyArray<CanonicalProviderEvent> => [
  {
    _tag: "ToolCallProposed",
    callRef: "c1",
    toolName: "send_message",
    argumentsJson: JSON.stringify({
      kind: "Query",
      body,
      recipientWorkspaceId: String(workspaceIds[1]),
    }),
  },
  { _tag: "TurnCompleted", finishReason: "ToolCall" },
];

export const seed = Effect.gen(function* () {
  const sql = yield* SqlClient;
  yield* sql.withTransaction(
    Effect.gen(function* () {
      for (const [index, sessionId] of sessionIds.entries()) {
        yield* sql.unsafe(
          "INSERT INTO sessions (session_id, binding_kind, workspace_id, execution_id, context_epoch, created_at) VALUES (?,?,?,?,?,?)",
          [sessionId, "WorkspacePrimary", workspaceIds[index], null, 0, "t"],
        );
      }
      yield* sql.unsafe(
        "INSERT INTO projects (project_id, name, root_workspace_id, project_policy, project_policy_revision, default_configuration, environment_ref, lifecycle, revision, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
        [
          projectId,
          "p",
          workspaceIds[0],
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
      yield* ensureLegacyProjectResourceSourceFixture();
      for (const [index, workspaceId] of workspaceIds.entries()) {
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
            sessionIds[index],
            "{}",
            0,
            0,
            "Active",
            "t",
            "t",
          ],
        );
      }
      for (const [index, executionId] of executionIds.entries()) {
        yield* sql.unsafe(
          "INSERT INTO executions (execution_id, project_id, binding_kind, workspace_id, focus_kind, focus_work_id, parent_execution_id, mission, session_id, admitted_at, stop_requested_at, settlement_kind, settlement_json, settled_at) VALUES (?,?,?,?,?,NULL,NULL,NULL,?,?,NULL,NULL,NULL,NULL)",
          [
            executionId,
            projectId,
            "workspace",
            workspaceIds[index],
            "coordination",
            sessionIds[index],
            "t",
          ],
        );
        yield* sql.unsafe(
          "INSERT INTO execution_leases (execution_id, worker_id, generation, expires_at, updated_at) VALUES (?,?,?,?,?)",
          [executionId, "worker", 0, "9999-12-31T00:00:00.000Z", "t"],
        );
      }
    }),
  );
});
