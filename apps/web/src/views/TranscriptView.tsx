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
  const visibleEntries = res.entries.filter(
    (entry) => entry.kind !== "ModelOutput",
  );
  return (
    <div className="arbor-view-stack">
      {visibleEntries.length === 0 ? (
        <Empty>无会话记录</Empty>
      ) : (
        <ul className="arbor-conversation-list">
          {visibleEntries.map((entry, index) => {
            // The legacy arm's `kind: string` overlaps the turn literals, so
            // narrow by property presence (the frozen arms are distinguished
            // by their payload fields, not by the tag alone).
            if ("messageId" in entry) {
              return (
                <li
                  key={`human:${entry.messageId}`}
                  className="arbor-conversation-turn arbor-conversation-human"
                  data-conversation-turn-key={`human:${entry.messageId}`}
                >
                  <span className="arbor-conversation-author">你</span>
                  <span className="arbor-conversation-body">{entry.body}</span>
                  <TimeText at={entry.occurredAt} />
                </li>
              );
            }
            if ("executionId" in entry) {
              return (
                <li
                  key={`assistant:${entry.executionId}:${entry.occurredAt}`}
                  className="arbor-conversation-turn arbor-conversation-assistant"
                  data-conversation-turn-key={`assistant:${entry.executionId}:${entry.occurredAt}`}
                >
                  <span className="arbor-conversation-author">Arbor</span>
                  <span className="arbor-conversation-body">{entry.body}</span>
                  <TimeText at={entry.occurredAt} />
                </li>
              );
            }
            return (
              <li
                key={`${entry.at}:${String(index)}`}
                className="arbor-conversation-turn arbor-conversation-event"
              >
                <EnumBadge label={entry.kind} />
                <span>{entry.summaryRef}</span>
                <TimeText at={entry.at} />
              </li>
            );
          })}
        </ul>
      )}
      {nextCursor == null || onLoadMore === undefined ? null : (
        <Button variant="quiet" onClick={() => onLoadMore?.(nextCursor)}>
          加载更多记录
        </Button>
      )}
    </div>
  );
}
