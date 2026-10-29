import {
  ContextEpochNumber,
  ExecutionId,
  parse,
  providerTurnInferenceId,
  SessionId,
  WorkId,
  WorkspaceId,
  workspaceEpisodeExecution,
} from "@arbor/domain";
import type { ModelOutput, PreparedModelTurn } from "@arbor/model-context";
import {
  decodeReasoningAttachment,
  PROVIDER_REASONING_ATTACHMENT_MEDIA_TYPE,
  type SessionItemWrite,
  sessionEntryKindOf,
  sha256Hex,
} from "@arbor/ports";
import { Effect, Option } from "effect";
import { describe, expect, it } from "vitest";
import { recordAcceptedModelOutput } from "../src/model-output-journal.js";

const executionId = parse(ExecutionId)(
  "exe_00000000-0000-7000-8000-000000000162",
);
const sessionId = parse(SessionId)("ses_00000000-0000-7000-8000-000000000162");
const workspaceId = parse(WorkspaceId)(
  "ws_00000000-0000-7000-8000-000000000162",
);
const workId = parse(WorkId)("wrk_00000000-0000-7000-8000-000000000162");
const providerTurnId = providerTurnInferenceId(executionId, 0);
const bindingFingerprint = `p16fp_${"a".repeat(64)}`;

describe("P16 reasoning round-trip output journal", () => {
  it("persists one content-addressed attachment and replays the same ProviderTurn idempotently", async () => {
    const writes = new Map<
      string,
      SessionItemWrite & { readonly sequence: number }
    >();
    const blobs = new Map<string, Uint8Array>();
    const sessions = {
      supportsTypedTimeline: () => Effect.succeed(true),
      findById: () =>
        Effect.succeed(
          Option.some({ contextEpoch: parse(ContextEpochNumber)(0) } as never),
        ),
      appendItemIdempotent: (_sessionId: string, write: SessionItemWrite) => {
        const key = `${write.item._tag}:${write.source.kind}:${write.source.ref}`;
        const prior = writes.get(key);
        if (prior !== undefined) {
          return prior.contentHash === write.contentHash
            ? Effect.succeed({ sequence: prior.sequence, inserted: false })
            : Effect.fail({ _tag: "SessionSourceConflict" as const });
        }
        const sequence = writes.size + 1;
        writes.set(key, { ...write, sequence });
        return Effect.succeed({ sequence, inserted: true });
      },
    };
    const loopStep = {
      identity: { executionId, logicalStepNo: 0, repairAttempt: 0 },
      providerTurnId,
      state: "ProviderResultAvailable",
      nextActionIndex: 0,
      revision: 2,
      updatedAt: "2026-10-24T04:00:00.000Z",
    } as never;
    const loopSteps = {
      transition: (input: { readonly next: unknown }) =>
        Effect.succeed(input.next),
    } as never;
    const preparedTurn = {
      manifest: {
        providerTurnId,
        executionId,
        sessionId,
        contextEpoch: parse(ContextEpochNumber)(0),
        modelRef: "model-deepseek-v4-flash",
        protocolFamily: "openai-chat-completions-sse",
        outputContractRef: "agent-directive-v1",
        resolvedModelBindingFingerprint: bindingFingerprint,
      },
    } as never as PreparedModelTurn;
    const decodedOutput: ModelOutput = {
      text: "",
      finishReason: "ToolCall",
      reasoningOpaquePayload: "synthetic opaque reasoning",
      toolInvocations: [
        {
          providerTurnId,
          outputPosition: 0,
          callRef: "call-read",
          toolName: "read",
          argumentsJson: '{"path":"README.md"}',
        },
      ],
    };
    const dependencies = {
      input: {
        execution: {
          executionId,
          workspaceId,
          sessionId,
          binding: workspaceEpisodeExecution(workspaceId, {
            _tag: "WorkEpisode",
            workId,
            targetWorkRevision: 0 as never,
          }),
        } as never,
        context: { _tag: "ExecutionOrigin" } as never,
      },
      preparedTurn,
      decodedOutput,
      currentLoopStep: loopStep,
      loopSteps,
      loopStepFence: {} as never,
      tx: { transact: <A, E>(effect: Effect.Effect<A, E>) => effect } as never,
      sessions: sessions as never,
      blobs: {
        put: (bytes: Uint8Array) =>
          Effect.sync(() => {
            const ref = sha256Hex(new TextDecoder().decode(bytes));
            blobs.set(ref, bytes);
            return ref;
          }),
      },
      failure: (cause: unknown) =>
        ({ _tag: "ExecutionDriverError", cause }) as never,
      now: () => Effect.succeed("must-not-replace-stable-step-time"),
    };

    await Effect.runPromise(recordAcceptedModelOutput(dependencies));
    await Effect.runPromise(recordAcceptedModelOutput(dependencies));

    expect([...writes.values()].map((write) => write.item._tag)).toEqual([
      "AssistantMessage",
      "AttachmentRef",
      "ToolCall",
    ]);
    const assistant = [...writes.values()][0];
    expect(assistant?.contentHash).toBe(
      sha256Hex(JSON.stringify({ text: "", finishReason: "ToolCall" })),
    );
    const reasoning = [...writes.values()][1];
    expect(reasoning?.item).toMatchObject({
      _tag: "AttachmentRef",
      mediaType: PROVIDER_REASONING_ATTACHMENT_MEDIA_TYPE,
      trust: "DataOnly",
      providerTurnId,
    });
    expect(
      reasoning === undefined ? undefined : sessionEntryKindOf(reasoning.item),
    ).toBe("ModelOutput");
    const ref =
      reasoning?.item._tag === "AttachmentRef" ? reasoning.item.ref : undefined;
    expect(ref).toBeDefined();
    expect(blobs).toHaveLength(1);
    expect(
      decodeReasoningAttachment(blobs.get(ref as string) as Uint8Array),
    ).toEqual({
      attachmentType: "provider-reasoning-v1",
      modelRef: "model-deepseek-v4-flash",
      protocolFamily: "openai-chat-completions-sse",
      bindingFingerprint,
      opaquePayload: "synthetic opaque reasoning",
      receivedAt: "2026-10-24T04:00:00.000Z",
    });
  });
});
