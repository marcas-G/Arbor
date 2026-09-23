/**
 * W-03 — Overview 项目落地页（frozen §2.2）：三区块自上而下——
 * ① 待处理摘要（governance digest）② 树顶快照 ③ 健康与用量摘要。
 * 所有数据经 useViewQuery（WS invalidation 自动生效）；查询失败按
 * 区块就地 ProblemCard，不整页崩。FreshnessChip 由 Topbar 呈现。
 */
import type { Route } from "../../api/router.js";
import { useViewQuery } from "../../api/useViewQuery.js";
import { GovernanceDigest } from "./GovernanceDigest.js";
import { HealthUsageSummary } from "./HealthUsageSummary.js";
import styles from "./overview.module.css";
import { TreeTopSnapshot } from "./TreeTopSnapshot.js";

export function OverviewPage({
  route,
}: {
  readonly route: Extract<Route, { name: "project-overview" }>;
}) {
  const treeQuery = useViewQuery("responsibility-tree", {
    projectId: route.projectId as never,
  });
  return (
    <div className={styles.page}>
      <h1 className={styles.heading}>概览</h1>
      <GovernanceDigest projectId={route.projectId} treeQuery={treeQuery} />
      <TreeTopSnapshot projectId={route.projectId} treeQuery={treeQuery} />
      <HealthUsageSummary projectId={route.projectId} treeQuery={treeQuery} />
    </div>
  );
}
