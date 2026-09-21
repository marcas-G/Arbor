import type { InboxEntry, WorkspaceId } from "@arbor/domain";
import type {
  InboxProjectionStoreError,
  InboxProjectionStoreService,
  TransactionScope,
} from "@arbor/ports";
import { Effect } from "effect";

export interface ConsumeInboxEntryArgs {
  readonly workspaceId: WorkspaceId;
  readonly entryKey: string;
  /** Session-side cognitive timestamp. Consumption is NOT a canonical
   * mutation (SD §7.4), so no store call consumes it; the physical
   * consumed_at stamp is owned by the Inbox projection adapter. */
  readonly now: string;
}

export interface InboxConsumptionResult {
  /** The consumed entry (for the Context Builder's cognitive consumption);
   * null when the entry was not in the unconsumed set — idempotent replay,
   * never an error. */
  readonly consumed: InboxEntry | null;
}

export interface InboxConsumptionDependencies {
  readonly inbox: Pick<
    InboxProjectionStoreService,
    "listUnconsumed" | "markConsumed"
  >;
}

/** P6 `02` §4 / SD §7.4: Inbox != Next Context. Consumption is the Agent
 * (Session) cognitive event — the Context Builder selectively consumes
 * input relevant to Current Work — and marking an entry consumed is NOT a
 * canonical mutation: it only advances the Inbox projection of unconsumed
 * input. Finding the key in the unconsumed list before marking makes
 * repeated consumption of the same entry a null no-op (idempotent). */
export const consumeInboxEntry = (
  args: ConsumeInboxEntryArgs,
  deps: InboxConsumptionDependencies,
): Effect.Effect<
  InboxConsumptionResult,
  InboxProjectionStoreError,
  TransactionScope
> =>
  Effect.gen(function* () {
    const unconsumed = yield* deps.inbox.listUnconsumed(args.workspaceId);
    const entry = unconsumed.find(
      (candidate) => candidate.entryKey === args.entryKey,
    );
    if (entry === undefined) {
      return { consumed: null };
    }
    yield* deps.inbox.markConsumed(args.workspaceId, args.entryKey);
    return { consumed: entry };
  });
