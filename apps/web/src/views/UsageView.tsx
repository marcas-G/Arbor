/**
 * usage view: groupBy switch (value + change forwarded by the parent layer)
 * and the server-provided rows. No browser-side aggregation (`03` §2 I2);
 * cost Unknown renders "unknown", never 0 (P12 `04` TR-5).
 */
import type { UsageReq, UsageRes } from "@arbor/api-contracts";
import { Button } from "../components/Button.js";
import { Empty } from "../components/Empty.js";
import { useCompactLayout } from "../components/useCompactLayout.js";
import styles from "../pages/usage/usage.module.css";
import { formatCost, Mono } from "./shared.js";

const GROUP_BY_OPTIONS: ReadonlyArray<UsageReq["groupBy"]> = [
  "workspace",
  "subtree",
  "project",
];

const GROUP_BY_LABELS: Readonly<Record<UsageReq["groupBy"], string>> = {
  workspace: "按责任",
  subtree: "含下级责任",
  project: "整个项目",
};

export function UsageView({
  res,
  groupBy,
  onGroupByChange,
  workspaceNames,
}: {
  readonly res: UsageRes;
  readonly groupBy: UsageReq["groupBy"];
  readonly onGroupByChange?: ((next: UsageReq["groupBy"]) => void) | undefined;
  readonly workspaceNames?: ReadonlyMap<string, string> | undefined;
}) {
  const knownGroup = GROUP_BY_OPTIONS.includes(groupBy);
  const compact = useCompactLayout();
  return (
    <div className="arbor-view-stack">
      <fieldset className="arbor-segmented" aria-label="统计范围">
        {GROUP_BY_OPTIONS.map((option) => (
          <Button
            key={option}
            variant={option === groupBy ? "primary" : "quiet"}
            onClick={() => onGroupByChange?.(option)}
          >
            {GROUP_BY_LABELS[option]}
          </Button>
        ))}
        {knownGroup ? null : <Mono>{groupBy}</Mono>}
      </fieldset>
      {res.rows.length === 0 ? (
        <Empty>无用量数据</Empty>
      ) : compact ? (
        <ul className={styles.mobileRows} aria-label="用量明细">
          {res.rows.map((row, index) => (
            <li className={styles.mobileRow} key={row.workspaceId}>
              <dl className={styles.rowValues}>
                <div>
                  <dt>分工</dt>
                  <dd>
                    {workspaceNames?.get(row.workspaceId) ??
                      `责任 ${String(index + 1)}`}
                  </dd>
                </div>
                <div>
                  <dt>处理量</dt>
                  <dd>{String(row.tokens)}</dd>
                </div>
                <div>
                  <dt>费用</dt>
                  <dd>
                    <Mono>{formatCost(row.cost)}</Mono>
                  </dd>
                </div>
                <div>
                  <dt>运行次数</dt>
                  <dd>{String(row.turns)}</dd>
                </div>
              </dl>
            </li>
          ))}
        </ul>
      ) : (
        <table className="arbor-table">
          <thead>
            <tr>
              <th scope="col">分工</th>
              <th scope="col">处理量</th>
              <th scope="col">费用</th>
              <th scope="col">运行次数</th>
            </tr>
          </thead>
          <tbody>
            {res.rows.map((row, index) => (
              <tr key={row.workspaceId}>
                <td>
                  {workspaceNames?.get(row.workspaceId) ??
                    `责任 ${String(index + 1)}`}
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
