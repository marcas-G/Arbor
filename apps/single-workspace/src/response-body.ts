import { Effect } from "effect";
import type { SqlClient } from "effect/unstable/sql/SqlClient";

/**
 * P14 `02` §4 / `03` — the bounded assistant-response aggregator. At settle
 * time the sweep persists a bounded digest of the coordination execution's
 * ModelOutput session entries (the user-visible response episode). This keeps
 * the transcript read model a single-table read (human_messages) with no
 * read-time window joins.
 */
export const RESPONSE_BODY_LIMIT = 4000;

interface ModelOutputRow {
  readonly payload_json: string;
  readonly entry_kind: string;
}

/** Bounded, whitespace-normalised aggregation of ModelOutput entries logged
 * for the message's claimed execution. Never throws — a missing execution or
 * absent entries yield null (the transcript then shows the turn without a
 * body). */
export const makeResponseBodyOf =
  (sql: SqlClient) =>
  (messageId: string): Effect.Effect<string | null, never, never> =>
    Effect.gen(function* () {
      const rows = yield* sql
        .unsafe<ModelOutputRow>(
          `SELECT se.payload_json AS payload_json, se.entry_kind AS entry_kind
             FROM human_messages hm
             JOIN executions e ON e.execution_id = hm.claimed_by_execution_id
             JOIN session_entries se ON se.session_id = e.session_id
            WHERE hm.message_id = ?
              AND se.entry_kind = 'ModelOutput'
              AND (e.admitted_at IS NULL OR se.created_at >= e.admitted_at)
            ORDER BY se.created_at ASC, se.sequence ASC`,
          [messageId],
        )
        .pipe(Effect.orElseSucceed(() => [] as ReadonlyArray<ModelOutputRow>));
      if (rows.length === 0) {
        return null;
      }
      // The conversation answer is the FINAL ModelOutput of the execution
      // (each turn re-states the assistant reply; joining all turns would
      // duplicate it). Scan newest-first and take the last non-empty text.
      for (let index = rows.length - 1; index >= 0; index -= 1) {
        const text = extractText(rows[index]?.payload_json ?? "");
        if (text !== null && text.trim().length > 0) {
          const normalized = text.replace(/\s+/g, " ").trim();
          return normalized.length <= RESPONSE_BODY_LIMIT
            ? normalized
            : `${normalized.slice(0, RESPONSE_BODY_LIMIT - 1)}…`;
        }
      }
      return null;
    });

const extractText = (payloadJson: string): string | null => {
  try {
    const parsed: unknown = JSON.parse(payloadJson);
    if (typeof parsed === "string") {
      return parsed;
    }
    if (typeof parsed === "object" && parsed !== null) {
      const record = parsed as Record<string, unknown>;
      for (const key of ["text", "content", "body", "message", "summary"]) {
        const value = record[key];
        if (typeof value === "string" && value.length > 0) {
          return value;
        }
      }
      return null;
    }
    return null;
  } catch {
    return null;
  }
};
