import {
  AttentionProjectionStore as AttentionProjectionStorePort,
  canonicalArgumentsDigestV1,
  canonicalizeRecoveryBindingV1,
  type RecoveryBindingV1,
  recoveryBindingV1Digest,
  sha256Hex,
  TransactionPort,
  targetResourceIdentityDigestV1,
} from "@arbor/ports";
import { Effect, Layer } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { describe, expect, it } from "vitest";
import {
  AttentionProjectionStoreLive,
  layer,
  TransactionPortLive,
} from "../src/index.js";

const projectId = "prj_018f2b3c-4d5e-7abc-8def-0123456789a1" as never;
const workspaceId = "ws_018f2b3c-4d5e-7abc-8def-0123456789a1" as never;
const executionId = "exe_018f2b3c-4d5e-7abc-8def-0123456789a1" as never;
const invocationId = "tin_018f2b3c-4d5e-7abc-8def-0123456789a1";
const intentAt = "2026-10-19T10:00:00.000Z";
const now = "2026-10-19T10:00:01.000Z";
const argumentsJson = '{"command":"pwd"}';
const episodeJson = JSON.stringify({
  _tag: "WorkEpisode",
  workId: "wrk_018f2b3c-4d5e-7abc-8def-0123456789a1",
  targetWorkRevision: 1,
});
const regions: ReadonlyArray<import("@arbor/domain").CanonicalResourceRegion> =
  [];
const binding: RecoveryBindingV1 = {
  bindingVersion: 1,
  digestAlgorithm: "SHA-256",
  executionId: executionId as never,
  invocationId: invocationId as never,
  providerTurnId: "ptn_018f2b3c-4d5e-7abc-8def-0123456789a1" as never,
  logicalStepNo: 0,
  repairAttempt: 0,
  logicalActionId: "action-policy-required",
  actionIndex: 0,
  callRef: "call-policy-required",
  toolName: "shell",
  toolVersion: "shell-v1",
  toolDefinitionHash: "a".repeat(64),
  sideEffectSemantics: "NonIdempotent",
  canonicalArgumentsDigest: canonicalArgumentsDigestV1(
    JSON.parse(argumentsJson),
  ),
  targetResourceIdentityDigest: targetResourceIdentityDigestV1(regions),
  resourceBoundaryRevision: 1,
  environmentRevision: "1",
  authoritySourceRevision: null,
  principalId: "user:local",
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
  effectKey: "effect-policy-required",
};

const app = () => {
  const infra = layer({ filename: ":memory:" });
  return Layer.mergeAll(
    infra,
    Layer.provide(TransactionPortLive, infra),
    Layer.provide(AttentionProjectionStoreLive, infra),
  );
};

describe("P10 derived SandboxPolicyDecisionRequired Attention", () => {
  it("requires an exact verified pending NotAdmitted process action without writing facts or markers", async () => {
    const result = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const sql = yield* SqlClient;
          yield* sql.unsafe(`CREATE TABLE executions (
            project_id TEXT NOT NULL, execution_id TEXT NOT NULL,
            workspace_id TEXT NOT NULL, settled_at TEXT, stop_requested_at TEXT
          )`);
          yield* sql.unsafe(`CREATE TABLE agent_execution_state (
            execution_id TEXT NOT NULL, episode_json TEXT NOT NULL
          )`);
          yield* sql.unsafe(`CREATE TABLE sandbox_policy_decisions (
            project_id TEXT NOT NULL, workspace_id TEXT NOT NULL,
            execution_id TEXT NOT NULL, episode_binding_json TEXT NOT NULL,
            policy_revision INTEGER NOT NULL, expires_at TEXT NOT NULL
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
            profile_id TEXT
          )`);
          yield* sql.unsafe(`CREATE TABLE agent_loop_step_actions (
            execution_id TEXT NOT NULL, logical_step_no INTEGER NOT NULL,
            repair_attempt INTEGER NOT NULL, action_index INTEGER NOT NULL,
            logical_action_id TEXT NOT NULL, call_ref TEXT NOT NULL,
            route_kind TEXT NOT NULL, action_kind TEXT NOT NULL,
            input_hash TEXT NOT NULL, state TEXT NOT NULL
          )`);
          yield* sql.unsafe(`CREATE TABLE agent_loop_steps (
            execution_id TEXT NOT NULL, logical_step_no INTEGER NOT NULL,
            repair_attempt INTEGER NOT NULL, provider_turn_id TEXT NOT NULL,
            state TEXT NOT NULL, next_action_index INTEGER NOT NULL
          )`);
          yield* sql.unsafe(`INSERT INTO executions VALUES (?,?,?,NULL,NULL)`, [
            projectId,
            executionId,
            workspaceId,
          ]);
          yield* sql.unsafe(`INSERT INTO agent_execution_state VALUES (?,?)`, [
            executionId,
            episodeJson,
          ]);
          const bindingJson = canonicalizeRecoveryBindingV1(binding);
          const bindingDigest = recoveryBindingV1Digest(binding);
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
            `INSERT INTO tool_invocation_effect_attempts VALUES (?,0,?)`,
            [invocationId, binding.profileId],
          );
          yield* sql.unsafe(
            `INSERT INTO agent_loop_steps VALUES (?,0,0,?,'ActionsInProgress',0)`,
            [executionId, binding.providerTurnId],
          );
          yield* sql.unsafe(
            `INSERT INTO agent_loop_step_actions VALUES (?,0,0,0,?,?,'Executable','shell',?,'Pending')`,
            [
              executionId,
              binding.logicalActionId,
              binding.callRef,
              sha256Hex(argumentsJson),
            ],
          );
          const attention = yield* AttentionProjectionStorePort;
          const tx = yield* TransactionPort;
          const rows = yield* tx.transact(
            attention.listSandboxPolicyDecisionRequired?.(projectId, now) ??
              Effect.succeed([]),
          );
          if (rows === undefined) throw new Error("P10 port unavailable");
          const persisted = yield* sql.unsafe<{ readonly count: number }>(
            `SELECT COUNT(*) AS count FROM sqlite_master
              WHERE name IN ('sandbox_provider_unavailable_facts',
                             'sandbox_provider_unavailable_attention_queue',
                             'sandbox_provider_unavailable_attention_rows')`,
          );
          return { rows, persisted: persisted[0]?.count ?? 0 };
        }),
        app(),
      ),
    );
    expect(result.rows).toEqual([
      {
        projectId,
        executionId,
        invocationId,
        workspaceId,
        attentionFactId: `sandbox-policy-decision-required:${executionId}:${invocationId}`,
        intentAt,
      },
    ]);
    expect(result.persisted).toBe(0);
  });
});
