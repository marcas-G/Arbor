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
  Clock,
  canonicalizeRecoveryBindingV1,
  IdGenerator,
  type InvocationAuthority,
  type RecoveryBindingV1,
  recoveryBindingV1Digest,
  type ToolExecutionContext,
  type ToolInvocationIntent,
  ToolInvocationStore,
  type ToolObservationEvidenceObservation,
  ToolObservationEvidenceStore,
  ToolObservationReplayAttentionFactStore,
  type ToolObservationSettlement,
  TransactionPort,
  verifyRecoveryBindingV1,
} from "@arbor/ports";
import { Effect, Exit, Layer } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { afterEach, describe, expect, it } from "vitest";
import {
  createSchema42TestDatabase,
  type Schema42TestDatabase,
} from "../../../tests/support/schema42-database.js";
import {
  CURRENT_MIGRATIONS,
  DomainEventJournalLive,
  layer,
  ToolInvocationStoreLive,
  ToolObservationEvidenceStoreLive,
  ToolObservationReplayAttentionFactStoreLive,
  TransactionPortLive,
} from "../src/index.js";
import { encodeToolObservationEvidence } from "../src/tool-observation-evidence-codec.js";

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
const artifactId = "art_018f2b3c-4d5e-7abc-8def-0123456789a2";
const workerId = "worker:p40";
const incarnationId = "incarnation:p40";
const now = "2026-10-11T00:00:01.000Z";
const databases: Schema42TestDatabase[] = [];
const fence = {
  executionId,
  workerId,
  workerIncarnationId: incarnationId,
  fencingGeneration: 0 as LeaseGeneration,
} as NonNullable<ToolExecutionContext["executionFence"]>;

const intent: ToolInvocationIntent = {
  invocationId,
  executionId,
  workspaceId,
  toolName: "write_once",
  toolVersion: "1",
  sideEffectSemantics: "Idempotent",
  argumentsJson: "{}",
  resolvedRegions: [],
  approvalId: null,
  intentAt: now,
};

const authenticatedRnoEvidence = (factId: string) => {
  const binding: RecoveryBindingV1 = {
    bindingVersion: 1,
    digestAlgorithm: "SHA-256",
    executionId,
    invocationId,
    providerTurnId: "ptn_00000000-0000-7000-8000-000000000003" as never,
    logicalStepNo: 0,
    repairAttempt: 0,
    logicalActionId: "action-1",
    actionIndex: 0,
    callRef: "call-1",
    toolName: "patch",
    toolVersion: intent.toolVersion,
    toolDefinitionHash: "a".repeat(64),
    sideEffectSemantics: "Idempotent",
    canonicalArgumentsDigest: "b".repeat(64),
    targetResourceIdentityDigest: "c".repeat(64),
    resourceBoundaryRevision: 2,
    environmentRevision: "0",
    authoritySourceRevision: "authority-source",
    principalId: "user-1",
    capability: ["fs:write"],
    permissionGrantRevisions: [["pgr_1", 3]],
    workspacePolicyRevision: 4,
    projectPolicyRevision: 5,
    controlBasisDigest: "d".repeat(64),
    approvalId: null,
    approvalSubject: null,
    approvalPreConsumeRevision: null,
    approvalConsumedRevision: null,
    approvalExpiresAt: null,
    approvalTargetDigest: null,
    approvalActionDigest: null,
    approvalConsumedBy: null,
    profileId: "profile-1",
    profileVersion: "1",
    profileHash: "e".repeat(64),
    profileProtocol: "reconcile-v1",
    effectKey: "effect-key",
  };
  const canonicalJson = canonicalizeRecoveryBindingV1(binding);
  const bindingSha = recoveryBindingV1Digest(binding);
  const verifiedBinding = verifyRecoveryBindingV1({
    invocationId,
    canonicalJson,
    bindingSha256: bindingSha,
  });
  if (verifiedBinding === null) throw new Error("invalid P39 test binding");
  return {
    binding: verifiedBinding,
    attempt: {
      invocationId,
      attemptNo: 1 as const,
      admissionState: "MayHaveStarted" as const,
      bindingSha256: bindingSha,
      toolDefinitionHash: binding.toolDefinitionHash,
      sideEffectSemantics: binding.sideEffectSemantics,
      profileId: binding.profileId,
      profileVersion: binding.profileVersion,
      profileHash: binding.profileHash,
      profileProtocol: binding.profileProtocol,
      effectKey: binding.effectKey,
      admittedAt: now,
      admissionSource: "P39Admission" as const,
      admissionTimePrecision: "TransactionTimestamp" as const,
    },
    fact: {
      factId,
      invocationId,
      attemptNo: 1 as const,
      bindingSha256: bindingSha,
      profileHash: binding.profileHash,
      effectKey: binding.effectKey,
      factOrigin: "ProfileReconciliation" as const,
      legacyReason: null,
      factDisposition: "RecoveryInput" as const,
      outcome: "NotOccurred" as const,
      reasonCode: null,
      evidenceRef: "art_018f2b3c-4d5e-7abc-8def-0123456789a3",
      evidenceSha256: "c".repeat(64),
      resultRef: null,
      observedAt: now,
    },
  };
};

const makeApp = (filename = ":memory:") => {
  const sqlite = layer({ filename });
  return Layer.mergeAll(
    sqlite,
    Layer.provide(TransactionPortLive, sqlite),
    Layer.provide(ToolInvocationStoreLive, sqlite),
    Layer.provide(ToolObservationEvidenceStoreLive, sqlite),
  );
};

const bindP39Intent = (evidence = authenticatedRnoEvidence("f".repeat(64))) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    yield* sql.unsafe(
      `INSERT INTO tool_invocation_recovery_bindings (
      invocation_id, binding_version, canonical_binding_json,
      binding_sha256, created_at
    ) VALUES (?, 1, ?, ?, ?)`,
      [
        invocationId,
        evidence.binding.canonicalJson,
        evidence.binding.bindingSha256,
        now,
      ],
    );
    yield* sql.unsafe(
      `UPDATE tool_invocations
        SET recovery_binding_state = 'Bound', recovery_binding_sha256 = ?
      WHERE invocation_id = ?`,
      [evidence.binding.bindingSha256, invocationId],
    );
  });

const seedWorkspaceExecution = Effect.gen(function* () {
  const sql = yield* SqlClient;
  yield* sql.withTransaction(
    Effect.gen(function* () {
      yield* sql.unsafe(
        `INSERT INTO projects (
      project_id, name, root_workspace_id, project_policy,
      project_policy_revision, default_configuration, environment_ref,
      lifecycle, revision, created_at, updated_at
    ) VALUES (?, 'P40', ?, '{}', 0, '{}', 'local', 'Open', 0, 't0', 't0')`,
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
        [executionId, workerId, incarnationId],
      );
    }),
  );
});

describe("P40 P4 persistent observation admission gates", () => {
  afterEach(() => {
    for (const database of databases.splice(0)) database.cleanup();
  });

  it("keeps the maintenance-only P39 descriptor outside runtime migration prefixes", () => {
    expect(CURRENT_MIGRATIONS.some(({ id }) => id === 39)).toBe(false);
  });

  it("rejects a NotAdmitted Success before artifact materialization or settlement writes", async () => {
    const database = await createSchema42TestDatabase();
    databases.push(database);
    const app = makeApp(database.databaseFilename);
    const program = Effect.gen(function* () {
      yield* seedWorkspaceExecution;
      const tx = yield* TransactionPort;
      const invocations = yield* ToolInvocationStore;
      const evidenceStore = yield* ToolObservationEvidenceStore;
      const sql = yield* SqlClient;
      yield* tx.transact(invocations.recordIntent(intent, fence, now));
      yield* bindP39Intent();
      const missingFence = yield* Effect.exit(
        tx.transact(evidenceStore.read(intent, undefined as never, now)),
      );
      yield* sql.unsafe(
        `INSERT INTO artifacts (
          artifact_id, kind, blob_ref, byte_size, content_hash,
          invocation_id, execution_id, created_at
        ) VALUES (?, 'tool-result:write_once', 'blob:p40', 1, 'hash', ?, ?, ?)`,
        [artifactId, invocationId, executionId, now],
      );
      let materializeCalls = 0;
      const candidate = {
        invocation: intent,
        settlement: { _tag: "Success" as const },
        resultRef: artifactId,
        observation: {
          _tag: "Success" as const,
          observation: { text: "forged", truncated: false },
          resultRef: artifactId,
        },
        materializeResultRef: () => {
          materializeCalls += 1;
          return Effect.succeed(artifactId);
        },
        settledAt: now,
        executionFence: fence,
        fenceNow: now,
      };
      const rejected = yield* Effect.exit(
        tx.transact(evidenceStore.settleOrReadWinner(candidate)),
      );
      const encoded = encodeToolObservationEvidence({
        settlement: { _tag: "Success" },
        observation: {
          _tag: "Success",
          observation: { text: "forged", truncated: false },
          resultRef: artifactId,
        },
        resultRef: artifactId,
      });
      if (encoded._tag !== "Encoded") throw new Error("bad fixture");
      const directStoreBypass = yield* Effect.exit(
        sql.unsafe(
          `UPDATE tool_invocations SET
             settled_at = ?, settlement_kind = 'Success',
             settlement_json = ?, result_ref = ?,
             observation_format_version = ?, observation_json = ?,
             observation_sha256 = ?, settlement_provenance = 'Ordinary'
           WHERE invocation_id = ?`,
          [
            now,
            JSON.stringify({ _tag: "Success" }),
            artifactId,
            encoded.evidence.formatVersion,
            encoded.evidence.bytes,
            encoded.evidence.sha256,
            invocationId,
          ],
        ),
      );
      const row = yield* sql.unsafe<{
        readonly settled_at: string | null;
        readonly settlement_provenance: string | null;
        readonly result_ref: string | null;
        readonly observation_json: Uint8Array | null;
      }>(
        `SELECT settled_at, settlement_provenance, result_ref, observation_json
           FROM tool_invocations WHERE invocation_id = ?`,
        [invocationId],
      );
      return {
        missingFence,
        rejected,
        directStoreBypass,
        row: row[0],
        materializeCalls,
      };
    });
    const result = await Effect.runPromise(Effect.provide(program, app));
    expect(Exit.isFailure(result.rejected)).toBe(true);
    expect(Exit.isFailure(result.missingFence)).toBe(true);
    expect(Exit.isFailure(result.directStoreBypass)).toBe(true);
    expect(result.materializeCalls).toBe(0);
    expect(result.row).toEqual({
      settled_at: null,
      settlement_provenance: null,
      result_ref: null,
      observation_json: null,
    });
  }, 120_000);

  it("rejects a 2,001-unit P4 candidate before materializing its Artifact", async () => {
    const database = await createSchema42TestDatabase();
    databases.push(database);
    const app = makeApp(database.databaseFilename);
    const program = Effect.gen(function* () {
      yield* seedWorkspaceExecution;
      const tx = yield* TransactionPort;
      const invocations = yield* ToolInvocationStore;
      const evidenceStore = yield* ToolObservationEvidenceStore;
      const sql = yield* SqlClient;
      yield* tx.transact(invocations.recordIntent(intent, fence, now));
      yield* bindP39Intent();
      yield* sql.unsafe(
        "UPDATE tool_invocations SET effect_admission_state = 'MayHaveStarted' WHERE invocation_id = ?",
        [invocationId],
      );
      let materializeCalls = 0;
      const rejected = yield* Effect.exit(
        tx.transact(
          evidenceStore.settleOrReadWinner({
            invocation: intent,
            settlement: { _tag: "Success" },
            resultRef: null,
            observation: {
              _tag: "Success",
              observation: { text: "x".repeat(2_001), truncated: false },
              resultRef: null,
            },
            materializeResultRef: () => {
              materializeCalls += 1;
              return Effect.succeed(artifactId);
            },
            settledAt: now,
            executionFence: fence,
            fenceNow: now,
          }),
        ),
      );
      const state = yield* sql.unsafe<{
        readonly settled_at: string | null;
        readonly result_artifacts: number;
      }>(
        `SELECT settled_at,
                (SELECT COUNT(*) FROM artifacts WHERE artifact_id = ?) AS result_artifacts
           FROM tool_invocations WHERE invocation_id = ?`,
        [artifactId, invocationId],
      );
      return { rejected, materializeCalls, state: state[0] };
    });
    const result = await Effect.runPromise(Effect.provide(program, app));
    expect(Exit.isFailure(result.rejected)).toBe(true);
    expect(result.materializeCalls).toBe(0);
    expect(result.state).toEqual({ settled_at: null, result_artifacts: 0 });
  }, 120_000);

  it("persists and idempotently replays a Stop-winning NotAdmitted Interrupted observation", async () => {
    const database = await createSchema42TestDatabase();
    databases.push(database);
    const app = makeApp(database.databaseFilename);
    const program = Effect.gen(function* () {
      yield* seedWorkspaceExecution;
      const tx = yield* TransactionPort;
      const invocations = yield* ToolInvocationStore;
      const evidenceStore = yield* ToolObservationEvidenceStore;
      const sql = yield* SqlClient;
      yield* tx.transact(invocations.recordIntent(intent, fence, now));
      yield* bindP39Intent();
      yield* sql.unsafe(
        "UPDATE executions SET stop_requested_at = ? WHERE execution_id = ?",
        [now, executionId],
      );
      const authority: InvocationAuthority = {
        principal: "user:p40" as never,
        workspaceId,
        executionId,
        toolName: intent.toolName,
        toolVersion: intent.toolVersion,
        resourceSpaceIds: [],
        allowedCapabilities: [],
        controlBasisDigest: "control-basis",
        expiresAt: "2999-01-01T00:00:00.000Z",
        delegationDepth: 0,
        sourceRevision: "source-revision",
      };
      const admission = yield* tx.transact(
        invocations.admitEffect(invocationId, authority, now, fence),
      );
      const candidate = {
        invocation: intent,
        settlement: { _tag: "Interrupted" as const },
        resultRef: null,
        observation: { _tag: "Interrupted" as const },
        settledAt: now,
        executionFence: fence,
        fenceNow: now,
      };
      const first = yield* tx.transact(
        evidenceStore.settleOrReadWinner(candidate),
      );
      const replay = yield* tx.transact(evidenceStore.read(intent, fence, now));
      const repeated = yield* tx.transact(
        evidenceStore.settleOrReadWinner(candidate),
      );
      if (first._tag !== "Applied" || repeated._tag !== "Existing") {
        throw new Error(
          "Interrupted Stop candidate did not preserve its winner",
        );
      }
      const rows = yield* sql.unsafe<{
        readonly effect_admission_state: string;
        readonly settlement_kind: string | null;
        readonly observation_format_version: string | null;
        readonly observation_json: Uint8Array | null;
        readonly observation_sha256: string | null;
      }>(
        `SELECT effect_admission_state, settlement_kind,
                observation_format_version, observation_json,
                observation_sha256
           FROM tool_invocations WHERE invocation_id = ?`,
        [invocationId],
      );
      return { admission, first, replay, repeated, row: rows[0] };
    });
    const result = await Effect.runPromise(Effect.provide(program, app));
    expect(result.admission).toEqual({ _tag: "ExecutionStopping" });
    expect(result.first._tag).toBe("Applied");
    expect(result.replay.observation).toEqual({ _tag: "Interrupted" });
    expect(result.repeated._tag).toBe("Existing");
    expect(result.repeated.evidence).toEqual(result.first.evidence);
    expect(result.row).toMatchObject({
      effect_admission_state: "NotAdmitted",
      settlement_kind: "Interrupted",
      observation_format_version: "p4-canonical-tool-observation-v1",
      observation_sha256: result.first.evidence.sha256,
    });
    expect(
      new TextDecoder().decode(
        result.row?.observation_json ?? new Uint8Array(),
      ),
    ).toBe('{"_tag":"Interrupted"}');
  }, 120_000);

  it.each([
    {
      name: "Success",
      effectAdmissionState: "MayHaveStarted",
      settlement: { _tag: "Success" },
      observation: {
        _tag: "Success",
        observation: { text: "committed-success", truncated: false },
        resultRef: null,
      },
    },
    {
      name: "ExpectedFailure",
      effectAdmissionState: "MayHaveStarted",
      settlement: { _tag: "ExpectedFailure" },
      observation: {
        _tag: "ExpectedFailure",
        observation: { text: "committed-failure", truncated: false },
      },
    },
    {
      name: "OutcomeUnknown",
      effectAdmissionState: "MayHaveStarted",
      settlement: {
        _tag: "OutcomeUnknown",
        reconciliationRefs: [String(invocationId)],
      },
      observation: {
        _tag: "OutcomeUnknown",
        reconciliationRefs: [String(invocationId)],
      },
    },
    {
      name: "RuntimeFailure",
      effectAdmissionState: "MayHaveStarted",
      settlement: { _tag: "RuntimeFailure", cause: "committed-runtime-error" },
      observation: { _tag: "RuntimeFailure", cause: "committed-runtime-error" },
    },
  ] as const)(
    "a Stop candidate preserves an already committed $name P40 winner",
    async (winnerCase) => {
      const database = await createSchema42TestDatabase();
      databases.push(database);
      const app = makeApp(database.databaseFilename);
      const program = Effect.gen(function* () {
        yield* seedWorkspaceExecution;
        const tx = yield* TransactionPort;
        const invocations = yield* ToolInvocationStore;
        const evidenceStore = yield* ToolObservationEvidenceStore;
        const sql = yield* SqlClient;
        yield* tx.transact(invocations.recordIntent(intent, fence, now));
        yield* bindP39Intent();
        if (winnerCase.effectAdmissionState === "MayHaveStarted") {
          yield* sql.unsafe(
            "UPDATE tool_invocations SET effect_admission_state = 'MayHaveStarted' WHERE invocation_id = ?",
            [invocationId],
          );
        }
        const winningObservation =
          winnerCase.observation as ToolObservationEvidenceObservation;
        const winningSettlement =
          winnerCase.settlement as ToolObservationSettlement;
        const winner = yield* tx.transact(
          evidenceStore.settleOrReadWinner({
            invocation: intent,
            settlement: winningSettlement,
            resultRef: null,
            observation: winningObservation,
            settledAt: now,
            executionFence: fence,
            fenceNow: now,
          }),
        );
        const stopRacer = yield* tx.transact(
          evidenceStore.settleOrReadWinner({
            invocation: intent,
            settlement: { _tag: "Interrupted" },
            resultRef: null,
            observation: { _tag: "Interrupted" },
            settledAt: now,
            executionFence: fence,
            fenceNow: now,
          }),
        );
        const rows = yield* sql.unsafe<{
          readonly effect_admission_state: string;
          readonly settlement_kind: string | null;
        }>(
          `SELECT effect_admission_state, settlement_kind
             FROM tool_invocations WHERE invocation_id = ?`,
          [invocationId],
        );
        return { winner, stopRacer, row: rows[0] };
      });
      const result = await Effect.runPromise(Effect.provide(program, app));
      expect(result.winner._tag).toBe("Applied");
      expect(result.stopRacer._tag).toBe("Existing");
      if (result.stopRacer._tag !== "Existing") {
        throw new Error("Stop candidate did not return the committed winner");
      }
      expect(result.stopRacer.evidence.observation).toEqual(
        winnerCase.observation,
      );
      expect(result.row).toEqual({
        effect_admission_state: winnerCase.effectAdmissionState,
        settlement_kind: winnerCase.name,
      });
    },
  );

  it("returns a committed P4 Denied row as ExistingDenied to a later Stop candidate", async () => {
    const database = await createSchema42TestDatabase();
    databases.push(database);
    const app = makeApp(database.databaseFilename);
    const program = Effect.gen(function* () {
      yield* seedWorkspaceExecution;
      const tx = yield* TransactionPort;
      const invocations = yield* ToolInvocationStore;
      const evidenceStore = yield* ToolObservationEvidenceStore;
      yield* tx.transact(
        invocations.recordNoEffectDenial(
          intent,
          "InvocationAuthorityDenied",
          now,
          fence,
          now,
        ),
      );
      return yield* tx.transact(
        evidenceStore.settleOrReadWinner({
          invocation: intent,
          settlement: { _tag: "Interrupted" },
          resultRef: null,
          observation: { _tag: "Interrupted" },
          settledAt: now,
          executionFence: fence,
          fenceNow: now,
        }),
      );
    });
    const result = await Effect.runPromise(Effect.provide(program, app));
    expect(result).toEqual({
      _tag: "ExistingDenied",
      reasonCode: "InvocationAuthorityDenied",
    });
  }, 120_000);

  it("returns only the committed winner to a fenced loser and rejects that same fence after takeover", async () => {
    const database = await createSchema42TestDatabase();
    databases.push(database);
    const app = makeApp(database.databaseFilename);
    const program = Effect.gen(function* () {
      yield* seedWorkspaceExecution;
      const tx = yield* TransactionPort;
      const invocations = yield* ToolInvocationStore;
      const evidenceStore = yield* ToolObservationEvidenceStore;
      const sql = yield* SqlClient;
      yield* tx.transact(invocations.recordIntent(intent, fence, now));
      yield* bindP39Intent();
      yield* sql.unsafe(
        "UPDATE tool_invocations SET effect_admission_state = 'MayHaveStarted' WHERE invocation_id = ?",
        [invocationId],
      );
      const successEvidence = encodeToolObservationEvidence({
        settlement: { _tag: "Success" },
        observation: {
          _tag: "Success",
          observation: { text: "winner", truncated: false },
          resultRef: null,
        },
        resultRef: null,
      });
      if (successEvidence._tag !== "Encoded") throw new Error("bad fixture");
      const winner = yield* tx.transact(
        evidenceStore.settleOrReadWinner({
          invocation: intent,
          settlement: { _tag: "Success" },
          resultRef: null,
          observation: {
            _tag: "Success",
            observation: { text: "winner", truncated: false },
            resultRef: null,
          },
          settledAt: now,
          executionFence: fence,
          fenceNow: now,
        }),
      );
      let loserMaterializeCalls = 0;
      const loser = yield* tx.transact(
        evidenceStore.settleOrReadWinner({
          invocation: intent,
          settlement: { _tag: "Success" },
          resultRef: null,
          observation: {
            _tag: "Success",
            observation: { text: "loser-local", truncated: false },
            resultRef: null,
          },
          materializeResultRef: () => {
            loserMaterializeCalls += 1;
            return Effect.succeed(artifactId);
          },
          settledAt: now,
          executionFence: fence,
          fenceNow: now,
        }),
      );
      const stopRacer = yield* tx.transact(
        evidenceStore.settleOrReadWinner({
          invocation: intent,
          settlement: { _tag: "Interrupted" },
          resultRef: null,
          observation: { _tag: "Interrupted" },
          settledAt: now,
          executionFence: fence,
          fenceNow: now,
        }),
      );
      yield* sql.unsafe(
        "UPDATE execution_leases SET generation = 1 WHERE execution_id = ?",
        [executionId],
      );
      const staleRead = yield* Effect.exit(
        tx.transact(evidenceStore.read(intent, fence, now)),
      );
      return { winner, loser, stopRacer, staleRead, loserMaterializeCalls };
    });
    const result = await Effect.runPromise(Effect.provide(program, app));
    expect(result.winner._tag).toBe("Applied");
    expect(result.loser).toMatchObject({
      _tag: "Existing",
      evidence: { observation: { observation: { text: "winner" } } },
    });
    expect(result.stopRacer).toMatchObject({
      _tag: "Existing",
      evidence: {
        observation: { _tag: "Success", observation: { text: "winner" } },
      },
    });
    expect(result.loserMaterializeCalls).toBe(0);
    expect(Exit.isFailure(result.staleRead)).toBe(true);
  }, 120_000);

  it("rolls back Artifact metadata and terminal evidence together", async () => {
    const database = await createSchema42TestDatabase();
    databases.push(database);
    const app = makeApp(database.databaseFilename);
    const program = Effect.gen(function* () {
      yield* seedWorkspaceExecution;
      const tx = yield* TransactionPort;
      const invocations = yield* ToolInvocationStore;
      const evidenceStore = yield* ToolObservationEvidenceStore;
      const sql = yield* SqlClient;
      yield* tx.transact(invocations.recordIntent(intent, fence, now));
      yield* bindP39Intent();
      yield* sql.unsafe(
        "UPDATE tool_invocations SET effect_admission_state = 'MayHaveStarted' WHERE invocation_id = ?",
        [invocationId],
      );
      const rollback = yield* Effect.exit(
        tx.transact(
          Effect.gen(function* () {
            const applied = yield* evidenceStore.settleOrReadWinner({
              invocation: intent,
              settlement: { _tag: "Success" },
              resultRef: null,
              observation: {
                _tag: "Success",
                observation: { text: "transactional result", truncated: false },
                resultRef: null,
              },
              materializeResultRef: () =>
                Effect.gen(function* () {
                  yield* sql
                    .unsafe(
                      `INSERT INTO artifacts (
                      artifact_id, kind, blob_ref, byte_size, content_hash,
                      invocation_id, execution_id, created_at
                    ) VALUES (?, 'tool-result:write_once', 'blob:p40', 1, 'hash', ?, ?, ?)`,
                      [artifactId, invocationId, executionId, now],
                    )
                    .pipe(
                      Effect.mapError((cause) => ({
                        _tag: "ArtifactError" as const,
                        cause,
                      })),
                    );
                  return artifactId;
                }),
              settledAt: now,
              executionFence: fence,
              fenceNow: now,
            });
            if (applied._tag !== "Applied") {
              return yield* Effect.fail(
                new Error("expected the fresh P4 transaction to apply"),
              );
            }
            return yield* Effect.fail(
              new Error("injected P4 transaction rollback"),
            );
          }),
        ),
      );
      const row = yield* sql.unsafe<{
        readonly settled_at: string | null;
        readonly settlement_provenance: string | null;
        readonly result_ref: string | null;
        readonly observation_json: Uint8Array | null;
        readonly artifacts: number;
      }>(
        `SELECT settled_at, settlement_provenance, result_ref, observation_json,
                (SELECT COUNT(*) FROM artifacts WHERE artifact_id = ?) AS artifacts
           FROM tool_invocations WHERE invocation_id = ?`,
        [artifactId, invocationId],
      );
      return { rollback, row: row[0] };
    });
    const result = await Effect.runPromise(Effect.provide(program, app));
    expect(Exit.isFailure(result.rollback)).toBe(true);
    expect(result.row).toEqual({
      settled_at: null,
      settlement_provenance: null,
      result_ref: null,
      observation_json: null,
      artifacts: 0,
    });
  }, 120_000);

  it("keeps a P9 replay-failure fact immutable in SQLite", async () => {
    const database = await createSchema42TestDatabase();
    databases.push(database);
    const app = makeApp(database.databaseFilename);
    const program = Effect.gen(function* () {
      yield* seedWorkspaceExecution;
      const tx = yield* TransactionPort;
      const invocations = yield* ToolInvocationStore;
      const sql = yield* SqlClient;
      yield* tx.transact(invocations.recordIntent(intent, fence, now));
      const eventId = "evt_118f2b3c-4d5e-7abc-8def-0123456789a1";
      const factId = `att_${"1".repeat(64)}`;
      yield* sql.unsafe(
        `INSERT INTO domain_events (
          event_id, project_id, sequence, event_type, event_version,
          occurred_at, aggregate_ref, actor, caused_by_command_id,
          caused_by_event_id, correlation_ref, payload_json
        ) VALUES (?, ?, 90, 'ToolObservationReplayEvidenceEscalated', 1,
          ?, ?, 'system:recovery', NULL, NULL, 'action-p40', '{}')`,
        [eventId, projectId, now, workspaceId],
      );
      yield* sql.unsafe(
        `INSERT INTO tool_observation_replay_attention_facts (
          attention_fact_id, event_id, project_id, execution_id,
          target_workspace_id, logical_action_id, provider_turn_id,
          call_ref, invocation_id, failure_code, first_detected_at
        ) VALUES (?, ?, ?, ?, ?, 'action-p40', 'ptn_018f2b3c-4d5e-7abc-8def-0123456789a1',
          'call-p40', ?, 'Missing', ?)`,
        [
          factId,
          eventId,
          projectId,
          executionId,
          workspaceId,
          invocationId,
          now,
        ],
      );
      const update = yield* Effect.exit(
        sql.unsafe(
          "UPDATE tool_observation_replay_attention_facts SET failure_code = 'Malformed' WHERE attention_fact_id = ?",
          [factId],
        ),
      );
      const deletion = yield* Effect.exit(
        sql.unsafe(
          "DELETE FROM tool_observation_replay_attention_facts WHERE attention_fact_id = ?",
          [factId],
        ),
      );
      return { update, deletion };
    });
    const result = await Effect.runPromise(Effect.provide(program, app));
    expect(Exit.isFailure(result.update)).toBe(true);
    expect(Exit.isFailure(result.deletion)).toBe(true);
  }, 120_000);

  it("rechecks the lease at the P9 fact write boundary using trusted time, not firstDetectedAt", async () => {
    const database = await createSchema42TestDatabase();
    databases.push(database);
    const sqlite = layer({ filename: database.databaseFilename });
    const ticks = ["2026-10-11T00:00:01.999Z", "2026-10-11T00:00:02.001Z"];
    const clock = Layer.succeed(Clock, {
      now: () => Effect.sync(() => ticks.shift() ?? "2026-10-11T00:00:02.001Z"),
    });
    const eventId = "evt_218f2b3c-4d5e-7abc-8def-0123456789a1";
    const ids = Layer.succeed(IdGenerator, {
      generate: <T>(_kind: string) => Effect.succeed(eventId as unknown as T),
    });
    const journal = Layer.provide(
      DomainEventJournalLive,
      Layer.mergeAll(sqlite, ids),
    );
    const factStoreLayer = Layer.provide(
      ToolObservationReplayAttentionFactStoreLive,
      Layer.mergeAll(sqlite, journal, ids, clock),
    );
    const app = Layer.mergeAll(
      sqlite,
      Layer.provide(TransactionPortLive, sqlite),
      Layer.provide(ToolInvocationStoreLive, sqlite),
      factStoreLayer,
    );
    const program = Effect.gen(function* () {
      yield* seedWorkspaceExecution;
      const tx = yield* TransactionPort;
      const sql = yield* SqlClient;
      const invocations = yield* ToolInvocationStore;
      const factStore = yield* ToolObservationReplayAttentionFactStore;
      yield* tx.transact(invocations.recordIntent(intent, fence, now));
      yield* bindP39Intent();
      yield* sql.unsafe(
        "UPDATE execution_leases SET expires_at = ? WHERE execution_id = ?",
        ["2026-10-11T00:00:02.000Z", executionId],
      );
      const firstDetectedAt = "2026-10-11T00:00:01.000Z";
      const rejected = yield* Effect.exit(
        tx.transact(
          factStore.recordFailure({
            projectId,
            executionId,
            targetWorkspaceId: workspaceId,
            logicalActionId: "act_018f2b3c-4d5e-7abc-8def-0123456789a1",
            providerTurnId: "ptn_018f2b3c-4d5e-7abc-8def-0123456789a1",
            callRef: "call-expiry-race",
            invocationId,
            failureCode: "Missing",
            firstDetectedAt,
            executionFence: fence,
          }),
        ),
      );
      const persisted = yield* sql.unsafe<{
        readonly facts: number;
        readonly events: number;
      }>(
        `SELECT
           (SELECT COUNT(*) FROM tool_observation_replay_attention_facts) AS facts,
           (SELECT COUNT(*) FROM domain_events
             WHERE event_type = 'ToolObservationReplayEvidenceEscalated') AS events`,
      );
      return { rejected, persisted: persisted[0] };
    });
    const result = await Effect.runPromise(Effect.provide(program, app));
    expect(Exit.isFailure(result.rejected)).toBe(true);
    expect(result.persisted).toEqual({ facts: 0, events: 0 });
  }, 120_000);

  it("commits a final NotOccurred selection with its exact P40 RNO Observation and never rewrites the selection", async () => {
    const database = await createSchema42TestDatabase();
    databases.push(database);
    const app = makeApp(database.databaseFilename);
    const factId = "f".repeat(64);
    const evidenceRef = "art_018f2b3c-4d5e-7abc-8def-0123456789a3";
    const evidenceSha256 = "c".repeat(64);
    const selectedP39Evidence = authenticatedRnoEvidence(factId);
    const program = Effect.gen(function* () {
      yield* seedWorkspaceExecution;
      const tx = yield* TransactionPort;
      const invocations = yield* ToolInvocationStore;
      const evidenceStore = yield* ToolObservationEvidenceStore;
      const sql = yield* SqlClient;
      yield* tx.transact(invocations.recordIntent(intent, fence, now));
      yield* bindP39Intent(selectedP39Evidence);
      yield* sql.unsafe(
        "UPDATE tool_invocations SET effect_admission_state = 'MayHaveStarted' WHERE invocation_id = ?",
        [invocationId],
      );
      yield* sql.unsafe(
        `INSERT INTO tool_invocation_effect_attempts (
          invocation_id, attempt_no, admission_state, tool_definition_hash,
          side_effect_semantics, profile_id, profile_version, profile_hash,
          profile_protocol, effect_key, binding_sha256, admitted_at,
          admission_source, admission_time_precision
        ) VALUES (?, 1, 'MayHaveStarted', ?, 'Idempotent', ?, '1', ?, ?, ?, ?, ?,
          'P39Admission', 'TransactionTimestamp')`,
        [
          invocationId,
          selectedP39Evidence.binding.value.toolDefinitionHash,
          selectedP39Evidence.binding.value.profileId,
          selectedP39Evidence.binding.value.profileHash,
          selectedP39Evidence.binding.value.profileProtocol,
          selectedP39Evidence.binding.value.effectKey,
          selectedP39Evidence.binding.bindingSha256,
          now,
        ],
      );
      yield* sql.unsafe(
        `INSERT INTO artifacts (
          artifact_id, kind, blob_ref, byte_size, content_hash,
          invocation_id, execution_id, created_at
        ) VALUES (?, 'proof', 'blob:proof', 1, ?, ?, ?, ?)`,
        [evidenceRef, evidenceSha256, invocationId, executionId, now],
      );
      yield* sql.unsafe(
        `INSERT INTO tool_reconciliation_facts (
          fact_id, invocation_id, attempt_no, profile_hash, effect_key,
          fact_origin, fact_disposition, binding_sha256, outcome,
          evidence_ref, evidence_sha256, result_ref, observed_at
        ) VALUES (?, ?, 1, ?, ?,
          'ProfileReconciliation', 'RecoveryInput', ?, 'NotOccurred', ?, ?, NULL, ?)`,
        [
          factId,
          invocationId,
          selectedP39Evidence.binding.value.profileHash,
          selectedP39Evidence.binding.value.effectKey,
          selectedP39Evidence.binding.bindingSha256,
          evidenceRef,
          evidenceSha256,
          now,
        ],
      );
      yield* sql.unsafe(
        `INSERT INTO artifacts (
          artifact_id, kind, blob_ref, byte_size, content_hash,
          invocation_id, execution_id, created_at
        ) VALUES (?, 'tool-result:write_once', 'blob:rno', 4, 'result-hash', ?, ?, ?)`,
        [artifactId, invocationId, executionId, now],
      );
      const observation = {
        _tag: "ReconciledNoEffect" as const,
        reasonCode: "ReplayLimitReached" as const,
        reconciliationFactRef: factId,
        observation: { text: "effect did not occur", truncated: false },
        resultRef: artifactId,
      };
      const applied = yield* tx.transact(
        evidenceStore.settleOrReadWinner({
          invocation: intent,
          settlement: {
            _tag: "ReconciledNoEffect",
            reasonCode: "ReplayLimitReached",
            reconciliationFactRef: factId,
          },
          resultRef: artifactId,
          observation,
          reconciliationSelection: { attemptNo: 1, factId },
          authenticatedRecoveryEvidence: selectedP39Evidence,
          settledAt: now,
          executionFence: fence,
          fenceNow: now,
        }),
      );
      const replay = yield* tx.transact(evidenceStore.read(intent, fence, now));
      const stopRacer = yield* tx.transact(
        evidenceStore.settleOrReadWinner({
          invocation: intent,
          settlement: { _tag: "Interrupted" },
          resultRef: null,
          observation: { _tag: "Interrupted" },
          settledAt: now,
          executionFence: fence,
          fenceNow: now,
        }),
      );
      const rewritten = yield* Effect.exit(
        sql.unsafe(
          "UPDATE tool_invocations SET selected_fact_id = ? WHERE invocation_id = ?",
          ["a".repeat(64), invocationId],
        ),
      );
      const selection = yield* sql.unsafe<{
        readonly selected_attempt_no: number | null;
        readonly selected_fact_id: string | null;
        readonly p39_result_ref: string | null;
        readonly p4_result_ref: string | null;
      }>(
        `SELECT selected_attempt_no, selected_fact_id,
                (SELECT result_ref FROM tool_reconciliation_facts WHERE fact_id = ?) AS p39_result_ref,
                result_ref AS p4_result_ref
           FROM tool_invocations WHERE invocation_id = ?`,
        [factId, invocationId],
      );
      return { applied, replay, stopRacer, rewritten, selection: selection[0] };
    });
    const result = await Effect.runPromise(Effect.provide(program, app));
    expect(result.applied._tag).toBe("Applied");
    expect(result.replay.observation).toEqual({
      _tag: "ReconciledNoEffect",
      reasonCode: "ReplayLimitReached",
      reconciliationFactRef: factId,
      observation: { text: "effect did not occur", truncated: false },
      resultRef: artifactId,
    });
    expect(result.stopRacer).toMatchObject({
      _tag: "Existing",
      evidence: { observation: { _tag: "ReconciledNoEffect" } },
    });
    expect(Exit.isFailure(result.rewritten)).toBe(true);
    expect(result.selection).toEqual({
      selected_attempt_no: 1,
      selected_fact_id: factId,
      p39_result_ref: null,
      p4_result_ref: artifactId,
    });
  }, 120_000);
});
