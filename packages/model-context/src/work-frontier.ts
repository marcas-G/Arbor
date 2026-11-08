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
): ReadonlyArray<SessionEntryRecord> =>
  entries.filter((entry) => entry.causalBinding?.workId === identity.workId);
