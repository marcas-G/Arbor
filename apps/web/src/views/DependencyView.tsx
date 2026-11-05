/**
 * dependency-view: dependency row table, shared with workspace-detail.
 * Read-only — no in-row mutation actions (v1 has no dependency-class
 * Human-actionable command, `02` §4).
 */
import type { DependencyRes, DependencyRow } from "@arbor/api-contracts";
import { Badge } from "../components/Badge.js";
import { Empty } from "../components/Empty.js";

export function formatBinding(binding: DependencyRow["binding"]): string {
  switch (binding._tag) {
    case "AnyProducer":
      return "任意工作";
    case "WorkspaceBound":
      return "指定分工";
    case "WorkBound":
      return "指定工作";
    default:
      return JSON.stringify(binding) ?? "unknown-binding";
  }
}

function dependencyState(state: DependencyRow["state"]): {
  readonly label: string;
  readonly tone: "leaf" | "attention" | "danger" | "muted";
} {
  switch (state) {
    case "Satisfied":
      return { label: "已满足", tone: "leaf" };
    case "Unsatisfied":
      return { label: "等待中", tone: "attention" };
    case "Withdrawn":
      return { label: "已撤回", tone: "muted" };
    case "Unfulfillable":
      return { label: "无法满足", tone: "danger" };
    default:
      return { label: state, tone: "muted" };
  }
}

export function DependencyTable({
  rows,
}: {
  readonly rows: ReadonlyArray<DependencyRow>;
}) {
  return (
    <table className="arbor-table">
      <thead>
        <tr>
          <th scope="col">事项</th>
          <th scope="col">等待对象</th>
          <th scope="col">状态</th>
          <th scope="col">进展</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row, index) => {
          const state = dependencyState(row.state);
          return (
            <tr key={row.dependencyId}>
              <td>{`依赖 ${String(index + 1)}`}</td>
              <td>{formatBinding(row.binding)}</td>
              <td>
                <Badge tone={state.tone}>{state.label}</Badge>
              </td>
              <td>{row.satisfiedBy == null ? "—" : "已收到结果"}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

export function DependencyView({ res }: { readonly res: DependencyRes }) {
  if (res.rows.length === 0) {
    return <Empty>无依赖</Empty>;
  }
  return <DependencyTable rows={res.rows} />;
}
