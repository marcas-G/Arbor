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
    [
      {
        _tag: "Denied" as const,
        reasonCode: "InvocationAuthorityDenied" as const,
        reason: "policy",
      },
      "Denied",
    ],
    [{ _tag: "Interrupted" as const }, "Interrupted"],
    [{ _tag: "RuntimeFailure" as const, cause: "defect" }, "Failed"],
  ])("maps %s to typed status %s", (input, status) => {
    const outcome = toExecutableOutcome(input);
    expect(outcome).toMatchObject({ _tag: "Observation", status });
    if (input._tag === "Denied") {
      expect(outcome).toMatchObject({
        terminalDenial: {
          _tag: "P4NoEffectDenied",
          reasonCode: input.reasonCode,
        },
      });
    }
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

  it("preserves typed sandbox unavailability for P9 instead of mapping it to a generic failure", () => {
    const outcome = {
      _tag: "SandboxProviderUnavailable" as const,
      projectId: "prj_test" as never,
      workspaceId: "ws_test" as never,
      executionId: "exe_test" as never,
      episodeBinding: {
        _tag: "InboxEpisode" as const,
        entryKey: "entry_test",
        inputKind: "HumanMessage",
      },
      policyRevision: 3,
      policyDigest: "a".repeat(64),
      profileId: "WorkspaceWrite" as const,
      providerId: "bwrap",
      providerVersion: "0.8.0",
      probeEvidenceRef: null,
      failureCode: "ProviderNotSupported",
    };
    expect(toExecutableOutcome(outcome)).toEqual({
      _tag: "SandboxProviderUnavailable",
      outcome,
    });
  });

  it("keeps a final P39 NotOccurred result as a failed sourced observation with its distinct P4 Artifact", () => {
    expect(
      toExecutableOutcome({
        _tag: "ReconciledNoEffect",
        reasonCode: "ReplayLimitReached",
        reconciliationFactRef: "f".repeat(64),
        observation: { text: "the effect was proven absent", truncated: false },
        resultRef: "art_p40_result",
      }),
    ).toEqual({
      _tag: "Observation",
      source: "Tool",
      observation: { text: "the effect was proven absent", truncated: false },
      status: "Failed",
      disposition: "ReconciledNoEffect:ReplayLimitReached",
      resultRef: "art_p40_result",
      artifactRefs: ["art_p40_result"],
      reconciliationFactRef: "f".repeat(64),
    });
  });

  it.each([
    [
      "AuthoritySnapshotChanged",
      "Denied",
      "ReconciledNoEffect:AuthoritySnapshotChanged",
    ],
    [
      "ResourceSnapshotChanged",
      "Denied",
      "ReconciledNoEffect:ResourceSnapshotChanged",
    ],
    [
      "ApprovalNoLongerAuthorized",
      "Denied",
      "ReconciledNoEffect:ApprovalNoLongerAuthorized",
    ],
    ["StopRequested", "Interrupted", "ExecutionStopping"],
  ] as const)(
    "persists the exact selected P39 fact separately from the Artifact for %s",
    (reasonCode, status, disposition) => {
      const reconciliationFactRef = "d".repeat(64);
      const resultRef = "art_p40_selected_result";
      expect(
        toExecutableOutcome({
          _tag: "ReconciledNoEffect",
          reasonCode,
          reconciliationFactRef,
          observation: { text: "effect did not occur", truncated: true },
          resultRef,
        }),
      ).toEqual({
        _tag: "Observation",
        source: "Tool",
        observation: { text: "effect did not occur", truncated: true },
        status,
        disposition,
        resultRef,
        artifactRefs: [resultRef],
        reconciliationFactRef,
      });
    },
  );

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

  it("propagates P4 replay-evidence loss as a P3 recovery block with the exact action source", async () => {
    let source: {
      readonly providerTurnId?: string;
      readonly logicalActionId?: string;
    } = {};
    const handler = makeExecutableToolHandler(
      {
        invoke: (_intent, context) => {
          source = context;
          return Effect.fail({
            _tag: "ToolObservationRecoveryBlocked" as const,
            executionId: "exe_p40_replay" as never,
            logicalActionId: "lac_p40_replay",
          });
        },
      },
      { now: () => Effect.succeed("t") },
      {
        visibleRefs: () =>
          Effect.succeed([{ name: "read", version: "2", hash: "read-v2" }]),
        resolveForModel: () => Effect.die("unused"),
      },
    );
    const blocked = await Effect.runPromise(
      Effect.flip(
        handler.handle({
          invocation: {
            providerTurnId: "ptn_p40_replay" as never,
            outputPosition: 0,
            callRef: "call-p40-replay",
            toolName: "read",
            argumentsJson: "{}",
          },
          execution: {
            executionId: "exe_p40_replay" as never,
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
          } as never,
          context: {
            _tag: "ExecutionOrigin",
            principal: "worker:test" as never,
            executionId: "exe_p40_replay" as never,
            workerId: "worker:test",
            workerIncarnationId: "incarnation:test",
            fencingGeneration: 0 as never,
          },
          controlBasis: {} as never,
          providerTurnId: "ptn_p40_replay",
          logicalActionId: "lac_p40_replay",
        }),
      ),
    );
    expect(blocked).toMatchObject({
      _tag: "AgentActionRecoveryBlocked",
      executionId: "exe_p40_replay",
      logicalActionId: "lac_p40_replay",
    });
    expect(source).toMatchObject({
      providerTurnId: "ptn_p40_replay",
      logicalActionId: "lac_p40_replay",
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
