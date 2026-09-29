import { describe, expect, it } from "vitest";
import type { ProviderFailureKind } from "../packages/ports/src/provider.js";
import {
  DEFAULT_PROVIDER_EXECUTION_POLICY,
  decideProviderRetry,
  mergeAttemptObservation,
  type ProviderAttemptObservation,
  providerRetryCauseFromAttempt,
  resolveProviderExecutionPolicy,
} from "../packages/provider-runtime/src/policy.js";

const knownSafeObservation = (): ProviderAttemptObservation => ({
  responseStarted: false,
  canonicalEventEmitted: false,
  consumerVisibleOutput: false,
  toolCallProposed: false,
  continuationAvailable: false,
  externalEffectPossible: false,
});

describe("Provider Runtime Phase 1 policy", () => {
  it("resolves policy field-by-field with model/deployment > provider > system precedence", () => {
    const resolved = resolveProviderExecutionPolicy({
      systemDefault: DEFAULT_PROVIDER_EXECUTION_POLICY,
      providerDefault: { connectTimeoutMs: 900, maxAttempts: 4 },
      modelDeploymentOverride: { firstEventTimeoutMs: 2_500, maxAttempts: 2 },
    });

    expect(resolved).toEqual({
      connectTimeoutMs: 900,
      firstEventTimeoutMs: 2_500,
      streamIdleTimeoutMs:
        DEFAULT_PROVIDER_EXECUTION_POLICY.streamIdleTimeoutMs,
      turnTimeoutMs: DEFAULT_PROVIDER_EXECUTION_POLICY.turnTimeoutMs,
      maxAttempts: 2,
      retryBackoffMs: DEFAULT_PROVIDER_EXECUTION_POLICY.retryBackoffMs,
    });
  });

  it("rejects invalid or unknown policy values instead of widening the control surface", () => {
    expect(() =>
      resolveProviderExecutionPolicy({
        systemDefault: DEFAULT_PROVIDER_EXECUTION_POLICY,
        modelDeploymentOverride: { maxAttempts: 0 },
      }),
    ).toThrow(/maxAttempts/u);
    expect(() =>
      resolveProviderExecutionPolicy({
        systemDefault: DEFAULT_PROVIDER_EXECUTION_POLICY,
        providerDefault: { unexpected: 10 } as never,
      }),
    ).toThrow(/unexpected/u);
  });

  it("merges observations monotonically and fails closed on contradictory facts", () => {
    const observed = mergeAttemptObservation(knownSafeObservation(), {
      responseStarted: true,
      externalEffectPossible: false,
    });
    expect(observed.responseStarted).toBe(true);
    expect(() =>
      mergeAttemptObservation(observed, { responseStarted: false }),
    ).toThrow(/monotonic/u);
    expect(() =>
      mergeAttemptObservation(observed, {
        unrecognized: true,
      } as never),
    ).toThrow(/unrecognized/u);
  });

  it.each<ProviderFailureKind>([
    "RateLimited",
    "ProviderUnavailable",
    "TransportFailed",
    "StreamInterrupted",
  ])("%s is retry eligible only with complete safe-replay evidence", (kind) => {
    const decision = decideProviderRetry({
      cause: { _tag: "ProviderFailure", kind },
      observation: knownSafeObservation(),
      attemptNo: 0,
      maxAttempts: 3,
      cancelled: false,
      deadlineExpired: false,
    });
    expect(decision).toMatchObject({
      safety: "SafeReplay",
      decision: "Retry",
      strategy: "Replay",
    });
    expect(decision.reason).toContain("no provider or consumer effect");
  });

  it("marks an otherwise retryable cause unsafe when any relevant fact is unknown", () => {
    const observation = knownSafeObservation();
    const decision = decideProviderRetry({
      cause: { _tag: "ProviderFailure", kind: "TransportFailed" },
      observation: { ...observation, responseStarted: null },
      attemptNo: 0,
      maxAttempts: 3,
      cancelled: false,
      deadlineExpired: false,
    });
    expect(decision).toMatchObject({
      safety: "UnsafeReplay",
      decision: "Stop",
      strategy: null,
    });
  });

  it.each([
    ["responseStarted", { responseStarted: true }],
    ["canonicalEventEmitted", { canonicalEventEmitted: true }],
    ["consumerVisibleOutput", { consumerVisibleOutput: true }],
    ["toolCallProposed", { toolCallProposed: true }],
    ["continuationAvailable", { continuationAvailable: true }],
    ["externalEffectPossible", { externalEffectPossible: true }],
  ] as const)(
    "never replays after %s without a verified resume checkpoint",
    (_fact, patch) => {
      const decision = decideProviderRetry({
        cause: { _tag: "ProviderFailure", kind: "StreamInterrupted" },
        observation: { ...knownSafeObservation(), ...patch },
        attemptNo: 0,
        maxAttempts: 3,
        cancelled: false,
        deadlineExpired: false,
      });
      expect(decision.safety).toBe("UnsafeReplay");
      expect(decision.decision).toBe("Stop");
    },
  );

  it("allows SafeResume only with a durable cursor, canonical prefix, and delivered position", () => {
    const decision = decideProviderRetry({
      cause: { _tag: "ProviderFailure", kind: "StreamInterrupted" },
      observation: {
        ...knownSafeObservation(),
        responseStarted: true,
        canonicalEventEmitted: true,
        continuationAvailable: true,
      },
      continuationCheckpoint: {
        cursor: "cursor-2",
        canonicalEventPrefixJson: '[{"_tag":"TextDelta","text":"partial"}]',
        deliveredPosition: 1,
        resumeGuaranteed: true,
      },
      attemptNo: 0,
      maxAttempts: 3,
      cancelled: false,
      deadlineExpired: false,
    });
    expect(decision).toMatchObject({
      safety: "SafeResume",
      decision: "Retry",
      strategy: "Resume",
    });

    const incomplete = decideProviderRetry({
      cause: { _tag: "ProviderFailure", kind: "StreamInterrupted" },
      observation: {
        ...knownSafeObservation(),
        responseStarted: true,
        continuationAvailable: true,
      },
      continuationCheckpoint: {
        cursor: "cursor-2",
        canonicalEventPrefixJson: "[]",
        deliveredPosition: null,
        resumeGuaranteed: true,
      },
      attemptNo: 0,
      maxAttempts: 3,
      cancelled: false,
      deadlineExpired: false,
    });
    expect(incomplete.safety).toBe("UnsafeReplay");
    expect(incomplete.decision).toBe("Stop");
  });

  it("can safely retry a resumed Attempt before its new response starts", () => {
    const decision = decideProviderRetry({
      cause: { _tag: "ProcessLost" },
      observation: {
        ...knownSafeObservation(),
        continuationAvailable: true,
      },
      continuationCheckpoint: {
        cursor: "cursor-from-prior-attempt",
        canonicalEventPrefixJson:
          '[{"_tag":"TextDelta","text":"durable-prefix"}]',
        deliveredPosition: 0,
        resumeGuaranteed: true,
      },
      attemptNo: 1,
      maxAttempts: 3,
      cancelled: false,
      deadlineExpired: false,
    });
    expect(decision).toMatchObject({
      safety: "SafeResume",
      decision: "Retry",
      strategy: "Resume",
    });
  });

  it.each([
    ["Cancelled", true, false, 0, 3],
    ["deadline expired", false, true, 0, 3],
    ["attempt limit reached", false, false, 2, 3],
  ] as const)(
    "does not retry when %s",
    (_label, cancelled, deadlineExpired, attemptNo, maxAttempts) => {
      const decision = decideProviderRetry({
        cause: { _tag: "ProviderFailure", kind: "TransportFailed" },
        observation: knownSafeObservation(),
        attemptNo,
        maxAttempts,
        cancelled,
        deadlineExpired,
      });
      expect(decision.safety).toBe("SafeReplay");
      expect(decision.decision).toBe("Stop");
    },
  );

  it("allows ProcessLost to be evaluated as a separate cause, while unknown in-flight evidence fails closed", () => {
    const noAttempt = decideProviderRetry({
      cause: { _tag: "ProcessLost" },
      observation: knownSafeObservation(),
      attemptNo: -1,
      maxAttempts: 3,
      cancelled: false,
      deadlineExpired: false,
    });
    expect(noAttempt).toMatchObject({
      safety: "SafeReplay",
      decision: "Retry",
    });
    expect(noAttempt.reason).toContain("ProcessLost");

    const inFlight = decideProviderRetry({
      cause: { _tag: "ProcessLost" },
      observation: {
        responseStarted: null,
        canonicalEventEmitted: null,
        consumerVisibleOutput: null,
        toolCallProposed: null,
        continuationAvailable: null,
        externalEffectPossible: null,
      },
      attemptNo: 0,
      maxAttempts: 3,
      cancelled: false,
      deadlineExpired: false,
    });
    expect(inFlight.safety).toBe("UnsafeReplay");
    expect(inFlight.decision).toBe("Stop");
  });

  it("normalizes unknown historical failure labels into the closed terminal taxonomy", () => {
    expect(
      providerRetryCauseFromAttempt({
        outcome: "TerminalFailure",
        providerErrorKind: "FutureProviderFailure",
      }),
    ).toEqual({
      _tag: "ProviderFailure",
      kind: "UnknownProviderFailure",
    });
  });
});
