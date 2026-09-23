/**
 * usage view: groupBy switch (value + change forwarded by the parent layer)
 * and the server-provided rows. No browser-side aggregation (`03` §2 I2);
 * cost Unknown renders "unknown", never 0 (P12 `04` TR-5).
 */
import type { UsageReq, UsageRes } from "@arbor/api-contracts";
import { Button } from "../components/Button.js";
import { Empty } from "../components/Empty.js";
import { formatCost, Mono } from "./shared.js";

const GROUP_BY_OPTIONS: ReadonlyArray<UsageReq["groupBy"]> = [
  "workspace",
  "subtree",
  "project",
];

export function UsageView({
  res,
  groupBy,
  onGroupByChange,
}: {
  readonly res: UsageRes;
  readonly groupBy: UsageReq["groupBy"];
  readonly onGroupByChange?: ((next: UsageReq["groupBy"]) => void) | undefined;
}) {
  const knownGroup = GROUP_BY_OPTIONS.includes(groupBy);
  return (
    <div className="arbor-view-stack">
      <fieldset className="arbor-segmented" aria-label="groupBy">
        {GROUP_BY_OPTIONS.map((option) => (
          <Button
            key={option}
            variant={option === groupBy ? "primary" : "quiet"}
            onClick={() => onGroupByChange?.(option)}
          >
            {option}
          </Button>
        ))}
        {knownGroup ? null : <Mono>{groupBy}</Mono>}
      </fieldset>
      {res.rows.length === 0 ? (
        <Empty>无用量数据</Empty>
      ) : (
        <table className="arbor-table">
          <thead>
            <tr>
              <th scope="col">workspaceId</th>
              <th scope="col">tokens</th>
              <th scope="col">cost</th>
              <th scope="col">turns</th>
            </tr>
          </thead>
          <tbody>
            {res.rows.map((row) => (
              <tr key={row.workspaceId}>
                <td>
                  <Mono>{row.workspaceId}</Mono>
                </td>
                <td>{String(row.tokens)}</td>
                <td>
                  <Mono>{formatCost(row.cost)}</Mono>
                </td>
                <td>{String(row.turns)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
