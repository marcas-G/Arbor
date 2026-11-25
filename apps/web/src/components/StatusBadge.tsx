import { statusTone } from "../tokens.js";
import { Badge } from "./Badge.js";

const STATUS_LABELS: Readonly<Record<string, string>> = {
  executing: "执行中",
  "waiting-runnable": "等待执行",
  "waiting-blocked": "等待条件",
  idle: "空闲",
  retired: "已归档",
  "attention-flagged": "需要关注",
};

/** W-01 StatusBadge: status label rendered verbatim, tone resolved through
 * the frozen statusTone map (unmapped → muted). */
export function StatusBadge({ label }: { readonly label: string }) {
  const presented = STATUS_LABELS[label] ?? label;
  return (
    <span className={"inline-flex items-center"}>
      <Badge tone={statusTone(label)}>{presented}</Badge>
    </span>
  );
}
