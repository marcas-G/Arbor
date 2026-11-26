import { TERMINAL_PROVIDER_FAILURE_KINDS } from "@arbor/ports";
import { Effect, Option } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { describe, expect, it } from "vitest";
import {
  executionId,
  query,
  runDb,
  seed,
  seedTerminalFailureHistory,
  seedTerminalProviderFailureChain,
  terminalFailureHistorySnapshot,
  terminalSettlement,
} from "./support.js";

describe("P2 WorkReadmissionGateStore", () => {
  it.each([...TERMINAL_PROVIDER_FAILURE_KINDS])(
    "derives the complete %s Provider failure source from the exact durable chain",
    (kind) =>
      runDb(
        Effect.gen(function* () {
          const settlement = terminalSettlement(kind);
          yield* seed(settlement);
          yield* seedTerminalProviderFailureChain(kind);
          const found = yield* query();
          expect(Option.isSome(found)).toBe(true);
          if (Option.isSome(found)) {
            expect(found.value).toMatchObject({
              sourceKind: "TerminalProviderFailureSettlement",
              executionId,
              logicalStepNo: 0,
              repairAttempt: 0,
              attemptNo: 0,
              failureKind: kind,
            });
            expect(
              "failureFingerprint" in found.value
                ? found.value.failureFingerprint
                : "",
            ).toMatch(/^[0-9a-f]{64}$/u);
          }
        }),
      ),
  );

  it("fails closed when the settlement-producing Step is missing", () =>
    runDb(
      Effect.gen(function* () {
        yield* seed(terminalSettlement("ProtocolViolation"));
        yield* seedTerminalProviderFailureChain("ProtocolViolation", {
          omitStep: true,
        });
        const exit = yield* Effect.exit(query());
        expect(exit._tag).toBe("Failure");
        if (exit._tag === "Failure") {
          expect(JSON.stringify(exit.cause)).toContain(
            '"reasonCode":"SourceSettlementStepMissing"',
          );
        }
      }),
    ));

  it.each([
    [
      "a second SettlementProposed Step",
      { additionalSettlementStep: true },
      "SourceSettlementStepNonUnique",
    ],
    [
      "a non-Failed ProviderTurn",
      { turnFinishReason: "Succeeded" },
      "SourceProviderTurnMismatch",
    ],
    [
      "a conflicting Manifest",
      { malformedManifest: true },
      "SourceManifestMismatch",
    ],
    [
      "an unsupported legacy taxonomy",
      { taxonomy: "legacy-v1" },
      "FailureTaxonomyUnsupported",
    ],
    [
      "a noncanonical occurrence time",
      { occurrenceTime: "2026-10-25T00:00:01Z" },
      "FailureOccurrenceTimeInvalid",
    ],
    [
      "a nonterminal final Attempt",
      { attemptOutcome: "RetryableFailure" },
      "SourceProviderAttemptMismatch",
    ],
    [
      "a conflicting final Attempt kind",
      { providerErrorKind: "ProtocolViolation" },
      "SourceProviderAttemptMismatch",
    ],
    [
      "a retrying final Attempt",
      { retryDecision: "Retry" },
      "SourceProviderAttemptMismatch",
    ],
  ] as const)("fails closed for %s", (_label, options, reasonCode) =>
    runDb(
      Effect.gen(function* () {
        yield* seed(terminalSettlement("RequestRejected"));
        yield* seedTerminalProviderFailureChain("RequestRejected", options);
        const exit = yield* Effect.exit(query());
        expect(exit._tag).toBe("Failure");
        if (exit._tag === "Failure") {
          expect(JSON.stringify(exit.cause)).toContain(
            `"reasonCode":"${reasonCode}"`,
          );
        }
      }),
    ),
  );

  it("selects the earliest exact terminal witness across hundreds of historical repetitions without rewriting evidence", () =>
    runDb(
      Effect.gen(function* () {
        yield* seed();
        yield* seedTerminalFailureHistory(200);
        const sql = yield* SqlClient;
        const before = yield* terminalFailureHistorySnapshot(sql);
        const first = yield* query();
        const second = yield* query();
        const after = yield* terminalFailureHistorySnapshot(sql);

        expect(Option.isSome(first)).toBe(true);
        expect(Option.isSome(second)).toBe(true);
        if (Option.isSome(first) && Option.isSome(second)) {
          expect(first.value.sourceKind).toBe(
            "TerminalProviderFailureSettlement",
          );
          expect(first.value.executionId).toBe(
            "exe_00000000-0000-4000-8000-000000000000",
          );
          expect(second.value).toEqual(first.value);
        }
        expect(before).toEqual(after);
        expect((before.executions as ReadonlyArray<unknown>).length).toBe(201);
        expect((before.steps as ReadonlyArray<unknown>).length).toBe(200);
        expect((before.turns as ReadonlyArray<unknown>).length).toBe(200);
        expect((before.manifests as ReadonlyArray<unknown>).length).toBe(200);
        expect((before.attempts as ReadonlyArray<unknown>).length).toBe(200);
      }),
    ));

  it("returns bounded integrity for a malformed historical variant and does not rewrite any source", () =>
    runDb(
      Effect.gen(function* () {
        yield* seed();
        yield* seedTerminalFailureHistory(200, 199);
        const sql = yield* SqlClient;
        const before = yield* terminalFailureHistorySnapshot(sql);
        const exit = yield* Effect.exit(query());
        const after = yield* terminalFailureHistorySnapshot(sql);

        expect(exit._tag).toBe("Failure");
        if (exit._tag === "Failure") {
          const encoded = JSON.stringify(exit.cause);
          expect(encoded).toContain('"_tag":"ReadmissionGateIntegrityFailure"');
          expect(encoded).toContain('"reasonCode":"SourceManifestMismatch"');
          expect(encoded).not.toContain("conflicting-contract");
        }
        expect(before).toEqual(after);
      }),
    ));
});
