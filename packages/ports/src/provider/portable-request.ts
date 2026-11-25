import type { ContextEpochNumber, ProviderTurnId } from "@arbor/domain";

export interface PortableInstruction {
  readonly slotId: string;
  readonly authorityRole: string;
  readonly text: string;
}

export interface PortableMessage {
  readonly _tag: "Message";
  readonly role: "system" | "user" | "assistant" | "tool";
  readonly text: string;
}

/** Pre-SCRC request compatibility. New compilers must emit the tagged Message
 * variant; persisted v1 requests remain readable and are normalized at the
 * provider boundary. */
export interface PortableLegacyMessage {
  readonly role: "system" | "user" | "assistant" | "tool";
  readonly text: string;
}

export interface PortableToolCall {
  readonly _tag: "ToolCall";
  readonly callRef: string;
  readonly toolName: string;
  readonly argumentsJson: string;
}

export type PortableToolResultStatus =
  | "Succeeded"
  | "Failed"
  | "Denied"
  | "Interrupted"
  | "OutcomeUnknown";

export interface PortableToolResult {
  readonly _tag: "ToolResult";
  readonly callRef: string;
  readonly toolName: string;
  readonly status: PortableToolResultStatus;
  readonly outputText: string;
  readonly observationRef: string;
  readonly artifactRefs: ReadonlyArray<string>;
  readonly truncated: boolean;
}

export interface PortableControlResult {
  readonly _tag: "ControlResult";
  readonly callRef: string;
  readonly actionKind: string;
  readonly status: PortableToolResultStatus;
  readonly outputText: string;
  readonly observationRef: string;
  readonly canonicalRefs: ReadonlyArray<string>;
}

export interface PortableContextUpdate {
  readonly _tag: "ContextUpdate";
  readonly sourceRef: string;
  readonly revision: number;
  readonly updateKind: "Full" | "Replace" | "Revoke";
  readonly text: string;
}

export interface PortableCompactionCheckpoint {
  readonly _tag: "CompactionCheckpoint";
  readonly implementation: "Summary" | "ProviderNative";
  readonly fromEpoch: ContextEpochNumber;
  readonly toEpoch: ContextEpochNumber;
  readonly retainedFrontierRef: string;
  readonly summaryText?: string;
  readonly opaqueItemRef?: string;
  readonly bindingFingerprint?: string;
}

export interface PortableAttachmentRef {
  readonly _tag: "AttachmentRef";
  readonly ref: string;
  readonly mediaType: string;
  readonly filename?: string;
  readonly trust: "CanonicalInstruction" | "InstructionCandidate" | "DataOnly";
}

/**
 * Provider-native reasoning attached to one historical assistant turn.
 *
 * Model Context is the only layer allowed to select this item for a request.
 * The payload is opaque: portable consumers may bind and forward it, but must
 * never parse or rewrite it. Protocol adapters own the final wire field.
 */
export interface PortableReasoningAttachment {
  readonly _tag: "ReasoningAttachment";
  readonly providerTurnId: ProviderTurnId;
  readonly modelRef: string;
  readonly protocolFamily: string;
  readonly bindingFingerprint: string;
  readonly opaquePayload: string;
}

export type PortableInputItem =
  | PortableMessage
  | PortableToolCall
  | PortableToolResult
  | PortableControlResult
  | PortableContextUpdate
  | PortableCompactionCheckpoint
  | PortableAttachmentRef
  | PortableReasoningAttachment;

export type PortableInputItemKind = PortableInputItem["_tag"];
export type PortableOperationKind =
  | "Inference"
  | "CompactionSummary"
  | "CompactionNative";

export interface PortableToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly schemaJson: string;
}

export interface CacheHint {
  readonly cacheClass: "Stable" | "SemiStable" | "TurnDynamic";
}

interface PortableModelRequestShared {
  readonly modelRef: string;
  readonly instructions: ReadonlyArray<PortableInstruction>;
  readonly toolDefinitions: ReadonlyArray<PortableToolDefinition>;
  readonly outputContractRef: string;
  readonly budget: { readonly maxOutputTokens: number };
  readonly cacheHints: ReadonlyArray<CacheHint>;
}

/** Persisted/request compatibility for pre-SCRC turns. Never emitted by the
 * v2 Model Context compiler after SCRC-001. */
export interface PortableModelRequestV1 extends PortableModelRequestShared {
  readonly requestVersion?: 1;
  readonly messages: ReadonlyArray<PortableLegacyMessage>;
}

export interface PortableModelRequestV2 extends PortableModelRequestShared {
  readonly requestVersion: 2;
  readonly operationKind: PortableOperationKind;
  readonly inputItems: ReadonlyArray<PortableInputItem>;
}

export type PortableModelRequest =
  | PortableModelRequestV1
  | PortableModelRequestV2;

export const isPortableModelRequestV2 = (
  request: PortableModelRequest,
): request is PortableModelRequestV2 => request.requestVersion === 2;

export const portableRequestOperationKind = (
  request: PortableModelRequest,
): PortableOperationKind =>
  isPortableModelRequestV2(request) ? request.operationKind : "Inference";

export const portableInputItems = (
  request: PortableModelRequest,
): ReadonlyArray<PortableInputItem> =>
  isPortableModelRequestV2(request)
    ? request.inputItems
    : request.messages.map((message) => ({
        _tag: "Message" as const,
        role: message.role,
        text: message.text,
      }));

export interface PortableRequestCompatibility {
  readonly operationKinds: ReadonlyArray<PortableOperationKind>;
  readonly inputItemKinds: ReadonlyArray<PortableInputItemKind>;
}

export interface PortableRequestIncompatible {
  readonly _tag: "PortableRequestIncompatible";
  readonly operationKind: PortableOperationKind;
  readonly unsupportedOperation: boolean;
  readonly unsupportedInputItemKinds: ReadonlyArray<PortableInputItemKind>;
}

export type PortableRequestCompatibilityResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly error: PortableRequestIncompatible };

export const validatePortableRequestCompatibility = (
  request: PortableModelRequest,
  compatibility: PortableRequestCompatibility,
): PortableRequestCompatibilityResult => {
  const operationKind = portableRequestOperationKind(request);
  const unsupportedInputItemKinds = [
    ...new Set(
      portableInputItems(request)
        .map((item) => item._tag)
        .filter((kind) => !compatibility.inputItemKinds.includes(kind)),
    ),
  ];
  const unsupportedOperation =
    !compatibility.operationKinds.includes(operationKind);
  return unsupportedOperation || unsupportedInputItemKinds.length > 0
    ? {
        ok: false,
        error: {
          _tag: "PortableRequestIncompatible",
          operationKind,
          unsupportedOperation,
          unsupportedInputItemKinds,
        },
      }
    : { ok: true };
};

export interface PortableToolPairingError {
  readonly _tag: "PortableToolPairingError";
  readonly kind:
    | "DuplicateToolCall"
    | "MissingToolCall"
    | "DuplicateToolResult"
    | "DanglingToolCall";
  readonly callRef: string;
}

export type PortableToolPairingValidation =
  | { readonly ok: true }
  | { readonly ok: false; readonly error: PortableToolPairingError };

export const validatePortableToolPairing = (
  items: ReadonlyArray<PortableInputItem>,
): PortableToolPairingValidation => {
  const calls = new Set<string>();
  const results = new Set<string>();
  for (const item of items) {
    if (item._tag === "ToolCall") {
      if (calls.has(item.callRef)) {
        return {
          ok: false,
          error: {
            _tag: "PortableToolPairingError",
            kind: "DuplicateToolCall",
            callRef: item.callRef,
          },
        };
      }
      calls.add(item.callRef);
      continue;
    }
    if (item._tag !== "ToolResult" && item._tag !== "ControlResult") continue;
    if (!calls.has(item.callRef)) {
      return {
        ok: false,
        error: {
          _tag: "PortableToolPairingError",
          kind: "MissingToolCall",
          callRef: item.callRef,
        },
      };
    }
    if (results.has(item.callRef)) {
      return {
        ok: false,
        error: {
          _tag: "PortableToolPairingError",
          kind: "DuplicateToolResult",
          callRef: item.callRef,
        },
      };
    }
    results.add(item.callRef);
  }
  for (const callRef of calls) {
    if (!results.has(callRef)) {
      return {
        ok: false,
        error: {
          _tag: "PortableToolPairingError",
          kind: "DanglingToolCall",
          callRef,
        },
      };
    }
  }
  return { ok: true };
};
