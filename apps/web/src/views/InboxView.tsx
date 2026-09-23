/**
 * inbox-view: unconsumed inbox entries (kind + summary + watermark).
 * No "mark as read" action — no such Human-actionable command exists (`02`).
 */
import type { InboxUnconsumedEntry, InboxViewRes } from "@arbor/api-contracts";
import { Empty } from "../components/Empty.js";
import { EnumBadge, Mono } from "./shared.js";

export function InboxRows({
  rows,
}: {
  readonly rows: ReadonlyArray<InboxUnconsumedEntry>;
}) {
  return (
    <ul className="arbor-row-list">
      {rows.map((entry) => (
        <li key={entry.entryKey} className="arbor-inbox-row">
          <EnumBadge label={entry.kind} />
          <span>{entry.summary}</span>
          <Mono>{`wm ${String(entry.watermark)}`}</Mono>
        </li>
      ))}
    </ul>
  );
}

export function InboxView({ res }: { readonly res: InboxViewRes }) {
  if (res.unconsumed.length === 0) {
    return <Empty>无未消费条目</Empty>;
  }
  return <InboxRows rows={res.unconsumed} />;
}
