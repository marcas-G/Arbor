import type {
  PortableInputItem,
  PortableLegacyMessage,
  SessionEntryRecord,
} from "@arbor/ports";

export const SESSION_CONTEXT_ENTRY_LIMIT = 64;

export interface SessionContextAssembly {
  readonly messages: ReadonlyArray<PortableLegacyMessage>;
  readonly inputItems: ReadonlyArray<PortableInputItem>;
  readonly contextRefs: ReadonlyArray<string>;
}

const observationText = (payload: unknown): string | null => {
  if (typeof payload !== "object" || payload === null) return null;
  const observation = (payload as { readonly observation?: unknown })
    .observation;
  if (typeof observation !== "object" || observation === null) return null;
  const text = (observation as { readonly text?: unknown }).text;
  return typeof text === "string" && text.length > 0 ? text : null;
};

/**
 * Converts durable runtime observations into provider-neutral tool messages.
 * Observation payloads are DataOnly facts; this assembler never promotes them
 * into instructions or reconstructs authority from their text.
 */
export const assembleSessionContext = (
  entries: ReadonlyArray<SessionEntryRecord>,
): SessionContextAssembly => {
  const messages: PortableLegacyMessage[] = [];
  const inputItems: PortableInputItem[] = [];
  const contextRefs: string[] = [];
  for (const entry of entries) {
    if (
      entry.entryKind === "Input" &&
      typeof entry.payload === "object" &&
      entry.payload !== null &&
      (entry.payload as { readonly _tag?: unknown })._tag === "UserMessage"
    ) {
      const item = entry.payload as {
        readonly text?: unknown;
        readonly source?: { readonly kind?: unknown };
      };
      // P14 still supplies the exact claimed human body from HumanMessageStore;
      // its bounded Inbox summary is retained durably but not injected twice.
      if (
        typeof item.text === "string" &&
        item.source?.kind !== "HumanConversation"
      ) {
        inputItems.push({ _tag: "Message", role: "user", text: item.text });
        contextRefs.push(
          entry.source === undefined
            ? `session-input:${entry.sequence}`
            : `session-input:${entry.source.kind}:${entry.source.ref}`,
        );
      }
      continue;
    }
    if (
      entry.entryKind === "ModelOutput" &&
      typeof entry.payload === "object" &&
      entry.payload !== null &&
      (entry.payload as { readonly _tag?: unknown })._tag === "ToolCall"
    ) {
      const item = entry.payload as {
        readonly callRef: string;
        readonly toolRef: string;
        readonly argumentsJson: string;
      };
      inputItems.push({
        _tag: "ToolCall",
        callRef: item.callRef,
        toolName: item.toolRef,
        argumentsJson: item.argumentsJson,
      });
      continue;
    }
    if (
      entry.entryKind === "Observation" &&
      typeof entry.payload === "object" &&
      entry.payload !== null
    ) {
      const item = entry.payload as Record<string, unknown>;
      if (item._tag === "ToolResult") {
        inputItems.push({
          _tag: "ToolResult",
          callRef: String(item.callRef),
          toolName: String(item.toolName),
          status: item.status as "Succeeded",
          outputText: String(item.outputText),
          observationRef: String(item.observationRef),
          artifactRefs: Array.isArray(item.artifactRefs)
            ? item.artifactRefs.map(String)
            : [],
          truncated: item.truncated === true,
        });
        continue;
      }
      if (item._tag === "ControlResult") {
        inputItems.push({
          _tag: "ControlResult",
          callRef: String(item.callRef),
          actionKind: String(item.actionKind),
          status: item.status as "Succeeded",
          outputText: String(item.outputText),
          observationRef: String(item.observationRef),
          canonicalRefs: Array.isArray(item.canonicalRefs)
            ? item.canonicalRefs.map(String)
            : [],
        });
        continue;
      }
    }
    if (entry.entryKind !== "Observation") continue;
    const text = observationText(entry.payload);
    if (text === null) continue;
    messages.push({ role: "tool", text });
    contextRefs.push(
      entry.source === undefined
        ? `session-observation:${entry.sequence}`
        : `session-observation:${entry.source.kind}:${entry.source.ref}`,
    );
  }
  return { messages, inputItems, contextRefs };
};
