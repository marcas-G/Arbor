import type { ExecutionId, WorkId } from "@arbor/domain";
import type { SessionEntryRecord } from "@arbor/ports";

export interface WorkFrontierIdentity {
  readonly executionId: ExecutionId;
  readonly workId: WorkId;
}

/** Keep only explicitly bound entries for this durable Work across its
 * successive Execution episodes; historical/unbound rows fail closed. */
export const filterEntriesForWork = (
  entries: ReadonlyArray<
    SessionEntryRecord & {
      readonly causalBinding?: {
        readonly executionId: ExecutionId;
        readonly workId: WorkId | null;
      };
    }
  >,
  identity: WorkFrontierIdentity,
): ReadonlyArray<SessionEntryRecord> => {
  const owned = entries.filter(
    (entry) => entry.causalBinding?.workId === identity.workId,
  );
  const callRefs = new Set(
    owned.flatMap((entry) => {
      const payload = entry.payload;
      return typeof payload === "object" &&
        payload !== null &&
        (payload as { readonly _tag?: unknown })._tag === "ToolCall" &&
        typeof (payload as { readonly callRef?: unknown }).callRef === "string"
        ? [(payload as { readonly callRef: string }).callRef]
        : [];
    }),
  );
  // The pre-checkpoint repository window is deliberately selected before
  // ownership filtering. A result can therefore survive the window while
  // its older call is outside it. Drop only that synthetic orphan here;
  // genuine result-before-call corruption remains the projector's concern.
  return owned.filter((entry) => {
    const payload = entry.payload;
    if (
      entry.entryKind !== "Observation" ||
      entry.source?.kind !== "AgentLoopAction" ||
      typeof payload !== "object" ||
      payload === null ||
      !["ToolResult", "ControlResult"].includes(
        (payload as { readonly _tag?: unknown })._tag as string,
      )
    )
      return true;
    const callRef = (payload as { readonly callRef?: unknown }).callRef;
    return typeof callRef !== "string" || callRefs.has(callRef);
  });
};
