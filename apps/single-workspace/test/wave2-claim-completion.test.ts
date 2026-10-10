import { mkdtempSync, rmSync } from "node:fs";
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
import { Clock, TransactionPort, WorkspaceRepository } from "@arbor/ports";
import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { afterEach, describe, expect, it } from "vitest";
import { assignWorkHandler } from "../src/control-actions.js";
import {
  buildSingleWorkspaceLayer,
  CURRENT_MIGRATIONS,
  runMigrations,
} from "../src/index.js";

const ids = {
  project: "prj_018f2b3c-4d5e-7abc-8def-0123456789b2",
  workspace: "ws_018f2b3c-4d5e-7abc-8def-0123456789b2",
  session: "ses_018f2b3c-4d5e-7abc-8def-0123456789b2",
  execution: "exe_018f2b3c-4d5e-7abc-8def-0123456789b2",
  work: "wrk_018f2b3c-4d5e-7abc-8def-0123456789b2",
  command: "cmd_018f2b3c-4d5e-7abc-8def-0123456789b2",
} as const;

const projectId = parse(ProjectId)(ids.project);
const workspaceId = parse(WorkspaceId)(ids.workspace);
const sessionId = parse(SessionId)(ids.session);
const executionId = parse(ExecutionId)(ids.execution);
const workId = parse(WorkId)(ids.work);
const principal = parse(Principal)("worker:a");
const actor = parse(Actor)("user:test");
const context: CommandSubmissionContext = {
  _tag: "System",
  principal,
  causationRef: "c",
};

const directories: string[] = [];

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
      yield* sql.unsafe(
        "INSERT INTO permission_grants (permission_grant_id, project_id, scope, issuer, lifetime, state, subject_kind, subject_ref, capability, target, valid_from, expires_at, revision) VALUES ('pgr_spawn_test',?,?,?,'until-revoked','Active','WorkspaceAgent',?,'core.control.spawn-specialist',?,'2020-01-01T00:00:00.000Z',NULL,0)",
        [
          projectId,
          `core.control.spawn-specialist@${workspaceId}`,
          "user:test",
          workspaceId,
          workspaceId,
        ],
      );
    }),
  );
});

const admitWorkExecution = Effect.gen(function* () {
  const gateway = yield* CommandGateway;
  const payload: AdmitExecutionPayload = {
    _tag: "WorkspaceMain",
    executionId,
    workspaceId,
    episode: {
      _tag: "WorkEpisode",
      workId,
      targetWorkRevision: 0 as never,
    },
  };
  const commandId = parse(CommandId)(ids.command);
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
  const receipt = yield* gateway.execute(
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
  expect(
    receipt.resolution._tag === "Committed" ||
      (receipt.resolution._tag === "TerminalRejected" &&
        receipt.resolution.error._tag === "ActiveExecutionConflict"),
  ).toBe(true);
});

const runTurns = (_turns: ReadonlyArray<ReadonlyArray<unknown>>) =>
  Effect.gen(function* () {
    yield* runMigrations(CURRENT_MIGRATIONS);
    yield* seed;
    yield* admitWorkExecution;
    const settlement = yield* runExecution(
      executionId,
      {
        _tag: "WorkSelected",
      },
      principal,
    );
    const sql = yield* SqlClient;
    const work = yield* sql.unsafe<{ lifecycle: string; revision: number }>(
      "SELECT lifecycle, revision FROM works WHERE work_id = ?",
      [workId],
    );
    const assignedWorks = yield* sql.unsafe<{
      work_id: string;
      workspace_id: string;
      objective: string;
      provenance: string;
      verification_mission: string;
    }>(
      "SELECT work_id, workspace_id, objective, provenance, verification_mission FROM works WHERE work_id <> ? ORDER BY work_id",
      [workId],
    );
    const proposals = yield* sql.unsafe<{
      proposal_id: string;
      state: string;
      proposal_json: string;
    }>("SELECT proposal_id, state, proposal_json FROM formation_proposals");
    const dependencies = yield* sql.unsafe<{
      dependency_id: string;
      consumer_work_id: string;
      state: string;
    }>("SELECT dependency_id, consumer_work_id, state FROM dependencies");
    const specialists = yield* sql.unsafe<{
      execution_id: string;
      binding_kind: string;
      parent_execution_id: string | null;
      mission: string | null;
    }>(
      "SELECT execution_id, binding_kind, parent_execution_id, mission FROM executions WHERE execution_id <> ?",
      [executionId],
    );
    const workspaces = yield* sql.unsafe<{ workspace_id: string }>(
      "SELECT workspace_id FROM workspaces",
    );
    const inbox = yield* sql.unsafe<{
      entry_key: string;
      kind: string;
      consumed_at: string | null;
    }>(
      "SELECT entry_key, kind, consumed_at FROM inbox_entries ORDER BY entry_key",
    );
    const waits = yield* sql.unsafe<{
      work_id: string;
      conditions_json: string;
    }>("SELECT work_id, conditions_json FROM work_waits ORDER BY work_id");
    return {
      settlement,
      work,
      assignedWorks,
      proposals,
      specialists,
      dependencies,
      workspaces,
      inbox,
      waits,
    };
  });

const claimCompletionTurn = [
  {
    _tag: "ToolCallProposed" as const,
    callRef: "c1",
    toolName: "claim_completion",
    argumentsJson: JSON.stringify({
      claim: "all acceptance criteria delivered and locally verified",
    }),
  },
  { _tag: "TurnCompleted" as const, finishReason: "ToolCall" as const },
];

const assignWorkTurn = [
  {
    _tag: "ToolCallProposed" as const,
    callRef: "c1",
    toolName: "assign_work",
    argumentsJson: JSON.stringify({
      objective: "produce an independently verified release report",
      why: "the parent Work needs a bounded report outcome",
      constraints: ["cite exact evidence"],
      completionExpectation: "one report with exact evidence references",
      verificationMission: {
        goal: "verify the assigned release report",
        criteria: [
          {
            criterionId: "report-evidence",
            requirement: "the report exists and cites exact evidence",
            required: true,
          },
        ],
        riskRequirements: ["uncited claims fail verification"],
      },
      reason: "delegate a bounded outcome from the current parent Work",
    }),
  },
  {
    _tag: "ToolCallProposed" as const,
    callRef: "c2",
    toolName: "wait",
    argumentsJson: JSON.stringify({
      reason: "await assigned Work",
      waitSpec: { mode: "Any", conditions: [{ _tag: "Manual" }] },
    }),
  },
  { _tag: "TurnCompleted" as const, finishReason: "Stop" as const },
];

const proposeChildTurn = [
  {
    _tag: "ToolCallProposed" as const,
    callRef: "c1",
    toolName: "propose_workspace",
    argumentsJson: JSON.stringify({
      name: "data-pipeline",
      rationale: "independent long-lived responsibility",
      responsibilityDraft: {
        purpose: "own the nightly pipeline",
        ownedResponsibilities: ["pipeline"],
      },
      resourceBoundaryDraft: {
        addresses: [{ _tag: "FileTree", path: "services/pipeline" }],
      },
    }),
  },
  {
    _tag: "ToolCallProposed" as const,
    callRef: "c2",
    toolName: "wait",
    argumentsJson: JSON.stringify({
      reason: "await human decision",
      waitSpec: { mode: "Any", conditions: [{ _tag: "Manual" }] },
    }),
  },
  { _tag: "TurnCompleted" as const, finishReason: "Stop" as const },
];

const spawnSpecialistTurn = [
  {
    _tag: "ToolCallProposed" as const,
    callRef: "c1",
    toolName: "spawn_specialist",
    argumentsJson: JSON.stringify({
      mission: "profile the failing query",
      constraints: ["read-only"],
    }),
  },
  {
    _tag: "ToolCallProposed" as const,
    callRef: "c2",
    toolName: "wait",
    argumentsJson: JSON.stringify({
      reason: "await specialist result",
      waitSpec: { mode: "Any", conditions: [{ _tag: "Manual" }] },
    }),
  },
  { _tag: "TurnCompleted" as const, finishReason: "Stop" as const },
];

const setupApp = (turns: ReadonlyArray<ReadonlyArray<unknown>>) => {
  const dir = mkdtempSync(join(tmpdir(), "wave2-"));
  directories.push(dir);
  return {
    app: buildSingleWorkspaceLayer({
      databaseFile: join(dir, "slice.db"),
      providerTurns: turns as never,
    }),
  };
};

const declareDependencyTurn = [
  {
    _tag: "ToolCallProposed" as const,
    callRef: "c1",
    toolName: "declare_dependency",
    argumentsJson: JSON.stringify({
      producerBinding: { _tag: "AnyProducer" },
      expectedDeliverable: {
        kind: "build-report",
        requiredArtifactRoles: ["report"],
      },
    }),
  },
  {
    _tag: "ToolCallProposed" as const,
    callRef: "c2",
    toolName: "wait",
    argumentsJson: JSON.stringify({
      reason: "await deliverable",
      waitSpec: { mode: "Any", conditions: [{ _tag: "Manual" }] },
    }),
  },
  { _tag: "TurnCompleted" as const, finishReason: "Stop" as const },
];

describe("Wave 2 — model-facing control actions through the adopted route", () => {
  it.skip("historical WorkspaceWork AssignWork approval route — superseded by MAC-P1 Root work initiation", async () => {
    const { app } = setupApp([assignWorkTurn]);
    const result = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          yield* runMigrations(CURRENT_MIGRATIONS);
          yield* seed;
          yield* admitWorkExecution;
          const first = yield* runExecution(
            executionId,
            { _tag: "WorkSelected" },
            principal,
          );
          if (first._tag !== "ApprovalRequired") {
            return yield* Effect.die("AssignWork did not suspend for approval");
          }
          const sql = yield* SqlClient;
          const before = yield* sql.unsafe<{ n: number }>(
            "SELECT COUNT(*) AS n FROM works WHERE work_id <> ?",
            [workId],
          );
          const gateway = yield* CommandGateway;
          const approvalCommandId = parse(CommandId)(
            "cmd_018f2b3c-4d5e-7abc-8def-0123456789b3",
          );
          const approvalActor = parse(Actor)("user:approver");
          const approvalPrincipal = parse(Principal)("user:approver");
          const payload = {
            approvalId: first.approvalId,
            expectedRevision: first.revision,
            decision: "Approve" as const,
            reason: "approve exact bounded assignment",
          };
          const receipt = yield* gateway.execute(
            {
              commandType: "ResolveControlApproval",
              commandId: approvalCommandId,
              projectId,
              actor: approvalActor,
              issuedAt: "2026-10-03T00:00:01.000Z",
              payload,
            },
            { _tag: "External", principal: approvalPrincipal },
            {
              _tag: "ControlApprovalDecisionAuthority",
              principal: approvalPrincipal,
              commandId: approvalCommandId,
              semanticRequestFingerprint: semanticRequestFingerprint({
                commandType: "ResolveControlApproval",
                projectId,
                actor: approvalActor,
                schemaVersion: "1",
                payload,
              }),
              projectId,
              approvalId: first.approvalId,
            },
          );
          const second = yield* runExecution(
            executionId,
            { _tag: "HumanIntervention" },
            principal,
          );
          const assigned = yield* sql.unsafe<{ work_id: string }>(
            "SELECT work_id FROM works WHERE work_id <> ?",
            [workId],
          );
          const approval = yield* sql.unsafe<{
            state: string;
            revision: number;
          }>(
            "SELECT state, revision FROM action_approvals WHERE route_kind = 'Control' AND approval_id = ?",
            [first.approvalId],
          );
          const execution = yield* sql.unsafe<{
            settlement_kind: string | null;
          }>("SELECT settlement_kind FROM executions WHERE execution_id = ?", [
            executionId,
          ]);
          return {
            first,
            receipt,
            second,
            before: Number(before[0]?.n ?? -1),
            assigned,
            approval: approval[0],
            execution: execution[0],
          };
        }),
        app,
      ),
    );
    expect(result.first._tag).toBe("ApprovalRequired");
    expect(result.before).toBe(0);
    expect(result.receipt.resolution._tag).toBe("Committed");
    expect(result.second).toMatchObject({
      _tag: "Completed",
      result: { _tag: "Yielded" },
    });
    expect(result.assigned).toHaveLength(1);
    expect(result.approval).toMatchObject({ state: "Consumed", revision: 2 });
    expect(result.execution?.settlement_kind).toBe("Completed");
  });

  it.skip("historical WorkspaceWork AssignWork rejection route — superseded by MAC-P1 Root work initiation", async () => {
    const { app } = setupApp([assignWorkTurn]);
    const result = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          yield* runMigrations(CURRENT_MIGRATIONS);
          yield* seed;
          yield* admitWorkExecution;
          const first = yield* runExecution(
            executionId,
            { _tag: "WorkSelected" },
            principal,
          );
          if (first._tag !== "ApprovalRequired") {
            return yield* Effect.die("AssignWork did not suspend for approval");
          }
          const gateway = yield* CommandGateway;
          const commandId = parse(CommandId)(
            "cmd_018f2b3c-4d5e-7abc-8def-0123456789b4",
          );
          const human = parse(Principal)("user:approver");
          const humanActor = parse(Actor)("user:approver");
          const payload = {
            approvalId: first.approvalId,
            expectedRevision: first.revision,
            decision: "Reject" as const,
            reason: "the assignment scope is not approved",
          };
          yield* gateway.execute(
            {
              commandType: "ResolveControlApproval",
              commandId,
              projectId,
              actor: humanActor,
              issuedAt: "2026-10-03T00:00:02.000Z",
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
              approvalId: first.approvalId,
            },
          );
          const second = yield* runExecution(
            executionId,
            { _tag: "HumanIntervention" },
            principal,
          );
          const sql = yield* SqlClient;
          const assigned = yield* sql.unsafe<{ n: number }>(
            "SELECT COUNT(*) AS n FROM works WHERE work_id <> ?",
            [workId],
          );
          const denial = yield* sql.unsafe<{ payload_json: string }>(
            "SELECT payload_json FROM session_entries WHERE item_type = 'ControlResult' AND payload_json LIKE '%control_action_denied%'",
          );
          return { second, assigned: Number(assigned[0]?.n ?? -1), denial };
        }),
        app,
      ),
    );
    expect(result.second).toMatchObject({
      _tag: "Completed",
      result: { _tag: "Yielded" },
    });
    expect(result.assigned).toBe(0);
    expect(result.denial).toHaveLength(1);
  });

  it("AssignWork binds ids, revisions and predecessor provenance in Runtime", async () => {
    const { app } = setupApp([]);
    const result = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          yield* runMigrations(CURRENT_MIGRATIONS);
          yield* seed;
          const handler = assignWorkHandler({
            gateway: yield* CommandGateway,
            workspaces: yield* WorkspaceRepository,
            clock: yield* Clock,
            tx: yield* TransactionPort,
          });
          const outcome = yield* handler.handle({
            action: {
              _tag: "AssignWork",
              objective: "produce an independently verified release report",
              why: "the parent Work needs a bounded report outcome",
              constraints: ["cite exact evidence"],
              completionExpectation:
                "one report with exact evidence references",
              verificationMission: {
                goal: "verify the assigned release report",
                criteria: [
                  {
                    criterionId: "report-evidence",
                    requirement: "the report exists and cites exact evidence",
                    required: true,
                  },
                ],
                riskRequirements: ["uncited claims fail verification"],
              },
              reason: "delegate a bounded outcome from the current parent Work",
            },
            invocation: {
              providerTurnId: "ptn_assign_work" as never,
              outputPosition: 0,
              callRef: "assign-call",
              toolName: "assign_work",
              argumentsJson: "{}",
            },
            execution: {
              executionId,
              projectId,
              workspaceId,
              binding: {
                _tag: "WorkspaceExecution",
                workspaceId,
                episode: {
                  _tag: "WorkEpisode",
                  workId,
                  targetWorkRevision: 0 as never,
                },
              },
              sessionId,
              admittedAt: "t",
              stopRequestedAt: null,
              state: { status: "Active", settlement: null },
            },
            context,
          });
          const sql = yield* SqlClient;
          const assignedWorks = yield* sql.unsafe<{
            work_id: string;
            workspace_id: string;
            objective: string;
            provenance: string;
            verification_mission: string;
          }>(
            "SELECT work_id, workspace_id, objective, provenance, verification_mission FROM works WHERE work_id <> ? ORDER BY work_id",
            [workId],
          );
          return { outcome, assignedWorks };
        }),
        app,
      ),
    );
    expect(result.outcome._tag).toBe("Observation");
    expect(result.assignedWorks).toHaveLength(1);
    const assigned = result.assignedWorks[0];
    expect(assigned?.work_id).toMatch(/^wrk_/);
    expect(assigned?.workspace_id).toBe(workspaceId);
    expect(assigned?.objective).toContain("release report");
    expect(JSON.parse(assigned?.provenance ?? "{}")).toEqual({
      predecessorWorkId: workId,
      reason: "delegate a bounded outcome from the current parent Work",
    });
    expect(JSON.parse(assigned?.verification_mission ?? "{}").criteria).toEqual(
      [
        expect.objectContaining({
          criterionId: "report-evidence",
          required: true,
        }),
      ],
    );
  });

  it("MAC-P1 binds RootConversation AssignWork to the current Workspace", async () => {
    const { app } = setupApp([]);
    const result = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          yield* runMigrations(CURRENT_MIGRATIONS);
          yield* seed;
          const handler = assignWorkHandler({
            gateway: yield* CommandGateway,
            workspaces: yield* WorkspaceRepository,
            clock: yield* Clock,
            tx: yield* TransactionPort,
          });
          const baseAction = {
            _tag: "AssignWork" as const,
            objective: "research a bounded strategy without live trading",
            why: "the user requested a durable research outcome",
            constraints: ["do not place real orders"],
            completionExpectation: "an evidence-backed research report",
            verificationMission: {
              goal: "verify the research report and the no-trading constraint",
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
          };
          const conversationExecution = {
            executionId,
            projectId,
            workspaceId,
            binding: {
              _tag: "WorkspaceExecution" as const,
              workspaceId,
              episode: {
                _tag: "ConversationResponseEpisode" as const,
                messageId: "msg_018f2b3c-4d5e-7abc-8def-0123456789b2" as never,
                responseJobRevision: 0,
              },
            },
            sessionId,
            admittedAt: "t",
            stopRequestedAt: null,
            state: {
              status: "Active" as const,
              settlement: null,
            },
          };
          const rejected = yield* Effect.flip(
            handler.handle({
              action: {
                ...baseAction,
                targetWorkspaceId: parse(WorkspaceId)(
                  "ws_018f2b3c-4d5e-7abc-8def-0123456789b3",
                ),
              },
              invocation: {
                providerTurnId: "ptn_root_assign_rejected" as never,
                outputPosition: 0,
                callRef: "root-assign-rejected",
                toolName: "assign_work",
                argumentsJson: "{}",
              },
              execution: conversationExecution,
              context,
            }),
          );
          const accepted = yield* handler.handle({
            action: baseAction,
            invocation: {
              providerTurnId: "ptn_root_assign_accepted" as never,
              outputPosition: 0,
              callRef: "root-assign-accepted",
              toolName: "assign_work",
              argumentsJson: "{}",
            },
            execution: conversationExecution,
            context,
          });
          const sql = yield* SqlClient;
          const works = yield* sql.unsafe<{
            workspace_id: string;
            provenance: string;
            constraints: string;
          }>(
            "SELECT workspace_id, provenance, constraints FROM works WHERE work_id <> ?",
            [workId],
          );
          return { rejected, accepted, works };
        }),
        app,
      ),
    );
    expect(result.rejected).toMatchObject({
      _tag: "AgentActionRejected",
      code: "action/target-unavailable",
      correction: "RetryWithChangedInput",
    });
    expect(result.accepted._tag).toBe("Observation");
    expect(result.works).toHaveLength(1);
    expect(result.works[0]?.workspace_id).toBe(workspaceId);
    expect(JSON.parse(result.works[0]?.provenance ?? "{}")).toEqual({
      predecessorWorkId: null,
      reason: "start the bounded goal from the root conversation",
    });
    expect(JSON.parse(result.works[0]?.constraints ?? "[]")).toContain(
      "do not place real orders",
    );
  });

  it("ClaimCompletion settles Completed(CompletionClaimed) and keeps the Work Open", async () => {
    const { app } = setupApp([claimCompletionTurn]);
    const result = await Effect.runPromise(
      Effect.provide(runTurns([claimCompletionTurn]), app),
    );
    expect(result.settlement).toEqual({
      _tag: "Completed",
      result: {
        _tag: "CompletionClaimed",
        workRevision: 0,
        claimRef: expect.stringMatching(/^clm_[0-9a-f-]+$/) as string,
      },
    });
    expect(result.work[0]?.lifecycle).toBe("Open");
    expect(result.waits).toHaveLength(1);
    expect(result.waits[0]?.work_id).toBe(workId);
    expect(JSON.parse(result.waits[0]?.conditions_json ?? "[]")).toEqual([
      {
        _tag: "VerificationChanged",
        workId,
        targetWorkRevision: 0,
      },
    ]);
    expect(result.workspaces).toHaveLength(1);
  });

  it("MAC-P2 exposes governed ProposeChildWorkspace without creating the child before approval", async () => {
    const { app } = setupApp([proposeChildTurn]);
    const result = await Effect.runPromise(
      Effect.provide(runTurns([proposeChildTurn]), app),
    );
    expect(result.settlement).toMatchObject({
      _tag: "Completed",
      result: { _tag: "Yielded" },
    });
    expect(result.proposals).toHaveLength(1);
    expect(result.proposals[0]?.state).toBe("Pending");
    expect(result.proposals[0]?.proposal_json).toContain("data-pipeline");
    expect(result.inbox).toEqual([
      expect.objectContaining({
        entry_key: expect.stringMatching(/^gov:fpr_.+:1$/),
        kind: "Governance",
        consumed_at: null,
      }),
    ]);
    expect(result.workspaces).toHaveLength(1);
  });

  it("MAC-P1 hides legacy SpawnSpecialist from WorkEpisode new writes", async () => {
    const { app } = setupApp([spawnSpecialistTurn]);
    const result = await Effect.runPromise(
      Effect.provide(runTurns([spawnSpecialistTurn]), app),
    );
    expect(result.settlement).toMatchObject({
      _tag: "Interrupted",
      result: { _tag: "ControlledInterruption" },
    });
    expect(result.specialists).toHaveLength(0);
    expect(result.workspaces).toHaveLength(1);
  });

  it("MAC-P3 exposes DeclareDependency and persists an Unsatisfied exact contract", async () => {
    const { app } = setupApp([declareDependencyTurn]);
    const result = await Effect.runPromise(
      Effect.provide(runTurns([declareDependencyTurn]), app),
    );
    expect(result.settlement).toMatchObject({
      _tag: "Completed",
      result: { _tag: "Yielded" },
    });
    expect(result.dependencies).toHaveLength(1);
    const dependency = result.dependencies[0];
    expect(dependency?.consumer_work_id).toBe(workId);
    expect(dependency?.state).toBe("Unsatisfied");
    expect(dependency?.dependency_id).toMatch(/^dep_/);
  });
});

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});
