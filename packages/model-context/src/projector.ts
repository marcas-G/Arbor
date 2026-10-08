import type {
  PortableInputItem,
  PortableToolResultStatus,
  SessionEntryRecord,
} from "@arbor/ports";
import type { InstructionFragment } from "./prompt.js";

/** Bounded recent Timeline window consumed by ContextProjector. The limit is
 * context policy, not an Agent Runtime assembly concern. */
export const SESSION_TIMELINE_ENTRY_LIMIT = 64;

export interface SessionTimelineProjection {
  readonly inputItems: ReadonlyArray<PortableInputItem>;
  readonly contextRefs: ReadonlyArray<string>;
  readonly callRefs: ReadonlyArray<string>;
  readonly frontier: {
    readonly firstSequence: number | null;
    readonly lastSequence: number | null;
  };
  readonly nativeCheckpoint?: {
    readonly sequence: number;
    readonly providerTurnId?: string;
    readonly fromEpoch?: number;
    readonly toEpoch?: number;
    readonly opaqueItemRef?: string;
    readonly bindingFingerprint?: string;
    readonly bindingMatches: boolean;
  };
  readonly instructionFragments: ReadonlyArray<InstructionFragment>;
}

export interface SessionFrontier {
  readonly firstSequence: number | null;
  readonly lastSequence: number | null;
}

export type SessionProjectionDecision =
  | { readonly _tag: "Ready"; readonly projection: SessionTimelineProjection }
  | {
      readonly _tag: "Blocked";
      readonly reason: "UnresolvedInvocation" | "ContradictoryTimeline";
      readonly callRefs: ReadonlyArray<string>;
      readonly closedFrontier: SessionFrontier;
    };

const isFullBindingFingerprint = (value: unknown): value is string =>
  typeof value === "string" && /^p16fp_[0-9a-f]{64}$/.test(value);

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
  bindingFingerprint?: string,
  nativeSupported = false,
): SessionTimelineProjection => {
  const inputItems: PortableInputItem[] = [];
  const contextRefs: string[] = [];
  const callRefs = new Set<string>();
  const latestCheckpoint = entries
    .filter((entry) => {
      if (typeof entry.payload !== "object" || entry.payload === null) {
        return false;
      }
      return (
        (entry.payload as Record<string, unknown>)._tag ===
        "CompactionCheckpoint"
      );
    })
    .at(-1);
  let nativeCheckpoint: SessionTimelineProjection["nativeCheckpoint"];
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
        if (entry.sequence !== latestCheckpoint?.sequence) break;
        if (payload.implementation === "ProviderNative") {
          const source = entry.source;
          const providerTurnId =
            source?.kind === "CompactionTurn" && source.ref.length > 0
              ? source.ref
              : undefined;
          const fromEpoch =
            typeof payload.fromEpoch === "number" &&
            Number.isSafeInteger(payload.fromEpoch) &&
            payload.fromEpoch >= 0
              ? payload.fromEpoch
              : undefined;
          const toEpoch =
            typeof payload.toEpoch === "number" &&
            Number.isSafeInteger(payload.toEpoch) &&
            payload.toEpoch >= 0
              ? payload.toEpoch
              : undefined;
          const opaqueItemRef =
            typeof payload.opaqueItemRef === "string" &&
            payload.opaqueItemRef.length > 0
              ? payload.opaqueItemRef
              : undefined;
          const checkpointBindingFingerprint = isFullBindingFingerprint(
            payload.bindingFingerprint,
          )
            ? payload.bindingFingerprint
            : undefined;
          const bindingMatches =
            providerTurnId !== undefined &&
            fromEpoch !== undefined &&
            toEpoch !== undefined &&
            toEpoch === fromEpoch + 1 &&
            opaqueItemRef !== undefined &&
            checkpointBindingFingerprint !== undefined &&
            nativeSupported &&
            isFullBindingFingerprint(bindingFingerprint) &&
            checkpointBindingFingerprint === bindingFingerprint;
          nativeCheckpoint = {
            sequence: entry.sequence,
            ...(providerTurnId === undefined ? {} : { providerTurnId }),
            ...(fromEpoch === undefined ? {} : { fromEpoch }),
            ...(toEpoch === undefined ? {} : { toEpoch }),
            ...(opaqueItemRef === undefined ? {} : { opaqueItemRef }),
            ...(checkpointBindingFingerprint === undefined
              ? {}
              : { bindingFingerprint: checkpointBindingFingerprint }),
            bindingMatches,
          };
          if (bindingMatches) {
            inputItems.push({
              _tag: "CompactionCheckpoint",
              implementation: "ProviderNative",
              fromEpoch: fromEpoch as never,
              toEpoch: toEpoch as never,
              retainedFrontierRef: String(payload.retainedFrontierRef ?? ""),
              opaqueItemRef: opaqueItemRef as string,
              bindingFingerprint: checkpointBindingFingerprint as string,
            });
            contextRefs.push(refOf(entry));
          }
          break;
        }
        if (
          payload.implementation !== "Summary" ||
          typeof payload.summaryText !== "string"
        ) {
          break;
        }
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
    ...(nativeCheckpoint === undefined ? {} : { nativeCheckpoint }),
    // Projected Session data is always data-only. Canonical instructions are
    // assembled by their owning source and cannot emerge from Timeline text.
    instructionFragments: [],
  };
};

const payloadOf = (
  entry: SessionEntryRecord,
): Record<string, unknown> | undefined =>
  typeof entry.payload === "object" && entry.payload !== null
    ? (entry.payload as Record<string, unknown>)
    : undefined;

const closedFrontierBefore = (
  entries: ReadonlyArray<SessionEntryRecord>,
  sequence: number,
): SessionFrontier => {
  const before = entries.filter((entry) => entry.sequence < sequence);
  return {
    firstSequence: before[0]?.sequence ?? null,
    lastSequence: before.at(-1)?.sequence ?? null,
  };
};

/** P17 Session Context Gate: only a causally closed invocation timeline may
 * become Provider input. Parallel results may complete out of order; identity
 * is the stable callRef, never adjacency or text inference. */
export const decideSessionProjection = (
  entries: ReadonlyArray<SessionEntryRecord>,
  bindingFingerprint?: string,
  nativeSupported = false,
): SessionProjectionDecision => {
  const calls = new Map<
    string,
    { readonly sequence: number; readonly toolName: string }
  >();
  const results = new Map<string, number>();
  for (const entry of entries) {
    const payload = payloadOf(entry);
    if (payload === undefined) continue;
    if (payload._tag === "ToolCall") {
      if (
        typeof payload.callRef !== "string" ||
        typeof payload.toolRef !== "string" ||
        calls.has(payload.callRef) ||
        results.has(payload.callRef)
      ) {
        const callRef = String(payload.callRef ?? "unknown");
        return {
          _tag: "Blocked",
          reason: "ContradictoryTimeline",
          callRefs: [callRef],
          closedFrontier: closedFrontierBefore(entries, entry.sequence),
        };
      }
      calls.set(payload.callRef, {
        sequence: entry.sequence,
        toolName: payload.toolRef,
      });
      continue;
    }
    if (payload._tag !== "ToolResult" && payload._tag !== "ControlResult") {
      continue;
    }
    const callRef = String(payload.callRef ?? "unknown");
    const call = calls.get(callRef);
    const resultToolName =
      payload._tag === "ToolResult"
        ? String(payload.toolName ?? "unknown")
        : String(payload.actionKind ?? "unknown");
    if (
      typeof payload.callRef !== "string" ||
      call === undefined ||
      results.has(callRef) ||
      call.toolName !== resultToolName
    ) {
      return {
        _tag: "Blocked",
        reason: "ContradictoryTimeline",
        callRefs: [callRef],
        closedFrontier: closedFrontierBefore(entries, entry.sequence),
      };
    }
    results.set(callRef, entry.sequence);
  }

  const unresolved = [...calls.entries()]
    .filter(([callRef]) => !results.has(callRef))
    .sort((left, right) => left[1].sequence - right[1].sequence);
  if (unresolved.length > 0) {
    const first = unresolved[0] as (typeof unresolved)[number];
    return {
      _tag: "Blocked",
      reason: "UnresolvedInvocation",
      callRefs: unresolved.map(([callRef]) => callRef),
      closedFrontier: closedFrontierBefore(entries, first[1].sequence),
    };
  }
  return {
    _tag: "Ready",
    projection: projectSessionTimeline(
      entries,
      bindingFingerprint,
      nativeSupported,
    ),
  };
};
