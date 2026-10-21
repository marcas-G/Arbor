import {
  ExecutionId,
  ProjectId,
  parse,
  ToolInvocationId,
  WorkspaceId,
} from "@arbor/domain";
import {
  canonicalArgumentsDigestV1,
  canonicalizeRecoveryBindingV1,
  type RecoveryBindingV1,
  recoveryBindingV1Digest,
  SandboxPolicyRequirementReadPort,
  sha256Hex,
  TransactionPort,
  targetResourceIdentityDigestV1,
} from "@arbor/ports";
import { Effect, Layer, Option } from "effect";
import {
  SqlClient,
  type SqlClient as SqlClientService,
} from "effect/unstable/sql/SqlClient";
import { describe, expect, it } from "vitest";
import {
  layer,
  SandboxPolicyRequirementReadPortLive,
  TransactionPortLive,
} from "../src/index.js";

const projectId = parse(ProjectId)("prj_018f2b3c-4d5e-7abc-8def-0123456789a1");
const workspaceId = parse(WorkspaceId)(
  "ws_018f2b3c-4d5e-7abc-8def-0123456789a1",
);
const executionId = parse(ExecutionId)(
  "exe_018f2b3c-4d5e-7abc-8def-0123456789a1",
);
const invocationId = parse(ToolInvocationId)(
  "tin_018f2b3c-4d5e-7abc-8def-0123456789a1",
);
const providerTurnId = "ptn_018f2b3c-4d5e-7abc-8def-0123456789a1" as never;
const logicalActionId = "action-sandbox-policy-required";
const callRef = "call-sandbox-policy-required";
const intentAt = "2026-10-19T10:00:00.000Z";
const argumentsJson = '{"command":"pwd"}';
const regions: ReadonlyArray<import("@arbor/domain").CanonicalResourceRegion> =
  [];
const episode = {
  _tag: "WorkEpisode" as const,
  workId: "wrk_018f2b3c-4d5e-7abc-8def-0123456789a1" as never,
  targetWorkRevision: 5 as never,
};
const binding: RecoveryBindingV1 = {
  bindingVersion: 1,
  digestAlgorithm: "SHA-256",
  executionId,
  invocationId,
  providerTurnId,
  logicalStepNo: 2,
  repairAttempt: 0,
  logicalActionId,
  actionIndex: 1,
  callRef,
  toolName: "shell",
  toolVersion: "shell-v1",
  toolDefinitionHash: "a".repeat(64),
  sideEffectSemantics: "NonIdempotent",
  canonicalArgumentsDigest: canonicalArgumentsDigestV1(
    JSON.parse(argumentsJson),
  ),
  targetResourceIdentityDigest: targetResourceIdentityDigestV1(regions),
  resourceBoundaryRevision: 7,
  environmentRevision: "env-5",
  authoritySourceRevision: null,
  principalId: "user:operator",
  capability: null,
  permissionGrantRevisions: [],
  workspacePolicyRevision: 0,
  projectPolicyRevision: 0,
  controlBasisDigest: "b".repeat(64),
  approvalId: null,
  approvalSubject: null,
  approvalPreConsumeRevision: null,
  approvalConsumedRevision: null,
  approvalExpiresAt: null,
  approvalTargetDigest: null,
  approvalActionDigest: null,
  approvalConsumedBy: null,
  profileId: "sandbox-provider",
  profileVersion: "1",
  profileHash: "c".repeat(64),
  profileProtocol: "native-v1",
  effectKey: "effect-sandbox-policy-required",
};
const bindingJson = canonicalizeRecoveryBindingV1(binding);
const bindingDigest = recoveryBindingV1Digest(binding);
const episodeJson = JSON.stringify(episode);

const makeApp = () => {
  const infra = layer({ filename: ":memory:" });
  return Layer.mergeAll(
    infra,
    Layer.provide(TransactionPortLive, infra),
    Layer.provide(SandboxPolicyRequirementReadPortLive, infra),
  );
};

const seedSchema = (sql: SqlClientService) =>
  Effect.gen(function* () {
    yield* sql.unsafe(`CREATE TABLE action_approvals (
      approval_id TEXT NOT NULL, route_kind TEXT NOT NULL,
      project_id TEXT, workspace_id TEXT, execution_id TEXT,
      logical_step_no INTEGER, repair_attempt INTEGER, action_index INTEGER,
      logical_action_id TEXT, call_ref TEXT, tool_invocation_id TEXT,
      stable_action_id TEXT, action_version TEXT, arguments_json TEXT,
      binding_proven INTEGER, state TEXT, revision INTEGER,
      expires_at TEXT, consumed_by TEXT
    )`);
    yield* sql.unsafe(`CREATE TABLE executions (
      project_id TEXT NOT NULL, execution_id TEXT NOT NULL,
      workspace_id TEXT NOT NULL, episode_revision INTEGER NOT NULL,
      settled_at TEXT, stop_requested_at TEXT
    )`);
    yield* sql.unsafe(`CREATE TABLE agent_execution_state (
      execution_id TEXT NOT NULL, episode_json TEXT NOT NULL
    )`);
    yield* sql.unsafe(`CREATE TABLE tool_invocations (
      invocation_id TEXT NOT NULL, execution_id TEXT NOT NULL,
      workspace_id TEXT NOT NULL, intent_at TEXT NOT NULL,
      recovery_binding_state TEXT NOT NULL, recovery_binding_sha256 TEXT,
      effect_admission_state TEXT NOT NULL, settled_at TEXT,
      tool_name TEXT NOT NULL, tool_version TEXT NOT NULL,
      side_effect_semantics TEXT NOT NULL, arguments_json TEXT NOT NULL,
      resolved_regions_json TEXT NOT NULL
    )`);
    yield* sql.unsafe(`CREATE TABLE tool_invocation_recovery_bindings (
      invocation_id TEXT NOT NULL, binding_version INTEGER NOT NULL,
      canonical_binding_json TEXT NOT NULL, binding_sha256 TEXT NOT NULL
    )`);
    yield* sql.unsafe(`CREATE TABLE tool_invocation_effect_attempts (
      invocation_id TEXT NOT NULL, attempt_no INTEGER NOT NULL,
      admission_state TEXT NOT NULL, side_effect_semantics TEXT NOT NULL,
      profile_id TEXT, profile_version TEXT, profile_hash TEXT,
      profile_protocol TEXT, effect_key TEXT, binding_sha256 TEXT
    )`);
    yield* sql.unsafe(`CREATE TABLE agent_loop_step_actions (
      execution_id TEXT NOT NULL, logical_step_no INTEGER NOT NULL,
      repair_attempt INTEGER NOT NULL, action_index INTEGER NOT NULL,
      logical_action_id TEXT NOT NULL, call_ref TEXT NOT NULL,
      route_kind TEXT NOT NULL, action_kind TEXT NOT NULL,
      input_hash TEXT NOT NULL, state TEXT NOT NULL,
      revision INTEGER NOT NULL DEFAULT 0
    )`);
    yield* sql.unsafe(`CREATE TABLE agent_loop_steps (
      execution_id TEXT NOT NULL, logical_step_no INTEGER NOT NULL,
      repair_attempt INTEGER NOT NULL, provider_turn_id TEXT NOT NULL,
      state TEXT NOT NULL, next_action_index INTEGER NOT NULL
    )`);
    yield* sql.unsafe(`INSERT INTO executions VALUES (?,?,?,?,NULL,NULL)`, [
      projectId,
      executionId,
      workspaceId,
      6,
    ]);
    yield* sql.unsafe(`INSERT INTO agent_execution_state VALUES (?,?)`, [
      executionId,
      episodeJson,
    ]);
    yield* sql.unsafe(
      `INSERT INTO tool_invocations VALUES (?,?,?,?,?,?,?,NULL,?,?,?,?,?)`,
      [
        invocationId,
        executionId,
        workspaceId,
        intentAt,
        "Bound",
        bindingDigest,
        "NotAdmitted",
        "shell",
        "shell-v1",
        "NonIdempotent",
        argumentsJson,
        JSON.stringify(regions),
      ],
    );
    yield* sql.unsafe(
      `INSERT INTO tool_invocation_recovery_bindings VALUES (?,1,?,?)`,
      [invocationId, bindingJson, bindingDigest],
    );
    yield* sql.unsafe(
      `INSERT INTO tool_invocation_effect_attempts VALUES (?,0,'NotAdmitted','NonIdempotent',NULL,NULL,NULL,NULL,NULL,NULL)`,
      [invocationId],
    );
    yield* sql.unsafe(
      `INSERT INTO agent_loop_steps VALUES (?,?,?,?,'ActionsInProgress',1)`,
      [
        executionId,
        binding.logicalStepNo,
        binding.repairAttempt,
        providerTurnId,
      ],
    );
    yield* sql.unsafe(
      `INSERT INTO agent_loop_step_actions VALUES (?,?,?,?,?,?,'Executable','shell',?,'Pending',0)`,
      [
        executionId,
        binding.logicalStepNo,
        binding.repairAttempt,
        binding.actionIndex,
        logicalActionId,
        callRef,
        sha256Hex(argumentsJson),
      ],
    );
  });

const seedPreIntentSchema = (sql: SqlClientService) =>
  Effect.gen(function* () {
    yield* sql.unsafe(`CREATE TABLE executions (
      project_id TEXT NOT NULL, execution_id TEXT NOT NULL,
      workspace_id TEXT NOT NULL, episode_revision INTEGER NOT NULL,
      settled_at TEXT, stop_requested_at TEXT
    )`);
    yield* sql.unsafe(`CREATE TABLE agent_execution_state (
      execution_id TEXT NOT NULL, episode_json TEXT NOT NULL
    )`);
    yield* sql.unsafe(`CREATE TABLE agent_loop_steps (
      execution_id TEXT NOT NULL, logical_step_no INTEGER NOT NULL,
      repair_attempt INTEGER NOT NULL, provider_turn_id TEXT NOT NULL,
      state TEXT NOT NULL, next_action_index INTEGER NOT NULL
    )`);
    yield* sql.unsafe(`CREATE TABLE agent_loop_step_actions (
      execution_id TEXT NOT NULL, logical_step_no INTEGER NOT NULL,
      repair_attempt INTEGER NOT NULL, action_index INTEGER NOT NULL,
      logical_action_id TEXT NOT NULL, call_ref TEXT NOT NULL,
      route_kind TEXT NOT NULL, action_kind TEXT NOT NULL,
      input_hash TEXT NOT NULL, state TEXT NOT NULL, revision INTEGER NOT NULL
    )`);
    yield* sql.unsafe(`CREATE TABLE action_approvals (
      approval_id TEXT NOT NULL, route_kind TEXT NOT NULL,
      project_id TEXT, workspace_id TEXT, execution_id TEXT,
      logical_step_no INTEGER, repair_attempt INTEGER, action_index INTEGER,
      logical_action_id TEXT, call_ref TEXT, tool_invocation_id TEXT,
      stable_action_id TEXT, action_version TEXT, arguments_json TEXT,
      binding_proven INTEGER, state TEXT, revision INTEGER,
      expires_at TEXT, consumed_by TEXT
    )`);
    yield* sql.unsafe(`CREATE TABLE tool_invocations (
      invocation_id TEXT NOT NULL, execution_id TEXT NOT NULL,
      workspace_id TEXT NOT NULL, intent_at TEXT NOT NULL,
      recovery_binding_state TEXT NOT NULL, recovery_binding_sha256 TEXT,
      effect_admission_state TEXT NOT NULL, settled_at TEXT,
      tool_name TEXT NOT NULL, tool_version TEXT NOT NULL,
      side_effect_semantics TEXT NOT NULL, arguments_json TEXT NOT NULL,
      resolved_regions_json TEXT NOT NULL
    )`);
    yield* sql.unsafe(`CREATE TABLE tool_invocation_recovery_bindings (
      invocation_id TEXT NOT NULL, binding_version INTEGER NOT NULL,
      canonical_binding_json TEXT NOT NULL, binding_sha256 TEXT NOT NULL
    )`);
    yield* sql.unsafe(`CREATE TABLE tool_invocation_effect_attempts (
      invocation_id TEXT NOT NULL, attempt_no INTEGER NOT NULL,
      admission_state TEXT NOT NULL, side_effect_semantics TEXT NOT NULL,
      profile_id TEXT, profile_version TEXT, profile_hash TEXT,
      profile_protocol TEXT, effect_key TEXT, binding_sha256 TEXT
    )`);
    yield* sql.unsafe(`INSERT INTO executions VALUES (?,?,?,?,NULL,NULL)`, [
      projectId,
      executionId,
      workspaceId,
      6,
    ]);
    yield* sql.unsafe(`INSERT INTO agent_execution_state VALUES (?,?)`, [
      executionId,
      episodeJson,
    ]);
    yield* sql.unsafe(
      `INSERT INTO agent_loop_steps VALUES (?,?,?,?,'ActionsInProgress',1)`,
      [executionId, 2, 0, providerTurnId],
    );
    yield* sql.unsafe(
      `INSERT INTO agent_loop_step_actions VALUES (?,?,?,?,?,?,?,?,?,'Pending',3)`,
      [
        executionId,
        2,
        0,
        1,
        logicalActionId,
        callRef,
        "Executable",
        "shell",
        sha256Hex(argumentsJson),
      ],
    );
    yield* sql.unsafe(
      `INSERT INTO action_approvals VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,1,'Pending',0,?,NULL)`,
      [
        "approval-exact",
        "Executable",
        projectId,
        workspaceId,
        executionId,
        2,
        0,
        1,
        logicalActionId,
        callRef,
        invocationId,
        "shell",
        "shell-v1",
        argumentsJson,
        "2026-10-21T12:00:00.000Z",
      ],
    );
  });

describe("P4 SandboxPolicyRequirementReadPort", () => {
  it("returns the exact Pending P3 Action and P4 approval before intent, read-only", async () => {
    const result = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const sql = yield* SqlClient;
          yield* seedPreIntentSchema(sql);
          const before = yield* sql.unsafe<{ readonly count: number }>(
            "SELECT total_changes() AS count",
          );
          const transactions = yield* TransactionPort;
          const port = yield* SandboxPolicyRequirementReadPort;
          const requirement = yield* transactions.transact(
            port.findPendingByExecution({
              projectId,
              workspaceId,
              executionId,
            }),
          );
          const after = yield* sql.unsafe<{ readonly count: number }>(
            "SELECT total_changes() AS count",
          );
          return {
            requirement,
            changes: (after[0]?.count ?? -1) - (before[0]?.count ?? -1),
          };
        }),
        makeApp(),
      ),
    );
    expect(result.requirement).toEqual(
      Option.some({
        _tag: "SandboxPolicyPreIntentRequirementV1",
        version: 1,
        projectId,
        workspaceId,
        executionId,
        episodeBinding: episode,
        expectedEpisodeRevision: 6,
        providerTurnId,
        logicalStepNo: 2,
        repairAttempt: 0,
        logicalActionId,
        actionIndex: 1,
        callRef,
        actionRevision: 3,
        inputHash: sha256Hex(argumentsJson),
        toolName: "shell",
        toolVersion: "shell-v1",
        approvalId: "approval-exact",
        approvalState: "Pending",
        approvalRevision: 0,
        approvalConsumedBy: null,
        approvalExpiresAt: "2026-10-21T12:00:00.000Z",
      }),
    );
    expect(result.changes).toBe(0);
  });

  it("does not expose a pre-intent requirement for an already Approved approval", async () => {
    const result = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const sql = yield* SqlClient;
          yield* seedPreIntentSchema(sql);
          yield* sql.unsafe(
            "UPDATE action_approvals SET state = 'Approved', revision = 1 WHERE approval_id = ?",
            ["approval-exact"],
          );
          const transactions = yield* TransactionPort;
          const port = yield* SandboxPolicyRequirementReadPort;
          return yield* transactions.transact(
            port.findPendingByExecution({
              projectId,
              workspaceId,
              executionId,
            }),
          );
        }),
        makeApp(),
      ),
    );
    expect(result).toEqual(Option.none());
  });

  it("fails closed on duplicate or mismatched pre-intent P4 source evidence", async () => {
    const duplicate = Effect.provide(
      Effect.gen(function* () {
        const sql = yield* SqlClient;
        yield* seedPreIntentSchema(sql);
        yield* sql.unsafe(
          `INSERT INTO action_approvals SELECT 'approval-duplicate', route_kind,
             project_id, workspace_id, execution_id, logical_step_no,
             repair_attempt, action_index, logical_action_id, call_ref,
             tool_invocation_id, stable_action_id, action_version,
             arguments_json, binding_proven, state, revision, expires_at,
             consumed_by FROM action_approvals WHERE approval_id = ?`,
          ["approval-exact"],
        );
        const transactions = yield* TransactionPort;
        const port = yield* SandboxPolicyRequirementReadPort;
        return yield* transactions.transact(
          port.findPendingByExecution({ projectId, workspaceId, executionId }),
        );
      }),
      makeApp(),
    );
    const duplicateResult = await Effect.runPromiseExit(duplicate);
    expect(duplicateResult._tag).toBe("Failure");

    const mismatched = Effect.provide(
      Effect.gen(function* () {
        const sql = yield* SqlClient;
        yield* seedPreIntentSchema(sql);
        yield* sql.unsafe(
          "UPDATE action_approvals SET arguments_json = ? WHERE approval_id = ?",
          ['{"command":"different"}', "approval-exact"],
        );
        const transactions = yield* TransactionPort;
        const port = yield* SandboxPolicyRequirementReadPort;
        return yield* transactions.transact(
          port.findPendingByExecution({ projectId, workspaceId, executionId }),
        );
      }),
      makeApp(),
    );
    const mismatchResult = await Effect.runPromiseExit(mismatched);
    expect(mismatchResult._tag).toBe("Failure");
  });

  it("compares Action before approval and uses trusted GatewayNow for expiry", async () => {
    const exact = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const sql = yield* SqlClient;
          yield* seedPreIntentSchema(sql);
          const transactions = yield* TransactionPort;
          const port = yield* SandboxPolicyRequirementReadPort;
          const requirement = yield* transactions.transact(
            port.findPendingByExecution({
              projectId,
              workspaceId,
              executionId,
            }),
          );
          if (
            Option.isNone(requirement) ||
            requirement.value._tag !== "SandboxPolicyPreIntentRequirementV1"
          )
            throw new Error("pre-intent requirement fixture missing");
          const exactField = yield* transactions.transact(
            port.comparePreIntentSource({
              expected: requirement.value,
              trustedNow: "2026-10-21T11:59:59.999Z",
            }),
          );
          yield* sql.unsafe(
            "UPDATE executions SET episode_revision = episode_revision + 1 WHERE execution_id = ?",
            [executionId],
          );
          const episodeChanged = yield* transactions.transact(
            port.comparePreIntentSource({
              expected: requirement.value,
              trustedNow: "2026-10-21T11:59:59.999Z",
            }),
          );
          yield* sql.unsafe(
            "UPDATE executions SET episode_revision = episode_revision - 1 WHERE execution_id = ?",
            [executionId],
          );
          yield* sql.unsafe(
            "UPDATE action_approvals SET arguments_json = ? WHERE approval_id = ?",
            ['{"command":"different"}', requirement.value.approvalId],
          );
          const approvalArgumentsChanged = yield* transactions.transact(
            port.comparePreIntentSource({
              expected: requirement.value,
              trustedNow: "2026-10-21T11:59:59.999Z",
            }),
          );
          yield* sql.unsafe(
            "UPDATE action_approvals SET arguments_json = ? WHERE approval_id = ?",
            [argumentsJson, requirement.value.approvalId],
          );
          yield* sql.unsafe(
            "UPDATE agent_loop_step_actions SET revision = revision + 1 WHERE logical_action_id = ?",
            [logicalActionId],
          );
          yield* sql.unsafe(
            "UPDATE action_approvals SET state = 'Approved', revision = revision + 1 WHERE approval_id = ?",
            [requirement.value.approvalId],
          );
          const actionFirst = yield* transactions.transact(
            port.comparePreIntentSource({
              expected: requirement.value,
              trustedNow: "2026-10-21T11:59:59.999Z",
            }),
          );
          yield* sql.unsafe(
            "UPDATE agent_loop_step_actions SET revision = revision - 1 WHERE logical_action_id = ?",
            [logicalActionId],
          );
          const approvalChanged = yield* transactions.transact(
            port.comparePreIntentSource({
              expected: requirement.value,
              trustedNow: "2026-10-21T11:59:59.999Z",
            }),
          );
          yield* sql.unsafe(
            "UPDATE action_approvals SET state = 'Pending', revision = 0 WHERE approval_id = ?",
            [requirement.value.approvalId],
          );
          const timeExpired = yield* transactions.transact(
            port.comparePreIntentSource({
              expected: requirement.value,
              trustedNow: "2026-10-21T12:00:00.000Z",
            }),
          );
          return {
            exactField,
            episodeChanged,
            approvalArgumentsChanged,
            actionFirst,
            approvalChanged,
            timeExpired,
          };
        }),
        makeApp(),
      ),
    );
    expect(exact).toEqual({
      exactField: undefined,
      episodeChanged: "ActionRevision",
      approvalArgumentsChanged: "ExecutableApprovalRevision",
      actionFirst: "ActionRevision",
      approvalChanged: "ExecutableApprovalRevision",
      timeExpired: "ExecutableApprovalRevision",
    });
  });

  it("returns exact active NotAdmitted P3/P4 evidence read-only in caller's transaction", async () => {
    const result = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const sql = yield* SqlClient;
          yield* seedSchema(sql);
          const before = yield* sql.unsafe<{ readonly count: number }>(
            "SELECT total_changes() AS count",
          );
          const transactions = yield* TransactionPort;
          const port = yield* SandboxPolicyRequirementReadPort;
          const requirements = yield* transactions.transact(
            port.findPendingByExecution({
              projectId,
              workspaceId,
              executionId,
            }),
          );
          const after = yield* sql.unsafe<{ readonly count: number }>(
            "SELECT total_changes() AS count",
          );
          return {
            requirements,
            changes: (after[0]?.count ?? -1) - (before[0]?.count ?? -1),
          };
        }),
        makeApp(),
      ),
    );
    expect(result.requirements).toEqual(
      Option.some({
        _tag: "SandboxPolicyRequirementV1",
        projectId,
        workspaceId,
        executionId,
        episodeBinding: episode,
        expectedEpisodeRevision: 6,
        invocationId,
        providerTurnId,
        logicalStepNo: 2,
        repairAttempt: 0,
        logicalActionId,
        actionIndex: 1,
        callRef,
        recoveryBindingDigest: bindingDigest,
      }),
    );
    expect(result.changes).toBe(0);
  });

  it("returns None for a valid terminal invocation", async () => {
    const result = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const sql = yield* SqlClient;
          yield* seedSchema(sql);
          yield* sql.unsafe(
            "UPDATE tool_invocations SET settled_at = ? WHERE invocation_id = ?",
            [intentAt, invocationId],
          );
          const transactions = yield* TransactionPort;
          const port = yield* SandboxPolicyRequirementReadPort;
          return yield* transactions.transact(
            port.findPendingByExecution({
              projectId,
              workspaceId,
              executionId,
            }),
          );
        }),
        makeApp(),
      ),
    );
    expect(result).toEqual(Option.none());
  });

  it("returns None when the exact action is no longer Pending", async () => {
    const result = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const sql = yield* SqlClient;
          yield* seedSchema(sql);
          yield* sql.unsafe(
            "UPDATE agent_loop_step_actions SET state = 'Applied' WHERE execution_id = ?",
            [executionId],
          );
          const transactions = yield* TransactionPort;
          const port = yield* SandboxPolicyRequirementReadPort;
          return yield* transactions.transact(
            port.findPendingByExecution({
              projectId,
              workspaceId,
              executionId,
            }),
          );
        }),
        makeApp(),
      ),
    );
    expect(result).toEqual(Option.none());
  });

  it("returns None for a valid non-policy-bearing executable invocation", async () => {
    const nonPolicyBinding: RecoveryBindingV1 = {
      ...binding,
      toolName: "read_file",
      profileId: null,
      profileVersion: null,
      profileHash: null,
      profileProtocol: null,
      effectKey: null,
    };
    const nonPolicyBindingJson =
      canonicalizeRecoveryBindingV1(nonPolicyBinding);
    const nonPolicyBindingDigest = recoveryBindingV1Digest(nonPolicyBinding);
    const result = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const sql = yield* SqlClient;
          yield* seedSchema(sql);
          yield* sql.unsafe(
            "UPDATE tool_invocations SET tool_name = 'read_file' WHERE invocation_id = ?",
            [invocationId],
          );
          yield* sql.unsafe(
            "UPDATE tool_invocation_recovery_bindings SET canonical_binding_json = ?, binding_sha256 = ? WHERE invocation_id = ?",
            [nonPolicyBindingJson, nonPolicyBindingDigest, invocationId],
          );
          yield* sql.unsafe(
            "UPDATE tool_invocations SET recovery_binding_sha256 = ? WHERE invocation_id = ?",
            [nonPolicyBindingDigest, invocationId],
          );
          yield* sql.unsafe(
            "UPDATE agent_loop_step_actions SET action_kind = 'read_file' WHERE execution_id = ?",
            [executionId],
          );
          const transactions = yield* TransactionPort;
          const port = yield* SandboxPolicyRequirementReadPort;
          return yield* transactions.transact(
            port.findPendingByExecution({
              projectId,
              workspaceId,
              executionId,
            }),
          );
        }),
        makeApp(),
      ),
    );
    expect(result).toEqual(Option.none());
  });

  it("recognizes a non-shell executable only when its exact sandbox profile is bound", async () => {
    const profileBinding: RecoveryBindingV1 = {
      ...binding,
      toolName: "write_file",
    };
    const profileBindingJson = canonicalizeRecoveryBindingV1(profileBinding);
    const profileBindingDigest = recoveryBindingV1Digest(profileBinding);
    const result = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const sql = yield* SqlClient;
          yield* seedSchema(sql);
          yield* sql.unsafe(
            "UPDATE tool_invocations SET tool_name = 'write_file', recovery_binding_sha256 = ? WHERE invocation_id = ?",
            [profileBindingDigest, invocationId],
          );
          yield* sql.unsafe(
            "UPDATE tool_invocation_recovery_bindings SET canonical_binding_json = ?, binding_sha256 = ? WHERE invocation_id = ?",
            [profileBindingJson, profileBindingDigest, invocationId],
          );
          yield* sql.unsafe(
            "UPDATE agent_loop_step_actions SET action_kind = 'write_file' WHERE execution_id = ?",
            [executionId],
          );
          const transactions = yield* TransactionPort;
          const port = yield* SandboxPolicyRequirementReadPort;
          return yield* transactions.transact(
            port.findPendingByExecution({
              projectId,
              workspaceId,
              executionId,
            }),
          );
        }),
        makeApp(),
      ),
    );
    expect(result).toMatchObject(
      Option.some({
        _tag: "SandboxPolicyRequirementV1",
        invocationId,
        logicalActionId,
        recoveryBindingDigest: profileBindingDigest,
      }),
    );
  });

  it("fails closed when a bound effect-attempt profile differs from RecoveryBinding", async () => {
    const result = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const sql = yield* SqlClient;
          yield* seedSchema(sql);
          yield* sql.unsafe(
            `UPDATE tool_invocation_effect_attempts
                SET profile_id = 'other-profile', profile_version = '1',
                    profile_hash = ?, profile_protocol = 'native-v1',
                    effect_key = 'effect-sandbox-policy-required'
              WHERE invocation_id = ?`,
            ["e".repeat(64), invocationId],
          );
          const transactions = yield* TransactionPort;
          const port = yield* SandboxPolicyRequirementReadPort;
          return yield* Effect.match(
            transactions.transact(
              port.findPendingByExecution({
                projectId,
                workspaceId,
                executionId,
              }),
            ),
            {
              onFailure: (error) => ({ _tag: "Failure" as const, error }),
              onSuccess: (value) => ({ _tag: "Success" as const, value }),
            },
          );
        }),
        makeApp(),
      ),
    );
    expect(result).toMatchObject({
      _tag: "Failure",
      error: {
        _tag: "PersistenceCorruption",
        operation: "sandbox-policy-requirement-read",
      },
    });
  });

  it("fails closed on duplicate P3 action evidence", async () => {
    const result = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const sql = yield* SqlClient;
          yield* seedSchema(sql);
          yield* sql.unsafe(
            `INSERT INTO agent_loop_step_actions
             SELECT * FROM agent_loop_step_actions WHERE execution_id = ?`,
            [executionId],
          );
          const transactions = yield* TransactionPort;
          const port = yield* SandboxPolicyRequirementReadPort;
          return yield* Effect.match(
            transactions.transact(
              port.findPendingByExecution({
                projectId,
                workspaceId,
                executionId,
              }),
            ),
            {
              onFailure: (error) => ({ _tag: "Failure" as const, error }),
              onSuccess: (value) => ({ _tag: "Success" as const, value }),
            },
          );
        }),
        makeApp(),
      ),
    );
    expect(result).toMatchObject({
      _tag: "Failure",
      error: {
        _tag: "PersistenceCorruption",
        operation: "sandbox-policy-requirement-read",
      },
    });
  });

  it("fails closed when a Pending action is not at the current Step cursor", async () => {
    const result = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const sql = yield* SqlClient;
          yield* seedSchema(sql);
          yield* sql.unsafe(
            "UPDATE agent_loop_steps SET next_action_index = 0 WHERE execution_id = ?",
            [executionId],
          );
          const transactions = yield* TransactionPort;
          const port = yield* SandboxPolicyRequirementReadPort;
          return yield* Effect.match(
            transactions.transact(
              port.findPendingByExecution({
                projectId,
                workspaceId,
                executionId,
              }),
            ),
            {
              onFailure: (error) => ({ _tag: "Failure" as const, error }),
              onSuccess: (value) => ({ _tag: "Success" as const, value }),
            },
          );
        }),
        makeApp(),
      ),
    );
    expect(result).toMatchObject({
      _tag: "Failure",
      error: {
        _tag: "PersistenceCorruption",
        operation: "sandbox-policy-requirement-read",
      },
    });
  });

  it("fails closed on corrupt exact recovery proof instead of treating it as absence", async () => {
    const result = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const sql = yield* SqlClient;
          yield* seedSchema(sql);
          yield* sql.unsafe(
            "UPDATE tool_invocation_recovery_bindings SET binding_sha256 = ? WHERE invocation_id = ?",
            ["d".repeat(64), invocationId],
          );
          const transactions = yield* TransactionPort;
          const port = yield* SandboxPolicyRequirementReadPort;
          return yield* Effect.match(
            transactions.transact(
              port.findPendingByExecution({
                projectId,
                workspaceId,
                executionId,
              }),
            ),
            {
              onFailure: (error) => ({ _tag: "Failure" as const, error }),
              onSuccess: (value) => ({ _tag: "Success" as const, value }),
            },
          );
        }),
        makeApp(),
      ),
    );
    expect(result).toMatchObject({
      _tag: "Failure",
      error: {
        _tag: "PersistenceCorruption",
        repository: "ToolObservationEvidenceStore",
        operation: "sandbox-policy-requirement-read",
      },
    });
  });
});
