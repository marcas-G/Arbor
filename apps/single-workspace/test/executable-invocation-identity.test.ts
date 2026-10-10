import { createHash } from "node:crypto";
import type { ExecutionId } from "@arbor/domain";
import { Effect, Option } from "effect";
import { describe, expect, it } from "vitest";
import { makeExecutableToolHandler } from "../src/executable-tool-handler.js";

const invocation = {
  providerTurnId: "ptn_identity-test" as never,
  outputPosition: 0,
  callRef: "same-provider-call-ref",
  toolName: "read",
  argumentsJson: "{}",
};

const executionFor = (executionId: string) =>
  ({
    executionId: executionId as ExecutionId,
    projectId: "prj_identity-test" as never,
    workspaceId: "ws_identity-test" as never,
    sessionId: "ses_identity-test" as never,
    binding: {
      _tag: "WorkspaceExecution",
      workspaceId: "ws_identity-test" as never,
      focus: { _tag: "Coordination" },
    },
    admittedAt: "2026-10-05T00:00:00.000Z",
    stopRequestedAt: null,
    state: { status: "Active", settlement: null },
  }) as never;

const contextFor = (executionId: string) =>
  ({
    _tag: "ExecutionOrigin",
    principal: "worker:identity-test" as never,
    executionId: executionId as ExecutionId,
    workerId: "worker:identity-test",
    workerIncarnationId: "incarnation:identity-test",
    fencingGeneration: 0 as never,
  }) as never;

describe("executable tool invocation identity scope", () => {
  it("separates executions that reuse a provider callRef and stabilizes retries within one execution", async () => {
    const observed: Array<{
      readonly executionId: string;
      readonly invocationId: string;
    }> = [];
    const handler = makeExecutableToolHandler(
      {
        invoke: (toolIntent, toolContext) => {
          observed.push({
            executionId: String(toolContext.executionId),
            invocationId: String(toolIntent.invocationId),
          });
          return Effect.succeed({
            _tag: "Success" as const,
            observation: { text: "ok", truncated: false },
            resultRef: null,
          });
        },
      },
      { now: () => Effect.succeed("2026-10-05T00:00:00.000Z") },
      {
        visibleRefs: () =>
          Effect.succeed([{ name: "read", version: "1", hash: "read-v1" }]),
        resolveForModel: () => Effect.die("unused"),
      },
    );

    const invokeFor = (executionId: string) =>
      Effect.runPromise(
        handler.handle({
          invocation,
          execution: executionFor(executionId),
          context: contextFor(executionId),
          controlBasis: {} as never,
        }),
      );

    await invokeFor("exe_identity_a");
    await invokeFor("exe_identity_b");
    await invokeFor("exe_identity_a");

    expect(observed).toHaveLength(3);
    expect(observed[0]?.executionId).toBe("exe_identity_a");
    expect(observed[1]?.executionId).toBe("exe_identity_b");
    expect(observed[2]?.executionId).toBe("exe_identity_a");
    expect(observed[0]?.invocationId).not.toBe(observed[1]?.invocationId);
    expect(observed[0]?.invocationId).toBe(observed[2]?.invocationId);
  });

  it("adopts only an exact pre-AH7 invocation from the same Execution", async () => {
    const legacyId = `tin_018f2b3c-4d5e-7abc-8def-${createHash("sha256")
      .update(invocation.callRef)
      .digest("hex")
      .slice(0, 12)}`;
    const ids: string[] = [];
    const handler = makeExecutableToolHandler(
      {
        invoke: (intent) => {
          ids.push(intent.invocationId);
          return Effect.succeed({
            _tag: "Success" as const,
            observation: { text: "ok", truncated: false },
            resultRef: null,
          });
        },
      },
      { now: () => Effect.succeed("2026-10-05T00:00:00.000Z") },
      {
        visibleRefs: () =>
          Effect.succeed([{ name: "read", version: "1", hash: "read-v1" }]),
        resolveForModel: () => Effect.die("unused"),
      },
      () =>
        Effect.succeed(
          Option.some({
            invocationId: legacyId as never,
            executionId: "exe_identity_a" as never,
            workspaceId: "ws_identity-test" as never,
            toolName: "read",
            toolVersion: "1",
            sideEffectSemantics: "ReadOnly",
            argumentsJson: invocation.argumentsJson,
            resolvedRegions: [],
            approvalId: null,
            intentAt: "2026-10-04T00:00:00.000Z",
            settledAt: null,
            settlement: null,
            resultRef: null,
          }),
        ),
    );
    for (const id of ["exe_identity_a", "exe_identity_b"]) {
      await Effect.runPromise(
        handler.handle({
          invocation,
          execution: executionFor(id),
          context: contextFor(id),
          controlBasis: {} as never,
        }),
      );
    }
    expect(ids[0]).toBe(legacyId);
    expect(ids[1]).not.toBe(legacyId);
  });

  it("fails closed before ToolRuntime when an active ExecutionOrigin lacks the lease holder triple", async () => {
    let invocationCalls = 0;
    const handler = makeExecutableToolHandler(
      {
        invoke: () => {
          invocationCalls += 1;
          return Effect.succeed({
            _tag: "Success" as const,
            observation: { text: "must not run", truncated: false },
            resultRef: null,
          });
        },
      },
      { now: () => Effect.succeed("2026-10-05T00:00:00.000Z") },
      {
        visibleRefs: () =>
          Effect.succeed([{ name: "read", version: "1", hash: "read-v1" }]),
        resolveForModel: () => Effect.die("unused"),
      },
    );
    const error = await Effect.runPromise(
      Effect.flip(
        handler.handle({
          invocation,
          execution: executionFor("exe_missing_execution_fence"),
          context: {
            _tag: "ExecutionOrigin",
            principal: "worker:identity-test" as never,
            executionId: "exe_missing_execution_fence" as never,
            fencingGeneration: 0 as never,
          } as never,
          controlBasis: {} as never,
        }),
      ),
    );
    expect(error).toMatchObject({
      _tag: "AgentActionOperationalFailure",
      operation: "ToolRuntime.LeaseFenceUnavailable",
    });
    expect(invocationCalls).toBe(0);
  });
});
