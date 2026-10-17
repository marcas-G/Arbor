import type { Execution } from "@arbor/domain";
import type {
  ConversationCheckpointOwner,
  ProviderRunInput,
} from "@arbor/ports";
import { sha256Hex } from "@arbor/ports";
import { Effect, Exit } from "effect";
import { describe, expect, it } from "vitest";
import {
  conversationCheckpointProviderTurnId,
  runConversationCheckpointCompaction,
} from "../src/conversation-checkpoint-compaction.js";
import type { ConversationAnsweredSource } from "../src/conversation-checkpoint-projection.js";

const workspaceId = "ws_018f2b3c-4d5e-7abc-8def-0123456789a1" as never;
const projectId = "prj_018f2b3c-4d5e-7abc-8def-0123456789a2" as never;
const currentExecutionId = "exe_018f2b3c-4d5e-7abc-8def-0123456789a3" as never;
const priorExecutionId = "exe_018f2b3c-4d5e-7abc-8def-0123456789a4" as never;
const providerTurnId = "ptn_018f2b3c-4d5e-7abc-8def-0123456789a5" as never;
const bindingFingerprint = `p16fp_${"a".repeat(64)}`;

const priorMessage = {
  messageId: "msg_018f2b3c-4d5e-7abc-8def-0123456789a6" as never,
  projectId,
  rootWorkspaceId: workspaceId,
  bodyRef: "prior human input",
  createdAt: "2026-10-17T00:00:00.000Z",
};
const currentMessageId = "msg_018f2b3c-4d5e-7abc-8def-0123456789a7";

const source: ConversationAnsweredSource = {
  message: priorMessage,
  responseBody: "prior assistant response",
  job: {
    messageId: priorMessage.messageId,
    projectId,
    rootWorkspaceId: workspaceId,
    revision: 2,
    nextAttemptNo: 1,
    state: {
      _tag: "Answered",
      executionId: priorExecutionId,
      responseBody: "prior assistant response",
    },
  },
  attempt: {
    messageId: priorMessage.messageId,
    attemptNo: 0,
    executionId: priorExecutionId,
    settledAt: "2026-10-17T00:00:01.000Z",
    settlementKind: "Completed",
    retryDecision: { _tag: "Answer" },
  },
  execution: {
    executionId: priorExecutionId,
    projectId,
    workspaceId,
    sessionId: "ses_prior" as never,
    binding: {
      _tag: "WorkspaceExecution",
      workspaceId,
      episode: {
        _tag: "ConversationResponseEpisode",
        messageId: priorMessage.messageId,
        responseJobRevision: 0,
      },
    },
    admittedAt: "2026-10-17T00:00:00.000Z",
    stopRequestedAt: null,
    state: {
      status: "Settled",
      settlement: {
        _tag: "Completed",
        result: {
          _tag: "ConversationResponseProduced",
          messageId: priorMessage.messageId,
        },
      },
    },
  } as Execution,
  manifestSource: {
    createdAt: priorMessage.createdAt,
    messageId: priorMessage.messageId,
    bodyRef: priorMessage.bodyRef,
    bodySha256: sha256Hex(priorMessage.bodyRef),
    responseBodySha256: sha256Hex("prior assistant response"),
    answeredJobRevision: 2,
    responseExecutionId: priorExecutionId,
    attemptNo: 0,
    admissionJobRevision: 0,
  },
};

const owner: ConversationCheckpointOwner = {
  rootWorkspaceId: workspaceId,
  contextEpoch: 0 as never,
  coveredThrough: null,
  checkpointKind: null,
  checkpointRef: null,
  bindingFingerprint: null,
  sourceManifestJson: null,
  producerExecutionId: null,
  producerProviderTurnId: null,
  updatedAt: "2026-10-17T00:00:00.000Z",
};

describe("AH19 Conversation checkpoint blob-before-owner commit", () => {
  it("generates a stable composite ProviderTurnId and binds it exactly in the manifest", async () => {
    const composite = conversationCheckpointProviderTurnId(
      String(currentExecutionId),
      3,
      "Summary",
      2,
    );
    expect(composite).toBe(
      conversationCheckpointProviderTurnId(
        String(currentExecutionId),
        3,
        "Summary",
        2,
      ),
    );
    expect(String(composite)).toBe(
      `ptn_${currentExecutionId}_3_conversation_compact_2`,
    );

    const execution = {
      executionId: currentExecutionId,
      projectId,
      workspaceId,
      sessionId: "ses_current" as never,
      binding: {
        _tag: "WorkspaceExecution",
        workspaceId,
        episode: {
          _tag: "ConversationResponseEpisode",
          messageId: currentMessageId as never,
          responseJobRevision: 0,
        },
      },
      admittedAt: "2026-10-17T00:00:00.000Z",
      stopRequestedAt: null,
      state: { status: "Active", settlement: null },
    } as Execution;
    let capturedManifest: Record<string, unknown> | undefined;
    let capturedRequest: unknown;
    await Effect.runPromiseExit(
      runConversationCheckpointCompaction(
        {
          execution,
          logicalStepNo: 3,
          owner: { ...owner, contextEpoch: 2 as never },
          sources: [source],
          coveredThrough: {
            createdAt: priorMessage.createdAt,
            messageId: priorMessage.messageId,
          },
          currentMessageId,
          currentResponseJob: {
            messageId: currentMessageId as never,
            projectId,
            rootWorkspaceId: workspaceId,
            state: {
              _tag: "Running",
              attemptNo: 0,
              executionId: currentExecutionId,
            },
            revision: 1,
            nextAttemptNo: 1,
          } as never,
          checkpointKind: "Summary",
          bindingFingerprint,
          modelRef: "model-openai",
          fence: {
            executionId: currentExecutionId,
            workerId: "worker:ah19",
            workerIncarnationId: "incarnation:ah19",
            fencingGeneration: 0 as never,
          },
          updatedAt: "2026-10-17T00:00:02.000Z",
        },
        {
          providerRuntime: {
            runTurn: (input: ProviderRunInput) => {
              capturedManifest = JSON.parse(input.manifestJson) as Record<
                string,
                unknown
              >;
              capturedRequest = input.request;
              return Effect.succeed({
                events: [{ _tag: "TextDelta", text: "portable summary" }],
                attemptNo: 0,
                retryDecisions: [],
              } as never);
            },
          } as never,
          checkpointStore: {
            commit: () => Effect.fail({ _tag: "ExpectedStop" }),
          } as never,
          providerTurns: {
            findSettledResult: () => Effect.succeed({ _tag: "NotFound" }),
            findManifestByTurn: () =>
              Effect.succeed(
                capturedManifest === undefined || capturedRequest === undefined
                  ? null
                  : {
                      manifestId: "mfest_ah19_generated_summary",
                      manifestJson: JSON.stringify(capturedManifest),
                      portableRequestJson: JSON.stringify(capturedRequest),
                    },
              ),
          } as never,
          blobs: {
            put: () => Effect.succeed("blob:summary" as never),
          } as never,
          tx: {
            transact: (effect: Effect.Effect<unknown, unknown>) => effect,
          } as never,
        },
      ),
    );
    expect(capturedManifest).toMatchObject({
      providerTurnId: String(composite),
      executionId: String(currentExecutionId),
      sessionId: "ses_current",
      contextEpoch: 2,
      conversationCheckpoint: {
        rootWorkspaceId: String(workspaceId),
        fromEpoch: 2,
        toEpoch: 3,
        currentMessageId,
        currentRunningJobRevision: 1,
        currentAdmissionJobRevision: 0,
      },
    });
  });

  it("leaves an allowed orphan Summary Blob when the owner CAS fails", async () => {
    const execution = {
      executionId: currentExecutionId,
      projectId,
      workspaceId,
      sessionId: "ses_current" as never,
      binding: {
        _tag: "WorkspaceExecution",
        workspaceId,
        episode: {
          _tag: "ConversationResponseEpisode",
          messageId: currentMessageId as never,
          responseJobRevision: 0,
        },
      },
      admittedAt: "2026-10-17T00:00:00.000Z",
      stopRequestedAt: null,
      state: { status: "Active", settlement: null },
    } as Execution;
    const currentResponseJob = {
      messageId: currentMessageId as never,
      projectId,
      rootWorkspaceId: workspaceId,
      state: {
        _tag: "Running",
        attemptNo: 0,
        executionId: currentExecutionId,
      },
      revision: 1,
      nextAttemptNo: 1,
    } as never;
    const blobs: Array<string> = [];
    let commitCalled = false;
    let providerManifestJson: string | undefined;
    let providerRequestJson: string | undefined;
    const providerTurns = {
      findSettledResult: () => Effect.succeed({ _tag: "NotFound" }),
      findManifestByTurn: () =>
        Effect.succeed(
          providerManifestJson === undefined ||
            providerRequestJson === undefined
            ? null
            : {
                manifestId: "mfest_orphan_summary",
                manifestJson: providerManifestJson,
                portableRequestJson: providerRequestJson,
              },
        ),
    };
    const result = await Effect.runPromiseExit(
      runConversationCheckpointCompaction(
        {
          execution,
          logicalStepNo: 0,
          providerTurnId,
          owner,
          sources: [source],
          coveredThrough: {
            createdAt: priorMessage.createdAt,
            messageId: priorMessage.messageId,
          },
          currentMessageId,
          currentResponseJob,
          checkpointKind: "Summary",
          bindingFingerprint,
          modelRef: "model-openai",
          fence: {
            executionId: currentExecutionId,
            workerId: "worker:ah19",
            workerIncarnationId: "incarnation:ah19",
            fencingGeneration: 0 as never,
          },
          updatedAt: "2026-10-17T00:00:02.000Z",
        },
        {
          providerRuntime: {
            runTurn: (input: ProviderRunInput) => {
              providerManifestJson = input.manifestJson;
              providerRequestJson = JSON.stringify(input.request);
              return Effect.succeed({
                events: [{ _tag: "TextDelta", text: "portable summary" }],
                attemptNo: 0,
                retryDecisions: [],
              } as never);
            },
          } as never,
          checkpointStore: {
            commit: () => {
              commitCalled = true;
              return Effect.fail({
                _tag: "ConversationCheckpointOwnerConflict",
                reason: "ExpectedEpochMismatch",
              });
            },
          } as never,
          providerTurns: providerTurns as never,
          blobs: {
            put: (bytes: Uint8Array) => {
              blobs.push(new TextDecoder().decode(bytes));
              return Effect.succeed("blob:orphan-summary" as never);
            },
          } as never,
          tx: {
            transact: (effect: Effect.Effect<unknown, unknown>) => effect,
          } as never,
        },
      ),
    );

    expect(Exit.isFailure(result)).toBe(true);
    expect(blobs).toEqual(["portable summary"]);
    expect(commitCalled).toBe(true);
  });
});
