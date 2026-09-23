/**
 * dependency-view: dependency row table, shared with workspace-detail.
 * Read-only — no in-row mutation actions (v1 has no dependency-class
 * Human-actionable command, `02` §4).
 */
import type { DependencyRes, DependencyRow } from "@arbor/api-contracts";
import { Empty } from "../components/Empty.js";
import { EnumBadge, Mono } from "./shared.js";

export function formatBinding(binding: DependencyRow["binding"]): string {
  switch (binding._tag) {
    case "AnyProducer":
      return "AnyProducer";
    case "WorkspaceBound":
      return `WorkspaceBound ${binding.workspaceId}`;
    case "WorkBound":
      return `WorkBound ${binding.workId}`;
    default:
      return JSON.stringify(binding) ?? "unknown-binding";
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
          <th scope="col">dependencyId</th>
          <th scope="col">consumerWorkId</th>
          <th scope="col">binding</th>
          <th scope="col">state</th>
          <th scope="col">satisfiedBy</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row.dependencyId}>
            <td>
              <Mono>{row.dependencyId}</Mono>
            </td>
            <td>
              <Mono>{row.consumerWorkId}</Mono>
            </td>
            <td>
              <Mono>{formatBinding(row.binding)}</Mono>
            </td>
            <td>
              <EnumBadge label={row.state} />
            </td>
            <td>
              {row.satisfiedBy === undefined ? null : (
                <Mono>{row.satisfiedBy}</Mono>
              )}
            </td>
          </tr>
        ))}
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
