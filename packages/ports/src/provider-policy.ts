import {
  type ObservationFact,
  PROVIDER_FAILURE_KINDS,
  PROVIDER_RETRY_ELIGIBLE_FAILURES,
  type ProviderAttemptObservation,
  type ProviderContinuationCheckpoint,
  type ProviderExecutionPolicyOverrides,
  type ProviderFailureKind,
  type ProviderPolicySources,
  type ProviderRetryCause,
  type ProviderRetryDecisionRecord,
  type ProviderRetrySafety,
  type ProviderRetryStrategy,
  type ProviderRuntimeExecutionPolicy,
} from "./provider.js";

export const DEFAULT_PROVIDER_EXECUTION_POLICY: ProviderRuntimeExecutionPolicy =
  {
    connectTimeoutMs: 15_000,
    firstEventTimeoutMs: 60_000,
    streamIdleTimeoutMs: 30_000,
    turnTimeoutMs: 300_000,
    maxAttempts: 3,
    retryBackoffMs: 100,
  };

const POLICY_KEYS = [
  "connectTimeoutMs",
  "firstEventTimeoutMs",
  "streamIdleTimeoutMs",
  "turnTimeoutMs",
  "maxAttempts",
  "retryBackoffMs",
] as const satisfies ReadonlyArray<keyof ProviderRuntimeExecutionPolicy>;

const validateOverrides = (
  sourceName: string,
  overrides: ProviderExecutionPolicyOverrides | undefined,
): void => {
  if (overrides === undefined) return;
  for (const key of Object.keys(overrides)) {
    if (!(POLICY_KEYS as ReadonlyArray<string>).includes(key)) {
      throw new Error(
        `${sourceName} provider policy has unknown field "${key}"`,
      );
    }
  }
  for (const key of POLICY_KEYS) {
    const value = overrides[key];
    if (value === undefined) continue;
    const min = key === "retryBackoffMs" ? 0 : 1;
    if (!Number.isSafeInteger(value) || value < min) {
      throw new Error(`${sourceName}.${key} must be an integer >= ${min}`);
    }
  }
};

export const resolveProviderExecutionPolicy = (
  sources: ProviderPolicySources,
): ProviderRuntimeExecutionPolicy => {
  validateOverrides("systemDefault", sources.systemDefault);
  validateOverrides("providerDefault", sources.providerDefault);
  validateOverrides("modelDeploymentOverride", sources.modelDeploymentOverride);
  const result = {} as Record<keyof ProviderRuntimeExecutionPolicy, number>;
  for (const key of POLICY_KEYS) {
    result[key] =
      sources.modelDeploymentOverride?.[key] ??
      sources.providerDefault?.[key] ??
      sources.systemDefault[key];
  }
  validateOverrides("resolved", result);
  return result;
};

const OBSERVATION_KEYS = [
  "responseStarted",
  "canonicalEventEmitted",
  "consumerVisibleOutput",
  "toolCallProposed",
  "continuationAvailable",
  "externalEffectPossible",
] as const satisfies ReadonlyArray<keyof ProviderAttemptObservation>;

export const mergeAttemptObservation = (
  current: ProviderAttemptObservation,
  delta: Readonly<Record<string, boolean>>,
): ProviderAttemptObservation => {
  for (const key of Object.keys(delta)) {
    if (!(OBSERVATION_KEYS as ReadonlyArray<string>).includes(key)) {
      throw new Error(`observation has unknown field "${key}"`);
    }
  }
  const next = { ...current };
  for (const key of OBSERVATION_KEYS) {
    const value = delta[key];
    if (value === undefined) continue;
    const previous = current[key];
    if (previous === true && value === false) {
      throw new Error(`observation field "${key}" is not monotonic`);
    }
    next[key] = value;
  }
  return next;
};

export interface ProviderRetryDecisionInput {
  readonly cause: ProviderRetryCause;
  readonly observation: ProviderAttemptObservation;
  readonly continuationCheckpoint?: ProviderContinuationCheckpoint | null;
  /** -1 denotes that no Attempt row was created before process loss. */
  readonly attemptNo: number;
  readonly maxAttempts: number;
  readonly cancelled: boolean;
  readonly deadlineExpired: boolean;
}

export interface ProviderRetryDecision extends ProviderRetryDecisionRecord {
  readonly safety: ProviderRetrySafety;
  readonly strategy: ProviderRetryStrategy;
}

const allFactsKnown = (observation: ProviderAttemptObservation): boolean =>
  OBSERVATION_KEYS.every((key) => observation[key] !== null);

const allReplayFactsAbsent = (
  observation: ProviderAttemptObservation,
): boolean => OBSERVATION_KEYS.every((key) => observation[key] === false);

const validResumeCheckpoint = (
  observation: ProviderAttemptObservation,
  checkpoint: ProviderContinuationCheckpoint | null | undefined,
): checkpoint is ProviderContinuationCheckpoint => {
  if (
    !allFactsKnown(observation) ||
    observation.continuationAvailable !== true ||
    observation.externalEffectPossible !== false ||
    checkpoint === undefined ||
    checkpoint === null ||
    checkpoint.resumeGuaranteed !== true ||
    checkpoint.cursor.length === 0 ||
    checkpoint.deliveredPosition === null ||
    checkpoint.deliveredPosition < 0
  ) {
    return false;
  }
  try {
    const prefix: unknown = JSON.parse(checkpoint.canonicalEventPrefixJson);
    return (
      Array.isArray(prefix) &&
      prefix.length > 0 &&
      checkpoint.deliveredPosition <= prefix.length
    );
  } catch {
    return false;
  }
};

const causeRetryEligible = (cause: ProviderRetryCause): boolean =>
  cause._tag === "ProcessLost" ||
  (cause._tag === "ProviderFailure" &&
    (
      PROVIDER_RETRY_ELIGIBLE_FAILURES as ReadonlyArray<ProviderFailureKind>
    ).includes(cause.kind));

const causeName = (cause: ProviderRetryCause): string => {
  switch (cause._tag) {
    case "ProviderFailure":
      return cause.kind;
    case "ProcessLost":
      return "ProcessLost";
    case "Timeout":
      return `Timeout(${cause.phase})`;
    case "Cancelled":
      return "Cancelled";
  }
};

export const decideProviderRetry = (
  input: ProviderRetryDecisionInput,
): ProviderRetryDecision => {
  const { observation } = input;
  let safety: ProviderRetrySafety = "UnsafeReplay";
  let strategy: ProviderRetryStrategy = null;
  if (validResumeCheckpoint(observation, input.continuationCheckpoint)) {
    safety = "SafeResume";
    strategy = "Resume";
  } else if (allFactsKnown(observation) && allReplayFactsAbsent(observation)) {
    safety = "SafeReplay";
    strategy = "Replay";
  }

  const attemptBudgetRemaining = input.attemptNo + 1 < input.maxAttempts;
  let decision: "Retry" | "Stop" = "Stop";
  let reason: string;
  if (!causeRetryEligible(input.cause)) {
    reason = `cause ${causeName(input.cause)} is not retry eligible`;
  } else if (safety === "UnsafeReplay") {
    reason =
      "durable observation is incomplete or proves replay may duplicate effects";
  } else if (input.cancelled) {
    reason = "cancellation is terminal and forbids another attempt";
  } else if (input.deadlineExpired) {
    reason = "ProviderTurn deadline expired before another attempt";
  } else if (!attemptBudgetRemaining) {
    reason = "maxAttempts has been exhausted";
  } else {
    decision = "Retry";
    reason =
      strategy === "Resume"
        ? `${causeName(input.cause)} retry: durable cursor, event prefix, and delivered position guarantee cursor-exclusive resume`
        : `${causeName(input.cause)} retry: all replay safety facts are known and no provider or consumer effect occurred`;
  }

  return { safety, decision, strategy, reason };
};

export const unknownAttemptObservation = (): ProviderAttemptObservation => ({
  responseStarted: null satisfies ObservationFact,
  canonicalEventEmitted: null,
  consumerVisibleOutput: null,
  toolCallProposed: null,
  continuationAvailable: null,
  externalEffectPossible: null,
});

export const noAttemptObservation = (): ProviderAttemptObservation => ({
  responseStarted: false,
  canonicalEventEmitted: false,
  consumerVisibleOutput: false,
  toolCallProposed: false,
  continuationAvailable: false,
  externalEffectPossible: false,
});

/** Reconstruct the retry cause from a durable ProviderAttempt. A null error
 * kind on an in-flight/recovered attempt is process loss, never a fabricated
 * provider failure. */
export const providerRetryCauseFromAttempt = (
  attempt:
    | {
        readonly outcome: string;
        readonly providerErrorKind: string | null;
      }
    | null
    | undefined,
): ProviderRetryCause => {
  if (
    attempt === null ||
    attempt === undefined ||
    attempt.outcome === "InProgress" ||
    attempt.providerErrorKind === null
  ) {
    return { _tag: "ProcessLost" };
  }
  if (attempt.outcome === "Cancelled") return { _tag: "Cancelled" };
  if (attempt.outcome === "TimedOut") {
    return { _tag: "Timeout", phase: "persisted-attempt-timeout" };
  }
  return {
    _tag: "ProviderFailure",
    kind: (PROVIDER_FAILURE_KINDS as ReadonlyArray<string>).includes(
      attempt.providerErrorKind,
    )
      ? (attempt.providerErrorKind as ProviderFailureKind)
      : "UnknownProviderFailure",
  };
};
