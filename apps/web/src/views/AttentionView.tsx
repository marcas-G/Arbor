/**
 * attention view: rows grouped by severity, ActionRequired group first
 * (`03` §2). Unknown severity/source values render verbatim (muted via
 * statusTone miss). Row target link only forwards `onOpenWorkspace`.
 */
import type {
  AttentionRes,
  AttentionRow,
  AttentionSeverity,
} from "@arbor/api-contracts";
import { Button } from "../components/Button.js";
import { Empty } from "../components/Empty.js";
import { EnumBadge, TimeText } from "./shared.js";

const SEVERITY_ORDER: ReadonlyArray<AttentionSeverity> = [
  "ActionRequired",
  "Attention",
];

function groupRows(
  rows: ReadonlyArray<AttentionRow>,
): ReadonlyArray<[string, ReadonlyArray<AttentionRow>]> {
  const groups = new Map<string, AttentionRow[]>();
  for (const row of rows) {
    const bucket = groups.get(row.severity);
    if (bucket === undefined) {
      groups.set(row.severity, [row]);
    } else {
      bucket.push(row);
    }
  }
  const known = SEVERITY_ORDER.filter((severity) => groups.has(severity));
  const unknown = [...groups.keys()].filter(
    (severity) => !SEVERITY_ORDER.includes(severity as AttentionSeverity),
  );
  const order = [...known, ...unknown];
  return order.map(
    (severity) => [severity, groups.get(severity) ?? []] as const,
  );
}

function AttentionGroupRows({
  rows,
  onOpenWorkspace,
}: {
  readonly rows: ReadonlyArray<AttentionRow>;
  readonly onOpenWorkspace?:
    | ((workspaceId: AttentionRow["targetWorkspaceId"]) => void)
    | undefined;
}) {
  return (
    <ul className="arbor-row-list">
      {rows.map((row) => (
        <li
          key={`${row.source}:${row.dedupKey}`}
          className="arbor-attention-row"
        >
          <EnumBadge label={row.source} />
          <span>{row.summaryRef}</span>
          <TimeText at={row.occurredAt} />
          <Button
            variant="quiet"
            onClick={() => onOpenWorkspace?.(row.targetWorkspaceId)}
          >
            <span className="arbor-mono">{row.targetWorkspaceId}</span>
          </Button>
        </li>
      ))}
    </ul>
  );
}

export function AttentionView({
  res,
  onOpenWorkspace,
}: {
  readonly res: AttentionRes;
  readonly onOpenWorkspace?:
    | ((workspaceId: AttentionRow["targetWorkspaceId"]) => void)
    | undefined;
}) {
  if (res.rows.length === 0) {
    return <Empty>无注意力事实</Empty>;
  }
  const groups = groupRows(res.rows);
  return (
    <div className="arbor-view-stack">
      {groups.map(([severity, rows]) => (
        <section key={severity} className="arbor-attention-group">
          <h3 className="arbor-attention-group-title">
            <EnumBadge label={severity} />
            <span>{`${String(rows.length)} 条`}</span>
          </h3>
          <AttentionGroupRows rows={rows} onOpenWorkspace={onOpenWorkspace} />
        </section>
      ))}
    </div>
  );
}
