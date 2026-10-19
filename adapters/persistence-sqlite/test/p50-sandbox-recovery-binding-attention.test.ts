import {
  AttentionProjectionStore as AttentionProjectionStorePort,
  canonicalArgumentsDigestV1,
  canonicalizeRecoveryBindingV1,
  type RecoveryBindingV1,
  recoveryBindingV1Digest,
  sha256Hex,
  TransactionPort,
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
const invocationId = "tin_018f2b3c-4d5e-7abc-8def-0123456789a1" as never;
const intentAt = "2026-10-19T10:00:00.000Z";
const argumentsJson = '{"command":"pwd"}';

const appLayer = () => {
  const sqlite = layer({ filename: ":memory:" });
  return Layer.mergeAll(
    sqlite,
    Layer.provide(TransactionPortLive, sqlite),
    Layer.provide(AttentionProjectionStoreLive, sqlite),
  );
};

const binding = (): RecoveryBindingV1 => ({
  bindingVersion: 1,
  digestAlgorithm: "SHA-256",
  executionId,
  invocationId,
  providerTurnId: "ptn_018f2b3c-4d5e-7abc-8def-0123456789a1" as never,
  logicalStepNo: 0,
  repairAttempt: 0,
  logicalActionId: "action-1",
  actionIndex: 0,
  callRef: "call-1",
  toolName: "shell",
  toolVersion: "shell-v1",
  toolDefinitionHash: "a".repeat(64),
  sideEffectSemantics: "NonIdempotent",
  canonicalArgumentsDigest: "b".repeat(64),
  targetResourceIdentityDigest: "c".repeat(64),
  resourceBoundaryRevision: 1,
  environmentRevision: "1",
  authoritySourceRevision: null,
  principalId: "user:local",
  capability: null,
  permissionGrantRevisions: [],
  workspacePolicyRevision: 0,
  projectPolicyRevision: 0,
  controlBasisDigest: "d".repeat(64),
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
  profileHash: "e".repeat(64),
  profileProtocol: "native-v1",
  effectKey: "effect-1",
});

const seedTables = Effect.gen(function* () {
  const sql = yield* SqlClient;
  yield* sql.unsafe(
    `CREATE TABLE executions (
       project_id TEXT NOT NULL, execution_id TEXT NOT NULL,
       workspace_id TEXT NOT NULL, settled_at TEXT, stop_requested_at TEXT
     )`,
  );
  yield* sql.unsafe(
    `CREATE TABLE tool_invocations (
       invocation_id TEXT NOT NULL, execution_id TEXT NOT NULL,
       workspace_id TEXT NOT NULL, intent_at TEXT NOT NULL,
       recovery_binding_state TEXT NOT NULL, recovery_binding_sha256 TEXT,
       effect_admission_state TEXT NOT NULL, settled_at TEXT,
       tool_name TEXT NOT NULL, tool_version TEXT NOT NULL,
       side_effect_semantics TEXT NOT NULL, arguments_json TEXT NOT NULL
     )`,
  );
  yield* sql.unsafe(
    `CREATE TABLE tool_invocation_recovery_bindings (
       invocation_id TEXT NOT NULL, binding_version INTEGER NOT NULL,
       canonical_binding_json TEXT NOT NULL, binding_sha256 TEXT NOT NULL
     )`,
  );
  yield* sql.unsafe(
    `CREATE TABLE tool_invocation_effect_attempts (
       invocation_id TEXT NOT NULL, attempt_no INTEGER NOT NULL,
       profile_id TEXT, PRIMARY KEY(invocation_id, attempt_no)
     )`,
  );
  yield* sql.unsafe(
    `CREATE TABLE agent_loop_step_actions (
       execution_id TEXT NOT NULL, logical_step_no INTEGER NOT NULL,
       repair_attempt INTEGER NOT NULL, action_index INTEGER NOT NULL,
       logical_action_id TEXT NOT NULL, call_ref TEXT NOT NULL,
       route_kind TEXT NOT NULL, action_kind TEXT NOT NULL,
       input_hash TEXT NOT NULL, state TEXT NOT NULL
     )`,
  );
  yield* sql.unsafe(
    `CREATE TABLE agent_loop_steps (
       execution_id TEXT NOT NULL, logical_step_no INTEGER NOT NULL,
       repair_attempt INTEGER NOT NULL, provider_turn_id TEXT NOT NULL,
       state TEXT NOT NULL
     )`,
  );
  yield* sql.unsafe(`INSERT INTO executions VALUES (?, ?, ?, NULL, NULL)`, [
    projectId,
    executionId,
    workspaceId,
  ]);
  yield* sql.unsafe(
    `INSERT INTO tool_invocations VALUES (?, ?, ?, ?, 'LegacyBindingUnproven', NULL,
       'NotAdmitted', NULL, 'shell', 'shell-v1', 'NonIdempotent', ?)`,
    [invocationId, executionId, workspaceId, intentAt, argumentsJson],
  );
});

const listFailures = (now = intentAt) =>
  Effect.gen(function* () {
    const tx = yield* TransactionPort;
    const attention = yield* AttentionProjectionStorePort;
    const list = attention.listSandboxRecoveryBindingFailures;
    if (list === undefined)
      throw new Error("V21 attention source is not wired");
    return yield* tx.transact(list(projectId, now));
  });

describe("V21 derived SandboxRecoveryBindingFailure Attention", () => {
  it("is read-only, stable, path-free and hashes the exact nullable binding identity", async () => {
    await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          yield* seedTables;
          const first = yield* listFailures();
          const second = yield* listFailures();
          const expectedId = sha256Hex(
            JSON.stringify({
              version: 1,
              executionId,
              invocationId,
              bindingShaOr: null,
            }),
          );
          expect(first).toEqual([
            {
              projectId,
              executionId,
              invocationId,
              workspaceId,
              attentionFactId: expectedId,
              intentAt,
            },
          ]);
          expect(second).toEqual(first);
          const sql = yield* SqlClient;
          expect(
            yield* sql.unsafe<{ readonly count: number }>(
              `SELECT COUNT(*) AS count FROM tool_invocation_recovery_bindings`,
            ),
          ).toEqual([{ count: 0 }]);
        }),
        appLayer(),
      ),
    );
  });

  it("uses a well-formed persisted digest verbatim even when proof bytes do not verify", async () => {
    const storedDigest = "f".repeat(64);
    await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          yield* seedTables;
          const sql = yield* SqlClient;
          yield* sql.unsafe(
            `UPDATE tool_invocations SET recovery_binding_state = 'Bound',
               recovery_binding_sha256 = ? WHERE invocation_id = ?`,
            [storedDigest, invocationId],
          );
          const value = binding();
          yield* sql.unsafe(
            `INSERT INTO tool_invocation_recovery_bindings VALUES (?, 1, ?, ?)`,
            [
              invocationId,
              canonicalizeRecoveryBindingV1(value),
              recoveryBindingV1Digest(value),
            ],
          );
          const rows = yield* listFailures();
          expect(rows[0]?.attentionFactId).toBe(
            sha256Hex(
              JSON.stringify({
                version: 1,
                executionId,
                invocationId,
                bindingShaOr: storedDigest,
              }),
            ),
          );
        }),
        appLayer(),
      ),
    );
  });

  it("does not raise Attention for an exact valid immutable binding", async () => {
    await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          yield* seedTables;
          const sql = yield* SqlClient;
          const value = {
            ...binding(),
            canonicalArgumentsDigest: canonicalArgumentsDigestV1({
              command: "pwd",
            }),
          };
          const digest = recoveryBindingV1Digest(value);
          yield* sql.unsafe(
            `UPDATE tool_invocations SET recovery_binding_state = 'Bound',
               recovery_binding_sha256 = ? WHERE invocation_id = ?`,
            [digest, invocationId],
          );
          yield* sql.unsafe(
            `INSERT INTO tool_invocation_recovery_bindings VALUES (?, 1, ?, ?)`,
            [invocationId, canonicalizeRecoveryBindingV1(value), digest],
          );
          yield* sql.unsafe(
            `INSERT INTO tool_invocation_effect_attempts VALUES (?, 0, ?)`,
            [invocationId, value.profileId],
          );
          yield* sql.unsafe(
            `INSERT INTO agent_loop_steps VALUES (?, 0, 0, ?, 'ActionsInProgress')`,
            [executionId, value.providerTurnId],
          );
          yield* sql.unsafe(
            `INSERT INTO agent_loop_step_actions VALUES (?, 0, 0, 0, ?, ?,
               'Executable', 'shell', ?, 'Pending')`,
            [
              executionId,
              value.logicalActionId,
              value.callRef,
              sha256Hex(argumentsJson),
            ],
          );
          expect(yield* listFailures()).toEqual([]);
        }),
        appLayer(),
      ),
    );
  });

  it.each([
    ["malformed digest", "not-a-digest", intentAt],
    ["invalid intent time", null, "not-an-instant"],
  ])(
    "fails closed for %s without fabricating Attention",
    async (_label, digest, time) => {
      await Effect.runPromise(
        Effect.provide(
          Effect.gen(function* () {
            yield* seedTables;
            const sql = yield* SqlClient;
            if (digest !== null) {
              yield* sql.unsafe(
                `UPDATE tool_invocations SET recovery_binding_sha256 = ? WHERE invocation_id = ?`,
                [digest, invocationId],
              );
            }
            if (time !== intentAt) {
              yield* sql.unsafe(
                `UPDATE tool_invocations SET intent_at = ? WHERE invocation_id = ?`,
                [time, invocationId],
              );
            }
            const result = yield* Effect.result(listFailures());
            expect(result._tag).toBe("Failure");
            if (result._tag === "Failure") {
              expect(result.failure).toMatchObject({
                _tag: "PersistenceCorruption",
                repository: "AttentionProjectionStore",
                operation: "sandbox-recovery-binding-read",
              });
            }
          }),
          appLayer(),
        ),
      );
    },
  );
});
