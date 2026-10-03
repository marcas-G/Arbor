import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CommandGateway, semanticRequestFingerprint } from "@arbor/application";
import {
  Actor,
  CommandId,
  Principal,
  ProjectId,
  parse,
  SessionId,
  WorkspaceId,
} from "@arbor/domain";
import type { CanonicalProviderEvent } from "@arbor/ports";
import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildSingleWorkspaceLayer,
  CURRENT_MIGRATIONS,
  ProductionDaemonService,
  runMigrations,
} from "../src/index.js";

const projectId = parse(ProjectId)("prj_018f2b3c-4d5e-7abc-8def-0123456789e1");
const workspaceId = parse(WorkspaceId)(
  "ws_018f2b3c-4d5e-7abc-8def-0123456789e1",
);
const sessionId = parse(SessionId)("ses_018f2b3c-4d5e-7abc-8def-0123456789e1");
const messageId = "msg_018f2b3c-4d5e-7abc-8def-0123456789e1";
const human = parse(Principal)("user:mac-p1-approver");
const humanActor = parse(Actor)("user:mac-p1-approver");

const directories: string[] = [];

const assignTurn: ReadonlyArray<CanonicalProviderEvent> = [
  {
    _tag: "ToolCallProposed",
    callRef: "root-assign-call",
    toolName: "assign_work",
    argumentsJson: JSON.stringify({
      objective: "research a bounded strategy without live trading",
      why: "the user requested a durable research outcome",
      constraints: ["do not place real orders"],
      completionExpectation: "an evidence-backed research report",
      verificationMission: {
        goal: "verify the report and the no-trading constraint",
        criteria: [
          {
            criterionId: "report",
            requirement: "the report exists and cites evidence",
            required: true,
          },
        ],
        riskRequirements: ["no real order execution"],
      },
      reason: "start the bounded goal from the root conversation",
    }),
  },
  { _tag: "TurnCompleted", finishReason: "ToolCall" },
];

const finalTurn = (
  decision: "Approve" | "Reject",
): ReadonlyArray<CanonicalProviderEvent> => [
  {
    _tag: "TextDelta",
    text:
      decision === "Approve"
        ? "工作已创建，后续会异步执行并验证。"
        : "这次工作未获批准，因此没有创建。",
  },
  { _tag: "TurnCompleted", finishReason: "Stop" },
];

const seed = Effect.gen(function* () {
  const sql = yield* SqlClient;
  yield* sql.withTransaction(
    Effect.gen(function* () {
      yield* sql.unsafe(
        "INSERT INTO projects (project_id, name, root_workspace_id, project_policy, project_policy_revision, default_configuration, environment_ref, lifecycle, revision, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
        [
          projectId,
          "MAC-P1 root initiation",
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
          "root",
          JSON.stringify({
            purpose: "Own the project-level outcome.",
            ownedResponsibilities: [],
            obligations: [],
            includes: [],
            excludes: [],
            interfaces: [],
          }),
          0,
          JSON.stringify({ addresses: [] }),
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
        "INSERT INTO human_messages (message_id, project_id, root_workspace_id, human_principal, body_ref, command_id, fingerprint, state, claimed_by_execution_id, created_at, settled_at, response_body, attempt_no) VALUES (?,?,?,?,?,?,?,'Pending',NULL,?,NULL,NULL,0)",
        [
          messageId,
          projectId,
          workspaceId,
          human,
          "研究一个量化策略，不要真实下单",
          "cmd_018f2b3c-4d5e-7abc-8def-0123456789e1",
          "mac-p1-root-goal",
          "2026-10-04T00:00:00.000Z",
        ],
      );
      yield* sql.unsafe(
        "INSERT INTO conversation_response_jobs (message_id, project_id, root_workspace_id, state, active_execution_id, next_attempt_no, next_eligible_at, attention_reason, last_failure_class, last_failure_fingerprint, policy_version, response_body, response_execution_id, provider_reasoning_json, revision, created_at, updated_at) VALUES (?,?,?,'Queued',NULL,0,NULL,NULL,NULL,NULL,'conversation-retry-v1',NULL,NULL,NULL,0,?,?)",
        [
          messageId,
          projectId,
          workspaceId,
          "2026-10-04T00:00:00.000Z",
          "2026-10-04T00:00:00.000Z",
        ],
      );
    }),
  );
});

const scenario = (decision: "Approve" | "Reject") => {
  const directory = mkdtempSync(join(tmpdir(), "mac-p1-root-work-"));
  directories.push(directory);
  const app = buildSingleWorkspaceLayer({
    databaseFile: join(directory, "slice.db"),
    projectId,
    providerTurns: [assignTurn, finalTurn(decision)],
  });
  return Effect.runPromise(
    Effect.provide(
      Effect.gen(function* () {
        yield* runMigrations(CURRENT_MIGRATIONS);
        yield* seed;
        const daemon = yield* ProductionDaemonService;
        const sql = yield* SqlClient;

        yield* daemon.daemon.conversationTick;
        const pending = yield* sql.unsafe<{
          approval_id: string;
          revision: number;
          state: string;
          requested_at: string;
          expires_at: string;
        }>(
          "SELECT approval_id, revision, state, requested_at, expires_at FROM action_approvals WHERE route_kind = 'Control'",
        );
        const before = yield* sql.unsafe<{ n: number }>(
          "SELECT COUNT(*) AS n FROM works",
        );
        const approval = pending[0];
        if (approval === undefined) {
          return yield* Effect.die("root AssignWork produced no approval");
        }

        const commandId = parse(CommandId)(
          decision === "Approve"
            ? "cmd_018f2b3c-4d5e-7abc-8def-0123456789e2"
            : "cmd_018f2b3c-4d5e-7abc-8def-0123456789e3",
        );
        const payload = {
          approvalId: approval.approval_id,
          expectedRevision: approval.revision,
          decision,
          reason: `MAC-P1 ${decision.toLowerCase()} exact root Work`,
        };
        const gateway = yield* CommandGateway;
        const receipt = yield* gateway.execute(
          {
            commandType: "ResolveControlApproval",
            commandId,
            projectId,
            actor: humanActor,
            issuedAt: approval.requested_at,
            payload,
          },
          { _tag: "External", principal: human },
          {
            _tag: "ControlApprovalDecisionAuthority",
            principal: human,
            commandId,
            semanticRequestFingerprint: semanticRequestFingerprint({
              commandType: "ResolveControlApproval",
              projectId,
              actor: humanActor,
              schemaVersion: "1",
              payload,
            }),
            projectId,
            approvalId: approval.approval_id,
          },
        );
        if (receipt.resolution._tag !== "Committed") {
          return yield* Effect.die(
            `approval decision rejected: ${JSON.stringify(receipt.resolution)}`,
          );
        }

        yield* daemon.daemon.conversationTick;
        yield* daemon.daemon.conversationTick;

        const works = yield* sql.unsafe<{
          workspace_id: string;
          constraints: string;
          provenance: string;
        }>("SELECT workspace_id, constraints, provenance FROM works");
        const approvals = yield* sql.unsafe<{
          state: string;
          revision: number;
        }>(
          "SELECT state, revision FROM action_approvals WHERE route_kind = 'Control'",
        );
        const jobs = yield* sql.unsafe<{
          state: string;
          response_body: string | null;
        }>(
          "SELECT state, response_body FROM conversation_response_jobs WHERE message_id = ?",
          [messageId],
        );
        const deniedResults = yield* sql.unsafe<{ n: number }>(
          "SELECT COUNT(*) AS n FROM session_entries WHERE item_type = 'ControlResult' AND payload_json LIKE '%control_action_denied%'",
        );
        return {
          approvalBefore: approval,
          before: Number(before[0]?.n ?? -1),
          receipt: receipt.resolution,
          works,
          approvalAfter: approvals[0],
          job: jobs[0],
          deniedResults: Number(deniedResults[0]?.n ?? -1),
        };
      }),
      app,
    ),
  );
};

describe("MAC-P1 Root Conversation Work initiation", () => {
  it("pauses before mutation, approves, resumes the same run and creates one exact Work", async () => {
    const result = await scenario("Approve");
    expect(result.approvalBefore).toMatchObject({
      state: "Pending",
      revision: 0,
    });
    expect(result.before).toBe(0);
    expect(result.receipt).toMatchObject({ _tag: "Committed" });
    expect(result.works).toHaveLength(1);
    expect(result.works[0]?.workspace_id).toBe(workspaceId);
    expect(JSON.parse(result.works[0]?.constraints ?? "[]")).toContain(
      "do not place real orders",
    );
    expect(JSON.parse(result.works[0]?.provenance ?? "{}")).toEqual({
      predecessorWorkId: null,
      reason: "start the bounded goal from the root conversation",
    });
    expect(result.approvalAfter).toMatchObject({
      state: "Consumed",
      revision: 2,
    });
    expect(result.job).toMatchObject({ state: "Answered" });
    expect(result.job?.response_body).toContain("工作已创建");
  });

  it("rejects the exact action, returns useful feedback and creates no Work", async () => {
    const result = await scenario("Reject");
    expect(result.approvalBefore).toMatchObject({
      state: "Pending",
      revision: 0,
    });
    expect(result.before).toBe(0);
    expect(result.receipt).toMatchObject({ _tag: "Committed" });
    expect(result.works).toHaveLength(0);
    expect(result.approvalAfter).toMatchObject({
      state: "Rejected",
      revision: 1,
    });
    expect(result.deniedResults).toBe(1);
    expect(result.job).toMatchObject({ state: "Answered" });
    expect(result.job?.response_body).toContain("没有创建");
  });
});

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});
