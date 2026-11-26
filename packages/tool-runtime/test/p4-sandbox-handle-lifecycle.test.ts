import type { ToolRuntimeError } from "@arbor/ports";
import { Effect, Fiber } from "effect";
import { describe, expect, it, vi } from "vitest";
import { executeAdmittedTool } from "../src/runtime/execute-admitted-tool.js";
import type { makeProcessRunner } from "../src/runtime/process-runner.js";
import type { ToolExecutor } from "../src/runtime/types.js";

const intent = {
  callRef: "c",
  toolName: "read",
  toolVersion: "2",
  invocationId: "tin_018f2b3c-4d5e-7abc-8def-0123456789a1",
  sideEffectSemantics: "ReadOnly",
  argumentsJson: "{}",
  approvalId: null,
} as never;

const context = {
  executionId: "exe_018f2b3c-4d5e-7abc-8def-0123456789a1",
  workspaceId: "ws_018f2b3c-4d5e-7abc-8def-0123456789a1",
} as never;

const okExecutor: ToolExecutor = {
  name: "read",
  write: false,
  requiresApproval: () => false,
  execute: () =>
    Effect.succeed({
      settlement: { _tag: "Success" },
      observation: { text: "ok", truncated: false },
      resultRef: null,
    }),
};

type LifecycleTrace = {
  opened: boolean;
  closed: number;
  closeFails?: boolean;
};

const sandboxStub = (trace: LifecycleTrace) =>
  ({
    open: () =>
      Effect.sync(() => {
        trace.opened = true;
        return {
          handleId: "s",
          rootPath: "/tmp/s",
          writableRegions: [],
        };
      }),
    close: () => {
      if (trace.closeFails === true) {
        return Effect.fail({ _tag: "SandboxError", cause: "close-failure" });
      }
      trace.closed += 1;
      return Effect.succeed(true);
    },
  }) as never;

const run = (executor: ToolExecutor, trace: LifecycleTrace) =>
  executeAdmittedTool(
    intent,
    context,
    context,
    { sideEffectSemantics: "ReadOnly" } as never,
    executor,
    sandboxStub(trace),
    undefined,
    undefined,
    [],
    undefined,
    (() => {}) as unknown as ReturnType<typeof makeProcessRunner>,
  );

describe("P4 sandbox handle lifecycle (E07)", () => {
  it("closes the handle on the success path", async () => {
    const trace: LifecycleTrace = { opened: false, closed: 0 };
    const outcome = await Effect.runPromise(run(okExecutor, trace));
    expect(outcome.settlement).toEqual({ _tag: "Success" });
    expect(trace.opened).toBe(true);
    expect(trace.closed).toBe(1);
  });

  it("closes the handle when the executor fails with a typed error", async () => {
    const trace: LifecycleTrace = { opened: false, closed: 0 };
    const failingExecutor: ToolExecutor = {
      ...okExecutor,
      execute: () =>
        Effect.fail({
          _tag: "ToolRuntimeOperationalFailure",
          stage: "Executor",
          effectDisposition: "OutcomeUncertain",
          invocationRef: "tin",
          cause: "boom",
        } as ToolRuntimeError),
    };
    const exit = await Effect.runPromise(
      Effect.exit(run(failingExecutor, trace)),
    );
    expect(trace.closed).toBe(1);
    expect(exit._tag).toBe("Failure");
  });

  it("releases the handle when the invoke fiber is interrupted", async () => {
    const trace: LifecycleTrace = { opened: false, closed: 0 };
    const parkedExecutor: ToolExecutor = {
      ...okExecutor,
      execute: () => Effect.never as Effect.Effect<never, never>,
    };
    const child = Effect.runFork(
      Effect.gen(function* () {
        const fiber = yield* Effect.forkChild(run(parkedExecutor, trace));
        yield* Effect.promise(() =>
          vi.waitFor(() => expect(trace.opened).toBe(true)),
        );
        yield* Fiber.interrupt(fiber);
        yield* Fiber.await(fiber);
      }),
    );
    await Effect.runPromise(Fiber.await(child));
    expect(trace.opened).toBe(true);
    expect(trace.closed).toBe(1);
  });

  it("reports a close failure as the typed cleanup failure", async () => {
    const trace: LifecycleTrace = {
      opened: false,
      closed: 0,
      closeFails: true,
    };
    const exit = await Effect.runPromise(Effect.exit(run(okExecutor, trace)));
    expect(trace.closed).toBe(0);
    expect(exit._tag).toBe("Failure");
    if (exit._tag === "Failure") {
      const reasons = exit.cause.reasons as ReadonlyArray<{
        _tag?: string;
        error?: { stage?: string };
      }>;
      const fail = reasons.find((reason) => reason._tag === "Fail");
      expect(fail?.error?.stage).toBe("SandboxClose");
    }
  });
});
