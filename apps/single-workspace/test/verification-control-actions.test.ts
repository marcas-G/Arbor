import {
  type AgentActionHandlerInput,
  ControlActionAuthorizer,
  makeControlToolRegistry,
  selectInitialAgentLoopStepCursor,
} from "@arbor/agent-runtime";
import type {
  CommandGatewayService,
  CommandHandlerRegistryService,
  GatewayEnvelope,
} from "@arbor/application";
import {
  CommandHandlerRegistry,
  CommandHandlerRegistryLive,
  makeRecordVerificationEvidenceHandler,
  newUuid7,
  semanticRequestFingerprint,
} from "@arbor/application";
import {
  CommandId,
  EvidenceId,
  ExecutionId,
  type LeaseGeneration,
  Principal,
  ProjectId,
  parse,
  SessionId,
  startVerification,
  ToolInvocationId,
  VerificationId,
  WorkId,
  WorkRevision,
  WorkspaceId,
} from "@arbor/domain";
import {
  AgentLoopStepStoreLive,
  layer as sqliteLayer,
  TransactionPortLive,
} from "@arbor/persistence-sqlite";
import type {
  BlobStorePortService,
  ClockService,
  CommandStoreService,
  FormationProposalStoreService,
  MessageStoreService,
  SessionRepositoryService,
  ToolInvocationStoreService,
  TransactionPortService,
  VerificationRepositoryService,
  WorkRepositoryService,
  WorkspaceRepositoryService,
} from "@arbor/ports";
import {
  AgentLoopStepStore,
  Clock,
  CommandStore,
  ControlApprovalStore,
  InboxProjectionStore,
  PermissionGrantRepository,
  sha256Hex,
  TransactionPort,
  WorkspaceRepository,
} from "@arbor/ports";
import { Effect, Layer, Option, Stream } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { describe, expect, it } from "vitest";
import { executeAgentLoopActions } from "../../../packages/agent-runtime/src/agent-loop-actions.js";
import { ControlActionAuthorizerLive } from "../src/control-action-authorizer.js";
import { makeSingleWorkspaceControlActionHandlers } from "../src/control-actions.js";

const executionId = parse(ExecutionId)(
  "exe_00000000-0000-7000-8000-000000000001",
);
const workspaceId = parse(WorkspaceId)(
  "ws_00000000-0000-7000-8000-000000000001",
);
const projectId = parse(ProjectId)("prj_00000000-0000-7000-8000-000000000001");
const sessionId = parse(SessionId)("ses_00000000-0000-7000-8000-000000000001");
const verificationId = parse(VerificationId)(
  "ver_00000000-0000-7000-8000-000000000001",
);
const toolInvocationId = parse(ToolInvocationId)(
  "tin_00000000-0000-7000-8000-000000000001",
);
const evidenceId = parse(EvidenceId)(
  "evd_00000000-0000-7000-8000-000000000001",
);
const principal = parse(Principal)("agent:verifier");

const verification = startVerification({
  verificationId,
  workId: parse(WorkId)("wrk_00000000-0000-7000-8000-000000000001"),
  targetWorkRevision: parse(WorkRevision)(1),
  missionSnapshot: {
    goal: "verify",
    criteria: [
      {
        criterionId: "focused-test",
        requirement: "focused test passes",
        required: true,
      },
    ],
    riskRequirements: [],
  },
  verificationExecutionIds: [executionId],
});

const execution = {
  executionId,
  projectId,
  workspaceId,
  sessionId,
  binding: {
    _tag: "ExecutionBoundAgentBinding" as const,
    parentExecutionId: null,
    mission: "verification-execution-v1",
  },
  admittedAt: "t",
  stopRequestedAt: null,
  state: { status: "Active" as const, settlement: null },
};

const context = {
  _tag: "ExecutionOrigin" as const,
  principal,
  executionId,
  fencingGeneration: 0 as LeaseGeneration,
};

const setup = (
  options: {
    readonly rejectConclusion?: boolean;
    readonly corruptBlobRead?: boolean;
    readonly toolStatus?:
      | "Succeeded"
      | "Failed"
      | "Interrupted"
      | "OutcomeUnknown";
    readonly toolSettlement?: import("@arbor/ports").ToolInvocationSettlement;
    readonly priorEvidenceReceipt?: "fencing" | "rejected" | "committed";
    readonly priorEvidenceFingerprintMismatch?: boolean;
    readonly priorEvidenceValidatorMissing?: boolean;
    readonly priorEvidenceCanonicalMismatch?: boolean;
    readonly priorConclusionReceipt?: "fencing" | "rejected" | "committed";
    readonly priorConclusionFingerprintMismatch?: boolean;
    readonly priorConclusionCanonicalMismatch?: boolean;
    readonly priorConclusionMalformedResult?: boolean;
    readonly tx?: TransactionPortService;
    readonly commandHandlerRegistry?: CommandHandlerRegistryService;
    readonly invocationArgumentsJson?: string;
    readonly invocationToolName?: string;
  } = {},
) => {
  const submitted: Array<GatewayEnvelope<unknown>> = [];
  let blob = new Uint8Array();
  let waitClears = 0;
  let waitPresent = true;
  let priorValidatorCalls = 0;
  let priorConclusionValidatorCalls = 0;
  const priorEvidenceCommandId = parse(CommandId)(
    `cmd_${newUuid7("record-verification-evidence", "ptn_verify:1")}`,
  );
  const priorEvidenceId = parse(EvidenceId)(
    `evd_${newUuid7("verification-evidence", "ptn_verify:1")}`,
  );
  const priorEvidencePayload = {
    verificationId,
    evidence: {
      evidenceId: priorEvidenceId,
      criterionId: "focused-test",
      kind: "ToolObservation" as const,
      toolInvocationId,
      observationRef: "observation:1",
      callRef: "tool-call-1",
      recordedAt: "2026-10-02T00:00:00.000Z",
    },
  };
  const priorEvidenceFingerprint = semanticRequestFingerprint({
    commandType: "RecordVerificationEvidence",
    projectId,
    actor: principal,
    schemaVersion: "1",
    payload: priorEvidencePayload,
  });
  const priorConclusionCommandId = parse(CommandId)(
    `cmd_${newUuid7("conclude-verification", "ptn_verify:2")}`,
  );
  const priorConclusionPayload = {
    verificationId,
    verdict: "Pass" as const,
    criteriaResults: [
      {
        criterionId: "focused-test",
        requirement: "focused test passes",
        required: true,
        verdict: "Pass" as const,
        evidenceRefs: [evidenceId],
      },
    ],
    summaryRef: "blob:summary",
  };
  const priorConclusionFingerprint = semanticRequestFingerprint({
    commandType: "ConcludeVerification",
    projectId,
    actor: principal,
    schemaVersion: "1",
    payload: priorConclusionPayload,
  });
  const gateway: CommandGatewayService = {
    execute: (envelope) => {
      submitted.push(envelope);
      if (
        options.rejectConclusion === true &&
        envelope.commandType === "ConcludeVerification"
      ) {
        return Effect.succeed({
          resolution: {
            _tag: "TerminalRejected",
            error: { _tag: "AuthorityDenied", reason: "test rejection" },
          },
        } as never);
      }
      return Effect.succeed({
        resolution: {
          _tag: "Committed",
          result:
            envelope.commandType === "RecordVerificationEvidence"
              ? { verificationId, evidenceId, state: "Recorded" }
              : {
                  verificationId,
                  state: "Concluded",
                  verdict: "Pass",
                  summaryRef: "blob:summary",
                  wakeSignals: [],
                  channel1Release: {
                    workId: verification.workId,
                    targetWorkRevision: verification.targetWorkRevision,
                  },
                },
        },
      } as never);
    },
  };
  const blobs: BlobStorePortService = {
    put: (bytes) =>
      Effect.sync(() => {
        blob = bytes.slice();
        return "blob:summary";
      }),
    get: () =>
      Effect.succeed(
        options.corruptBlobRead === true ? new Uint8Array([0]) : blob,
      ),
    stream: () => Stream.empty,
  };
  const tx = {
    transact: <A, E, R>(effect: Effect.Effect<A, E, R>) => effect,
  } as TransactionPortService;
  const dependencies = {
    gateway,
    commandReceipts: {
      findResolution: (commandId) => {
        const isEvidence = commandId === priorEvidenceCommandId;
        const isConclusion = commandId === priorConclusionCommandId;
        if (
          (isEvidence && options.priorEvidenceReceipt === undefined) ||
          (isConclusion && options.priorConclusionReceipt === undefined) ||
          (!isEvidence && !isConclusion)
        ) {
          return Effect.succeed(Option.none());
        }
        const priorReceiptKind = isEvidence
          ? options.priorEvidenceReceipt
          : options.priorConclusionReceipt;
        if (priorReceiptKind === undefined)
          return Effect.succeed(Option.none());
        return Effect.succeed(
          Option.some({
            commandId,
            projectId,
            semanticRequestFingerprint:
              (isEvidence &&
                options.priorEvidenceFingerprintMismatch === true) ||
              (isConclusion &&
                options.priorConclusionFingerprintMismatch === true)
                ? "bad-fingerprint"
                : isEvidence
                  ? priorEvidenceFingerprint
                  : priorConclusionFingerprint,
            schemaVersion: "1",
            fingerprintAlgorithmVersion: 1,
            resolution:
              priorReceiptKind === "committed"
                ? "Committed"
                : "TerminalRejected",
            resultJson:
              priorReceiptKind !== "committed"
                ? null
                : isEvidence
                  ? JSON.stringify({
                      verificationId,
                      evidenceId: priorEvidenceId,
                      state: "Recorded",
                    })
                  : options.priorConclusionMalformedResult === true
                    ? JSON.stringify({ unexpected: true })
                    : JSON.stringify({
                        verificationId,
                        state: "Concluded",
                        verdict: "Pass",
                        summaryRef: "blob:summary",
                        wakeSignals: [],
                        channel1Release: {
                          workId: verification.workId,
                          targetWorkRevision: verification.targetWorkRevision,
                        },
                      }),
            terminalErrorJson:
              priorReceiptKind === "fencing"
                ? JSON.stringify({ _tag: "FencingRejected" })
                : priorReceiptKind === "rejected"
                  ? JSON.stringify({
                      _tag: "AuthorityDenied",
                      reason: "denied",
                    })
                  : null,
            createdAt: "2026-10-02T00:00:00.000Z",
            settledAt: "2026-10-02T00:00:01.000Z",
          } as never),
        );
      },
    } as Pick<CommandStoreService, "findResolution">,
    commandHandlerRegistry:
      options.commandHandlerRegistry ??
      ({
        lookup: (commandType: string) =>
          commandType === "RecordVerificationEvidence" &&
          options.priorEvidenceReceipt !== undefined
            ? Option.some({
                commandType,
                schemaVersion: "1",
                ...(options.priorEvidenceValidatorMissing === true
                  ? {}
                  : {
                      validateReceiptReplay: () => {
                        priorValidatorCalls += 1;
                        return options.priorEvidenceCanonicalMismatch === true
                          ? Effect.fail({
                              _tag: "PersistenceCorruption",
                            } as never)
                          : Effect.void;
                      },
                    }),
              } as never)
            : commandType === "ConcludeVerification" &&
                options.priorConclusionReceipt !== undefined
              ? Option.some({
                  commandType,
                  schemaVersion: "2",
                  priorReceiptSchemaVersions: ["1"],
                  validateReceiptReplay: () => {
                    priorConclusionValidatorCalls += 1;
                    return options.priorConclusionCanonicalMismatch === true
                      ? Effect.fail({ _tag: "PersistenceCorruption" } as never)
                      : Effect.void;
                  },
                } as never)
              : Option.none(),
      } as CommandHandlerRegistryService),
    blobs,
    clock: {
      now: () => Effect.succeed("2026-10-02T00:00:00.000Z"),
    } as ClockService,
    tx: options.tx ?? tx,
    verifications: {
      findByExecutionId: () => Effect.succeed(Option.some(verification)),
    } as unknown as VerificationRepositoryService,
    sessions: {
      listEntries: () =>
        Effect.succeed([
          {
            sessionId,
            sequence: 1,
            entryKind: "Observation" as const,
            payload: {
              _tag: "ToolResult",
              callRef: "tool-call-1",
              invocationId: toolInvocationId,
              observationRef: "observation:1",
              status: options.toolStatus ?? "Succeeded",
            },
            createdAt: "t",
          },
        ]),
    } as unknown as SessionRepositoryService,
    toolInvocations: {
      findById: () =>
        Effect.succeed(
          Option.some({
            invocationId: toolInvocationId,
            executionId,
            workspaceId,
            toolName: "shell",
            toolVersion: "1",
            sideEffectSemantics: "ReadOnly",
            argumentsJson: "{}",
            resolvedRegions: [],
            approvalId: null,
            intentAt: "t",
            settledAt: "t2",
            settlement: options.toolSettlement ?? { _tag: "Success" },
            resultRef: null,
          }),
        ),
    } as unknown as ToolInvocationStoreService,
    loopSteps: {
      findCurrent: () =>
        Effect.succeed(
          Option.some({
            identity: { executionId, logicalStepNo: 0, repairAttempt: 0 },
            providerTurnId: "ptn_verify",
            state: "ActionsInProgress",
          }),
        ),
      listActions: () =>
        Effect.succeed([
          {
            actionIndex: 1,
            state: "Pending",
            routeKind: "Control",
            callRef: "control-1",
            actionKind:
              options.invocationToolName ??
              "arbor_record_verification_evidence",
            inputHash: sha256Hex(options.invocationArgumentsJson ?? "{}"),
            updatedAt: "2026-10-02T00:00:00.000Z",
          },
        ]),
    } as never,
    messages: {} as MessageStoreService,
    workspaces: {} as WorkspaceRepositoryService,
    works: {} as WorkRepositoryService,
    proposals: {} as FormationProposalStoreService,
    inbox: { admitUpsert: () => Effect.void },
    waits: {
      findByWork: () =>
        Effect.succeed(
          waitPresent
            ? Option.some({
                workId: verification.workId,
                waitSpec: {
                  mode: "Any" as const,
                  conditions: [
                    {
                      _tag: "VerificationChanged" as const,
                      workId: verification.workId,
                      targetWorkRevision:
                        verification.targetWorkRevision as never,
                    },
                  ],
                },
                registeredAt: "t",
                updatedAt: "t",
              })
            : Option.none(),
        ),
      clear: () =>
        Effect.sync(() => {
          waitClears += 1;
          waitPresent = false;
        }),
      upsert: () => Effect.void,
    },
  };
  return {
    submitted,
    readBlob: () => new TextDecoder().decode(blob),
    priorValidatorCalls: () => priorValidatorCalls,
    priorConclusionValidatorCalls: () => priorConclusionValidatorCalls,
    waitClears: () => waitClears,
    handlers: makeSingleWorkspaceControlActionHandlers(dependencies),
  };
};

const input = (
  action: AgentActionHandlerInput["action"],
  outputPosition: number,
  generation: number = 0,
): AgentActionHandlerInput => ({
  action,
  invocation: {
    providerTurnId: "ptn_verify" as never,
    outputPosition,
    callRef: `control-${outputPosition}`,
    toolName:
      action._tag === "RecordVerificationEvidence"
        ? "arbor_record_verification_evidence"
        : "arbor_conclude_verification",
    argumentsJson: "{}",
  },
  execution,
  context: { ...context, fencingGeneration: generation as LeaseGeneration },
});

describe("verification control actions", () => {
  const evidenceAction = {
    _tag: "RecordVerificationEvidence" as const,
    criterionId: "focused-test",
    sourceCallRef: "tool-call-1",
  };
  const conclusionAction = {
    _tag: "ConcludeVerification" as const,
    verdict: "Pass" as const,
    criteriaResults: [
      {
        criterionId: "focused-test",
        requirement: "focused test passes",
        required: true,
        verdict: "Pass" as const,
        evidenceRefs: [evidenceId],
      },
    ],
    summary: "Focused verification passed.",
  };

  it("decodes a registered v1 ConcludeVerification receipt and validates canonical replay before settling", async () => {
    const state = setup({ priorConclusionReceipt: "committed" });
    const handler = state.handlers.find(
      (candidate) => candidate.action === "ConcludeVerification",
    );
    const result = await Effect.runPromise(
      handler?.handle(input(conclusionAction, 2, 1)) as Effect.Effect<unknown>,
    );
    expect(result).toMatchObject({
      _tag: "Settle",
      settlement: {
        _tag: "Completed",
        result: {
          _tag: "VerificationConcluded",
          verificationId,
          verdict: "Pass",
        },
      },
    });
    expect(state.priorConclusionValidatorCalls()).toBe(1);
    expect(state.submitted).toHaveLength(0);
  });

  it.each([
    ["non-fencing rejection", { priorConclusionReceipt: "rejected" as const }],
    [
      "fingerprint mismatch",
      {
        priorConclusionReceipt: "committed" as const,
        priorConclusionFingerprintMismatch: true,
      },
    ],
    [
      "canonical row/event mismatch",
      {
        priorConclusionReceipt: "committed" as const,
        priorConclusionCanonicalMismatch: true,
      },
    ],
    [
      "malformed prior result",
      {
        priorConclusionReceipt: "committed" as const,
        priorConclusionMalformedResult: true,
      },
    ],
  ])(
    "does not replay or replace a prior ConcludeVerification with %s",
    async (_label, options) => {
      const state = setup(options);
      const handler = state.handlers.find(
        (candidate) => candidate.action === "ConcludeVerification",
      );
      const exit = await Effect.runPromise(
        Effect.exit(
          handler?.handle(input(conclusionAction, 2, 1)) as Effect.Effect<
            unknown,
            unknown
          >,
        ),
      );
      expect(exit._tag).toBe("Failure");
      expect(state.submitted).toHaveLength(0);
    },
  );

  it("converges a committed prior-generation Evidence receipt through its registered validator", async () => {
    const state = setup({ priorEvidenceReceipt: "committed" });
    const handler = state.handlers.find(
      (candidate) => candidate.action === "RecordVerificationEvidence",
    );
    const result = await Effect.runPromise(
      handler?.handle(input(evidenceAction, 1, 1)) as Effect.Effect<unknown>,
    );
    expect(result).toMatchObject({ _tag: "Observation" });
    expect(state.priorValidatorCalls()).toBe(1);
    expect(state.submitted).toHaveLength(0);
  });

  it("returns from gen1 Evidence replay with a real SQLite transaction and the registered P8 validator", async () => {
    const occurrence = "ptn_verify:1";
    const replayEvidenceId = parse(EvidenceId)(
      `evd_${newUuid7("verification-evidence", occurrence)}`,
    );
    const replayRecordedAt = "2026-10-02T00:00:00.000Z";
    const verificationRows = {
      findById: (id: VerificationId) =>
        Effect.gen(function* () {
          const sql = yield* SqlClient;
          const rows = yield* sql.unsafe<{ verification_id: string }>(
            "SELECT verification_id FROM p8_replay_verifications WHERE verification_id = ?",
            [id],
          );
          return rows.length === 1 ? Option.some(verification) : Option.none();
        }),
    };
    const evidenceRows = {
      append: () => Effect.void,
      listByVerification: (id: VerificationId) =>
        Effect.gen(function* () {
          const sql = yield* SqlClient;
          const rows = yield* sql.unsafe<{ evidence_id: string }>(
            "SELECT evidence_id FROM p8_replay_evidence WHERE verification_id = ?",
            [id],
          );
          return rows.map(() => ({
            evidenceId: replayEvidenceId,
            verificationId: id,
            criterionId: "focused-test",
            kind: "ToolObservation" as const,
            artifactRef: null,
            observedEnvironmentRevision: null,
            recordedByExecutionId: executionId,
            recordedAt: replayRecordedAt,
            toolInvocationId,
            observationRef: "observation:1",
            callRef: "tool-call-1",
          }));
        }),
    };
    const registeredHandler = makeRecordVerificationEvidenceHandler({
      verifications: verificationRows as never,
      evidence: evidenceRows as never,
    });
    const registryLayer = CommandHandlerRegistryLive([
      registeredHandler as never,
    ]);
    const app = Layer.provideMerge(
      TransactionPortLive,
      sqliteLayer({ filename: ":memory:" }),
    );
    const program = Effect.gen(function* () {
      const sql = yield* SqlClient;
      yield* sql.unsafe(
        "CREATE TABLE p8_replay_verifications (verification_id TEXT PRIMARY KEY)",
      );
      yield* sql.unsafe(
        "CREATE TABLE p8_replay_evidence (evidence_id TEXT PRIMARY KEY, verification_id TEXT NOT NULL)",
      );
      yield* sql.unsafe(
        "INSERT INTO p8_replay_verifications (verification_id) VALUES (?)",
        [verificationId],
      );
      yield* sql.unsafe(
        "INSERT INTO p8_replay_evidence (evidence_id, verification_id) VALUES (?, ?)",
        [replayEvidenceId, verificationId],
      );
      const registry = yield* CommandHandlerRegistry;
      const tx = yield* TransactionPort;
      const state = setup({
        priorEvidenceReceipt: "committed",
        tx,
        commandHandlerRegistry: registry,
      });
      const handler = state.handlers.find(
        (candidate) => candidate.action === "RecordVerificationEvidence",
      );
      const result = yield* handler?.handle(
        input(evidenceAction, 1, 1),
      ) as Effect.Effect<unknown>;
      return { result, submitted: state.submitted };
    }).pipe(Effect.provide(registryLayer));
    const observed = await Effect.runPromise(Effect.provide(program, app));
    expect(observed.result).toMatchObject({ _tag: "Observation" });
    expect(observed.submitted).toHaveLength(0);
  });

  it("resumes step 1 Pending Control through the real SQLite P9 store, registry, authorizer, and receipt validator", async () => {
    const occurrence = "ptn_verify:1";
    const invocationArgumentsJson = JSON.stringify({
      criterionId: "focused-test",
      sourceCallRef: "tool-call-1",
    });
    const replayEvidenceId = parse(EvidenceId)(
      `evd_${newUuid7("verification-evidence", occurrence)}`,
    );
    const replayRecordedAt = "2026-10-02T00:00:00.000Z";
    const verificationRows = {
      findById: (id: VerificationId) =>
        Effect.gen(function* () {
          const sql = yield* SqlClient;
          const rows = yield* sql.unsafe<{ verification_id: string }>(
            "SELECT verification_id FROM p8_replay_verifications WHERE verification_id = ?",
            [id],
          );
          return rows.length === 1 ? Option.some(verification) : Option.none();
        }),
    };
    const evidenceRows = {
      append: () => Effect.void,
      listByVerification: (id: VerificationId) =>
        Effect.gen(function* () {
          const sql = yield* SqlClient;
          const rows = yield* sql.unsafe<{ evidence_id: string }>(
            "SELECT evidence_id FROM p8_replay_evidence WHERE verification_id = ?",
            [id],
          );
          return rows.map(() => ({
            evidenceId: replayEvidenceId,
            verificationId: id,
            criterionId: "focused-test",
            kind: "ToolObservation" as const,
            artifactRef: null,
            observedEnvironmentRevision: null,
            recordedByExecutionId: executionId,
            recordedAt: replayRecordedAt,
            toolInvocationId,
            observationRef: "observation:1",
            callRef: "tool-call-1",
          }));
        }),
    };
    const registeredHandler = makeRecordVerificationEvidenceHandler({
      verifications: verificationRows as never,
      evidence: evidenceRows as never,
    });
    const commandRegistryLayer = CommandHandlerRegistryLive([
      registeredHandler as never,
    ]);
    const sqlite = sqliteLayer({ filename: ":memory:" });
    const txLayer = Layer.provide(TransactionPortLive, sqlite);
    const clockLayer = Layer.succeed(Clock, {
      now: () => Effect.succeed("2026-10-02T00:00:00.000Z"),
    });
    const stepStoreLayer = Layer.provide(
      AgentLoopStepStoreLive,
      Layer.merge(sqlite, clockLayer),
    );
    const workspaceLayer = Layer.succeed(WorkspaceRepository, {
      findById: () =>
        Effect.gen(function* () {
          const sql = yield* SqlClient;
          yield* sql.unsafe("SELECT 1");
          return Option.some({ workspacePolicy: {} } as never);
        }),
    } as never);
    const authorizerDependencies = Layer.mergeAll(
      clockLayer,
      commandRegistryLayer,
      Layer.succeed(ControlApprovalStore, {} as never),
      Layer.succeed(CommandStore, {} as never),
      Layer.succeed(InboxProjectionStore, {} as never),
      Layer.succeed(PermissionGrantRepository, {} as never),
      txLayer,
      workspaceLayer,
    );
    const authorizerLayer = Layer.provideMerge(
      ControlActionAuthorizerLive,
      authorizerDependencies,
    );
    const app = Layer.mergeAll(
      sqlite,
      txLayer,
      clockLayer,
      stepStoreLayer,
      commandRegistryLayer,
      authorizerLayer,
    );
    const basis = {
      projectPolicyRevision: 0,
      workspacePolicyRevision: 0,
      responsibilityRevision: 0,
      resourceBoundaryRevision: 0,
      authorizationDigest: "authz",
      environmentRevision: "env0",
    };
    const program = Effect.gen(function* () {
      const sql = yield* SqlClient;
      const tx = yield* TransactionPort;
      const loopSteps = yield* AgentLoopStepStore;
      const authorizer = yield* ControlActionAuthorizer;
      yield* sql.unsafe(
        "CREATE TABLE p8_replay_verifications (verification_id TEXT PRIMARY KEY)",
      );
      yield* sql.unsafe(
        "CREATE TABLE p8_replay_evidence (evidence_id TEXT PRIMARY KEY, verification_id TEXT NOT NULL)",
      );
      yield* sql.unsafe(
        "CREATE TABLE executions (execution_id TEXT PRIMARY KEY, settled_at TEXT)",
      );
      yield* sql.unsafe(
        "CREATE TABLE execution_leases (execution_id TEXT PRIMARY KEY, worker_id TEXT, worker_incarnation_id TEXT, generation INTEGER, expires_at TEXT)",
      );
      yield* sql.unsafe(
        "CREATE TABLE agent_loop_steps (execution_id TEXT, logical_step_no INTEGER, repair_attempt INTEGER, provider_turn_id TEXT, predecessor_logical_step_no INTEGER, predecessor_repair_attempt INTEGER, manifest_id TEXT, state TEXT, decoder_version TEXT, provider_failure_json TEXT, repair_disposition_json TEXT, successor_json TEXT, next_step_reason TEXT, decoded_output_hash TEXT, model_output_session_sequence INTEGER, next_action_index INTEGER, settlement_json TEXT, migration_provenance_json TEXT, revision INTEGER, updated_at TEXT, PRIMARY KEY(execution_id, logical_step_no, repair_attempt))",
      );
      yield* sql.unsafe(
        "CREATE TABLE agent_loop_step_actions (execution_id TEXT, logical_step_no INTEGER, repair_attempt INTEGER, action_index INTEGER, logical_action_id TEXT, call_ref TEXT, route_kind TEXT, action_kind TEXT, input_hash TEXT, state TEXT, result_ref TEXT, settlement_ref TEXT, disposition_json TEXT, observation_source_ref TEXT, revision INTEGER, updated_at TEXT, PRIMARY KEY(execution_id, logical_step_no, repair_attempt, action_index))",
      );
      yield* sql.unsafe(
        "CREATE TABLE session_observations (source_ref TEXT PRIMARY KEY, payload_json TEXT NOT NULL)",
      );
      yield* sql.unsafe(
        "INSERT INTO p8_replay_verifications (verification_id) VALUES (?)",
        [verificationId],
      );
      yield* sql.unsafe(
        "INSERT INTO p8_replay_evidence (evidence_id, verification_id) VALUES (?, ?)",
        [replayEvidenceId, verificationId],
      );
      yield* sql.unsafe(
        "INSERT INTO executions (execution_id, settled_at) VALUES (?, NULL)",
        [executionId],
      );
      yield* sql.unsafe(
        "INSERT INTO execution_leases (execution_id, worker_id, worker_incarnation_id, generation, expires_at) VALUES (?, 'worker-gen1', 'inc-gen1', 1, '2026-10-03T00:00:00.000Z')",
        [executionId],
      );
      yield* sql.unsafe(
        "INSERT INTO agent_loop_steps (execution_id, logical_step_no, repair_attempt, provider_turn_id, predecessor_logical_step_no, predecessor_repair_attempt, manifest_id, state, successor_json, next_action_index, revision, updated_at) VALUES (?, 0, 0, 'ptn_previous', NULL, NULL, NULL, 'NextStepReady', ?, 1, 1, '2026-10-02T00:00:00.000Z')",
        [
          executionId,
          JSON.stringify({
            executionId,
            logicalStepNo: 1,
            repairAttempt: 0,
            providerTurnId: "ptn_verify",
          }),
        ],
      );
      yield* sql.unsafe(
        "INSERT INTO agent_loop_steps (execution_id, logical_step_no, repair_attempt, provider_turn_id, predecessor_logical_step_no, predecessor_repair_attempt, manifest_id, state, next_action_index, revision, updated_at) VALUES (?, 1, 0, 'ptn_verify', 0, 0, NULL, 'ActionsInProgress', 1, 0, '2026-10-02T00:00:00.000Z')",
        [executionId],
      );
      yield* sql.unsafe(
        "INSERT INTO agent_loop_step_actions (execution_id, logical_step_no, repair_attempt, action_index, logical_action_id, call_ref, route_kind, action_kind, input_hash, state, result_ref, observation_source_ref, revision, updated_at) VALUES (?, 1, 0, 0, 'lac-read-applied', 'read-call', 'Executable', 'shell', ?, 'Applied', 'result-read', 'observation-read', 1, '2026-10-02T00:00:00.000Z')",
        [executionId, sha256Hex("{}")],
      );
      const p8LogicalActionId = `lac_${sha256Hex(
        JSON.stringify({
          executionId,
          providerTurnId: "ptn_verify",
          callRef: "control-1",
          routeKind: "Control",
          actionKind: "record_verification_evidence",
        }),
      )}`;
      yield* sql.unsafe(
        "INSERT INTO agent_loop_step_actions (execution_id, logical_step_no, repair_attempt, action_index, logical_action_id, call_ref, route_kind, action_kind, input_hash, state, revision, updated_at) VALUES (?, 1, 0, 1, ?, 'control-1', 'Control', 'record_verification_evidence', ?, 'Pending', 0, '2026-10-02T00:00:00.000Z')",
        [executionId, p8LogicalActionId, sha256Hex(invocationArgumentsJson)],
      );
      const steps = yield* tx.transact(loopSteps.listByExecution(executionId));
      const cursor = selectInitialAgentLoopStepCursor(steps);
      expect(cursor).toEqual({ logicalStepNo: 1, repairAttempt: 0 });
      const current = yield* tx.transact(loopSteps.findCurrent(executionId));
      const handlerState = setup({
        priorEvidenceReceipt: "committed",
        tx,
        commandHandlerRegistry: yield* CommandHandlerRegistry,
        invocationArgumentsJson,
        invocationToolName: "record_verification_evidence",
      });
      const controlRegistry = makeControlToolRegistry(handlerState.handlers);
      const p8Definition = controlRegistry
        .definitions()
        .find(
          (definition) => definition.name === "record_verification_evidence",
        );
      if (p8Definition === undefined) {
        throw new Error("P8 control is missing from the actual registry");
      }
      const executionForAction = {
        ...execution,
        binding: { _tag: "WorkspaceExecution", workspaceId },
      } as never;
      const contextForAction = {
        ...context,
        fencingGeneration: 1,
        workerId: "worker-gen1",
        workerIncarnationId: "inc-gen1",
      } as never;
      const outcome = yield* executeAgentLoopActions({
        input: { execution: executionForAction, context: contextForAction },
        preparedTurn: {
          manifest: {
            providerTurnId: "ptn_verify",
            executionId,
            sessionId,
            contextEpoch: 0,
            controlBasis: basis,
          },
          toolRoutes: [
            { name: "shell", route: "Executable" },
            {
              name: p8Definition.name,
              route: "Control",
              stableId: p8Definition.stableId,
              version: p8Definition.version,
              hash: p8Definition.hash,
            },
          ],
        } as never,
        decodedOutput: {
          text: "",
          finishReason: "ToolCalls",
          toolInvocations: [
            {
              providerTurnId: "ptn_verify",
              outputPosition: 0,
              callRef: "read-call",
              toolName: "shell",
              argumentsJson: "{}",
            },
            {
              providerTurnId: "ptn_verify",
              outputPosition: 1,
              callRef: "control-1",
              toolName: "record_verification_evidence",
              argumentsJson: invocationArgumentsJson,
            },
          ],
        } as never,
        turn: 1,
        ...(Option.isSome(current) ? { currentLoopStep: current.value } : {}),
        loopSteps,
        loopStepFence: {
          executionId,
          workerId: "worker-gen1",
          workerIncarnationId: "inc-gen1",
          fencingGeneration: 1,
        },
        tx,
        sessions: {
          listEntries: () =>
            Effect.succeed([
              {
                sessionId,
                sequence: 1,
                entryKind: "Observation",
                payload: {
                  _tag: "ToolResult",
                  callRef: "tool-call-1",
                  invocationId: toolInvocationId,
                  observationRef: "observation:1",
                  status: "Succeeded",
                },
                createdAt: replayRecordedAt,
              },
            ]),
          supportsTypedTimeline: () => Effect.succeed(false),
          appendEntryIdempotent: (
            _sessionId: string,
            source: { readonly ref: string },
            entry: { readonly payload: unknown },
          ) =>
            Effect.gen(function* () {
              const client = yield* SqlClient;
              yield* client.unsafe(
                "INSERT OR IGNORE INTO session_observations (source_ref, payload_json) VALUES (?, ?)",
                [source.ref, JSON.stringify(entry.payload)],
              );
            }),
        } as never,
        controlRegistry,
        controlAuthorizer: authorizer,
        currentControlBasis: () => Effect.succeed(basis as never),
        admit: () => Effect.succeed("Continue"),
        failure: (cause: unknown) => cause as never,
        now: () => Effect.succeed(replayRecordedAt),
      } as never);
      const actions = yield* tx.transact(
        loopSteps.listActions({
          executionId,
          logicalStepNo: 1,
          repairAttempt: 0,
        }),
      );
      const updatedStep = yield* tx.transact(
        loopSteps.findCurrent(executionId),
      );
      const observations = yield* sql.unsafe<{ payload_json: string }>(
        "SELECT payload_json FROM session_observations",
      );
      return { outcome, actions, updatedStep, observations };
    }).pipe(Effect.provide(commandRegistryLayer));
    const observed = await Effect.runPromise(Effect.provide(program, app));
    expect(observed.outcome).toMatchObject({ _tag: "Completed" });
    expect(observed.actions[1]).toMatchObject({
      actionKind: "record_verification_evidence",
      state: "Applied",
      revision: 1,
    });
    expect(observed.updatedStep).toMatchObject({
      _tag: "Some",
      value: { state: "ActionsInProgress", nextActionIndex: 2, revision: 1 },
    });
    expect(observed.observations).toHaveLength(1);
    expect(observed.observations[0]?.payload_json).toContain(
      "VerificationEvidenceRecorded",
    );
  });

  it("skips only a prior FencingRejected receipt and submits a generation-scoped command", async () => {
    const state = setup({ priorEvidenceReceipt: "fencing" });
    const handler = state.handlers.find(
      (candidate) => candidate.action === "RecordVerificationEvidence",
    );
    await Effect.runPromise(
      handler?.handle(input(evidenceAction, 1, 1)) as Effect.Effect<unknown>,
    );
    expect(state.submitted).toHaveLength(1);
    expect(state.submitted[0]?.commandId).not.toBe(
      `cmd_${newUuid7("record-verification-evidence", "ptn_verify:1")}`,
    );
  });

  it.each([
    ["non-fencing rejection", { priorEvidenceReceipt: "rejected" as const }],
    [
      "fingerprint mismatch",
      {
        priorEvidenceReceipt: "committed" as const,
        priorEvidenceFingerprintMismatch: true,
      },
    ],
    [
      "canonical effect mismatch",
      {
        priorEvidenceReceipt: "committed" as const,
        priorEvidenceCanonicalMismatch: true,
      },
    ],
  ])(
    "fails closed on prior %s without submitting a replacement command",
    async (_label, options) => {
      const state = setup(options);
      const handler = state.handlers.find(
        (candidate) => candidate.action === "RecordVerificationEvidence",
      );
      const exit = await Effect.runPromise(
        Effect.exit(
          handler?.handle(input(evidenceAction, 1, 1)) as Effect.Effect<
            unknown,
            unknown
          >,
        ),
      );
      expect(exit._tag).toBe("Failure");
      expect(state.submitted).toHaveLength(0);
    },
  );

  it("fails closed when a committed prior receipt has no registered replay validator", async () => {
    const state = setup({
      priorEvidenceReceipt: "committed",
      priorEvidenceValidatorMissing: true,
    });
    const handler = state.handlers.find(
      (candidate) => candidate.action === "RecordVerificationEvidence",
    );
    const exit = await Effect.runPromise(
      Effect.exit(
        handler?.handle(input(evidenceAction, 1, 1)) as Effect.Effect<
          unknown,
          unknown
        >,
      ),
    );
    expect(exit._tag).toBe("Failure");
    expect(state.submitted).toHaveLength(0);
  });

  it("binds evidence identity from the visible terminal ToolResult", async () => {
    const state = setup();
    const handler = state.handlers.find(
      (candidate) => candidate.action === "RecordVerificationEvidence",
    );
    expect(handler).toBeDefined();
    await Effect.runPromise(
      handler?.handle(
        input(
          {
            _tag: "RecordVerificationEvidence",
            criterionId: "focused-test",
            sourceCallRef: "tool-call-1",
          },
          1,
        ),
      ) as Effect.Effect<unknown>,
    );
    const payload = state.submitted[0]?.payload as {
      readonly evidence: Record<string, unknown>;
    };
    expect(payload.evidence).toMatchObject({
      criterionId: "focused-test",
      toolInvocationId,
      observationRef: "observation:1",
      callRef: "tool-call-1",
    });
  });

  it("accepts newest-first ordinal selection while still binding canonical identity", async () => {
    const state = setup();
    const handler = state.handlers.find(
      (candidate) => candidate.action === "RecordVerificationEvidence",
    );
    await Effect.runPromise(
      handler?.handle(
        input(
          {
            _tag: "RecordVerificationEvidence",
            criterionId: "focused-test",
            sourceCallRef: "1",
          },
          1,
        ),
      ) as Effect.Effect<unknown>,
    );
    expect(state.submitted).toHaveLength(1);
    // biome-ignore lint/style/noNonNullAssertion: guarded by length assertion
    const payload = state.submitted[0]!.payload as {
      evidence: Record<string, unknown>;
    };
    expect(payload.evidence).toMatchObject({
      toolInvocationId,
      callRef: "tool-call-1",
    });
  });

  it.each([
    ["Failed", { _tag: "ExpectedFailure" }],
    ["Failed", { _tag: "RuntimeFailure", cause: "tool defect" }],
    ["Interrupted", { _tag: "Interrupted" }],
    [
      "OutcomeUnknown",
      { _tag: "OutcomeUnknown", reconciliationRefs: ["tin:unknown"] },
    ],
  ] as const)(
    "records %s ToolResult as verifier evidence when durable settlement matches",
    async (toolStatus, toolSettlement) => {
      const state = setup({ toolStatus, toolSettlement });
      const handler = state.handlers.find(
        (candidate) => candidate.action === "RecordVerificationEvidence",
      );
      await Effect.runPromise(
        handler?.handle(
          input(
            {
              _tag: "RecordVerificationEvidence",
              criterionId: "focused-test",
              sourceCallRef: "tool-call-1",
            },
            1,
          ),
        ) as Effect.Effect<unknown>,
      );
      expect(state.submitted).toHaveLength(1);
      expect(state.submitted[0]?.payload).toMatchObject({
        evidence: {
          toolInvocationId,
          observationRef: "observation:1",
          callRef: "tool-call-1",
        },
      });
    },
  );

  it("rejects a ToolResult whose model-visible status contradicts durable settlement", async () => {
    const state = setup({
      toolStatus: "Failed",
      toolSettlement: { _tag: "Success" },
    });
    const handler = state.handlers.find(
      (candidate) => candidate.action === "RecordVerificationEvidence",
    );
    const exit = await Effect.runPromise(
      Effect.exit(
        handler?.handle(
          input(
            {
              _tag: "RecordVerificationEvidence",
              criterionId: "focused-test",
              sourceCallRef: "tool-call-1",
            },
            1,
          ),
        ) as Effect.Effect<unknown, unknown>,
      ),
    );
    expect(exit._tag).toBe("Failure");
    expect(state.submitted).toHaveLength(0);
  });

  it("stores exact summary bytes and submits only the returned BlobRef", async () => {
    const state = setup();
    const handler = state.handlers.find(
      (candidate) => candidate.action === "ConcludeVerification",
    );
    expect(handler).toBeDefined();
    const outcome = await Effect.runPromise(
      handler?.handle(
        input(
          {
            _tag: "ConcludeVerification",
            verdict: "Pass",
            criteriaResults: [
              {
                criterionId: "focused-test",
                requirement: "focused test passes",
                required: true,
                verdict: "Pass",
                evidenceRefs: [evidenceId],
              },
            ],
            summary: "Focused verification passed.",
          },
          2,
        ),
      ) as Effect.Effect<unknown>,
    );
    expect(state.readBlob()).toBe("Focused verification passed.");
    expect(state.submitted[0]?.payload).toMatchObject({
      verificationId,
      summaryRef: "blob:summary",
    });
    // The command only records VerificationConcluded. The durable workflow
    // signal consumer owns wait release after the event commits.
    expect(state.waitClears()).toBe(0);
    expect(outcome).toEqual({
      _tag: "Settle",
      settlement: {
        _tag: "Completed",
        result: {
          _tag: "VerificationConcluded",
          verificationId,
          verdict: "Pass",
        },
      },
    });
  });

  it("replays one conclusion occurrence with one command identity and no synchronous wake", async () => {
    const state = setup();
    const handler = state.handlers.find(
      (candidate) => candidate.action === "ConcludeVerification",
    );
    const invocation = input(
      {
        _tag: "ConcludeVerification",
        verdict: "Pass",
        criteriaResults: [
          {
            criterionId: "focused-test",
            requirement: "focused test passes",
            required: true,
            verdict: "Pass",
            evidenceRefs: [evidenceId],
          },
        ],
        summary: "Focused verification passed.",
      },
      2,
    );
    const first = await Effect.runPromise(
      handler?.handle(invocation) as Effect.Effect<unknown>,
    );
    const replay = await Effect.runPromise(
      handler?.handle(invocation) as Effect.Effect<unknown>,
    );
    expect(replay).toEqual(first);
    expect(state.submitted).toHaveLength(2);
    expect(state.submitted[0]?.commandId).toBe(state.submitted[1]?.commandId);
    expect(state.waitClears()).toBe(0);
  });

  it("never settles when summary verification or the conclusion command fails", async () => {
    const action = input(
      {
        _tag: "ConcludeVerification",
        verdict: "Pass",
        criteriaResults: [
          {
            criterionId: "focused-test",
            requirement: "focused test passes",
            required: true,
            verdict: "Pass",
            evidenceRefs: [evidenceId],
          },
        ],
        summary: "Focused verification passed.",
      },
      2,
    );
    for (const state of [
      setup({ corruptBlobRead: true }),
      setup({ rejectConclusion: true }),
    ]) {
      const handler = state.handlers.find(
        (candidate) => candidate.action === "ConcludeVerification",
      );
      const exit = await Effect.runPromise(
        Effect.exit(handler?.handle(action) as Effect.Effect<unknown, unknown>),
      );
      expect(exit._tag).toBe("Failure");
      expect(state.waitClears()).toBe(0);
    }
  });
});
