import type {
  PortableInputItem,
  PortableToolResultStatus,
  SessionEntryRecord,
} from "@arbor/ports";
import type { InstructionFragment } from "./prompt.js";

export interface SessionTimelineProjection {
  readonly inputItems: ReadonlyArray<PortableInputItem>;
  readonly contextRefs: ReadonlyArray<string>;
  readonly callRefs: ReadonlyArray<string>;
  readonly frontier: {
    readonly firstSequence: number | null;
    readonly lastSequence: number | null;
  };
  readonly instructionFragments: ReadonlyArray<InstructionFragment>;
}

const statusOf = (value: unknown): PortableToolResultStatus => {
  switch (value) {
    case "Succeeded":
    case "Failed":
    case "Denied":
    case "Interrupted":
    case "OutcomeUnknown":
      return value;
    default:
      return "Failed";
  }
};

const refOf = (entry: SessionEntryRecord): string =>
  entry.source === undefined
    ? `session:${entry.sequence}`
    : `session:${entry.source.kind}:${entry.source.ref}`;

export const projectSessionTimeline = (
  entries: ReadonlyArray<SessionEntryRecord>,
): SessionTimelineProjection => {
  const inputItems: PortableInputItem[] = [];
  const contextRefs: string[] = [];
  const callRefs = new Set<string>();
  for (const entry of entries) {
    if (typeof entry.payload !== "object" || entry.payload === null) continue;
    const payload = entry.payload as Record<string, unknown>;
    switch (payload._tag) {
      case "UserMessage": {
        const source = payload.source as Record<string, unknown> | undefined;
        if (source?.kind === "HumanConversation") break;
        if (typeof payload.text !== "string") break;
        inputItems.push({ _tag: "Message", role: "user", text: payload.text });
        contextRefs.push(refOf(entry));
        break;
      }
      case "ToolCall":
        if (
          typeof payload.callRef !== "string" ||
          typeof payload.toolRef !== "string" ||
          typeof payload.argumentsJson !== "string"
        ) {
          break;
        }
        inputItems.push({
          _tag: "ToolCall",
          callRef: payload.callRef,
          toolName: payload.toolRef,
          argumentsJson: payload.argumentsJson,
        });
        callRefs.add(payload.callRef);
        contextRefs.push(refOf(entry));
        break;
      case "ToolResult":
        if (typeof payload.callRef !== "string") break;
        inputItems.push({
          _tag: "ToolResult",
          callRef: payload.callRef,
          toolName: String(payload.toolName ?? "unknown"),
          status: statusOf(payload.status),
          outputText: String(payload.outputText ?? ""),
          observationRef: String(payload.observationRef ?? refOf(entry)),
          artifactRefs: Array.isArray(payload.artifactRefs)
            ? payload.artifactRefs.map(String)
            : [],
          truncated: payload.truncated === true,
        });
        callRefs.add(payload.callRef);
        contextRefs.push(refOf(entry));
        break;
      case "ControlResult":
        if (typeof payload.callRef !== "string") break;
        inputItems.push({
          _tag: "ControlResult",
          callRef: payload.callRef,
          actionKind: String(payload.actionKind ?? "unknown"),
          status: statusOf(payload.status),
          outputText: String(payload.outputText ?? ""),
          observationRef: String(payload.observationRef ?? refOf(entry)),
          canonicalRefs: Array.isArray(payload.canonicalRefs)
            ? payload.canonicalRefs.map(String)
            : [],
        });
        callRefs.add(payload.callRef);
        contextRefs.push(refOf(entry));
        break;
      case "ContextUpdate":
        inputItems.push({
          _tag: "ContextUpdate",
          sourceRef: String(payload.sourceRef ?? refOf(entry)),
          revision: Number(payload.revision ?? 0),
          updateKind:
            payload.updateKind === "Replace" || payload.updateKind === "Revoke"
              ? payload.updateKind
              : "Full",
          text: String(payload.text ?? ""),
        });
        contextRefs.push(refOf(entry));
        break;
      case "CompactionCheckpoint":
        if (typeof payload.summaryText !== "string") break;
        inputItems.push({
          _tag: "Message",
          role: "system",
          text: `[Continuation checkpoint]\n${payload.summaryText}`,
        });
        contextRefs.push(refOf(entry));
        break;
      default: {
        if (entry.entryKind !== "Observation") break;
        const observation = payload.observation as
          | Record<string, unknown>
          | undefined;
        if (typeof observation?.text !== "string") break;
        inputItems.push({
          _tag: "Message",
          role: "tool",
          text: observation.text,
        });
        contextRefs.push(refOf(entry));
      }
    }
  }
  return {
    inputItems,
    contextRefs,
    callRefs: [...callRefs],
    frontier: {
      firstSequence: entries[0]?.sequence ?? null,
      lastSequence: entries.at(-1)?.sequence ?? null,
    },
    // Projected Session data is always data-only. Canonical instructions are
    // assembled by their owning source and cannot emerge from Timeline text.
    instructionFragments: [],
  };
};
