import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import {
  makeExecutableToolHandler,
  toExecutableOutcome,
} from "../src/executable-tool-handler.js";

describe("SCRC executable outcome taxonomy", () => {
  it.each([
    [
      {
        _tag: "Success" as const,
        observation: { text: "ok", truncated: false },
        resultRef: "artifact:full",
      },
      "Succeeded",
    ],
    [
      {
        _tag: "ExpectedFailure" as const,
        observation: { text: "bad input", truncated: false },
      },
      "Failed",
    ],
    [{ _tag: "Denied" as const, reason: "policy" }, "Denied"],
    [{ _tag: "Interrupted" as const }, "Interrupted"],
    [{ _tag: "RuntimeFailure" as const, cause: "defect" }, "Failed"],
  ])("maps %s to typed status %s", (input, status) => {
    const outcome = toExecutableOutcome(input);
    expect(outcome).toMatchObject({ _tag: "Observation", status });
  });

  it("keeps a ToolRuntime OutcomeUnknown as reconciliation settlement, not an applied observation", () => {
    expect(
      toExecutableOutcome({
        _tag: "OutcomeUnknown",
        reconciliationRefs: ["tin_unknown"],
      }),
    ).toEqual({
      _tag: "Settle",
      settlement: {
        _tag: "OutcomeUnknown",
        reconciliation: {
          _tag: "ReconciliationRequired",
          invocationRefs: ["tin_unknown"],
        },
      },
    });
  });

  it("keeps the complete result reference when the model observation is bounded", () => {
    expect(
      toExecutableOutcome({
        _tag: "Success",
        observation: { text: "excerpt", truncated: true },
        resultRef: "artifact:full",
      }),
    ).toMatchObject({
      status: "Succeeded",
      resultRef: "artifact:full",
      artifactRefs: ["artifact:full"],
      observation: { text: "excerpt", truncated: true },
    });
  });

  it("settles OutcomeUnknown when ToolRuntime cannot establish the external effect", async () => {
    const handler = makeExecutableToolHandler(
      {
        invoke: () =>
          Effect.fail({
            _tag: "ToolRuntimeOperationalFailure",
            stage: "SettlementJournal",
            effectDisposition: "OutcomeUncertain",
            invocationRef: "tin_uncertain",
            cause: "journal unavailable",
          }),
      },
      { now: () => Effect.succeed("t") },
      {
        visibleRefs: () =>
          Effect.succeed([{ name: "read", version: "2", hash: "read-v2" }]),
        resolveForModel: () => Effect.die("unused"),
      },
    );
    const outcome = await Effect.runPromise(
      handler.handle({
        invocation: {
          providerTurnId: "ptn_test" as never,
          outputPosition: 0,
          callRef: "call-1",
          toolName: "read",
          argumentsJson: "{}",
        },
        execution: {
          executionId: "exe_test" as never,
          projectId: "prj_test" as never,
          workspaceId: "ws_test" as never,
          sessionId: "ses_test" as never,
          binding: {
            _tag: "WorkspaceExecution",
            workspaceId: "ws_test" as never,
            focus: { _tag: "Coordination" },
          },
          admittedAt: "t",
          stopRequestedAt: null,
          state: { status: "Active", settlement: null },
        },
        context: {
          _tag: "ExecutionOrigin",
          principal: "worker:test" as never,
          executionId: "exe_test" as never,
          workerId: "worker:test",
          workerIncarnationId: "incarnation:test",
          fencingGeneration: 0 as never,
        },
        controlBasis: {} as never,
      }),
    );
    expect(outcome).toEqual({
      _tag: "Settle",
      settlement: {
        _tag: "OutcomeUnknown",
        reconciliation: {
          _tag: "ReconciliationRequired",
          invocationRefs: ["tin_uncertain"],
        },
      },
    });
  });

  it("keeps pre-effect ToolRuntime failure out of the model-result channel", async () => {
    const handler = makeExecutableToolHandler(
      {
        invoke: () =>
          Effect.fail({
            _tag: "ToolRuntimeOperationalFailure",
            stage: "SandboxOpen",
            effectDisposition: "NotStarted",
            invocationRef: "tin_not_started",
            cause: "sandbox unavailable",
          }),
      },
      { now: () => Effect.succeed("t") },
      {
        visibleRefs: () =>
          Effect.succeed([{ name: "read", version: "2", hash: "read-v2" }]),
        resolveForModel: () => Effect.die("unused"),
      },
    );
    const failure = await Effect.runPromise(
      Effect.flip(
        handler.handle({
          invocation: {
            providerTurnId: "ptn_test" as never,
            outputPosition: 0,
            callRef: "call-1",
            toolName: "read",
            argumentsJson: "{}",
          },
          execution: {
            executionId: "exe_test" as never,
            projectId: "prj_test" as never,
            workspaceId: "ws_test" as never,
            sessionId: "ses_test" as never,
            binding: {
              _tag: "WorkspaceExecution",
              workspaceId: "ws_test" as never,
              focus: { _tag: "Coordination" },
            },
            admittedAt: "t",
            stopRequestedAt: null,
            state: { status: "Active", settlement: null },
          },
          context: {
            _tag: "ExecutionOrigin",
            principal: "worker:test" as never,
            executionId: "exe_test" as never,
            workerId: "worker:test",
            workerIncarnationId: "incarnation:test",
            fencingGeneration: 0 as never,
          },
          controlBasis: {} as never,
        }),
      ),
    );
    expect(failure).toMatchObject({
      _tag: "AgentActionOperationalFailure",
      operation: "ToolRuntime.SandboxOpen",
    });
  });
});
