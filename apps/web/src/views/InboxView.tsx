/**
 * inbox-view: unconsumed inbox entries (kind + summary + watermark).
 * No "mark as read" action — no such Human-actionable command exists (`02`).
 */
import type { InboxUnconsumedEntry, InboxViewRes } from "@arbor/api-contracts";
import { Empty } from "../components/Empty.js";
import { EnumBadge } from "./shared.js";

const entryKindLabel = (kind: string): string =>
  ({
    Message: "消息",
    HumanConversation: "新消息",
    Governance: "待决策",
    ControlApproval: "待授权",
    WorkAcceptance: "等待验收",
  })[kind] ?? kind;

export function InboxRows({
  rows,
}: {
  readonly rows: ReadonlyArray<InboxUnconsumedEntry>;
}) {
  return (
    <ul className="arbor-row-list">
      {rows.map((entry) => (
        <li key={entry.entryKey} className="arbor-inbox-row">
          <EnumBadge label={entryKindLabel(entry.kind)} />
          <span>{entry.summary}</span>
        </li>
      ))}
    </ul>
  );
}

export function InboxView({ res }: { readonly res: InboxViewRes }) {
  if (res.unconsumed.length === 0) {
    return <Empty>暂无待处理消息</Empty>;
  }
  return <InboxRows rows={res.unconsumed} />;
}
