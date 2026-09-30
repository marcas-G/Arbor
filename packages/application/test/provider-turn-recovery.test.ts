import {
  DEFAULT_PROVIDER_EXECUTION_POLICY,
  type ProviderTurnStoreService,
  type TransactionPortService,
  TransactionScope,
  type UnsettledProviderTurn,
} from "@arbor/ports";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { recoverUnsettledProviderTurns } from "../src/provider-turn-recovery.js";

const turn: UnsettledProviderTurn = {
  turn: {
    providerTurnId: "ptn_deadline_invalid" as never,
    executionId: "exe_deadline_invalid" as never,
    sessionId: "ses_deadline_invalid" as never,
    contextEpoch: 0 as never,
    modelRef: "model-a",
    outputContractRef: "oc",
    manifestId: "mft_deadline_invalid",
    executionPolicy: DEFAULT_PROVIDER_EXECUTION_POLICY,
    turnDeadlineAt: "not-an-instant",
  },
  attempts: [],
  manifestJson: JSON.stringify({
    providerTurnId: "ptn_deadline_invalid",
    executionId: "exe_deadline_invalid",
    sessionId: "ses_deadline_invalid",
    contextEpoch: 0,
    modelRef: "model-a",
    outputContractRef: "oc",
    compiledRequestHash: "hash",
  }),
  portableRequestJson: JSON.stringify({
    modelRef: "model-a",
    outputContractRef: "oc",
    instructions: [],
    messages: [],
    toolDefinitions: [],
  }),
};

describe("ProviderTurn recovery deadline", () => {
  it("fails closed when the persisted absolute deadline is malformed", async () => {
    let failedTurns = 0;
    const turns = {
      findUnsettledByProject: () => Effect.succeed([turn]),
      recordRecoveryDecision: () => Effect.void,
      failTurn: () =>
        Effect.sync(() => {
          failedTurns += 1;
        }),
    } as unknown as ProviderTurnStoreService;
    const tx: TransactionPortService = {
      transact: (body) =>
        Effect.provideService(body, TransactionScope, {
          session: { id: "test" },
        }),
    };
    const report = await Effect.runPromise(
      recoverUnsettledProviderTurns(
        {
          turns,
          tx,
          clock: { now: () => Effect.succeed("2026-09-30T00:00:00.000Z") },
        },
        "prj_deadline_invalid" as never,
        "runtime:test" as never,
      ),
    );

    expect(report.retryPlan).toEqual([]);
    expect(report.failedTurns).toHaveLength(1);
    expect(report.failedTurns[0]?.retryDecision).toMatchObject({
      decision: "Stop",
      safety: "UnsafeReplay",
    });
    expect(failedTurns).toBe(1);
  });
});
