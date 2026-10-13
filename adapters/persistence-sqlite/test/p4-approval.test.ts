import {
  Actor,
  ExecutionId,
  LeaseGeneration,
  Principal,
  ProjectId,
  parse,
  SessionId,
  ToolInvocationId,
  WorkspaceId,
} from "@arbor/domain";
import type {
  InvocationApproval,
  ToolDefinition,
  ToolExecutionContext,
  ToolIntent,
} from "@arbor/ports";
import { ToolInvocationStore, TransactionPort } from "@arbor/ports";
import { Effect, Layer } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { describe, expect, it } from "vitest";
import {
  actionDigestOf,
  matchApproval,
} from "../../../packages/tool-runtime/src/index.js";
import {
  layer,
  P36_MIGRATIONS,
  runMigrations,
  ToolInvocationStoreLive,
  TransactionPortLive,
} from "../src/index.js";

const workspaceId = parse(WorkspaceId)(
  "ws_018f2b3c-4d5e-7abc-8def-0123456789a1",
);
const executionId = parse(ExecutionId)(
  "exe_018f2b3c-4d5e-7abc-8def-0123456789a1",
);
const projectId = parse(ProjectId)("prj_018f2b3c-4d5e-7abc-8def-0123456789a1");
const sessionId = parse(SessionId)("ses_018f2b3c-4d5e-7abc-8def-0123456789a1");
const principal = parse(Principal)("worker:a");
const actor = parse(Actor)("worker:a");
const invocationId = parse(ToolInvocationId)(
  "tin_018f2b3c-4d5e-7abc-8def-0123456789a1",
);
const executionFence = {
  executionId,
  workerId: String(principal),
  workerIncarnationId: "incarnation:p4-approval",
  fencingGeneration: parse(LeaseGeneration)(0),
};

const definition: ToolDefinition = {
  name: "shell",
  version: "1",
  hash: "shell-v1",
  description: "shell",
  inputSchemaJson: "{}",
  resultSchemaJson: "{}",
  capabilityMetadata: ["shell:exec"],
  sideEffectSemantics: "Reconcilable",
  source: "Builtin",
};
const intent: ToolIntent = {
  callRef: "c",
  toolName: "shell",
  toolVersion: "1",
  argumentsJson: '{"command":"ls"}',
  invocationId,
  approvalId: null,
};
const context = {
  executionId,
  workspaceId,
  sessionId,
  projectId,
  actor,
  authenticatedPrincipal: principal,
  executionFence,
  authority: {
    principal,
    workspaceId,
    executionId,
    toolName: "shell",
    toolVersion: "1",
    resourceSpaceIds: ["filesystem"],
    allowedCapabilities: ["shell:exec"],
    controlBasisDigest: "d",
    expiresAt: "2999-01-01T00:00:00.000Z",
    delegationDepth: 0,
  },
  controlBasisDigest: "d",
  requestedAt: "t",
} as ToolExecutionContext;

const approval: InvocationApproval = {
  approvalId: "apr_1",
  toolName: "shell",
  toolVersion: "1",
  actionDigest: actionDigestOf(intent),
  targetResourceSpaceIds: ["filesystem"],
  controlBasisDigest: "d",
  expiresAt: "2999-01-01T00:00:00.000Z",
  consumedBy: null,
};
const regions = [{ resourceSpaceId: "filesystem", normalizedRegion: {} }];

const makeApp = () => {
  const base = layer({ filename: ":memory:" });
  const infra = Layer.mergeAll(base);
  return Layer.mergeAll(
    infra,
    Layer.provide(TransactionPortLive, infra),
    Layer.provide(ToolInvocationStoreLive, infra),
  );
};

describe("P4 InvocationApproval", () => {
  it("matches an exact intent and denies mismatch/expiry/consumed", () => {
    expect(
      matchApproval({
        approval,
        intent,
        definition,
        context,
        regions,
        now: "2026-01-01T00:00:00.000Z",
      })._tag,
    ).toBe("Ok");
    expect(
      matchApproval({
        approval: { ...approval, actionDigest: "x" },
        intent,
        definition,
        context,
        regions,
        now: "2026-01-01T00:00:00.000Z",
      })._tag,
    ).toBe("Denied");
    expect(
      matchApproval({
        approval: { ...approval, expiresAt: "2000-01-01T00:00:00.000Z" },
        intent,
        definition,
        context,
        regions,
        now: "2026-01-01T00:00:00.000Z",
      })._tag,
    ).toBe("Denied");
    expect(
      matchApproval({
        approval: { ...approval, consumedBy: invocationId },
        intent,
        definition,
        context,
        regions,
        now: "2026-01-01T00:00:00.000Z",
      })._tag,
    ).toBe("Denied");
  });

  it("keeps binding-proven executable approval out of the legacy P4 consume route", async () => {
    const app = makeApp();
    const program = Effect.gen(function* () {
      yield* runMigrations(P36_MIGRATIONS);
      const sql = yield* SqlClient;
      yield* sql.withTransaction(
        Effect.gen(function* () {
          yield* sql.unsafe(
            "INSERT INTO projects (project_id, name, root_workspace_id, project_policy, project_policy_revision, default_configuration, environment_ref, lifecycle, revision, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
            [
              projectId,
              "p4 approval",
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
              "approval",
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
            "INSERT INTO executions (execution_id, project_id, binding_kind, workspace_id, episode_kind, episode_ref, episode_revision, parent_execution_id, mission, session_id, admitted_at, stop_requested_at, settlement_kind, settlement_json, settled_at) VALUES (?,?,?, ?,NULL,NULL,NULL,NULL,?,?,?,NULL,NULL,NULL,NULL)",
            [
              executionId,
              projectId,
              "execution_bound",
              workspaceId,
              "fixture",
              sessionId,
              "t",
            ],
          );
          yield* sql.unsafe(
            "INSERT INTO execution_leases (execution_id, worker_id, worker_incarnation_id, generation, expires_at, updated_at) VALUES (?,?,?,?,?,?)",
            [
              executionId,
              executionFence.workerId,
              executionFence.workerIncarnationId,
              0,
              "2999-01-01T00:00:00.000Z",
              "t",
            ],
          );
          yield* sql.unsafe(
            `INSERT INTO action_approvals (
              approval_id, route_kind, project_id, workspace_id, execution_id,
              subject_ref, stable_action_id, action_version,
              side_effect_semantics, action_digest, arguments_json, target_ref,
              target_resource_space_ids_json, control_basis_digest, state,
              revision, requested_at, expires_at, decided_at, decided_by,
              decision_reason, consumed_at, consumed_by, binding_proven,
              source_state
            ) VALUES (?, 'Executable', ?, ?, ?, ?, ?, ?, 'Reconcilable', ?, ?,
              'filesystem', ?, ?, 'Approved', 1, 't', ?, 't', 'human:test',
              NULL, NULL, NULL, 1, 'Approved')`,
            [
              approval.approvalId,
              projectId,
              workspaceId,
              executionId,
              `Execution:${executionId}`,
              approval.toolName,
              approval.toolVersion,
              approval.actionDigest,
              intent.argumentsJson,
              JSON.stringify(approval.targetResourceSpaceIds),
              approval.controlBasisDigest,
              approval.expiresAt,
            ],
          );
        }),
      );
      const tx = yield* TransactionPort;
      const store = yield* ToolInvocationStore;
      yield* tx.transact(
        store.recordIntent(
          {
            invocationId,
            executionId,
            workspaceId,
            toolName: "shell",
            toolVersion: "1",
            sideEffectSemantics: "Reconcilable",
            argumentsJson: intent.argumentsJson,
            resolvedRegions: regions,
            approvalId: approval.approvalId,
            intentAt: "2026-01-01T00:00:00.000Z",
          },
          executionFence,
          "2026-01-01T00:00:00.000Z",
        ),
      );
      const first = yield* tx.transact(
        store.consumeApproval(
          "apr_1",
          invocationId,
          executionFence,
          "2026-01-01T00:00:00.000Z",
        ),
      );
      const second = yield* tx.transact(
        store.consumeApproval(
          "apr_1",
          invocationId,
          executionFence,
          "2026-01-01T00:00:00.000Z",
        ),
      );
      const found = yield* tx.transact(store.findApproval("apr_1"));
      return { first, second, found };
    });
    const r = await Effect.runPromise(
      Effect.provide(program, app) as Effect.Effect<unknown, unknown, never>,
    );
    expect((r as { first: boolean }).first).toBe(false);
    expect((r as { second: boolean }).second).toBe(false);
    expect((r as { found: { _tag: string } }).found._tag).toBe("None");
  });
});
