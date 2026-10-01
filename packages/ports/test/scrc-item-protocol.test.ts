import {
  type PortableInputItem,
  type PortableModelRequestV2,
  validatePortableRequestCompatibility,
  validatePortableToolPairing,
} from "@arbor/ports";
import { describe, expect, it } from "vitest";

const message = (text: string): PortableInputItem => ({
  _tag: "Message",
  role: "user",
  text,
});

describe("SCRC typed item protocol", () => {
  it("preserves provider-neutral message and callRef-paired tool items", () => {
    const items: ReadonlyArray<PortableInputItem> = [
      message("inspect both files"),
      {
        _tag: "ToolCall",
        callRef: "call-a",
        toolName: "read",
        argumentsJson: '{"path":"a.ts"}',
      },
      {
        _tag: "ToolCall",
        callRef: "call-b",
        toolName: "read",
        argumentsJson: '{"path":"b.ts"}',
      },
      {
        _tag: "ToolResult",
        callRef: "call-b",
        toolName: "read",
        status: "Succeeded",
        outputText: "b",
        observationRef: "obs-b",
        artifactRefs: [],
        truncated: false,
      },
      {
        _tag: "ToolResult",
        callRef: "call-a",
        toolName: "read",
        status: "Succeeded",
        outputText: "a",
        observationRef: "obs-a",
        artifactRefs: [],
        truncated: false,
      },
    ];

    expect(validatePortableToolPairing(items)).toEqual({ ok: true });
  });

  it("rejects a tool result whose callRef has no originating call", () => {
    const items: ReadonlyArray<PortableInputItem> = [
      {
        _tag: "ToolResult",
        callRef: "missing",
        toolName: "read",
        status: "Interrupted",
        outputText: "execution interrupted",
        observationRef: "obs-missing",
        artifactRefs: [],
        truncated: false,
      },
    ];

    expect(validatePortableToolPairing(items)).toEqual({
      ok: false,
      error: {
        _tag: "PortableToolPairingError",
        kind: "MissingToolCall",
        callRef: "missing",
      },
    });
  });

  it("returns typed incompatibility instead of silently textifying an unsupported item", () => {
    const request: PortableModelRequestV2 = {
      requestVersion: 2,
      operationKind: "Inference",
      modelRef: "model-a",
      instructions: [],
      inputItems: [
        message("inspect"),
        {
          _tag: "AttachmentRef",
          ref: "artifact://diagram",
          mediaType: "image/png",
          trust: "DataOnly",
        },
      ],
      toolDefinitions: [],
      outputContractRef: "tool-invocation-v1",
      budget: { maxOutputTokens: 100 },
      cacheHints: [],
    };

    expect(
      validatePortableRequestCompatibility(request, {
        operationKinds: ["Inference"],
        inputItemKinds: ["Message", "ToolCall", "ToolResult"],
      }),
    ).toEqual({
      ok: false,
      error: {
        _tag: "PortableRequestIncompatible",
        operationKind: "Inference",
        unsupportedOperation: false,
        unsupportedInputItemKinds: ["AttachmentRef"],
      },
    });
  });
});
