import type { Execution } from "@arbor/domain";
import type {
  ConversationAttempt,
  ConversationCheckpointOwner,
  ConversationResponseJob,
  HumanMessageRecord,
} from "@arbor/ports";
import { sha256Hex } from "@arbor/ports";
import { describe, expect, it } from "vitest";
import { projectConversationCheckpointHistory } from "../src/conversation-checkpoint-projection.js";

const rootWorkspaceId = "ws_root" as never;
const projectId = "prj_root" as never;
const currentExecutionId = "exe_current" as never;
const coveredExecutionId = "exe_covered" as never;
const afterExecutionId = "exe_after" as never;
type TestMessage = Pick<
  HumanMessageRecord,
  "messageId" | "projectId" | "rootWorkspaceId" | "bodyRef" | "createdAt"
>;
type TestJob = Pick<
  ConversationResponseJob,
  | "messageId"
  | "projectId"
  | "rootWorkspaceId"
  | "state"
  | "revision"
  | "nextAttemptNo"
>;
type TestAttempt = Pick<
  ConversationAttempt,
  | "messageId"
  | "attemptNo"
  | "executionId"
  | "settledAt"
  | "settlementKind"
  | "retryDecision"
>;

const covered: TestMessage = {
  messageId: "msg_01_covered" as never,
  projectId,
  rootWorkspaceId,
  bodyRef: "blob:body-covered",
  createdAt: "2026-10-17T00:01:00.000Z",
};

const after: TestMessage = {
  messageId: "msg_02_after" as never,
  projectId,
  rootWorkspaceId,
  bodyRef: "blob:body-after",
  createdAt: "2026-10-17T00:02:00.000Z",
};

const current: TestMessage = {
  messageId: "msg_03_current" as never,
  projectId,
  rootWorkspaceId,
  bodyRef: "blob:body-current",
  createdAt: "2026-10-17T00:03:00.000Z",
};

const answeredJob = (
  message: TestMessage,
  executionId:
    | typeof coveredExecutionId
    | typeof afterExecutionId = coveredExecutionId,
  options: {
    readonly revision?: number;
    readonly state?: ConversationResponseJob["state"];
  } = {},
): TestJob => ({
  messageId: message.messageId as never,
  projectId: message.projectId,
  rootWorkspaceId: message.rootWorkspaceId,
  revision: options.revision ?? 2,
  nextAttemptNo: 1,
  state: options.state ?? {
    _tag: "Answered",
    executionId,
    responseBody: `answer-for-${message.messageId}`,
  },
});

const currentJob: TestJob = {
  messageId: current.messageId as never,
  projectId,
  rootWorkspaceId,
  revision: 1,
  nextAttemptNo: 1,
  state: { _tag: "Running", attemptNo: 0, executionId: currentExecutionId },
};

const answeredAttempt = (
  message: TestMessage,
  executionId: typeof coveredExecutionId | typeof afterExecutionId,
): TestAttempt => ({
  messageId: message.messageId as never,
  attemptNo: 0,
  executionId,
  settledAt: "2026-10-17T00:04:00.000Z",
  settlementKind: "Completed",
  retryDecision: { _tag: "Answer" },
});

const currentAttempt: TestAttempt = {
  messageId: current.messageId as never,
  attemptNo: 0,
  executionId: currentExecutionId,
  settledAt: null,
  settlementKind: null,
  retryDecision: null,
};

const responseExecution = (
  message: TestMessage,
  executionId: typeof coveredExecutionId | typeof afterExecutionId,
  admissionRevision = 0,
): Execution => ({
  executionId,
  projectId,
  workspaceId: rootWorkspaceId,
  sessionId: "ses_response" as never,
  admittedAt: "2026-10-17T00:00:00.000Z",
  stopRequestedAt: null,
  binding: {
    _tag: "WorkspaceExecution",
    workspaceId: rootWorkspaceId,
    episode: {
      _tag: "ConversationResponseEpisode",
      messageId: message.messageId as never,
      responseJobRevision: admissionRevision,
    },
  },
  state: {
    status: "Settled",
    settlement: {
      _tag: "Completed",
      result: {
        _tag: "ConversationResponseProduced",
        messageId: message.messageId as never,
      },
    },
  },
});

const currentExecution: Execution = {
  executionId: currentExecutionId,
  projectId,
  workspaceId: rootWorkspaceId,
  sessionId: "ses_response" as never,
  admittedAt: "2026-10-17T00:00:00.000Z",
  stopRequestedAt: null,
  binding: {
    _tag: "WorkspaceExecution",
    workspaceId: rootWorkspaceId,
    episode: {
      _tag: "ConversationResponseEpisode",
      messageId: current.messageId as never,
      responseJobRevision: 0,
    },
  },
  state: { status: "Active", settlement: null },
};

const source = {
  createdAt: covered.createdAt,
  messageId: covered.messageId,
  bodyRef: covered.bodyRef,
  bodySha256: sha256Hex(covered.bodyRef),
  responseBodySha256: sha256Hex(`answer-for-${covered.messageId}`),
  answeredJobRevision: 2,
  responseExecutionId: coveredExecutionId,
  attemptNo: 0,
  admissionJobRevision: 0,
};

const owner = (
  overrides: Partial<ConversationCheckpointOwner> = {},
): ConversationCheckpointOwner => {
  const manifest = {
    version: 1,
    rootWorkspaceId,
    fromEpoch: 0,
    toEpoch: 1,
    fromFrontier: null,
    coveredThrough: {
      createdAt: covered.createdAt,
      messageId: covered.messageId,
    },
    coveredSources: [source],
    currentMessageId: "msg_checkpoint_producer",
    currentRunningJobRevision: 1,
    currentRunningAttemptNo: 0,
    currentAdmissionJobRevision: 0,
    checkpointKind: "Summary",
    producerExecutionId: "exe_checkpoint_producer",
    producerProviderTurnId: "ptn_checkpoint_producer",
    producerManifestId: "manifest-checkpoint-producer",
  };
  return {
    rootWorkspaceId,
    contextEpoch: 1 as never,
    coveredThrough: {
      createdAt: covered.createdAt,
      messageId: covered.messageId,
    },
    checkpointKind: "Summary",
    checkpointRef: "a".repeat(64),
    bindingFingerprint: null,
    sourceManifestJson: JSON.stringify(manifest),
    producerExecutionId: "exe_checkpoint_producer" as never,
    producerProviderTurnId: "ptn_checkpoint_producer" as never,
    updatedAt: "2026-10-17T00:04:00.000Z",
    ...overrides,
  };
};

const standardInput = (
  overrides: Partial<{
    messages: ReadonlyArray<TestMessage>;
    responseJobs: ReadonlyArray<TestJob>;
    attempts: ReadonlyArray<TestAttempt>;
    executions: ReadonlyArray<Execution>;
  }> = {},
) => ({
  owner: owner(),
  messages: [current, after, covered],
  responseJobs: [
    answeredJob(covered),
    answeredJob(after, afterExecutionId),
    currentJob,
  ],
  attempts: [
    answeredAttempt(covered, coveredExecutionId),
    answeredAttempt(after, afterExecutionId),
    currentAttempt,
  ],
  executions: [
    responseExecution(covered, coveredExecutionId),
    responseExecution(after, afterExecutionId),
    currentExecution,
  ],
  currentMessageId: current.messageId as string,
  currentExecution,
  ...overrides,
});

describe("AH19 Conversation owner history projection", () => {
  it.each([
    ["unknown owner kind", { checkpointKind: "CorruptKind" as never }],
    [
      "unknown manifest kind",
      {
        sourceManifestJson: JSON.stringify({
          ...JSON.parse(owner().sourceManifestJson ?? "{}"),
          checkpointKind: "CorruptKind",
        }),
      },
    ],
    [
      "Native owner without fingerprint",
      {
        checkpointKind: "ProviderNative" as never,
        checkpointRef: "opaque:native-state",
      },
    ],
    [
      "Native owner without ref",
      {
        checkpointKind: "ProviderNative" as never,
        checkpointRef: null,
        bindingFingerprint: `p16fp_${"b".repeat(64)}`,
      },
    ],
    [
      "Summary owner with non-digest ref",
      { checkpointRef: "opaque:native-state" },
    ],
  ])("blocks a malformed checkpoint binding: %s", (_label, ownerOverrides) => {
    const result = projectConversationCheckpointHistory({
      ...standardInput(),
      owner: owner(ownerOverrides),
    });
    expect(result).toEqual({ _tag: "Blocked", reason: "MalformedOwner" });
  });

  it("uses the inclusive owner frontier, exact Answered Job/Attempt/Execution suffix, and pins current once", () => {
    const result = projectConversationCheckpointHistory(standardInput());

    expect(result._tag).toBe("Ready");
    if (result._tag !== "Ready") return;
    expect(result.projection.checkpoint.coveredThrough).toEqual({
      createdAt: covered.createdAt,
      messageId: covered.messageId,
    });
    expect(
      result.projection.uncoveredAnswered.map((item) => item.message.messageId),
    ).toEqual([after.messageId]);
    expect(result.projection.currentMessage.messageId).toBe(current.messageId);
    expect(result.projection.currentMessage.bodyRef).toBe("blob:body-current");
    expect(result.projection.blockerMessageId).toBeNull();
    expect(result.projection.uncoveredAnswered[0]?.responseBody).toBe(
      `answer-for-${after.messageId}`,
    );
  });

  it("ignores every legacy HumanMessage lifecycle, claim, and response value", () => {
    const legacyVariants = [
      { state: "Pending", claimedByExecutionId: null, responseBody: null },
      {
        state: "Claimed",
        claimedByExecutionId: "exe_other",
        responseBody: "stale",
      },
      {
        state: "Declined",
        claimedByExecutionId: currentExecutionId,
        responseBody: "wrong",
      },
      {
        state: "Answered",
        claimedByExecutionId: null,
        responseBody: "different",
      },
    ];
    for (const legacy of legacyVariants) {
      const messages = [
        { ...covered, ...legacy },
        { ...after, ...legacy },
        { ...current, ...legacy },
      ];
      const result = projectConversationCheckpointHistory(
        standardInput({ messages }),
      );
      expect(result._tag).toBe("Ready");
      if (result._tag === "Ready") {
        expect(
          result.projection.uncoveredAnswered.map(
            (item) => item.message.messageId,
          ),
        ).toEqual([after.messageId]);
        expect(result.projection.currentMessage.messageId).toBe(
          current.messageId,
        );
      }
    }
  });

  it.each([
    ["Queued Job", { _tag: "Queued" } as const],
    [
      "RetryScheduled Job",
      {
        _tag: "RetryScheduled",
        attemptNo: 0,
        nextEligibleAt: "later",
        failureFingerprint: "fp",
      } as const,
    ],
    [
      "NeedsAttention Job",
      {
        _tag: "NeedsAttention",
        reason: "UnknownFailure",
        failureFingerprint: "fp",
      } as const,
    ],
    ["Cancelled Job", { _tag: "Cancelled", reason: "HumanCancelled" } as const],
  ])(
    "stops at an earlier %s even when later Job is Answered",
    (_label, state) => {
      const blockerJob = answeredJob(after, afterExecutionId, { state });
      const result = projectConversationCheckpointHistory(
        standardInput({
          messages: [covered, after, current],
          responseJobs: [answeredJob(covered), blockerJob, currentJob],
        }),
      );
      expect(result._tag).toBe("Ready");
      if (result._tag === "Ready") {
        expect(result.projection.uncoveredAnswered).toEqual([]);
        expect(result.projection.blockerMessageId).toBe(after.messageId);
      }
    },
  );

  it.each([
    [
      "missing exact Attempt",
      [],
      [responseExecution(covered, coveredExecutionId)],
    ],
    [
      "wrong Execution result",
      [answeredAttempt(covered, coveredExecutionId)],
      [
        {
          ...responseExecution(covered, coveredExecutionId),
          state: {
            status: "Settled",
            settlement: {
              _tag: "Completed",
              result: { _tag: "Yielded", reason: "wrong", waitSpec: {} },
            },
          },
        } as unknown as Execution,
      ],
    ],
    [
      "admission revision not related by P17 transitions",
      [answeredAttempt(covered, coveredExecutionId)],
      [responseExecution(covered, coveredExecutionId, 1)],
    ],
  ])(
    "does not accept an owner frontier without %s",
    (_label, attempts, executions) => {
      const result = projectConversationCheckpointHistory(
        standardInput({
          attempts: [
            ...attempts,
            answeredAttempt(after, afterExecutionId),
            currentAttempt,
          ],
          executions: [
            ...executions,
            responseExecution(after, afterExecutionId),
            currentExecution,
          ],
        }),
      );
      expect(result).toEqual({
        _tag: "Blocked",
        reason: "OwnerFrontierNotAuthoritative",
      });
    },
  );

  it("blocks current raw input unless the exact Running Job, active Attempt, and Episode Execution agree", () => {
    const currentJobQueued: TestJob = {
      ...currentJob,
      state: { _tag: "Queued" },
    };
    const result = projectConversationCheckpointHistory(
      standardInput({
        responseJobs: [
          answeredJob(covered),
          answeredJob(after, afterExecutionId),
          currentJobQueued,
        ],
      }),
    );
    expect(result).toEqual({ _tag: "Blocked", reason: "CurrentJobNotRunning" });

    const wrongCurrentExecution: Execution = {
      ...currentExecution,
      executionId: "exe_other" as never,
    };
    const mismatched = projectConversationCheckpointHistory({
      ...standardInput(),
      currentExecution: wrongCurrentExecution,
    });
    expect(mismatched).toEqual({
      _tag: "Blocked",
      reason: "CurrentJobNotRunning",
    });
  });
});
