import type { ExecutableApprovalRecord } from "@arbor/ports";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { actionDigestOf, type ToolExecutor } from "../../src/index.js";
import {
  authority,
  context,
  executionId,
  intent,
  invocationId,
  okExecutor,
  principal,
  projectId,
  workspaceId,
} from "./support.js";
import { app, run, runFailure } from "./support-app.js";
import type { PipelineTrace } from "./support-harness.js";

describe("tool runtime pipeline", () => {
  it("settles a post-claim effect-gate denial without opening the executor", async () => {
    let executorCalls = 0;
    const approvalExecutor: ToolExecutor = {
      ...okExecutor,
      requiresApproval: () => true,
      execute: (input) => {
        executorCalls += 1;
        return okExecutor.execute(input);
      },
    };
    const argumentsJson = '{"target":{"mount":"workspace","path":"."}}';
    const approvalId = "iap_018f2b3c-4d5e-7abc-8def-0123456789a1";
    const approval: ExecutableApprovalRecord = {
      executionId,
      logicalStepNo: 0,
      repairAttempt: 0,
      actionIndex: 0,
      logicalActionId: "action-post-claim-denial",
      projectId,
      workspaceId,
      subject: principal,
      callRef: intent(argumentsJson).callRef,
      toolInvocationId: invocationId,
      toolName: "read",
      toolVersion: "2",
      sideEffectSemantics: "ReadOnly",
      argumentsJson,
      actionDigest: actionDigestOf({ ...intent(argumentsJson), approvalId }),
      targetResourceSpaceIds: ["filesystem"],
      controlBasisDigest: "d",
      approvalId,
      routeKind: "Executable",
      revision: 4,
      requestedAt: "2026-01-01T00:00:00.000Z",
      expiresAt: "2999-01-01T00:00:00.000Z",
      state: "Approved",
      decidedAt: "2026-01-01T00:00:01.000Z",
      decidedBy: principal,
      decisionReason: null,
      cancelledAt: null,
      cancelledBy: null,
      cancellationReason: null,
      consumedAt: null,
      consumedBy: null,
    };
    const approvedContext: import("@arbor/ports").ToolExecutionContext = {
      ...context,
      authority: { ...authority, sourceRevision: "source-revision-1" },
      executionFence: {
        executionId,
        workerId: "worker-a",
        workerIncarnationId: "incarnation-a",
        fencingGeneration: 0 as never,
      },
      executableApproval: {
        approvalId,
        expectedRevision: approval.revision,
        state: approval.state,
        binding: approval,
      },
    };
    let signalAuthorityResolved!: () => void;
    let resumeEffectGate!: () => void;
    const authorityResolved = new Promise<void>((resolve) => {
      signalAuthorityResolved = resolve;
    });
    const effectGateResumed = new Promise<void>((resolve) => {
      resumeEffectGate = resolve;
    });
    const trace: PipelineTrace = {
      noEffectDenials: [],
      events: [],
      approvalConsumer: null,
      intentWrites: 0,
      effectAdmissions: 0,
      approvalConsumes: 0,
      afterAuthorityResolved: async () => {
        signalAuthorityResolved();
        await effectGateResumed;
      },
    };

    const resultPromise = run(
      app(false, approvalExecutor, {}, trace, approval),
      argumentsJson,
      approvalId,
      approvedContext,
    );
    await authorityResolved;
    // Simulate the authoritative source changing after resolution but before
    // the store's separate fenced admission transaction.
    trace.effectAdmissionDenial = "InvocationAuthorityDenied";
    resumeEffectGate();
    const result = await resultPromise;

    expect(result).toMatchObject({
      _tag: "Denied",
      reasonCode: "ApprovalNoLongerAuthorized",
    });
    expect(trace.events).toEqual([
      "intent",
      "consume",
      "effect-admission",
      "denied",
    ]);
    expect(trace.approvalConsumes).toBe(1);
    expect(trace.approvalConsumer).toBe(String(invocationId));
    expect(executorCalls).toBe(0);
  });

  it.each([
    ["WorkspaceLookup", { workspaceLookup: true }],
    ["EnvironmentResolution", { environmentResolution: true }],
    ["ResourceAdmission", { resourceAdmission: true }],
    ["IntentJournal", { intentJournal: true }],
    ["SandboxOpen", { sandboxOpen: true }],
    ["SettlementJournal", { settlementJournal: true }],
  ] as const)(
    "preserves the %s operational stage instead of flattening the cause",
    async (stage, faults) => {
      const failure = await runFailure(
        app(false, okExecutor, faults),
        '{"target":{"mount":"workspace","path":"."}}',
      );
      expect(failure).toMatchObject({
        _tag: "ToolRuntimeOperationalFailure",
        stage,
      });
    },
  );

  it("returns sandbox close failure as typed cleanup failure instead of a defect", async () => {
    const failure = await runFailure(
      app(false, okExecutor, { sandboxClose: true }),
      '{"target":{"mount":"workspace","path":"."}}',
    );
    expect(failure).toMatchObject({
      _tag: "ToolRuntimeCleanupFailure",
      stage: "SandboxClose",
    });
  });

  it("retains executor failure when sandbox cleanup also fails", async () => {
    const failingExecutor: ToolExecutor = {
      ...okExecutor,
      execute: () =>
        Effect.fail({
          _tag: "ToolRuntimeOperationalFailure",
          stage: "Executor",
          effectDisposition: "OutcomeUncertain",
          invocationRef: String(invocationId),
          cause: "executor-failure",
        }),
    };
    const failure = await runFailure(
      app(false, failingExecutor, { sandboxClose: true }),
      '{"target":{"mount":"workspace","path":"."}}',
    );
    expect(failure).toMatchObject({
      _tag: "ToolRuntimeCleanupFailure",
      stage: "SandboxClose",
      priorFailure: {
        _tag: "ToolRuntimeOperationalFailure",
        stage: "Executor",
      },
    });
  });
});
