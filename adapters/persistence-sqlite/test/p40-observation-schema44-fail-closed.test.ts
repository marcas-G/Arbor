import {
  ExecutionId,
  type LeaseGeneration,
  ProjectId,
  parse,
  SessionId,
  ToolInvocationId,
  WorkspaceId,
} from "@arbor/domain";
import {
  canonicalizeRecoveryBindingV1,
  type RecoveryBindingV1,
  recoveryBindingV1Digest,
  type ToolExecutionContext,
  type ToolInvocationIntent,
  ToolInvocationStore,
  ToolObservationEvidenceStore,
  TransactionPort,
} from "@arbor/ports";
import { Effect, Layer } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createSchema44TestDatabaseFactory,
  type Schema44TestDatabaseFactory,
  withSchema44TestDatabase,
} from "../../../tests/support/schema44-database.js";
import {
  layer,
  ToolInvocationStoreLive,
  ToolObservationEvidenceStoreLive,
  TransactionPortLive,
} from "../src/index.js";

const projectId = parse(ProjectId)("prj_018f2b3c-4d5e-7abc-8def-0123456789a1");
const workspaceId = parse(WorkspaceId)(
  "ws_018f2b3c-4d5e-7abc-8def-0123456789a1",
);
const sessionId = parse(SessionId)("ses_018f2b3c-4d5e-7abc-8def-0123456789a1");
const executionId = parse(ExecutionId)(
  "exe_018f2b3c-4d5e-7abc-8def-0123456789a1",
);
const invocationId = parse(ToolInvocationId)(
  "tin_018f2b3c-4d5e-7abc-8def-0123456789a1",
);
const now = "2026-10-16T00:00:01.000Z";
const fence = {
  executionId,
  workerId: "worker:p40-schema44",
  workerIncarnationId: "incarnation:p40-schema44",
  fencingGeneration: 0 as LeaseGeneration,
} as NonNullable<ToolExecutionContext["executionFence"]>;
const intent: ToolInvocationIntent = {
  invocationId,
  executionId,
  workspaceId,
  toolName: "read",
  toolVersion: "2",
  sideEffectSemantics: "ReadOnly",
  argumentsJson: "{}",
  resolvedRegions: [],
  approvalId: null,
  intentAt: now,
};

const makeApp = (filename: string) => {
  const sqlite = layer({ filename });
  return Layer.mergeAll(
    sqlite,
    Layer.provide(TransactionPortLive, sqlite),
    Layer.provide(ToolInvocationStoreLive, sqlite),
    Layer.provide(ToolObservationEvidenceStoreLive, sqlite),
  );
};

let schema44Factory: Schema44TestDatabaseFactory | undefined;

beforeAll(async () => {
  schema44Factory = await createSchema44TestDatabaseFactory({
    prefix: ".p40-observation-schema44-template-",
  });
}, 120_000);

afterAll(() => schema44Factory?.cleanup());

const seedWorkspaceExecution = Effect.gen(function* () {
  const sql = yield* SqlClient;
  yield* sql.withTransaction(
    Effect.gen(function* () {
      yield* sql.unsafe(
        `INSERT INTO projects (
          project_id, name, root_workspace_id, project_policy,
          project_policy_revision, default_configuration, environment_ref,
          lifecycle, revision, created_at, updated_at
        ) VALUES (?, 'P40 schema44', ?, '{}', 0, '{}', 'local', 'Open', 0, 't0', 't0')`,
        [projectId, workspaceId],
      );
      yield* sql.unsafe(
        `INSERT INTO sessions (
          session_id, binding_kind, workspace_id, execution_id,
          context_epoch, created_at
        ) VALUES (?, 'WorkspacePrimary', ?, NULL, 0, 't0')`,
        [sessionId, workspaceId],
      );
      yield* sql.unsafe(
        `INSERT INTO workspaces (
          workspace_id, project_id, parent_workspace_id, name,
          responsibility_definition, responsibility_revision,
          resource_boundary, resource_boundary_revision, agent_binding,
          primary_session_id, current_work_id, workspace_policy,
          workspace_policy_revision, revision, lifecycle, created_at, updated_at
        ) VALUES (?, ?, NULL, 'root', '{}', 0, '{}', 0, '{}', ?, NULL, '{}', 0, 0, 'Active', 't0', 't0')`,
        [workspaceId, projectId, sessionId],
      );
      yield* sql.unsafe(
        `INSERT INTO executions (
          execution_id, project_id, binding_kind, workspace_id,
          episode_kind, episode_ref, episode_revision, parent_execution_id,
          mission, session_id, admitted_at, stop_requested_at,
          settlement_kind, settlement_json, settled_at
        ) VALUES (?, ?, 'execution_bound', ?, NULL, NULL, NULL, NULL,
          'fixture', ?, 't0', NULL, NULL, NULL, NULL)`,
        [executionId, projectId, workspaceId, sessionId],
      );
      yield* sql.unsafe(
        `INSERT INTO execution_leases (
          execution_id, worker_id, worker_incarnation_id, generation,
          expires_at, updated_at
        ) VALUES (?, ?, ?, 0, '2999-01-01T00:00:00.000Z', 't0')`,
        [executionId, fence.workerId, fence.workerIncarnationId],
      );
    }),
  );
});

const seedSettledExpectedFailure = Effect.gen(function* () {
  yield* seedWorkspaceExecution;
  const tx = yield* TransactionPort;
  const invocations = yield* ToolInvocationStore;
  const evidence = yield* ToolObservationEvidenceStore;
  const sql = yield* SqlClient;
  yield* tx.transact(invocations.recordIntent(intent, fence, now));
  const binding: RecoveryBindingV1 = {
    bindingVersion: 1,
    digestAlgorithm: "SHA-256",
    executionId,
    invocationId,
    providerTurnId: "ptn_018f2b3c-4d5e-7abc-8def-0123456789a3" as never,
    logicalStepNo: 0,
    repairAttempt: 0,
    logicalActionId: "action-p40-schema44",
    actionIndex: 0,
    callRef: "call-p40-schema44",
    toolName: intent.toolName,
    toolVersion: intent.toolVersion,
    toolDefinitionHash: "a".repeat(64),
    sideEffectSemantics: intent.sideEffectSemantics,
    canonicalArgumentsDigest: "b".repeat(64),
    targetResourceIdentityDigest: "c".repeat(64),
    resourceBoundaryRevision: 0,
    environmentRevision: "env-p40-schema44",
    authoritySourceRevision: null,
    principalId: "worker:p40-schema44",
    capability: ["fs:read"],
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
    profileId: null,
    profileVersion: null,
    profileHash: null,
    profileProtocol: null,
    effectKey: null,
  };
  const bindingJson = canonicalizeRecoveryBindingV1(binding);
  const bindingSha256 = recoveryBindingV1Digest(binding);
  yield* sql.unsafe(
    `INSERT INTO tool_invocation_recovery_bindings (
      invocation_id, binding_version, canonical_binding_json,
      binding_sha256, created_at
    ) VALUES (?, 1, ?, ?, ?)`,
    [invocationId, bindingJson, bindingSha256, now],
  );
  yield* sql.unsafe(
    `UPDATE tool_invocations SET recovery_binding_state = 'Bound',
      recovery_binding_sha256 = ? WHERE invocation_id = ?`,
    [bindingSha256, invocationId],
  );
  yield* sql.unsafe(
    "UPDATE tool_invocations SET effect_admission_state = 'MayHaveStarted' WHERE invocation_id = ?",
    [invocationId],
  );
  yield* tx.transact(
    evidence.settleOrReadWinner({
      invocation: intent,
      settlement: { _tag: "ExpectedFailure" },
      resultRef: null,
      observation: {
        _tag: "ExpectedFailure",
        observation: {
          text: "original bounded failure",
          truncated: false,
        },
      },
      settledAt: now,
      executionFence: fence,
      fenceNow: now,
    }),
  );
});

describe("P40 schema-44 observation evidence read failures", () => {
  it.each([
    { damage: "missing" as const, failureCode: "Missing" as const },
    { damage: "corrupt" as const, failureCode: "HashMismatch" as const },
  ])(
    "fails closed for $damage terminal Observation evidence",
    async ({ damage, failureCode }) => {
      const factory = schema44Factory;
      if (factory === undefined)
        throw new Error("schema-44 fixture unavailable");
      await withSchema44TestDatabase(factory, async (database) => {
        const app = makeApp(database.databaseFilename);
        const result = await Effect.runPromise(
          Effect.scoped(
            Effect.provide(
              Effect.gen(function* () {
                yield* seedSettledExpectedFailure;
                const sql = yield* SqlClient;
                const version = yield* sql.unsafe<{
                  readonly user_version: number;
                }>("PRAGMA user_version");
                expect(Number(version[0]?.user_version)).toBe(44);
                yield* sql.unsafe(
                  "DROP TRIGGER tool_invocations_observation_update_guard",
                );
                if (damage === "missing") {
                  yield* sql.unsafe(
                    `UPDATE tool_invocations SET observation_format_version = NULL,
                    observation_json = NULL, observation_sha256 = NULL
                    WHERE invocation_id = ?`,
                    [invocationId],
                  );
                } else {
                  yield* sql.unsafe(
                    `UPDATE tool_invocations SET observation_sha256 = ?
                    WHERE invocation_id = ?`,
                    ["0".repeat(64), invocationId],
                  );
                }
                const tx = yield* TransactionPort;
                const evidence = yield* ToolObservationEvidenceStore;
                const read = yield* Effect.match(
                  tx.transact(evidence.read(intent, fence, now)),
                  {
                    onFailure: (cause) => ({ ok: false as const, cause }),
                    onSuccess: (value) => ({ ok: true as const, value }),
                  },
                );
                return read;
              }),
              app,
            ),
          ),
        );
        expect(result.ok).toBe(false);
        if (result.ok)
          throw new Error("damaged P40 evidence unexpectedly decoded");
        expect(result.cause).toMatchObject({
          _tag: "ToolObservationReplayEvidenceFailure",
          invocationId,
          failureCode,
        });
      });
    },
  );
});
