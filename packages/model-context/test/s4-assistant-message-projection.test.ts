import {
  ExecutionId,
  parse,
  providerTurnInferenceId,
  SessionId,
} from "@arbor/domain";
import {
  encodeReasoningAttachment,
  PROVIDER_REASONING_ATTACHMENT_MEDIA_TYPE,
  type ReasoningAttachment,
  type SessionEntryRecord,
  sha256Hex,
} from "@arbor/ports";
import { describe, expect, it } from "vitest";
import { projectCompressibleHistory } from "../src/history-context.js";
import {
  decideSessionProjection,
  projectSessionTimeline,
} from "../src/projector.js";

const executionId = parse(ExecutionId)(
  "exe_00000000-0000-7000-8000-000000000117",
);
const sessionId = parse(SessionId)("ses_00000000-0000-7000-8000-000000000117");
const providerTurnId = providerTurnInferenceId(executionId, 0);
const outputText = "I have finished.";
const finishReason = "Stop";
const assistantSourceRef = `${providerTurnId}:assistant`;
const assistantContentRef = `provider:${providerTurnId}:assistant`;
const assistantContentHash = sha256Hex(
  JSON.stringify({ text: outputText, finishReason }),
);

const validAssistantEntry: SessionEntryRecord = {
  sessionId,
  sequence: 7,
  entryKind: "ModelOutput",
  payload: {
    _tag: "AssistantMessage",
    providerTurnId,
    contentRef: assistantContentRef,
    text: outputText,
    finishReason,
  },
  createdAt: "2026-10-24T00:00:00.000Z",
  source: {
    kind: "ProviderTurn",
    ref: assistantSourceRef,
    contentHash: assistantContentHash,
  },
};
const bindingFingerprint = `p16fp_${"a".repeat(64)}`;
const reasoningBlobRef = "reasoning-blob-ref";
const reasoningAttachment: ReasoningAttachment = {
  attachmentType: "provider-reasoning-v1",
  modelRef: "model-deepseek",
  protocolFamily: "openai-chat-completions-sse",
  bindingFingerprint,
  opaquePayload: "opaque synthetic reasoning",
  receivedAt: "2026-10-24T00:00:01.000Z",
};
const reasoningPayload = {
  _tag: "AttachmentRef" as const,
  ref: reasoningBlobRef,
  mediaType: PROVIDER_REASONING_ATTACHMENT_MEDIA_TYPE,
  trust: "DataOnly" as const,
  providerTurnId,
};
const reasoningEntry: SessionEntryRecord = {
  sessionId,
  sequence: 8,
  entryKind: "ModelOutput",
  payload: reasoningPayload,
  createdAt: "2026-10-24T00:00:01.000Z",
  source: {
    kind: "ProviderTurnReasoning",
    ref: `${providerTurnId}:reasoning`,
    contentHash: sha256Hex(JSON.stringify(reasoningPayload)),
  },
};

describe("S4-CONTEXT-DG-01 AssistantMessage projection", () => {
  it("projects one exact sourced assistant-role item and its exact Session source ref", () => {
    const projection = projectSessionTimeline([validAssistantEntry]);

    expect(projection.inputItems).toEqual([
      { _tag: "Message", role: "assistant", text: outputText },
    ]);
    expect(projection.contextRefs).toEqual([
      `session:ProviderTurn:${assistantSourceRef}`,
    ]);
    expect(projection.frontier).toEqual({ firstSequence: 7, lastSequence: 7 });
    expect(projection.instructionFragments).toEqual([]);
  });

  it("keeps projected assistant history in DataOnly C3 with authenticated-agent provenance", () => {
    const projection = projectSessionTimeline([validAssistantEntry]);
    const history = projectCompressibleHistory({
      inputItems: projection.inputItems,
      sourceRefs: projection.contextRefs,
      compressibleIndexes: [0],
    });

    expect(history.contextFragments).toHaveLength(1);
    expect(history.contextFragments[0]).toMatchObject({
      layer: "C3",
      retention: "Compressible",
      provenance: {
        provenanceKind: "AuthenticatedAgent",
        instructionCapability: "DataOnly",
        epistemicStatus: "Established",
      },
    });
    expect(history.compressibleInputItemIndexes).toEqual([0]);
  });

  it("injects an opaque reasoning attachment only for the exact model/protocol/binding", () => {
    const matching = projectSessionTimeline(
      [validAssistantEntry, reasoningEntry],
      bindingFingerprint,
      false,
      {
        modelRef: "model-deepseek",
        protocolFamily: "openai-chat-completions-sse",
        bindingFingerprint,
      },
      new Map([
        [reasoningBlobRef, encodeReasoningAttachment(reasoningAttachment)],
      ]),
    );
    expect(matching.inputItems).toEqual([
      { _tag: "Message", role: "assistant", text: outputText },
      {
        _tag: "ReasoningAttachment",
        providerTurnId,
        modelRef: "model-deepseek",
        protocolFamily: "openai-chat-completions-sse",
        bindingFingerprint,
        opaquePayload: "opaque synthetic reasoning",
      },
    ]);
    expect(matching.reasoningAttachmentRefs).toEqual([
      {
        messageId: providerTurnId,
        modelRef: "model-deepseek",
        protocolFamily: "openai-chat-completions-sse",
        bindingFingerprint,
        decision: "Inject",
      },
    ]);

    const differentBinding = projectSessionTimeline(
      [validAssistantEntry, reasoningEntry],
      `p16fp_${"b".repeat(64)}`,
      false,
      {
        modelRef: "model-deepseek",
        protocolFamily: "openai-chat-completions-sse",
        bindingFingerprint: `p16fp_${"b".repeat(64)}`,
      },
      new Map([
        [reasoningBlobRef, encodeReasoningAttachment(reasoningAttachment)],
      ]),
    );
    expect(differentBinding.inputItems).toEqual([
      { _tag: "Message", role: "assistant", text: outputText },
    ]);
    expect(differentBinding.reasoningAttachmentRefs?.[0]?.decision).toBe(
      "Preserve",
    );
  });

  it("fails closed when a durable reasoning ref has no valid blob", () => {
    expect(
      decideSessionProjection(
        [validAssistantEntry, reasoningEntry],
        bindingFingerprint,
        false,
        {
          modelRef: "model-deepseek",
          protocolFamily: "openai-chat-completions-sse",
          bindingFingerprint,
        },
        new Map([[reasoningBlobRef, new TextEncoder().encode("not-json")]]),
      ),
    ).toMatchObject({
      _tag: "Blocked",
      reason: "ContradictoryTimeline",
    });
  });

  it.each([
    ["missing source", { source: undefined }],
    [
      "wrong source kind",
      { source: { ...validAssistantEntry.source, kind: "ToolInvocation" } },
    ],
    [
      "wrong source ref",
      { source: { ...validAssistantEntry.source, ref: "another:assistant" } },
    ],
    [
      "wrong source content hash",
      {
        source: { ...validAssistantEntry.source, contentHash: "0".repeat(64) },
      },
    ],
    [
      "wrong content ref",
      {
        payload: {
          ...(validAssistantEntry.payload as object),
          contentRef: "provider:other:assistant",
        },
      },
    ],
    [
      "malformed ProviderTurnId",
      {
        payload: {
          ...(validAssistantEntry.payload as object),
          providerTurnId: "not-a-provider-turn",
        },
      },
    ],
    [
      "wrong payload ProviderTurnId",
      {
        payload: {
          ...(validAssistantEntry.payload as object),
          providerTurnId: "ptn_exe_00000000-0000-7000-8000-000000000117_1",
        },
      },
    ],
    [
      "non-string text",
      { payload: { ...(validAssistantEntry.payload as object), text: 42 } },
    ],
    [
      "non-string finish reason",
      {
        payload: {
          ...(validAssistantEntry.payload as object),
          finishReason: null,
        },
      },
    ],
    [
      "unhashed text change",
      {
        payload: {
          ...(validAssistantEntry.payload as object),
          text: "different",
        },
      },
    ],
    ["wrong entry kind", { entryKind: "Input" }],
  ] as const)("does not infer a message from %s", (_name, patch) => {
    const entry = { ...validAssistantEntry, ...patch } as SessionEntryRecord;
    const projection = projectSessionTimeline([entry]);

    expect(projection.inputItems).toEqual([]);
    expect(projection.contextRefs).toEqual([]);
  });
});
