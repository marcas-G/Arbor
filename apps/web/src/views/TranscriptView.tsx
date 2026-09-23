/**
 * transcript view: cursor-paginated read-only entry list rendering the frozen
 * P14 `03` union — HumanConversationTurn / AssistantConversationTurn carry
 * bounded bodies; the legacy arm keeps `kind + summaryRef + at`. "更早" only
 * forwards `onLoadMore(nextCursor)`; no input box (the composer is P14 `04`).
 */
import type { TranscriptRes } from "@arbor/api-contracts";
import { Button } from "../components/Button.js";
import { Empty } from "../components/Empty.js";
import { EnumBadge, TimeText } from "./shared.js";

export function TranscriptView({
  res,
  onLoadMore,
}: {
  readonly res: TranscriptRes;
  readonly onLoadMore?: ((cursor: string) => void) | undefined;
}) {
  const nextCursor = res.nextCursor;
  return (
    <div className="arbor-view-stack">
      {res.entries.length === 0 ? (
        <Empty>无会话记录</Empty>
      ) : (
        <ul className="arbor-row-list">
          {res.entries.map((entry, index) => {
            // The legacy arm's `kind: string` overlaps the turn literals, so
            // narrow by property presence (the frozen arms are distinguished
            // by their payload fields, not by the tag alone).
            if ("messageId" in entry) {
              return (
                <li
                  key={`human:${entry.messageId}`}
                  className="arbor-transcript-row"
                >
                  <EnumBadge label="Human" />
                  <span className="arbor-transcript-body">{entry.body}</span>
                  <TimeText at={entry.occurredAt} />
                </li>
              );
            }
            if ("executionId" in entry) {
              return (
                <li
                  key={`assistant:${entry.executionId}:${entry.occurredAt}`}
                  className="arbor-transcript-row"
                >
                  <EnumBadge label="Assistant" />
                  <span className="arbor-transcript-body">{entry.body}</span>
                  <TimeText at={entry.occurredAt} />
                </li>
              );
            }
            return (
              <li
                key={`${entry.at}:${String(index)}`}
                className="arbor-transcript-row"
              >
                <EnumBadge label={entry.kind} />
                <span>{entry.summaryRef}</span>
                <TimeText at={entry.at} />
              </li>
            );
          })}
        </ul>
      )}
      {nextCursor == null ? null : (
        <Button variant="quiet" onClick={() => onLoadMore?.(nextCursor)}>
          更早
        </Button>
      )}
    </div>
  );
}
