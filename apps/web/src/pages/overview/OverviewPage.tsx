/**
 * W-03 — retained Overview read surface (no longer the project landing after
 * TR-WPU-A): 三区块自上而下——
 * ① 待处理摘要（governance digest）② 树顶快照 ③ 健康与用量摘要。
 * 所有数据经 useViewQuery（WS invalidation 自动生效）；查询失败按
 * 区块就地 ProblemCard，不整页崩。FreshnessChip 由 Topbar 呈现。
 */
import { navigate } from "../../api/router.js";
import { useViewQuery } from "../../api/useViewQuery.js";
import { Button } from "../../components/Button.js";
import { GovernanceDigest } from "./GovernanceDigest.js";
import { HealthUsageSummary } from "./HealthUsageSummary.js";
import styles from "./overview.module.css";
import { TreeTopSnapshot } from "./TreeTopSnapshot.js";

export function OverviewPage({ projectId }: { readonly projectId: string }) {
  const treeQuery = useViewQuery("responsibility-tree", {
    projectId: projectId as never,
  });
  const rootWorkspaceId = treeQuery.data?.nodes.find(
    (node) => node.parentWorkspaceId === null,
  )?.workspaceId;
  return (
    <div className={styles.page}>
      <h1 className={styles.heading}>概览</h1>
      {rootWorkspaceId === undefined ? null : (
        <div>
          <Button
            variant="quiet"
            onClick={() => {
              navigate({
                name: "workspace",
                projectId,
                workspaceId: rootWorkspaceId,
                tab: "conversation",
              });
            }}
          >
            与 Arbor 对话
          </Button>
        </div>
      )}
      <GovernanceDigest projectId={projectId} treeQuery={treeQuery} />
      <TreeTopSnapshot projectId={projectId} treeQuery={treeQuery} />
      <HealthUsageSummary projectId={projectId} treeQuery={treeQuery} />
    </div>
  );
}
