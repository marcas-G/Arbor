import type { InboxEntry, ProjectId, WorkspaceId } from "@arbor/domain";
import { Effect } from "effect";
import type { ProjectionReadError } from "./errors.js";
import type { InboxUnconsumedEntryView } from "./views/shared.js";

export type { InboxUnconsumedEntryView };

// --- P10 `01` §1 Inbox view (P9 `05` §3.2; SD §7.4; P10 `05` §1 cores) --
//
// P6 owns inbox semantics; P10 owns the view/query face. The store is
// command-path maintained (not event-replayed), so the per-row watermark
// renders the journal sequence the row set is current as of — the read-
// time canonical lastSequence (admission commits in the same transaction
// as the journal append). Read-only.

/** Mirrors the frozen InboxViewRes core. */
export interface InboxViewView {
  readonly unconsumed: ReadonlyArray<InboxUnconsumedEntryView>;
}

export interface InboxViewDeps {
  readonly listUnconsumedInbox: (
    workspaceId: WorkspaceId,
  ) => Effect.Effect<ReadonlyArray<InboxEntry>, ProjectionReadError>;
  readonly journalLastSequence: (
    projectId: ProjectId,
  ) => Effect.Effect<number, ProjectionReadError>;
  readonly projectIdOfWorkspace: (
    workspaceId: WorkspaceId,
  ) => Effect.Effect<ProjectId, ProjectionReadError>;
}

/** InboxViewRes derive — unconsumed rows in admission order, each
 * carrying the read-time journal watermark. */
export const deriveInboxView = (
  workspaceId: WorkspaceId,
  deps: InboxViewDeps,
): Effect.Effect<InboxViewView, ProjectionReadError> =>
  Effect.gen(function* () {
    const projectId = yield* deps.projectIdOfWorkspace(workspaceId);
    const watermark = yield* deps.journalLastSequence(projectId);
    const inbox = yield* deps.listUnconsumedInbox(workspaceId);
    return {
      unconsumed: inbox.map((entry) => ({
        entryKey: entry.entryKey,
        kind: entry.kind,
        summary: entry.summary,
        watermark,
      })),
    };
  });
