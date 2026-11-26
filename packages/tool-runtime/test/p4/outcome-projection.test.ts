import { parse, ToolInvocationId } from "@arbor/domain";
import { type InvocationApproval, ToolRuntimePort } from "@arbor/ports";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { actionDigestOf, type ToolExecutor } from "../../src/index.js";
import {
  context,
  expectWorkspaceSnapshotPhases,
  fixtureWorkspaceAddresses,
  intent,
  invocationId,
  okExecutor,
  workspaceId,
} from "./support.js";
import { app, run } from "./support-app.js";
import type { PipelineTrace } from "./support-harness.js";

describe("P4 tool runtime pipeline", () => {
  it("returns ExpectedFailure on invalid input", async () => {
    const result = await run(app(), "{}");
    expect(result._tag).toBe("ExpectedFailure");
  });

  it("returns Denied when admission denies", async () => {
    const trace: PipelineTrace = {
      noEffectDenials: [],
      events: [],
      approvalConsumer: null,
      intentWrites: 0,
      effectAdmissions: 0,
      approvalConsumes: 0,
    };
    const result = await run(
      app(true, okExecutor, {}, trace),
      '{"target":{"mount":"workspace","path":"."}}',
    );
    expect(result).toMatchObject({
      _tag: "Denied",
      reasonCode: "ResourceAdmissionDenied",
    });
    expect(trace).toMatchObject({
      noEffectDenials: ["ResourceAdmissionDenied"],
      events: ["denied"],
      approvalConsumer: null,
      intentWrites: 0,
      effectAdmissions: 0,
      approvalConsumes: 0,
    });
    expectWorkspaceSnapshotPhases(trace, [
      {
        phase: "InitialBoundaryResolve",
        workspaceId,
        revision: 0,
        addresses: fixtureWorkspaceAddresses,
      },
      {
        phase: "FinalClaimFreshness",
        workspaceId,
        revision: 0,
        addresses: fixtureWorkspaceAddresses,
      },
    ]);
  });

  it("returns Denied for an unknown tool", async () => {
    const result = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const runtime = yield* ToolRuntimePort;
          return yield* runtime.invoke(
            { ...intent("{}"), toolName: "nope" } as never,
            context,
          );
        }),
        app(),
      ) as Effect.Effect<{ _tag: string }, unknown, never>,
    );
    expect(result._tag).toBe("Denied");
  });

  it("requires approval when the executor demands it", async () => {
    const approvalExecutor: ToolExecutor = {
      name: "read",
      write: false,
      requiresApproval: () => true,
      execute: okExecutor.execute,
    };
    const trace: PipelineTrace = {
      noEffectDenials: [],
      events: [],
      approvalConsumer: null,
      intentWrites: 0,
      effectAdmissions: 0,
      approvalConsumes: 0,
    };
    const result = await run(
      app(false, approvalExecutor, {}, trace),
      '{"target":{"mount":"workspace","path":"."}}',
    );
    expect(result).toMatchObject({
      _tag: "ApprovalRequired",
    });
    expect(trace).toMatchObject({
      noEffectDenials: [],
      events: [],
      approvalConsumer: null,
      intentWrites: 0,
      effectAdmissions: 0,
      approvalConsumes: 0,
    });
    expectWorkspaceSnapshotPhases(trace, [
      {
        phase: "InitialBoundaryResolve",
        workspaceId,
        revision: 0,
        addresses: fixtureWorkspaceAddresses,
      },
    ]);
  });

  it("does not accept a P38 approval id without its exact executable context", async () => {
    const approvalExecutor: ToolExecutor = {
      name: "read",
      write: false,
      requiresApproval: () => true,
      execute: okExecutor.execute,
    };
    const trace: PipelineTrace = {
      noEffectDenials: [],
      events: [],
      approvalConsumer: null,
      intentWrites: 0,
      effectAdmissions: 0,
      approvalConsumes: 0,
    };
    const result = await run(
      app(false, approvalExecutor, {}, trace),
      '{"target":{"mount":"workspace","path":"."}}',
      "eap_018f2b3c-4d5e-7abc-8def-0123456789a1",
    );

    expect(result).toMatchObject({
      _tag: "Denied",
      reasonCode: "ApprovalNotFound",
    });
    expect(trace).toMatchObject({
      noEffectDenials: ["ApprovalNotFound"],
      events: ["denied"],
      approvalConsumer: null,
      intentWrites: 0,
      effectAdmissions: 0,
      approvalConsumes: 0,
    });
    expectWorkspaceSnapshotPhases(trace, [
      {
        phase: "InitialBoundaryResolve",
        workspaceId,
        revision: 0,
        addresses: fixtureWorkspaceAddresses,
      },
    ]);
  });

  it("fails closed when this approval's consumer has no recorded invocation", async () => {
    const approvalExecutor: ToolExecutor = {
      name: "read",
      write: false,
      requiresApproval: () => true,
      execute: okExecutor.execute,
    };
    const argumentsJson = '{"target":{"mount":"workspace","path":"."}}';
    const approvalId = "iap_018f2b3c-4d5e-7abc-8def-0123456789a1";
    const approval: InvocationApproval = {
      approvalId,
      toolName: "read",
      toolVersion: "2",
      actionDigest: actionDigestOf(intent(argumentsJson)),
      targetResourceSpaceIds: ["filesystem"],
      controlBasisDigest: "d",
      expiresAt: "2999-01-01T00:00:00.000Z",
      consumedBy: invocationId,
    };
    const trace: PipelineTrace = {
      noEffectDenials: [],
      events: [],
      approvalConsumer: null,
      intentWrites: 0,
      effectAdmissions: 0,
      approvalConsumes: 0,
    };
    const result = await run(
      app(false, approvalExecutor, {}, trace, approval),
      argumentsJson,
      approvalId,
    );

    expect(result).toMatchObject({
      _tag: "Denied",
      reasonCode: "ApprovalConsumedByOtherInvocation",
    });
    expect(trace.approvalConsumes).toBe(0);
    expect(trace.intentWrites).toBe(0);
    expect(trace.effectAdmissions).toBe(0);
  });

  it("does not reuse a legacy approval consumed by another invocation", async () => {
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
    const consumedApproval: InvocationApproval = {
      approvalId,
      toolName: "read",
      toolVersion: "2",
      actionDigest: actionDigestOf(intent(argumentsJson)),
      targetResourceSpaceIds: ["filesystem"],
      controlBasisDigest: "d",
      expiresAt: "2999-01-01T00:00:00.000Z",
      consumedBy: invocationId,
    };
    const trace: PipelineTrace = {
      noEffectDenials: [],
      events: [],
      approvalConsumer: null,
      intentWrites: 0,
      effectAdmissions: 0,
      approvalConsumes: 0,
    };
    const otherInvocationId = parse(ToolInvocationId)(
      "tin_018f2b3c-4d5e-7abc-8def-0123456789a2",
    );
    const result = await run(
      app(false, approvalExecutor, {}, trace, consumedApproval),
      argumentsJson,
      approvalId,
      otherInvocationId,
    );

    expect(result).toMatchObject({
      _tag: "Denied",
      reasonCode: "ApprovalConsumedByOtherInvocation",
    });
    expect(trace.approvalConsumes).toBe(0);
    expect(trace.intentWrites).toBe(0);
    expect(trace.effectAdmissions).toBe(0);
    expect(executorCalls).toBe(0);
  });
});
