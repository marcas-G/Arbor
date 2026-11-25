import { TransactionScope } from "@arbor/ports";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { proposePreparedStepSettlement } from "../src/decision/settlement.js";
import { settlementProposal } from "../src/settlement-proposal.js";
import { fixtureProviderTurnId } from "./fixtures/provider-turn.js";

describe("settlement proposal", () => {
  it("preserves the immutable settlement value", () => {
    const settlement = {
      _tag: "Interrupted",
      result: { _tag: "ControlledInterruption", reason: "test" },
    } as const;
    expect(settlementProposal(settlement)).toEqual({
      _tag: "SettlementProposal",
      settlement,
    });
  });
});

describe("Prepared step settlement phase", () => {
  const settlement = {
    _tag: "Interrupted",
    result: { _tag: "ControlledInterruption", reason: "test" },
  } as const;
  const providerTurnId = fixtureProviderTurnId();
  const timestamp = "2026-10-17T00:00:01.000Z";

  it("does not open a transaction when no step is present", async () => {
    const result = await Effect.runPromise(
      proposePreparedStepSettlement(
        {
          tx: {
            transact: () => Effect.die("unexpected transaction"),
          } as never,
          options: {},
          failure: (cause) => cause as never,
          now: () => Effect.succeed(timestamp),
        },
        { loopStep: undefined, providerTurnId, settlement },
      ),
    );
    expect(result).toBeUndefined();
  });

  it("returns the fenced transition result and retains the original step", async () => {
    const step = {
      identity: {
        executionId: "exe_00000000-0000-7000-8000-000000000001",
        logicalStepNo: 0,
        repairAttempt: 0,
      },
      providerTurnId,
      state: "Prepared",
      nextActionIndex: 0,
      revision: 1,
      updatedAt: "2026-10-17T00:00:00.000Z",
    } as const;
    const fence = { fencingGeneration: 1 };
    const trace: string[] = [];
    const result = await Effect.runPromise(
      proposePreparedStepSettlement(
        {
          tx: {
            transact: (
              body: Effect.Effect<unknown, unknown, TransactionScope>,
            ) =>
              Effect.gen(function* () {
                trace.push("transaction");
                return yield* Effect.provideService(body, TransactionScope, {
                  session: { id: "prepared-settlement-test" },
                });
              }),
          } as never,
          loopSteps: {
            transition: (
              input: {
                readonly expectedRevision: number;
                readonly expectedState: string;
                readonly next: unknown;
              },
              actualFence: unknown,
            ) =>
              Effect.sync(() => {
                trace.push("transition");
                expect(input.expectedRevision).toBe(1);
                expect(input.expectedState).toBe("Prepared");
                expect(actualFence).toBe(fence);
                return input.next;
              }),
          } as never,
          loopStepFence: fence as never,
          options: {},
          failure: (cause) => cause as never,
          now: () => Effect.succeed(timestamp),
        },
        { loopStep: step as never, providerTurnId, settlement },
      ),
    );
    expect(trace).toEqual(["transaction", "transition"]);
    expect(result).toEqual({
      ...step,
      state: "SettlementProposed",
      revision: 2,
      settlement,
      updatedAt: timestamp,
    });
    expect(step.state).toBe("Prepared");
  });
});
