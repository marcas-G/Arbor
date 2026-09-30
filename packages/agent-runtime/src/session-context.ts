import type { PortableMessage, SessionEntryRecord } from "@arbor/ports";

export const SESSION_CONTEXT_ENTRY_LIMIT = 64;

export interface SessionContextAssembly {
  readonly messages: ReadonlyArray<PortableMessage>;
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
  const messages: PortableMessage[] = [];
  const contextRefs: string[] = [];
  for (const entry of entries) {
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
  return { messages, contextRefs };
};
