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
import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildSliceLayer,
  P12_MIGRATIONS,
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
    }),
  );
});

const admitWorkExecution = Effect.gen(function* () {
  const gateway = yield* CommandGateway;
  const payload: AdmitExecutionPayload = {
    _tag: "WorkspaceMain",
    executionId,
    workspaceId,
    focus: { _tag: "Work", workId },
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
    yield* runMigrations(P12_MIGRATIONS);
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
      focus_kind: string | null;
      parent_execution_id: string | null;
      mission: string | null;
    }>(
      "SELECT execution_id, binding_kind, focus_kind, parent_execution_id, mission FROM executions WHERE execution_id <> ?",
      [executionId],
    );
    const workspaces = yield* sql.unsafe<{ workspace_id: string }>(
      "SELECT workspace_id FROM workspaces",
    );
    return {
      settlement,
      work,
      proposals,
      specialists,
      dependencies,
      workspaces,
    };
  });

const claimCompletionTurn = [
  {
    _tag: "ToolCallProposed" as const,
    callRef: "c1",
    toolName: "arbor_claim_completion",
    argumentsJson: JSON.stringify({
      claim: "all acceptance criteria delivered and locally verified",
    }),
  },
  { _tag: "TurnCompleted" as const, finishReason: "ToolCall" as const },
];

const proposeChildTurn = [
  {
    _tag: "ToolCallProposed" as const,
    callRef: "c1",
    toolName: "arbor_propose_child_workspace",
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
    toolName: "arbor_wait",
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
    toolName: "arbor_spawn_specialist",
    argumentsJson: JSON.stringify({
      mission: "profile the failing query",
      constraints: ["read-only"],
    }),
  },
  {
    _tag: "ToolCallProposed" as const,
    callRef: "c2",
    toolName: "arbor_wait",
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
    app: buildSliceLayer({
      databaseFile: join(dir, "slice.db"),
      providerTurns: turns as never,
    }),
  };
};

const declareDependencyTurn = [
  {
    _tag: "ToolCallProposed" as const,
    callRef: "c1",
    toolName: "arbor_declare_dependency",
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
    toolName: "arbor_wait",
    argumentsJson: JSON.stringify({
      reason: "await deliverable",
      waitSpec: { mode: "Any", conditions: [{ _tag: "Manual" }] },
    }),
  },
  { _tag: "TurnCompleted" as const, finishReason: "Stop" as const },
];

describe("Wave 2 — model-facing control actions through the adopted route", () => {
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
    expect(result.workspaces).toHaveLength(1);
  });

  it("ProposeChildWorkspace persists a Pending proposal and creates no workspace", async () => {
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
    expect(result.workspaces).toHaveLength(1);
  });

  it("SpawnSpecialist admits an ExecutionBound child of the spawning execution", async () => {
    const { app } = setupApp([spawnSpecialistTurn]);
    const result = await Effect.runPromise(
      Effect.provide(runTurns([spawnSpecialistTurn]), app),
    );
    expect(result.settlement).toMatchObject({
      _tag: "Completed",
      result: { _tag: "Yielded" },
    });
    expect(result.specialists).toHaveLength(1);
    const specialist = result.specialists[0];
    expect(specialist?.binding_kind).toBe("execution_bound");
    expect(specialist?.parent_execution_id).toBe(executionId);
    expect(specialist?.mission).toContain("profile the failing query");
    expect(specialist?.mission).toContain("read-only");
    expect(result.workspaces).toHaveLength(1);
  });

  it("DeclareDependency persists an Unsatisfied dependency bound to the current Work", async () => {
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
