import type { ExecutionSettlement } from "@arbor/domain";
import {
  type ConversationAttempt,
  type ConversationAttentionReason,
  type ConversationFailureClass,
  type ConversationResponseJob,
  type ConversationResponseJobState,
  type ConversationRetryDecision,
  sha256Hex,
} from "@arbor/ports";

export interface ConversationRetryPolicy {
  readonly version: string;
  readonly maxExecutionAttempts: number;
  readonly maxTotalElapsedMs: number;
  readonly identicalFailureLimit: number;
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
  readonly jitterRatio: number;
}

export const CONVERSATION_RETRY_POLICY_V1: ConversationRetryPolicy = {
  version: "conversation-retry-v1",
  maxExecutionAttempts: 3,
  maxTotalElapsedMs: 900_000,
  identicalFailureLimit: 2,
  baseDelayMs: 2_000,
  maxDelayMs: 60_000,
  jitterRatio: 0.2,
};

export interface ConversationRecoveryDecision {
  readonly nextState: ConversationResponseJobState;
  readonly failureClass: ConversationFailureClass | null;
  readonly failureFingerprint: string | null;
  readonly retryDecision: ConversationRetryDecision;
}

const failedReason = (settlement: ExecutionSettlement): string =>
  settlement._tag === "Failed" ? settlement.failure.reason : settlement._tag;

export const classifyConversationFailure = (
  settlement: ExecutionSettlement,
  responseBody: string | null,
): ConversationFailureClass | null => {
  if (settlement._tag === "Completed") {
    return responseBody === null ? "DeterministicModelFailure" : null;
  }
  if (settlement._tag === "OutcomeUnknown") {
    return "ReconciliationRequired";
  }
  if (settlement._tag === "Interrupted") {
    return "ControlledInterruption";
  }
  const reason = settlement.failure.reason.toLowerCase();
  if (reason.includes("authentication") || reason.includes("invalid_api_key")) {
    return "AuthenticationFailed";
  }
  if (
    reason.includes("requestrejected") ||
    reason.includes("bad request") ||
    reason.includes("portable_request_incompatible")
  ) {
    return "RequestRejected";
  }
  if (
    reason.includes("sessioncontextblocked") ||
    reason.includes("contextblocked")
  ) {
    return "ContextBlocked";
  }
  if (
    reason.includes("providerexecutiontimedout") ||
    reason.includes("streamidletimeout") ||
    reason.includes("ratelimit") ||
    reason.includes("rate_limit") ||
    reason.includes("providerunavailable") ||
    /(^|\D)5\d\d(\D|$)/.test(reason) ||
    /(^|\D)429(\D|$)/.test(reason)
  ) {
    return "TransientProviderUnavailable";
  }
  if (
    reason.includes("neither text nor a tool invocation") ||
    reason.includes("contract") ||
    reason.includes("max turns reached") ||
    reason.includes("repair")
  ) {
    return "DeterministicModelFailure";
  }
  return "UnknownFailure";
};

const fingerprintOf = (
  failureClass: ConversationFailureClass,
  settlement: ExecutionSettlement,
): string =>
  `cff_${sha256Hex(
    JSON.stringify({
      failureClass,
      settlementTag: settlement._tag,
      reason: failedReason(settlement),
    }),
  )}`;

const attentionReasonOf = (
  failureClass: ConversationFailureClass,
): ConversationAttentionReason => {
  switch (failureClass) {
    case "AuthenticationFailed":
    case "RequestRejected":
    case "DeterministicModelFailure":
    case "ContextBlocked":
    case "ReconciliationRequired":
    case "UnknownFailure":
      return failureClass;
    case "TransientProviderUnavailable":
      return "RetryBudgetExhausted";
    case "ControlledInterruption":
      return "UnknownFailure";
  }
};

const deterministicDelay = (
  messageId: string,
  attemptNo: number,
  policy: ConversationRetryPolicy,
): number => {
  const exponential = Math.min(
    policy.maxDelayMs,
    policy.baseDelayMs * 2 ** Math.max(0, attemptNo),
  );
  const hash = sha256Hex(`${messageId}:${String(attemptNo)}:${policy.version}`);
  const unit = Number.parseInt(hash.slice(0, 8), 16) / 0xffffffff;
  return Math.ceil(
    Math.min(
      policy.maxDelayMs,
      exponential + exponential * policy.jitterRatio * unit,
    ),
  );
};

export const decideConversationRecovery = (input: {
  readonly job: ConversationResponseJob;
  readonly attempts: ReadonlyArray<ConversationAttempt>;
  readonly settlement: ExecutionSettlement;
  readonly responseBody: string | null;
  readonly now: string;
  readonly policy: ConversationRetryPolicy;
}): ConversationRecoveryDecision => {
  const failureClass = classifyConversationFailure(
    input.settlement,
    input.responseBody,
  );
  if (failureClass === null && input.responseBody !== null) {
    const executionId =
      input.job.state._tag === "Running"
        ? input.job.state.executionId
        : ("exe_invalid" as never);
    return {
      nextState: {
        _tag: "Answered",
        executionId,
        responseBody: input.responseBody,
      },
      failureClass: null,
      failureFingerprint: null,
      retryDecision: { _tag: "Answer" },
    };
  }
  if (failureClass === "ControlledInterruption") {
    return {
      nextState: { _tag: "Cancelled", reason: "ControlledStop" },
      failureClass,
      failureFingerprint: fingerprintOf(failureClass, input.settlement),
      retryDecision: { _tag: "Cancel", reason: "ControlledStop" },
    };
  }

  const classified = failureClass ?? "DeterministicModelFailure";
  const failureFingerprint = fingerprintOf(classified, input.settlement);
  const executionId =
    input.job.state._tag === "Running"
      ? input.job.state.executionId
      : undefined;
  if (classified === "TransientProviderUnavailable") {
    const currentAttemptCount = input.attempts.length + 1;
    const identicalCount =
      input.attempts.filter(
        (attempt) => attempt.failureFingerprint === failureFingerprint,
      ).length + 1;
    const startedAt =
      input.attempts[0]?.admittedAt ?? input.job.createdAt ?? input.now;
    const elapsed = Math.max(0, Date.parse(input.now) - Date.parse(startedAt));
    if (
      currentAttemptCount >= input.policy.maxExecutionAttempts ||
      identicalCount >= input.policy.identicalFailureLimit ||
      elapsed >= input.policy.maxTotalElapsedMs
    ) {
      return {
        nextState: {
          _tag: "NeedsAttention",
          reason: "RetryBudgetExhausted",
          failureFingerprint,
          ...(executionId === undefined
            ? {}
            : { lastExecutionId: executionId }),
        },
        failureClass: classified,
        failureFingerprint,
        retryDecision: {
          _tag: "Attention",
          reason: "RetryBudgetExhausted",
        },
      };
    }
    const attemptNo =
      input.job.state._tag === "Running" ? input.job.state.attemptNo : 0;
    const nextEligibleAt = new Date(
      Date.parse(input.now) +
        deterministicDelay(input.job.messageId, attemptNo, input.policy),
    ).toISOString();
    return {
      nextState: {
        _tag: "RetryScheduled",
        attemptNo,
        nextEligibleAt,
        failureFingerprint,
      },
      failureClass: classified,
      failureFingerprint,
      retryDecision: { _tag: "RetryAt", nextEligibleAt },
    };
  }

  const reason = attentionReasonOf(classified);
  return {
    nextState: {
      _tag: "NeedsAttention",
      reason,
      failureFingerprint,
      ...(executionId === undefined ? {} : { lastExecutionId: executionId }),
    },
    failureClass: classified,
    failureFingerprint,
    retryDecision: { _tag: "Attention", reason },
  };
};
