import type { AgentActionHandlerInput } from "@arbor/agent-runtime";
import type {
  CommandGatewayService,
  CommandHandlerRegistryService,
  GatewayEnvelope,
} from "@arbor/application";
import { newUuid7, semanticRequestFingerprint } from "@arbor/application";
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
import { sha256Hex } from "@arbor/ports";
import { Effect, Option, Stream } from "effect";
import { describe, expect, it } from "vitest";
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
    commandHandlerRegistry: {
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
    } as CommandHandlerRegistryService,
    blobs,
    clock: {
      now: () => Effect.succeed("2026-10-02T00:00:00.000Z"),
    } as ClockService,
    tx,
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
            actionKind: "arbor_record_verification_evidence",
            inputHash: sha256Hex("{}"),
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
