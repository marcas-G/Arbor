import { Cause, Effect, Exit } from "effect";
import { describe, expect, it } from "vitest";
import {
  type ProviderContinuationCheckpoint,
  ProviderRuntime,
} from "../../packages/ports/src/index.js";
import { labeled } from "../support/p9-harness-api.js";
import type { ProviderProbe } from "./support.js";
import {
  attemptRows,
  boot,
  executionSettlement,
  makeApp,
  manifestIdFor,
  openDanglingTurn,
  principal,
  providerTurnId,
  providerTurnIdB,
  providerTurnIdC,
  providerTurnIdD,
  recover,
  recoveryDecisionRows,
  recoveryRunTurnInput,
  run,
  successTurn,
  turnRows,
} from "./support.js";

/**
 * P9-008 — provider disconnect injection (PD1–PD4 / I-4..I-7; P9 `02` §6,
 * `04` §2). Disconnect ≜ ProviderUnavailable (failure before the stream is
 * established) ∪ StreamInterrupted (break after TurnStarted). The harness
 * classifies by the observable boundary (`TurnStarted` emitted or not),
 * never by transport errno (04 §2.1, GQ4 zero-new-tag mapping). Every row
 * is labeled crash-injected (GQ5).
 */

describe("p9-provider-disconnect (PD1–PD4 / I-4..I-7, 02 §6 + 04 §2)", () => {
  it("PD4/I-7 [crash-injected]: daemon crash leaves the Turn unsettled → recovery plans resume-by-retry on the SAME Turn (attempt_no = MAX+1 / 0 for a no-attempt leftover); never calls the provider", async () => {
    expect(
      labeled("PD4-crash-resume-same-turn", "crash-injected").guarantee,
    ).toBe("crash-injected");
    const probe: ProviderProbe = { calls: [] };
    const r = await run(
      Effect.gen(function* () {
        yield* boot;
        // Crash leftovers: turn A died mid-stream after one recorded
        // interrupted attempt; turn B died before any attempt persisted.
        yield* openDanglingTurn(providerTurnId, [
          {
            attemptNo: 0,
            kind: "StreamInterrupted",
            resumeGuaranteed: true,
          },
        ]);
        yield* openDanglingTurn(providerTurnIdB);
        const report = yield* recover();
        const turns = yield* turnRows;
        const execution = yield* executionSettlement;
        expect(probe.calls).toHaveLength(0);
        const planA = report.retryPlan.find(
          (entry) => entry.providerTurnId === providerTurnId,
        );
        const planB = report.retryPlan.find(
          (entry) => entry.providerTurnId === providerTurnIdB,
        );
        if (planA === undefined || planB === undefined) {
          throw new Error("recovery did not provide both retry plans");
        }
        const runtime = yield* ProviderRuntime;
        yield* runtime.runTurn({
          ...recoveryRunTurnInput(planA),
          recovery: {
            manifestId: planA.manifestId,
            nextAttemptNo: planA.nextAttemptNo,
            retryDecision: planA.retryDecision,
            ...(planA.continuationCheckpoint === undefined
              ? {}
              : { continuationCheckpoint: planA.continuationCheckpoint }),
          },
        });
        yield* runtime.runTurn({
          ...recoveryRunTurnInput(planB),
          recovery: {
            manifestId: planB.manifestId,
            nextAttemptNo: planB.nextAttemptNo,
            retryDecision: planB.retryDecision,
          },
        });
        const attempts = yield* attemptRows(providerTurnId);
        const attemptsB = yield* attemptRows(providerTurnIdB);
        const settled = yield* turnRows;
        return {
          report,
          turns,
          execution,
          attempts,
          attemptsB,
          settled,
          recoveryDecisions: yield* recoveryDecisionRows(providerTurnId),
          recoveryDecisionsB: yield* recoveryDecisionRows(providerTurnIdB),
        };
      }),
      makeApp([{ events: successTurn }], probe),
    );
    // Resume-by-retry plan: same Turn identity + same Manifest (no new
    // Manifest — a resumed Turn is a transport retry, not a new model
    // decision); next attempt_no = MAX+1, Turn-local; the no-attempt
    // leftover plans attempt 0.
    expect(r.report.failedTurns).toEqual([]);
    const planA = r.report.retryPlan.find(
      (entry) => entry.providerTurnId === providerTurnId,
    );
    const planB = r.report.retryPlan.find(
      (entry) => entry.providerTurnId === providerTurnIdB,
    );
    expect(planA?.manifestId).toBe(manifestIdFor(providerTurnId));
    expect(planA?.retryDecision.safety).toBe("SafeResume");
    expect(planA?.retryDecision.strategy).toBe("Resume");
    expect(planA?.nextAttemptNo).toBe(1);
    expect(planA?.lastProviderErrorKind).toBe("StreamInterrupted");
    expect(planB?.nextAttemptNo).toBe(0);
    expect(planB?.lastProviderErrorKind).toBeNull();
    expect(r.recoveryDecisions).toEqual([
      {
        attempt_no: 0,
        cause_tag: "ProviderFailure",
        cause_detail: "StreamInterrupted",
        retry_safety: "SafeResume",
        retry_decision: "Retry",
        retry_strategy: "Resume",
        retry_reason: expect.stringContaining("StreamInterrupted retry"),
      },
    ]);
    expect(r.recoveryDecisionsB).toEqual([
      {
        attempt_no: -1,
        cause_tag: "ProcessLost",
        cause_detail: null,
        retry_safety: "SafeReplay",
        retry_decision: "Retry",
        retry_strategy: "Replay",
        retry_reason: expect.stringContaining("ProcessLost retry"),
      },
    ]);
    // The recovery pass itself never called the provider and minted no new
    // Turn rows (transport retry is never an extra model round).
    expect(probe.calls.map((call) => call.providerTurnId)).toEqual([
      providerTurnId,
      providerTurnIdB,
    ]);
    expect(probe.calls.map((call) => call.attemptNo)).toEqual([1, 0]);
    expect(r.turns).toHaveLength(2);
    expect(r.turns.map((turn) => turn.provider_turn_id).sort()).toEqual(
      [providerTurnId, providerTurnIdB].sort(),
    );
    // Recovery leaves the Execution Active for Scheduler re-dispatch.
    expect(r.execution).toBeNull();
    // The resumed transport retry lands under the SAME Turn and settles it
    // with the per-Turn usage aggregate (I-7).
    expect(r.attempts).toEqual([
      {
        attemptNo: 0,
        outcome: "RetryableFailure",
        providerErrorKind: "StreamInterrupted",
      },
      { attemptNo: 1, outcome: "Success", providerErrorKind: null },
    ]);
    expect(r.attemptsB).toEqual([
      { attemptNo: 0, outcome: "Success", providerErrorKind: null },
    ]);
    const resumed = r.settled.find(
      (turn) => turn.provider_turn_id === providerTurnId,
    );
    expect(resumed?.settled_at).not.toBeNull();
    expect(resumed?.finish_reason).toBe("Stop");
    // Gate C C1: usage_json now carries the five-field canonical model
    // (null semantics — this turn reported input/output only).
    expect(JSON.parse(resumed?.usage_json ?? "{}")).toEqual({
      inputTokens: 10,
      outputTokens: 5,
      reasoningTokens: null,
      cacheReadTokens: null,
      cacheWriteTokens: null,
    });
  });

  it("PD4 [crash-injected]: ProcessLost fails closed with incomplete evidence and resumes only from a complete durable checkpoint", async () => {
    const probe: ProviderProbe = { calls: [] };
    const r = await run(
      Effect.gen(function* () {
        yield* boot;
        // biome-ignore lint/correctness/noUnusedVariables: destructured for interface symmetry
        const incompleteFixture = yield* openDanglingTurn(providerTurnIdC, [
          { attemptNo: 0, inProgress: true },
        ]);
        const resumableFixture = yield* openDanglingTurn(providerTurnIdD, [
          {
            attemptNo: 0,
            inProgress: true,
            resumeGuaranteed: true,
          },
        ]);
        const report = yield* recover();
        const incompleteFailure = report.failedTurns.find(
          (entry) => entry.providerTurnId === providerTurnIdC,
        );
        const plan = report.retryPlan.find(
          (entry) => entry.providerTurnId === providerTurnIdD,
        );
        if (incompleteFailure === undefined || plan === undefined) {
          throw new Error("ProcessLost recovery evidence was not classified");
        }
        expect(incompleteFailure.providerErrorKind).toBeNull();
        expect(incompleteFailure.retryDecision).toMatchObject({
          safety: "UnsafeReplay",
          decision: "Stop",
          strategy: null,
        });
        expect(report.retryPlan.map((entry) => entry.providerTurnId)).toEqual([
          providerTurnIdD,
        ]);
        expect(plan.manifestId).toBe(manifestIdFor(providerTurnIdD));
        expect(plan.manifestJson).toBe(resumableFixture.manifestJson);
        expect(plan.portableRequestJson).toBe(
          resumableFixture.portableRequestJson,
        );
        expect(plan.nextAttemptNo).toBe(1);
        expect(plan.retryDecision).toMatchObject({
          safety: "SafeResume",
          decision: "Retry",
          strategy: "Resume",
        });
        expect(plan.retryDecision.reason).toMatch(/^ProcessLost retry:/u);

        const expectedCheckpoint: ProviderContinuationCheckpoint = {
          cursor: "cursor-0",
          canonicalEventPrefixJson: JSON.stringify([
            {
              _tag: "TurnStarted",
              providerTurnId: providerTurnIdD,
              attemptNo: 0,
              modelRef: "provider-fake",
            },
            { _tag: "TextDelta", text: "partial" },
          ]),
          deliveredPosition: 0,
          resumeGuaranteed: true,
        };
        expect(plan.continuationCheckpoint).toEqual(expectedCheckpoint);

        const recoveryInput = recoveryRunTurnInput(plan);
        expect(recoveryInput.manifestJson).toBe(resumableFixture.manifestJson);
        expect(JSON.stringify(recoveryInput.request)).toBe(
          resumableFixture.portableRequestJson,
        );
        expect(recoveryInput.recovery).toEqual({
          manifestId: plan.manifestId,
          nextAttemptNo: 1,
          retryDecision: plan.retryDecision,
          continuationCheckpoint: expectedCheckpoint,
        });

        const runtime = yield* ProviderRuntime;
        const result = yield* runtime.runTurn(recoveryInput);
        return {
          report,
          incompleteFailure,
          plan,
          result,
          attempts: yield* attemptRows(providerTurnIdD),
          incompleteDecisions: yield* recoveryDecisionRows(providerTurnIdC),
          resumableDecisions: yield* recoveryDecisionRows(providerTurnIdD),
        };
      }),
      makeApp([{ events: successTurn }], probe),
    );

    expect(r.report.retryPlan).toHaveLength(1);
    expect(r.report.failedTurns).toHaveLength(1);
    expect(r.incompleteFailure.providerErrorKind).toBeNull();
    expect(r.plan.retryDecision.reason).toMatch(/^ProcessLost retry:/u);
    expect(r.incompleteDecisions).toEqual([
      {
        attempt_no: 0,
        cause_tag: "ProcessLost",
        cause_detail: null,
        retry_safety: "UnsafeReplay",
        retry_decision: "Stop",
        retry_strategy: null,
        retry_reason:
          "durable observation is incomplete or proves replay may duplicate effects",
      },
    ]);
    expect(r.resumableDecisions).toEqual([
      {
        attempt_no: 0,
        cause_tag: "ProcessLost",
        cause_detail: null,
        retry_safety: "SafeResume",
        retry_decision: "Retry",
        retry_strategy: "Resume",
        retry_reason: expect.stringContaining("ProcessLost retry"),
      },
    ]);
    expect(r.result.attemptNo).toBe(1);
    expect(r.attempts).toEqual([
      {
        attemptNo: 0,
        outcome: "RetryableFailure",
        providerErrorKind: null,
      },
      { attemptNo: 1, outcome: "Success", providerErrorKind: null },
    ]);
    expect(probe.calls).toEqual([
      {
        providerTurnId: providerTurnIdD,
        attemptNo: 1,
        requestJson: r.plan.portableRequestJson,
        continuationCheckpoint: r.plan.continuationCheckpoint,
      },
    ]);
  });

  it("I-6 [crash-injected]: bounded retries exhausted → the Turn settles failed (driver Turn-failure semantics), the Execution stays unsettled", async () => {
    expect(
      labeled("I-6-retry-budget-exhausted-failure-mark", "crash-injected")
        .guarantee,
    ).toBe("crash-injected");
    const probe: ProviderProbe = { calls: [] };
    const r = await run(
      Effect.gen(function* () {
        yield* boot;
        // Crash window: all three safe-retry attempts exhausted with a
        // retryable kind; the worker died before the driver disposed.
        yield* openDanglingTurn(providerTurnId, [
          { attemptNo: 0, kind: "RateLimited" },
          { attemptNo: 1, kind: "RateLimited" },
          { attemptNo: 2, kind: "RateLimited" },
        ]);
        const report = yield* recover();
        const turns = yield* turnRows;
        const execution = yield* executionSettlement;
        return { report, turns, execution };
      }),
      makeApp([{ events: successTurn }], probe),
    );
    expect(r.report.retryPlan).toEqual([]);
    expect(r.report.failedTurns).toHaveLength(1);
    // biome-ignore lint/style/noNonNullAssertion: guarded by the preceding assertion
    expect(r.report.failedTurns[0]!.providerTurnId).toBe(providerTurnId);
    // biome-ignore lint/style/noNonNullAssertion: guarded by the preceding assertion
    expect(r.report.failedTurns[0]!.providerErrorKind).toBe("RateLimited");
    // biome-ignore lint/style/noNonNullAssertion: guarded by the preceding assertion
    expect(r.report.failedTurns[0]!.exhausted).toBe(true);
    // biome-ignore lint/style/noNonNullAssertion: guarded by the preceding assertion
    expect(r.report.failedTurns[0]!.markedBy).toEqual(principal);
    // biome-ignore lint/style/noNonNullAssertion: guarded by the preceding assertion
    expect(r.turns[0]!.settled_at).not.toBeNull();
    // biome-ignore lint/style/noNonNullAssertion: guarded by the preceding assertion
    expect(r.turns[0]!.finish_reason).toBe("Failed");
    // Execution-level disposition follows P2 `06` §4 — recovery never
    // invents a settlement.
    expect(r.execution).toBeNull();
    expect(probe.calls).toHaveLength(0);
    void Exit;
    void Cause;
  });
});
