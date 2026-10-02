import type { AgentActionHandlerInput } from "@arbor/agent-runtime";
import type {
  CommandGatewayService,
  GatewayEnvelope,
} from "@arbor/application";
import {
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
  FormationProposalStoreService,
  MessageStoreService,
  SessionRepositoryService,
  ToolInvocationStoreService,
  TransactionPortService,
  VerificationRepositoryService,
  WorkRepositoryService,
  WorkspaceRepositoryService,
} from "@arbor/ports";
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

const setup = () => {
  const submitted: Array<GatewayEnvelope<unknown>> = [];
  let blob = new Uint8Array();
  const gateway: CommandGatewayService = {
    execute: (envelope) => {
      submitted.push(envelope);
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
    get: () => Effect.succeed(blob),
    stream: () => Stream.empty,
  };
  const tx = {
    transact: <A, E, R>(effect: Effect.Effect<A, E, R>) => effect,
  } as TransactionPortService;
  const dependencies = {
    gateway,
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
              status: "Succeeded",
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
            settlement: { _tag: "Success" },
            resultRef: null,
          }),
        ),
    } as unknown as ToolInvocationStoreService,
    messages: {} as MessageStoreService,
    workspaces: {} as WorkspaceRepositoryService,
    works: {} as WorkRepositoryService,
    proposals: {} as FormationProposalStoreService,
  };
  return {
    submitted,
    readBlob: () => new TextDecoder().decode(blob),
    handlers: makeSingleWorkspaceControlActionHandlers(dependencies),
  };
};

const input = (
  action: AgentActionHandlerInput["action"],
  outputPosition: number,
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
  context,
});

describe("verification control actions", () => {
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

  it("stores exact summary bytes and submits only the returned BlobRef", async () => {
    const state = setup();
    const handler = state.handlers.find(
      (candidate) => candidate.action === "ConcludeVerification",
    );
    expect(handler).toBeDefined();
    await Effect.runPromise(
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
  });
});
