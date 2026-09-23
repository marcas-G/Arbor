import type { ProjectId, WorkspaceId } from "@arbor/domain";
import type { SessionEntryKind, SessionId } from "@arbor/ports";
import { Effect } from "effect";
import type { ProjectionReadError } from "./errors.js";
import { projectionReadError } from "./errors.js";

// --- P10 `01` §1 Transcript (SD §12.4 note, §10.2; P10 `05` §1 cores) ----
//
// On-demand DEBUG view, human-readable projection, NOT TRUTH — never
// feeds cognition (SD §12.4 note). Production read path over
// session_entries (SessionRepository.listEntries — the minimal read-only
// port face declared by this task). Cursor paging is deterministic and
// replay-stable: the cursor encodes the exact (sessionId, sequence)
// position in the total order (sessionId asc, sequence asc); both keys
// are immutable and append-only, so replay of the same page request
// yields the same page.

/** P14 `03` §1 — the frozen conversation-turn arms (DID v1.16 G-C). The
 * third arm keeps the pre-P14 session-entry stream verbatim, so unknown
 * kinds always pass through (presentation rule: verbatim + muted). */
export type ConversationTurnView =
  | {
      readonly kind: "HumanConversationTurn";
      readonly messageId: string;
      readonly body: string;
      readonly occurredAt: string;
    }
  | {
      readonly kind: "AssistantConversationTurn";
      readonly executionId: string;
      readonly body: string;
      readonly occurredAt: string;
    };

/** Mirrors the frozen TranscriptEntry core (P10 `05` §1) extended by P14 `03`:
 * conversation turns + the legacy session-entry arm. */
export type TranscriptEntryView =
  | ConversationTurnView
  | {
      readonly kind: string;
      readonly summaryRef: string;
      readonly at: string;
    };

/** Mirrors the frozen TranscriptRes core. */
export interface TranscriptPageView {
  readonly entries: ReadonlyArray<TranscriptEntryView>;
  readonly nextCursor?: string | undefined;
}

export interface TranscriptEntryRecord {
  readonly sessionId: SessionId;
  readonly sequence: number;
  readonly entryKind: SessionEntryKind;
  readonly payload: unknown;
  readonly createdAt: string;
}

export interface TranscriptRequest {
  readonly workspaceId: WorkspaceId;
  readonly sessionId?: SessionId | undefined;
  readonly cursor?: string | undefined;
  readonly limit: number;
}

export interface TranscriptDeps {
  readonly listSessionsByWorkspace: (
    workspaceId: WorkspaceId,
  ) => Effect.Effect<ReadonlyArray<SessionId>, ProjectionReadError>;
  readonly listEntries: (
    sessionId: SessionId,
    afterSequence: number,
    limit: number,
  ) => Effect.Effect<ReadonlyArray<TranscriptEntryRecord>, ProjectionReadError>;
  readonly journalLastSequence: (
    projectId: ProjectId,
  ) => Effect.Effect<number, ProjectionReadError>;
  /** P14 `03`: the workspace's conversation turns (Human/Assistant), newest
   * last. Read from the human-message store; absent = no turn merging. */
  readonly conversationTurns?:
    | ((
        workspaceId: WorkspaceId,
      ) => Effect.Effect<
        ReadonlyArray<ConversationTurnView>,
        ProjectionReadError
      >)
    | undefined;
}

interface CursorPosition {
  readonly sessionId: SessionId;
  readonly sequence: number;
}

const encodeCursor = (position: CursorPosition): string =>
  encodeURIComponent(
    JSON.stringify({ s: position.sessionId, q: position.sequence }),
  );

const decodeCursor = (cursor: string): CursorPosition | null => {
  try {
    const parsed = JSON.parse(decodeURIComponent(cursor)) as {
      s?: unknown;
      q?: unknown;
    };
    if (typeof parsed.s !== "string" || typeof parsed.q !== "number") {
      return null;
    }
    return { sessionId: parsed.s as SessionId, sequence: parsed.q };
  } catch {
    return null;
  }
};

const payloadRef = (payload: unknown): string | null => {
  if (typeof payload !== "object" || payload === null) {
    return null;
  }
  const ref = (payload as Record<string, unknown>).ref;
  return typeof ref === "string" ? ref : null;
};

/** One deterministic page. The summaryRef is a stable self-reference
 * (`session-entry:{sessionId}:{sequence}`), falling back to the payload
 * `ref` when the entry carries one — rendering detail stays P12. */
export const deriveTranscriptPage = (
  request: TranscriptRequest,
  deps: TranscriptDeps,
): Effect.Effect<TranscriptPageView, ProjectionReadError> =>
  Effect.gen(function* () {
    if (request.limit <= 0) {
      return yield* Effect.fail(
        projectionReadError("transcript limit must be positive"),
      );
    }
    const cursor =
      request.cursor === undefined ? null : decodeCursor(request.cursor);
    if (request.cursor !== undefined && cursor === null) {
      return yield* Effect.fail(
        projectionReadError(`malformed transcript cursor ${request.cursor}`),
      );
    }

    const sessions =
      request.sessionId !== undefined
        ? [request.sessionId]
        : [
            ...(yield* deps.listSessionsByWorkspace(request.workspaceId)),
          ].sort();
    if (request.sessionId === undefined && sessions.length === 0) {
      return { entries: [] };
    }

    const entries: Array<TranscriptEntryView> = [];
    let lastPosition: CursorPosition | undefined;
    let hasMore = false;

    // P14 `03`: the first page carries the conversation turns (time-ordered)
    // ahead of the legacy session-entry stream; cursor pages stay
    // session-entry based (v1 pagination shape).
    if (cursor === null && deps.conversationTurns !== undefined) {
      const turns = yield* deps.conversationTurns(request.workspaceId);
      for (const turn of turns) {
        if (entries.length >= request.limit) {
          hasMore = true;
          break;
        }
        entries.push(turn);
      }
    }

    outer: for (const sessionId of sessions) {
      // Sessions ordered before the cursor session are entirely before
      // the cursor position in the total order — skip them.
      if (cursor !== null && sessionId < cursor.sessionId) {
        continue;
      }
      // Session entry sequences are 0-based; the page position is
      // exclusive (entries strictly after (sessionId, sequence)). With
      // no cursor the page starts at the very first entry (-1).
      const afterSequence =
        cursor !== null && sessionId === cursor.sessionId
          ? cursor.sequence
          : -1;
      // One extra row beyond the page budget detects whether a next
      // cursor exists without a separate count query.
      const budget = request.limit - entries.length + 1;
      const page = yield* deps.listEntries(sessionId, afterSequence, budget);
      for (const record of page) {
        if (entries.length === request.limit) {
          hasMore = true;
          break outer;
        }
        entries.push({
          kind: record.entryKind,
          summaryRef:
            payloadRef(record.payload) ??
            `session-entry:${record.sessionId}:${record.sequence}`,
          at: record.createdAt,
        });
        lastPosition = {
          sessionId: record.sessionId,
          sequence: record.sequence,
        };
      }
    }

    return {
      entries,
      ...(hasMore && lastPosition !== undefined
        ? { nextCursor: encodeCursor(lastPosition) }
        : {}),
    };
  });
