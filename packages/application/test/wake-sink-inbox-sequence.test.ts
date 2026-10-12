import type { WakeCondition, WorkId, WorkspaceId } from "@arbor/domain";
import type { WorkWait } from "@arbor/ports";
import { Effect, Option } from "effect";
import { describe, expect, it } from "vitest";
import { deliverWakeSignal } from "../src/wake-sink.js";

const workspaceId = "ws_018f2b3c-4d5e-7abc-8def-0123456789a1" as WorkspaceId;
const workId = "wrk_018f2b3c-4d5e-7abc-8def-0123456789a1" as WorkId;

const makeDependencies = (conditions: ReadonlyArray<WakeCondition>) => {
  const wait: WorkWait = {
    workId,
    waitSpec: { mode: "Any", conditions },
    registeredAt: "t0",
    updatedAt: "t0",
  };
  let cleared = 0;
  let reevaluated = 0;
  return {
    dependencies: {
      tx: { transact: (effect: Effect.Effect<unknown>) => effect },
      waits: {
        findByWork: () => Effect.succeed(Option.some(wait)),
        clear: () => Effect.sync(() => (cleared += 1)).pipe(Effect.asVoid),
      },
      works: { listByWorkspace: () => Effect.succeed([{ workId } as never]) },
      scheduler: {
        reevaluate: () =>
          Effect.sync(() => (reevaluated += 1)).pipe(
            Effect.as({ _tag: "Idle" as const }),
          ),
      },
    },
    cleared: () => cleared,
    reevaluated: () => reevaluated,
  };
};

describe("InboxAdvanced wake release", () => {
  it("clears only a WorkWait whose bound Inbox sequence advanced", async () => {
    const state = makeDependencies([
      { _tag: "Manual" },
      { _tag: "InboxAdvanced", workspaceId, observedSequence: 7 },
    ]);
    const result = await Effect.runPromise(
      deliverWakeSignal(
        {
          workspaceId,
          reason: "InputArrived",
          detail: { inboxSequence: 8 },
        },
        state.dependencies as never,
      ),
    );
    expect(result).toMatchObject({ woke: true, clearedWaits: 1 });
    expect(state.cleared()).toBe(1);
    expect(state.reevaluated()).toBe(1);
  });

  it("does not release Manual or equal-sequence waits on generic input", async () => {
    const equal = makeDependencies([
      { _tag: "Manual" },
      { _tag: "InboxAdvanced", workspaceId, observedSequence: 8 },
    ]);
    await Effect.runPromise(
      deliverWakeSignal(
        { workspaceId, reason: "InputArrived", detail: { inboxSequence: 8 } },
        equal.dependencies as never,
      ),
    );
    expect(equal.cleared()).toBe(0);
    expect(equal.reevaluated()).toBe(1);

    const generic = makeDependencies([{ _tag: "Manual" }]);
    await Effect.runPromise(
      deliverWakeSignal(
        { workspaceId, reason: "InputArrived" },
        generic.dependencies as never,
      ),
    );
    expect(generic.cleared()).toBe(0);
    expect(generic.reevaluated()).toBe(1);
  });
});
