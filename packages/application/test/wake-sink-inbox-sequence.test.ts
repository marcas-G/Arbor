import type { WakeCondition, WorkId, WorkspaceId } from "@arbor/domain";
import type { WorkWait } from "@arbor/ports";
import { it } from "@effect/vitest";
import { Effect, Option } from "effect";
import { describe, expect } from "vitest";
import { deliverWakeSignal } from "../src/wake-sink.js";

const workspaceId = "ws_018f2b3c-4d5e-7abc-8def-0123456789a1" as WorkspaceId;
const workId = "wrk_018f2b3c-4d5e-7abc-8def-0123456789a1" as WorkId;
const entryKey = `steer:${workId}:1`;

const makeDependencies = (
  conditions: ReadonlyArray<WakeCondition>,
  correctionPending = true,
  workRevision = 0,
) => {
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
      works: {
        listByWorkspace: () =>
          Effect.succeed([{ workId, revision: workRevision } as never]),
      },
      inbox: {
        listUnconsumed: () =>
          Effect.succeed(
            correctionPending ? [{ entryKey, kind: "HumanInput" }] : [],
          ),
      },
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
  it.effect.each([
    { targetWorkRevision: 3, expected: 1, pending: true, target: workId },
    { targetWorkRevision: 5, expected: 0, pending: true, target: workId },
    { targetWorkRevision: 6, expected: 0, pending: true, target: workId },
    { targetWorkRevision: 3, expected: 0, pending: false, target: workId },
    {
      targetWorkRevision: 3,
      expected: 0,
      pending: true,
      target: `${workId}-other` as WorkId,
    },
  ])(
    "releases only this Work's obsolete verification wait on an unconsumed steer: %s",
    ({ targetWorkRevision, expected, pending, target }) =>
      Effect.gen(function* () {
        const state = makeDependencies(
          [
            {
              _tag: "VerificationChanged",
              workId: target,
              targetWorkRevision: targetWorkRevision as never,
            },
          ],
          pending,
          5,
        );
        yield* deliverWakeSignal(
          {
            workspaceId,
            reason: "HumanIntervention",
            detail: { inboxSequence: 9, workId, entryKey },
          },
          state.dependencies as never,
        );
        expect(state.cleared()).toBe(expected);
        expect(state.reevaluated()).toBe(1);
      }),
  );

  it.effect("clears only a WorkWait whose bound Inbox sequence advanced", () =>
    Effect.gen(function* () {
      const state = makeDependencies([
        { _tag: "Manual" },
        { _tag: "InboxAdvanced", workspaceId, observedSequence: 7 },
      ]);
      const result = yield* deliverWakeSignal(
        {
          workspaceId,
          reason: "InputArrived",
          detail: { inboxSequence: 8 },
        },
        state.dependencies as never,
      );
      expect(result).toMatchObject({ woke: true, clearedWaits: 1 });
      expect(state.cleared()).toBe(1);
      expect(state.reevaluated()).toBe(1);
    }),
  );

  it.effect(
    "does not release Manual or equal-sequence waits on generic input",
    () =>
      Effect.gen(function* () {
        const equal = makeDependencies([
          { _tag: "Manual" },
          { _tag: "InboxAdvanced", workspaceId, observedSequence: 8 },
        ]);
        yield* deliverWakeSignal(
          { workspaceId, reason: "InputArrived", detail: { inboxSequence: 8 } },
          equal.dependencies as never,
        );
        expect(equal.cleared()).toBe(0);
        expect(equal.reevaluated()).toBe(1);

        const generic = makeDependencies([{ _tag: "Manual" }]);
        yield* deliverWakeSignal(
          { workspaceId, reason: "InputArrived" },
          generic.dependencies as never,
        );
        expect(generic.cleared()).toBe(0);
        expect(generic.reevaluated()).toBe(1);
      }),
  );

  it.effect(
    "releases a plain Manual wait on human intervention but preserves Blocked waits",
    () =>
      Effect.gen(function* () {
        const manual = makeDependencies([{ _tag: "Manual" }]);
        yield* deliverWakeSignal(
          {
            workspaceId,
            reason: "HumanIntervention",
            detail: { inboxSequence: 9, workId, entryKey },
          },
          manual.dependencies as never,
        );
        expect(manual.cleared()).toBe(1);

        const blocked = makeDependencies([
          { _tag: "Manual" },
          { _tag: "InboxAdvanced", workspaceId, observedSequence: 9 },
        ]);
        yield* deliverWakeSignal(
          {
            workspaceId,
            reason: "HumanIntervention",
            detail: { inboxSequence: 9, workId, entryKey },
          },
          blocked.dependencies as never,
        );
        expect(blocked.cleared()).toBe(0);
      }),
  );

  it.effect(
    "does not release another Work's Manual wait on a targeted steer",
    () =>
      Effect.gen(function* () {
        const state = makeDependencies([{ _tag: "Manual" }]);
        yield* deliverWakeSignal(
          {
            workspaceId,
            reason: "HumanIntervention",
            detail: { inboxSequence: 9, workId: `${workId}-other`, entryKey },
          },
          state.dependencies as never,
        );
        expect(state.cleared()).toBe(0);
        expect(state.reevaluated()).toBe(1);
      }),
  );

  it.effect(
    "does not release a later Manual wait after the correction was consumed",
    () =>
      Effect.gen(function* () {
        const state = makeDependencies([{ _tag: "Manual" }], false);
        yield* deliverWakeSignal(
          {
            workspaceId,
            reason: "HumanIntervention",
            detail: { inboxSequence: 9, workId, entryKey },
          },
          state.dependencies as never,
        );
        expect(state.cleared()).toBe(0);
        expect(state.reevaluated()).toBe(1);
      }),
  );
});
