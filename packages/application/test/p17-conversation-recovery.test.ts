import type { ExecutionSettlement } from "@arbor/domain";
import type {
  ConversationAttempt,
  ConversationResponseJob,
} from "@arbor/ports";
import { describe, expect, it } from "vitest";
import {
  CONVERSATION_RETRY_POLICY_V1,
  decideConversationRecovery,
} from "../src/conversation-recovery.js";

const job: ConversationResponseJob = {
  messageId: "msg_018f2b3c-4d5e-7abc-8def-0123456789a1" as never,
  projectId: "prj_018f2b3c-4d5e-7abc-8def-0123456789a1" as never,
  rootWorkspaceId: "ws_018f2b3c-4d5e-7abc-8def-0123456789a1" as never,
  state: {
    _tag: "Running",
    attemptNo: 0,
    executionId: "exe_018f2b3c-4d5e-7abc-8def-0123456789a1" as never,
  },
  nextAttemptNo: 1,
  policyVersion: "conversation-retry-v1",
  providerReasoning: null,
  lastFailureClass: null,
  revision: 1,
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-01T00:00:00.000Z",
};

const failed = (reason: string): ExecutionSettlement => ({
  _tag: "Failed",
  failure: { _tag: "ExecutionFailure", reason },
});

const jobExecutionId =
  job.state._tag === "Running"
    ? job.state.executionId
    : (() => {
        throw new Error("test job must be Running");
      })();

describe("P17 conversation recovery policy", () => {
  it("schedules a first transient provider failure with deterministic delay", () => {
    const input = {
      job,
      attempts: [] as ReadonlyArray<ConversationAttempt>,
      settlement: failed("ProviderExecutionTimedOut:StreamIdleTimeout"),
      responseBody: null,
      now: "2026-10-01T00:00:10.000Z",
      policy: CONVERSATION_RETRY_POLICY_V1,
    };
    const first = decideConversationRecovery(input);
    const replay = decideConversationRecovery(input);
    expect(first).toEqual(replay);
    expect(first.failureClass).toBe("TransientProviderUnavailable");
    expect(first.nextState).toMatchObject({
      _tag: "RetryScheduled",
      attemptNo: 0,
      failureFingerprint: expect.stringMatching(/^cff_/),
    });
    if (first.nextState._tag !== "RetryScheduled") {
      throw new Error("expected retry schedule");
    }
    expect(Date.parse(first.nextState.nextEligibleAt)).toBeGreaterThan(
      Date.parse(input.now),
    );
  });

  it("moves the second identical transient failure to Attention", () => {
    const first = decideConversationRecovery({
      job,
      attempts: [],
      settlement: failed("ProviderExecutionTimedOut:StreamIdleTimeout"),
      responseBody: null,
      now: "2026-10-01T00:00:10.000Z",
      policy: CONVERSATION_RETRY_POLICY_V1,
    });
    const prior: ConversationAttempt = {
      messageId: job.messageId,
      attemptNo: 0,
      executionId: jobExecutionId,
      admittedAt: "2026-10-01T00:00:00.000Z",
      settledAt: "2026-10-01T00:00:10.000Z",
      settlementKind: "Failed",
      failureClass: first.failureClass,
      failureFingerprint: first.failureFingerprint,
      retryDecision: first.retryDecision,
      policyVersion: job.policyVersion,
    };
    const second = decideConversationRecovery({
      job: {
        ...job,
        state: {
          _tag: "Running",
          attemptNo: 1,
          executionId: "exe_018f2b3c-4d5e-7abc-8def-0123456789a2" as never,
        },
        nextAttemptNo: 2,
      },
      attempts: [prior],
      settlement: failed("ProviderExecutionTimedOut:StreamIdleTimeout"),
      responseBody: null,
      now: "2026-10-01T00:00:20.000Z",
      policy: CONVERSATION_RETRY_POLICY_V1,
    });
    expect(second.nextState).toMatchObject({
      _tag: "NeedsAttention",
      reason: "RetryBudgetExhausted",
      failureFingerprint: first.failureFingerprint,
    });
  });

  it("never retries deterministic output failure or OutcomeUnknown", () => {
    const deterministic = decideConversationRecovery({
      job,
      attempts: [],
      settlement: failed("turn produced neither text nor a tool invocation"),
      responseBody: null,
      now: "2026-10-01T00:00:10.000Z",
      policy: CONVERSATION_RETRY_POLICY_V1,
    });
    expect(deterministic.nextState).toMatchObject({
      _tag: "NeedsAttention",
      reason: "DeterministicModelFailure",
    });

    const unknown = decideConversationRecovery({
      job,
      attempts: [],
      settlement: {
        _tag: "OutcomeUnknown",
        reconciliation: {
          _tag: "ReconciliationRequired",
          invocationRefs: ["inv_1"],
        },
      },
      responseBody: null,
      now: "2026-10-01T00:00:10.000Z",
      policy: CONVERSATION_RETRY_POLICY_V1,
    });
    expect(unknown.nextState).toMatchObject({
      _tag: "NeedsAttention",
      reason: "ReconciliationRequired",
    });
  });
});
