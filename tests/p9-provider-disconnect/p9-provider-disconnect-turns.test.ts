import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { ProviderRuntime } from "../../packages/ports/src/index.js";
import { labeled } from "../support/p9-harness-api.js";
import type { ProviderProbe } from "./support.js";
import {
  attemptRows,
  boot,
  executionSettlement,
  makeApp,
  openDanglingTurn,
  providerTurnId,
  recover,
  run,
  runTurnInput,
  sessionEntryCount,
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
  it("PD1/I-4 [crash-injected]: pre-response TransportFailed → SafeReplay under the SAME ProviderTurn", async () => {
    expect(
      labeled("PD1-pre-connection-ProviderUnavailable", "crash-injected")
        .guarantee,
    ).toBe("crash-injected");
    const probe: ProviderProbe = { calls: [] };
    const r = await run(
      Effect.gen(function* () {
        yield* boot;
        const runtime = yield* ProviderRuntime;
        const { events } = yield* runtime.runTurn(runTurnInput(providerTurnId));
        const attempts = yield* attemptRows(providerTurnId);
        const turns = yield* turnRows;
        const entries = yield* sessionEntryCount;
        return { events, attempts, turns, entries };
      }),
      makeApp(
        [
          { disconnect: "pre-connect" },
          { disconnect: "pre-connect" },
          { events: successTurn },
        ],
        probe,
      ),
    );
    // Same ProviderTurn across all transport attempts (DID §6A.9 — a
    // transport retry is never a new model round): one turn identity, no
    // new ProviderTurn issued, turnNo unchanged.
    expect(probe.calls).toHaveLength(3);
    expect(new Set(probe.calls.map((call) => call.providerTurnId))).toEqual(
      new Set([providerTurnId]),
    );
    expect(probe.calls.map((call) => call.attemptNo)).toEqual([0, 1, 2]);
    expect(r.turns).toHaveLength(1);
    // biome-ignore lint/style/noNonNullAssertion: guarded by the preceding assertion
    expect(r.turns[0]!.provider_turn_id).toBe(providerTurnId);
    // biome-ignore lint/style/noNonNullAssertion: guarded by the preceding assertion
    expect(r.turns[0]!.manifest_id).toMatch(/^mft_/u);
    // Pre-response TransportFailed retries are admitted only with complete
    // negative observations and a persisted SafeReplay decision.
    expect(r.attempts).toEqual([
      {
        attemptNo: 0,
        outcome: "RetryableFailure",
        providerErrorKind: "TransportFailed",
      },
      {
        attemptNo: 1,
        outcome: "RetryableFailure",
        providerErrorKind: "TransportFailed",
      },
      { attemptNo: 2, outcome: "Success", providerErrorKind: null },
    ]);
    // biome-ignore lint/style/noNonNullAssertion: guarded by the preceding assertion
    expect(r.turns[0]!.settled_at).not.toBeNull();
    // biome-ignore lint/style/noNonNullAssertion: guarded by the preceding assertion
    expect(r.turns[0]!.finish_reason).toBe("Stop");
    expect(r.events.some((event) => event._tag === "TurnCompleted")).toBe(true);
    expect(r.entries).toBe(0);
  });

  it("PD2/I-5 [crash-injected]: mid-stream output without a verified cursor is UnsafeReplay", async () => {
    expect(
      labeled("PD2-mid-stream-StreamInterrupted", "crash-injected").guarantee,
    ).toBe("crash-injected");
    const probe: ProviderProbe = { calls: [] };
    const r = await run(
      Effect.gen(function* () {
        yield* boot;
        const runtime = yield* ProviderRuntime;
        const failure = yield* Effect.flip(
          runtime.runTurn(runTurnInput(providerTurnId)),
        );
        const attempts = yield* attemptRows(providerTurnId);
        const turns = yield* turnRows;
        const entries = yield* sessionEntryCount;
        return { failure, attempts, turns, entries };
      }),
      makeApp([{ disconnect: "mid-stream" }, { events: successTurn }], probe),
    );
    expect(probe.calls.map((call) => call.attemptNo)).toEqual([0]);
    expect(new Set(probe.calls.map((call) => call.providerTurnId))).toEqual(
      new Set([providerTurnId]),
    );
    // turnNo unchanged across attempts: exactly one Turn row, same manifest.
    expect(r.turns).toHaveLength(1);
    // biome-ignore lint/style/noNonNullAssertion: guarded by the preceding assertion
    expect(r.turns[0]!.provider_turn_id).toBe(providerTurnId);
    // biome-ignore lint/style/noNonNullAssertion: guarded by the preceding assertion
    expect(r.turns[0]!.manifest_id).toMatch(/^mft_/u);
    expect(r.failure).toMatchObject({
      _tag: "ProviderFailure",
      kind: "StreamInterrupted",
    });
    expect(r.attempts).toEqual([
      {
        attemptNo: 0,
        outcome: "TerminalFailure",
        providerErrorKind: "StreamInterrupted",
      },
    ]);
    // biome-ignore lint/style/noNonNullAssertion: guarded by the preceding assertion
    expect(r.turns[0]!.settled_at).toBeNull();
    // Streaming deltas never enter Session history (DID §9.8): the crashed
    // mid-stream attempt left no partial durable output — resume is clean
    // by construction.
    expect(r.entries).toBe(0);
  });

  it("PD3 [crash-injected]: terminal class → no transport retry, dangling Turn never settles the Execution; recovery marks the Turn failed with no retry plan", async () => {
    expect(
      labeled("PD3-terminal-no-transport-retry", "crash-injected").guarantee,
    ).toBe("crash-injected");
    const probe: ProviderProbe = { calls: [] };
    const r = await run(
      Effect.gen(function* () {
        yield* boot;
        const runtime = yield* ProviderRuntime;
        // AuthenticationFailed is terminal for the Turn (P3 `06` §2).
        const failure = yield* Effect.flip(
          runtime.runTurn(runTurnInput(providerTurnId)),
        );
        const attempts = yield* attemptRows(providerTurnId);
        const turnsBefore = yield* turnRows;
        const execution = yield* executionSettlement;
        // Crash window: the worker died after the terminal attempt was
        // recorded, before any driver disposition of the dangling Turn.
        const report = yield* recover();
        const turnsAfter = yield* turnRows;
        const executionAfter = yield* executionSettlement;
        return {
          failure,
          attempts,
          turnsBefore,
          execution,
          report,
          turnsAfter,
          executionAfter,
        };
      }),
      makeApp([{ terminal: "AuthenticationFailed" }], probe),
    );
    expect(r.failure._tag).toBe("ProviderFailure");
    if (r.failure._tag === "ProviderFailure") {
      expect(r.failure.kind).toBe("AuthenticationFailed");
    }
    // No transport retry for terminal classes.
    expect(probe.calls).toHaveLength(1);
    expect(r.attempts).toEqual([
      {
        attemptNo: 0,
        outcome: "TerminalFailure",
        providerErrorKind: "AuthenticationFailed",
      },
    ]);
    // The Turn dangles (driver decides), and a terminal Turn failure does
    // NOT itself settle the Execution Failed.
    // biome-ignore lint/style/noNonNullAssertion: guarded by the preceding assertion
    expect(r.turnsBefore[0]!.settled_at).toBeNull();
    expect(r.execution).toBeNull();
    // Recovery decision table, terminal row: failure mark, no resume.
    expect(r.report.retryPlan).toEqual([]);
    expect(r.report.failedTurns).toHaveLength(1);
    // biome-ignore lint/style/noNonNullAssertion: guarded by the preceding assertion
    expect(r.report.failedTurns[0]!.providerTurnId).toBe(providerTurnId);
    // biome-ignore lint/style/noNonNullAssertion: guarded by the preceding assertion
    expect(r.report.failedTurns[0]!.providerErrorKind).toBe(
      "AuthenticationFailed",
    );
    // biome-ignore lint/style/noNonNullAssertion: guarded by the preceding assertion
    expect(r.report.failedTurns[0]!.exhausted).toBe(false);
    // biome-ignore lint/style/noNonNullAssertion: guarded by the preceding assertion
    expect(r.turnsAfter[0]!.settled_at).not.toBeNull();
    // biome-ignore lint/style/noNonNullAssertion: guarded by the preceding assertion
    expect(r.turnsAfter[0]!.finish_reason).toBe("Failed");
    // Recovery never invents an Execution settlement (P2 `06` §4).
    expect(r.executionAfter).toBeNull();
  });

  it("fails a dangling ProviderTurn when the current request no longer matches its durable binding", async () => {
    const probe: ProviderProbe = { calls: [] };
    const r = await run(
      Effect.gen(function* () {
        yield* boot;
        yield* openDanglingTurn(providerTurnId);
        const runtime = yield* ProviderRuntime;
        const failure = yield* Effect.flip(
          runtime.runTurn(runTurnInput(providerTurnId)),
        );
        return { failure, turns: yield* turnRows };
      }),
      makeApp([{ events: successTurn }], probe),
    );
    expect(r.failure).toMatchObject({
      _tag: "ProviderFailure",
      kind: "UnknownProviderFailure",
      safeDiagnostic: "provider-turn-resume-binding-invalid",
    });
    expect(probe.calls).toEqual([]);
    expect(r.turns).toHaveLength(1);
    expect(r.turns[0]?.settled_at).not.toBeNull();
    expect(r.turns[0]?.finish_reason).toBe("Failed");
  });
});
