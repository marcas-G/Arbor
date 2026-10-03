import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { newUuid7 } from "@arbor/application";
import {
  ExecutionId,
  Principal,
  ProjectId,
  parse,
  SessionId,
  WorkId,
  WorkspaceId,
} from "@arbor/domain";
import { runExecution } from "@arbor/execution-runtime";
import type { CanonicalProviderEvent } from "@arbor/ports";
import { BlobStorePort } from "@arbor/ports";
import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { describe, expect, it } from "vitest";
import {
  admitExecution,
  buildSingleWorkspaceLayer,
  CURRENT_MIGRATIONS,
  runMigrations,
} from "../src/index.js";

const projectId = parse(ProjectId)("prj_018f2b3c-4d5e-7abc-8def-0123456789c1");
const parentWorkspaceId = parse(WorkspaceId)(
  "ws_018f2b3c-4d5e-7abc-8def-0123456789c1",
);
const childWorkspaceId = parse(WorkspaceId)(
  "ws_018f2b3c-4d5e-7abc-8def-0123456789c2",
);
const parentSessionId = parse(SessionId)(
  "ses_018f2b3c-4d5e-7abc-8def-0123456789c1",
);
const childSessionId = parse(SessionId)(
  "ses_018f2b3c-4d5e-7abc-8def-0123456789c2",
);
const workId = parse(WorkId)("wrk_018f2b3c-4d5e-7abc-8def-0123456789c1");
const parentWorkId = parse(WorkId)("wrk_018f2b3c-4d5e-7abc-8def-0123456789c2");
const executionId = parse(ExecutionId)(
  "exe_018f2b3c-4d5e-7abc-8def-0123456789c1",
);
const parentExecutionId = parse(ExecutionId)(
  "exe_018f2b3c-4d5e-7abc-8def-0123456789c2",
);
const principal = parse(Principal)("worker:i0");
const body = "The requested analysis is complete.";
const invalidRootReportBody = "root-report-must-fail-closed-i0-20260927";

interface DurableIntegrationResult {
  readonly settlement: {
    readonly _tag: string;
    readonly result?: { readonly _tag: string };
  };
  readonly invalidSettlement: { readonly _tag: string };
  readonly invalidControlResult: string;
  readonly message:
    | {
        readonly message_id: string;
        readonly sender_workspace_id: string;
        readonly recipient_workspace_id: string;
        readonly kind: string;
        readonly body_ref: string;
        readonly correlation_id: string | null;
      }
    | undefined;
  readonly messageCount: number;
  readonly inbox: ReadonlyArray<{
    readonly workspace_id: string;
    readonly entry_key: string;
    readonly kind: string;
  }>;
  readonly sentEvents: ReadonlyArray<{
    readonly event_type: string;
    readonly caused_by_command_id: string | null;
  }>;
  readonly toolInvocations: ReadonlyArray<{ readonly invocation_id: string }>;
  readonly providerTurnId: string | undefined;
  readonly content: string;
  readonly invalidBodyLookup: string;
}

const reportTurn: ReadonlyArray<CanonicalProviderEvent> = [
  {
    _tag: "ToolCallProposed",
    callRef: "report-call",
    toolName: "send_message",
    argumentsJson: JSON.stringify({ kind: "Report", body }),
  },
  { _tag: "TurnCompleted", finishReason: "ToolCall" },
];

const waitTurn: ReadonlyArray<CanonicalProviderEvent> = [
  {
    _tag: "ToolCallProposed",
    callRef: "wait-call",
    toolName: "wait",
    argumentsJson: JSON.stringify({
      reason: "Report submitted; wait for a wake.",
      waitSpec: { mode: "Any", conditions: [{ _tag: "Manual" }] },
    }),
  },
  { _tag: "TurnCompleted", finishReason: "ToolCall" },
];

const invalidRootReportTurn: ReadonlyArray<CanonicalProviderEvent> = [
  {
    _tag: "ToolCallProposed",
    callRef: "root-report-call",
    toolName: "send_message",
    argumentsJson: JSON.stringify({
      kind: "Report",
      body: invalidRootReportBody,
    }),
  },
  { _tag: "TurnCompleted", finishReason: "ToolCall" },
];

const rootRecoveryWaitTurn: ReadonlyArray<CanonicalProviderEvent> = [
  {
    _tag: "ToolCallProposed",
    callRef: "root-recovery-wait-call",
    toolName: "wait",
    argumentsJson: JSON.stringify({
      reason: "No parent target exists; wait for explicit coordination input.",
      waitSpec: { mode: "Any", conditions: [{ _tag: "Manual" }] },
    }),
  },
  { _tag: "TurnCompleted", finishReason: "ToolCall" },
];

describe("I0 SendMessage durable integration", () => {
  it("persists valid SendMessage and returns an invalid root Report to the agent as useful feedback", async () => {
    const root = mkdtempSync(join(tmpdir(), "i0-send-message-durable-"));
    const app = buildSingleWorkspaceLayer({
      databaseFile: join(root, "slice.db"),
      providerTurns: [
        reportTurn,
        waitTurn,
        invalidRootReportTurn,
        rootRecoveryWaitTurn,
      ],
    });

    const result = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          yield* runMigrations(CURRENT_MIGRATIONS);
          const sql = yield* SqlClient;
          yield* sql.withTransaction(
            Effect.gen(function* () {
              yield* sql.unsafe(
                "INSERT INTO projects (project_id, name, root_workspace_id, project_policy, project_policy_revision, default_configuration, environment_ref, lifecycle, revision, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
                [
                  projectId,
                  "I0 communication",
                  parentWorkspaceId,
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
                [
                  parentSessionId,
                  "WorkspacePrimary",
                  parentWorkspaceId,
                  0,
                  "t",
                ],
              );
              yield* sql.unsafe(
                "INSERT INTO sessions (session_id, binding_kind, workspace_id, execution_id, context_epoch, created_at) VALUES (?,?,?,NULL,?,?)",
                [childSessionId, "WorkspacePrimary", childWorkspaceId, 0, "t"],
              );
              yield* sql.unsafe(
                "INSERT INTO workspaces (workspace_id, project_id, parent_workspace_id, name, responsibility_definition, responsibility_revision, resource_boundary, resource_boundary_revision, agent_binding, primary_session_id, current_work_id, workspace_policy, workspace_policy_revision, revision, lifecycle, created_at, updated_at) VALUES (?,?,NULL,?,?,?,?,?,?,?,NULL,?,?,?,?,?,?)",
                [
                  parentWorkspaceId,
                  projectId,
                  "parent",
                  "{}",
                  0,
                  "{}",
                  0,
                  "{}",
                  parentSessionId,
                  "{}",
                  0,
                  0,
                  "Active",
                  "t",
                  "t",
                ],
              );
              yield* sql.unsafe(
                "INSERT INTO workspaces (workspace_id, project_id, parent_workspace_id, name, responsibility_definition, responsibility_revision, resource_boundary, resource_boundary_revision, agent_binding, primary_session_id, current_work_id, workspace_policy, workspace_policy_revision, revision, lifecycle, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                [
                  childWorkspaceId,
                  projectId,
                  parentWorkspaceId,
                  "child",
                  "{}",
                  0,
                  "{}",
                  0,
                  "{}",
                  childSessionId,
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
                  childWorkspaceId,
                  "Report a finding",
                  "I0 durable communication",
                  "[]",
                  "Report sent",
                  "{}",
                  "{}",
                  "Open",
                  0,
                  "t",
                  "t",
                ],
              );
              yield* sql.unsafe(
                "INSERT INTO works (work_id, project_id, workspace_id, objective, why, constraints, completion_expectation, verification_mission, provenance, lifecycle, revision, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
                [
                  parentWorkId,
                  projectId,
                  parentWorkspaceId,
                  "Handle child reports",
                  "I0 fail-closed integration",
                  "[]",
                  "Report received",
                  "{}",
                  "{}",
                  "Open",
                  0,
                  "t",
                  "t",
                ],
              );
              yield* sql.unsafe(
                "UPDATE workspaces SET current_work_id = ? WHERE workspace_id = ?",
                [parentWorkId, parentWorkspaceId],
              );
            }),
          );

          yield* admitExecution(
            childWorkspaceId,
            executionId,
            { _tag: "Work", workId },
            principal,
          );
          const settlement = yield* runExecution(
            executionId,
            { _tag: "WorkSelected" },
            principal,
          );
          yield* admitExecution(
            parentWorkspaceId,
            parentExecutionId,
            { _tag: "Work", workId: parentWorkId },
            principal,
          );
          const invalidSettlement = yield* runExecution(
            parentExecutionId,
            { _tag: "WorkSelected" },
            principal,
          );

          const messages = yield* sql.unsafe<{
            message_id: string;
            sender_workspace_id: string;
            recipient_workspace_id: string;
            kind: string;
            body_ref: string;
            correlation_id: string | null;
          }>("SELECT * FROM messages");
          const inbox = yield* sql.unsafe<{
            workspace_id: string;
            entry_key: string;
            kind: string;
          }>("SELECT workspace_id, entry_key, kind FROM inbox_entries");
          const sentEvents = yield* sql.unsafe<{
            event_type: string;
            caused_by_command_id: string | null;
          }>(
            "SELECT event_type, caused_by_command_id FROM domain_events WHERE event_type = 'MessageSent'",
          );
          const toolInvocations = yield* sql.unsafe<{ invocation_id: string }>(
            "SELECT invocation_id FROM tool_invocations",
          );
          const turns = yield* sql.unsafe<{ provider_turn_id: string }>(
            "SELECT provider_turn_id FROM provider_turns ORDER BY started_at",
          );
          const invalidControlResults = yield* sql.unsafe<{
            payload_json: string;
          }>(
            "SELECT payload_json FROM session_entries WHERE session_id = ? AND item_type = 'ControlResult' ORDER BY sequence",
            [parentSessionId],
          );
          const message = messages[0];
          const content = yield* (yield* BlobStorePort).get(
            message?.body_ref ?? "",
          );
          const invalidBodyLookup = yield* Effect.exit(
            (yield* BlobStorePort).get(
              createHash("sha256").update(invalidRootReportBody).digest("hex"),
            ),
          );
          return {
            settlement,
            invalidSettlement,
            invalidControlResult:
              invalidControlResults[0]?.payload_json ?? "{}",
            message,
            messageCount: messages.length,
            inbox,
            sentEvents,
            toolInvocations,
            providerTurnId: turns[0]?.provider_turn_id,
            content: new TextDecoder().decode(content),
            invalidBodyLookup: invalidBodyLookup._tag,
          };
        }),
        app,
      ) as unknown as Effect.Effect<DurableIntegrationResult, unknown, never>,
    );

    expect(result.settlement).toMatchObject({
      _tag: "Completed",
      result: { _tag: "Yielded" },
    });
    expect(result.invalidSettlement).toMatchObject({
      _tag: "Completed",
      result: { _tag: "Yielded" },
    });
    expect(JSON.parse(result.invalidControlResult)).toMatchObject({
      _tag: "ControlResult",
      callRef: "root-report-call",
      status: "Failed",
      disposition: "ModelUsable:action/not-applicable",
      outputText: expect.stringContaining("no parent target"),
    });
    expect(result.invalidBodyLookup).toBe("Failure");
    expect(result.messageCount).toBe(1);
    expect(result.message).toMatchObject({
      sender_workspace_id: childWorkspaceId,
      recipient_workspace_id: parentWorkspaceId,
      kind: "Report",
      correlation_id: null,
    });
    expect(result.content).toBe(body);
    expect(result.message?.body_ref).toMatch(/^[a-f0-9]{64}$/);
    expect(result.inbox).toEqual([
      {
        workspace_id: parentWorkspaceId,
        entry_key: `msg:${result.message?.message_id}`,
        kind: "Message",
      },
    ]);
    expect(result.sentEvents).toHaveLength(1);
    const occurrence = `${result.providerTurnId}:0`;
    expect(result.message?.message_id).toBe(
      `msg_${newUuid7("send-message-message", occurrence)}`,
    );
    expect(result.sentEvents[0]?.caused_by_command_id).toBe(
      `cmd_${newUuid7("send-message-command", occurrence)}`,
    );
    expect(result.toolInvocations).toEqual([]);
  });
});
