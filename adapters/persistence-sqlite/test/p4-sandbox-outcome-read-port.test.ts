import { ExecutionId, parse } from "@arbor/domain";
import {
  canonicalArgumentsDigestV1,
  canonicalizeRecoveryBindingV1,
  P4_TOOL_OBSERVATION_FORMAT_V1,
  P4SandboxOutcomeReadPort,
  type RecoveryBindingV1,
  recoveryBindingV1Digest,
  sha256Hex,
  TransactionPort,
} from "@arbor/ports";
import { Effect, Layer } from "effect";
import {
  SqlClient,
  type SqlClient as SqlClientService,
} from "effect/unstable/sql/SqlClient";
import { describe, expect, it } from "vitest";
import { layer, TransactionPortLive } from "../src/index.js";
import { P4SandboxOutcomeReadPortLive } from "../src/p4-sandbox-outcome-read-port.js";
import { encodeToolObservationEvidence } from "../src/tool-observation-evidence-codec.js";

const executionId = parse(ExecutionId)(
  "exe_018f2b3c-4d5e-7abc-8def-0123456789a1",
);
const workspaceId = "ws_018f2b3c-4d5e-7abc-8def-0123456789a1";
const summary =
  "required sandbox capability was unavailable or could not be verified; execution did not start";
const invocationId = "tin_018f2b3c-4d5e-7abc-8def-0123456789a1";
const providerTurnId = "ptn_018f2b3c-4d5e-7abc-8def-0123456789a1";
const logicalActionId = "action-p4-sandbox";
const callRef = "call-p4-sandbox";
const argumentsJson = '{"command":"pwd"}';
const binding: RecoveryBindingV1 = {
  bindingVersion: 1,
  digestAlgorithm: "SHA-256",
  executionId,
  invocationId: invocationId as never,
  providerTurnId: providerTurnId as never,
  logicalStepNo: 0,
  repairAttempt: 0,
  logicalActionId,
  actionIndex: 0,
  callRef,
  toolName: "shell",
  toolVersion: "1",
  toolDefinitionHash: "a".repeat(64),
  sideEffectSemantics: "NonIdempotent",
  canonicalArgumentsDigest: canonicalArgumentsDigestV1(
    JSON.parse(argumentsJson),
  ),
  targetResourceIdentityDigest: "b".repeat(64),
  resourceBoundaryRevision: 1,
  environmentRevision: "1",
  authoritySourceRevision: null,
  principalId: "user:local",
  capability: null,
  permissionGrantRevisions: [],
  workspacePolicyRevision: 0,
  projectPolicyRevision: 0,
  controlBasisDigest: "c".repeat(64),
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
  profileHash: "d".repeat(64),
  profileProtocol: "native-v1",
  effectKey: "effect-p4-sandbox",
};

const seedP4Rows = (
  sql: SqlClientService,
  evidence: { readonly bytes: Uint8Array; readonly sha256: string },
  admissionState: "MayHaveStarted" | "NotAdmitted",
) =>
  Effect.gen(function* () {
    const bindingJson = canonicalizeRecoveryBindingV1(binding);
    const bindingSha = recoveryBindingV1Digest(binding);
    yield* sql.unsafe(
      `CREATE TABLE executions (
        execution_id TEXT NOT NULL, workspace_id TEXT NOT NULL,
        settled_at TEXT, stop_requested_at TEXT
      )`,
    );
    yield* sql.unsafe(
      `CREATE TABLE tool_invocations (
        invocation_id TEXT NOT NULL, execution_id TEXT NOT NULL,
        workspace_id TEXT NOT NULL, effect_admission_state TEXT NOT NULL,
        settled_at TEXT, settlement_kind TEXT, result_ref TEXT,
        observation_format_version TEXT, observation_json BLOB,
        observation_sha256 TEXT, recovery_binding_state TEXT NOT NULL,
        recovery_binding_sha256 TEXT, arguments_json TEXT NOT NULL,
        tool_name TEXT NOT NULL, tool_version TEXT NOT NULL,
        side_effect_semantics TEXT NOT NULL
      )`,
    );
    yield* sql.unsafe(
      `CREATE TABLE tool_invocation_recovery_bindings (
        invocation_id TEXT NOT NULL, binding_version INTEGER NOT NULL,
        canonical_binding_json TEXT NOT NULL, binding_sha256 TEXT NOT NULL
      )`,
    );
    yield* sql.unsafe(
      `CREATE TABLE agent_loop_steps (
        execution_id TEXT NOT NULL, logical_step_no INTEGER NOT NULL,
        repair_attempt INTEGER NOT NULL, provider_turn_id TEXT NOT NULL,
        state TEXT NOT NULL, next_action_index INTEGER NOT NULL
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
    yield* sql.unsafe(`INSERT INTO executions VALUES (?, ?, NULL, NULL)`, [
      executionId,
      workspaceId,
    ]);
    yield* sql.unsafe(
      `INSERT INTO tool_invocations VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        invocationId,
        executionId,
        workspaceId,
        admissionState,
        "2026-10-19T00:00:00.000Z",
        "ExpectedFailure",
        null,
        P4_TOOL_OBSERVATION_FORMAT_V1,
        evidence.bytes,
        evidence.sha256,
        "Bound",
        bindingSha,
        argumentsJson,
        "shell",
        "1",
        "NonIdempotent",
      ],
    );
    yield* sql.unsafe(
      `INSERT INTO tool_invocation_recovery_bindings VALUES (?,1,?,?)`,
      [invocationId, bindingJson, bindingSha],
    );
    yield* sql.unsafe(
      `INSERT INTO agent_loop_steps VALUES (?,0,0,?,'ActionsInProgress',0)`,
      [executionId, providerTurnId],
    );
    yield* sql.unsafe(
      `INSERT INTO agent_loop_step_actions VALUES (?,0,0,0,?,?,'Executable','shell',?,'Pending')`,
      [executionId, logicalActionId, callRef, sha256Hex(argumentsJson)],
    );
  });

describe("P4 sandbox outcome read port", () => {
  it("reads only a strictly decoded terminal no-effect provider outcome", async () => {
    const observation = {
      _tag: "ExpectedFailure" as const,
      observation: { text: summary, truncated: false },
      sandboxProviderUnavailable: {
        policyRevision: 2,
        policyDigest: "a".repeat(64),
        profile: "WorkspaceWrite" as const,
        providerId: "os-sandbox",
        providerVersion: "1.4.2",
        capabilityRevision: "cap-17",
        probeEvidenceRef: "probe:evidence-1",
        failureCode: "sandbox/probe-interrupted",
        effectDisposition: "NoEffect" as const,
      },
    };
    const encoded = encodeToolObservationEvidence({
      settlement: { _tag: "ExpectedFailure" },
      observation,
      resultRef: null,
    });
    expect(encoded._tag).toBe("Encoded");
    if (encoded._tag !== "Encoded") return;

    const infra = layer({ filename: ":memory:" });
    const app = Layer.mergeAll(
      infra,
      Layer.provide(TransactionPortLive, infra),
      Layer.provide(P4SandboxOutcomeReadPortLive, infra),
    );
    const result = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const sql = yield* SqlClient;
          yield* seedP4Rows(sql, encoded.evidence, "MayHaveStarted");
          const tx = yield* TransactionPort;
          const port = yield* P4SandboxOutcomeReadPort;
          return yield* tx.transact(
            port.findUnavailableByExecutionAndRevision(executionId, 2),
          );
        }),
        app,
      ),
    );
    expect(result).toEqual([
      {
        ...observation.sandboxProviderUnavailable,
        invocationId: "tin_018f2b3c-4d5e-7abc-8def-0123456789a1",
        executionId,
        workspaceId,
        summary,
      },
    ]);
  });

  it("fails closed when the typed provider outcome is not a no-effect admitted row", async () => {
    const observation = {
      _tag: "ExpectedFailure" as const,
      observation: { text: summary, truncated: false },
      sandboxProviderUnavailable: {
        policyRevision: 2,
        policyDigest: "a".repeat(64),
        profile: "ReadOnly" as const,
        providerId: "os-sandbox",
        providerVersion: "1.4.2",
        capabilityRevision: "cap-17",
        probeEvidenceRef: null,
        failureCode: "sandbox/probe-interrupted",
        effectDisposition: "NoEffect" as const,
      },
    };
    const encoded = encodeToolObservationEvidence({
      settlement: { _tag: "ExpectedFailure" },
      observation,
      resultRef: null,
    });
    if (encoded._tag !== "Encoded") throw new Error("expected encoded body");
    const infra = layer({ filename: ":memory:" });
    const app = Layer.mergeAll(
      infra,
      Layer.provide(TransactionPortLive, infra),
      Layer.provide(P4SandboxOutcomeReadPortLive, infra),
    );
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient;
        yield* seedP4Rows(sql, encoded.evidence, "NotAdmitted");
        const tx = yield* TransactionPort;
        const port = yield* P4SandboxOutcomeReadPort;
        return yield* tx.transact(
          Effect.result(
            port.findUnavailableByExecutionAndRevision(executionId, 2),
          ),
        );
      }).pipe(Effect.provide(app)),
    );
    expect(result._tag).toBe("Failure");
    if (result._tag === "Failure") {
      expect(result.failure).toMatchObject({
        _tag: "PersistenceCorruption",
        operation: "sandbox-view-read",
      });
    }
  });
});
