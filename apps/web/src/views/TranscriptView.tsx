/**
 * transcript view: cursor-paginated read-only entry list. "更早" only
 * forwards `onLoadMore(nextCursor)`; no input box (chat is P14+, `02` §5).
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
          {res.entries.map((entry, index) => (
            <li
              key={`${entry.at}:${String(index)}`}
              className="arbor-transcript-row"
            >
              <EnumBadge label={entry.kind} />
              <span>{entry.summaryRef}</span>
              <TimeText at={entry.at} />
            </li>
          ))}
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
