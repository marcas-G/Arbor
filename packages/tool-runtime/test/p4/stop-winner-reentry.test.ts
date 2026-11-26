import type {
  ToolInvocationRecord,
  ToolObservationEvidence,
} from "@arbor/ports";
import { describe, expect, it } from "vitest";
import type { ToolExecutor } from "../../src/index.js";
import {
  executionId,
  invocationId,
  okExecutor,
  workspaceId,
} from "./support.js";
import { app, run } from "./support-app.js";
import type { PipelineTrace } from "./support-harness.js";

describe("P4 tool runtime pipeline", () => {
  it("runs the pipeline and returns Success", async () => {
    const result = await run(
      app(),
      '{"target":{"mount":"workspace","path":"."}}',
    );
    expect(result._tag).toBe("Success");
  });

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
      name: "Interrupted",
      effectAdmissionState: "NotAdmitted",
      settlement: { _tag: "Interrupted" },
      observation: { _tag: "Interrupted" },
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
    "P4 Stop re-entry projects the committed $name winner without rerunning the executor",
    async (winnerCase) => {
      const argumentsJson = '{"target":{"mount":"workspace","path":"."}}';
      const observation =
        winnerCase.observation as import("@arbor/ports").ToolObservationEvidenceObservation;
      const evidence: ToolObservationEvidence = {
        formatVersion: "p4-canonical-tool-observation-v1",
        bytes: new TextEncoder().encode(JSON.stringify(observation)),
        sha256: "a".repeat(64),
        observation,
      };
      const existing: ToolInvocationRecord = {
        invocationId,
        executionId,
        workspaceId,
        toolName: "read",
        toolVersion: "2",
        sideEffectSemantics: "ReadOnly",
        argumentsJson,
        resolvedRegions: [],
        approvalId: null,
        effectAdmissionState: winnerCase.effectAdmissionState,
        intentAt: "2026-01-01T00:00:00.000Z",
        settledAt: "2026-01-01T00:00:01.000Z",
        settlement: winnerCase.settlement as ToolInvocationRecord["settlement"],
        resultRef: null,
      };
      const trace: PipelineTrace = {
        noEffectDenials: [],
        events: [],
        approvalConsumer: null,
        intentWrites: 0,
        effectAdmissions: 0,
        approvalConsumes: 0,
        existingInvocationAfterStop: existing,
        p40WinnerEvidence: evidence,
        stopAtEffectAdmission: true,
      };
      let executorCalls = 0;
      const executor: ToolExecutor = {
        ...okExecutor,
        execute: (input) => {
          executorCalls += 1;
          return okExecutor.execute(input);
        },
      };
      const result = await run(app(false, executor, {}, trace), argumentsJson);
      expect(result).toEqual(observation);
      expect(executorCalls).toBe(0);
      expect(trace.effectAdmissions).toBe(1);
    },
  );

  it("keeps the canonical P4 Denied winner when Stop arrives before the effect gate", async () => {
    const argumentsJson = '{"target":{"mount":"workspace","path":"."}}';
    const deniedRecord: ToolInvocationRecord = {
      invocationId,
      executionId,
      workspaceId,
      toolName: "read",
      toolVersion: "2",
      sideEffectSemantics: "ReadOnly",
      argumentsJson,
      resolvedRegions: [],
      approvalId: null,
      effectAdmissionState: "NotAdmitted",
      intentAt: "2026-01-01T00:00:00.000Z",
      settledAt: "2026-01-01T00:00:01.000Z",
      settlement: { _tag: "Denied", reasonCode: "InvocationAuthorityDenied" },
      resultRef: null,
    };
    const trace: PipelineTrace = {
      noEffectDenials: [],
      events: [],
      approvalConsumer: null,
      intentWrites: 0,
      effectAdmissions: 0,
      approvalConsumes: 0,
      existingInvocationAfterStop: deniedRecord,
      stopAtEffectAdmission: true,
    };
    const result = await run(app(false, okExecutor, {}, trace), argumentsJson);
    expect(result).toMatchObject({
      _tag: "Denied",
      reasonCode: "InvocationAuthorityDenied",
    });
    expect(trace.effectAdmissions).toBe(1);
  });

  it("uses the legacy no-P40 interruption writer idempotently for a Stop before effect admission", async () => {
    const argumentsJson = '{"target":{"mount":"workspace","path":"."}}';
    const existing: ToolInvocationRecord = {
      invocationId,
      executionId,
      workspaceId,
      toolName: "read",
      toolVersion: "2",
      sideEffectSemantics: "ReadOnly",
      argumentsJson,
      resolvedRegions: [
        {
          resourceSpaceId: "filesystem",
          normalizedRegion: { _tag: "GitWorktree", path: "/repo/a" },
        },
      ],
      approvalId: null,
      effectAdmissionState: "NotAdmitted",
      intentAt: "2026-01-01T00:00:00.000Z",
      settledAt: null,
      settlement: null,
      resultRef: null,
    };
    const trace: PipelineTrace = {
      noEffectDenials: [],
      events: [],
      approvalConsumer: null,
      intentWrites: 0,
      effectAdmissions: 0,
      approvalConsumes: 0,
      existingInvocationAfterStop: existing,
      stopAtEffectAdmission: true,
    };
    const layer = app(false, okExecutor, {}, trace);
    const first = await run(layer, argumentsJson);
    const replay = await run(layer, argumentsJson);

    expect(first).toEqual({ _tag: "Interrupted" });
    expect(replay).toEqual({ _tag: "Interrupted" });
    expect(trace.legacyNoEffectInterruptionWrites).toBe(1);
    expect(trace.legacyInterruptedInvocation).toMatchObject({
      effectAdmissionState: "NotAdmitted",
      settlement: { _tag: "Interrupted" },
    });
    expect(trace.intentWrites).toBe(1);
    expect(trace.effectAdmissions).toBe(1);
    expect(trace.approvalConsumes).toBe(0);
  });
});
