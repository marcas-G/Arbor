/**
 * W-03 区块② 树顶快照：DTO 保持扁平前序列表，并用 server-projected
 * parentWorkspaceId 标识 root；v1 取前 N 张节点卡平铺。每卡 name + StatusBadge +
 * subtreeAttention 计数 Badge（>0 时 attention/danger tone）+
 * currentWork?.objective + usage 摘要（cost Unknown 原样 "unknown"）。
 * 点击卡 navigate workspace 路由。
 */
import type { TreeViewRes } from "@arbor/api-contracts";
import type { UseQueryResult } from "@tanstack/react-query";
import { navigate } from "../../api/router.js";
import { Badge } from "../../components/Badge.js";
import { Card } from "../../components/Card.js";
import { Empty } from "../../components/Empty.js";
import { StatusBadge } from "../../components/StatusBadge.js";
import { ProblemCard } from "../../problems/ProblemCard.js";
import { formatCost, Mono } from "../../views/shared.js";
import styles from "./overview.module.css";

const SNAPSHOT_LIMIT = 6;

export function TreeTopSnapshot({
  projectId,
  treeQuery,
}: {
  readonly projectId: string;
  readonly treeQuery: UseQueryResult<TreeViewRes>;
}) {
  if (treeQuery.isError) {
    return (
      <Card title="树顶快照">
        <ProblemCard problem={treeQuery.error as never} />
      </Card>
    );
  }
  if (treeQuery.isPending) {
    return (
      <Card title="树顶快照">
        <p className={styles.loading}>加载中…</p>
      </Card>
    );
  }
  const nodes = (treeQuery.data?.nodes ?? []).slice(0, SNAPSHOT_LIMIT);
  return (
    <Card title="树顶快照">
      {nodes.length === 0 ? (
        <Empty>无工作区</Empty>
      ) : (
        <ul className={styles.treeGrid}>
          {nodes.map((node) => (
            <li key={node.workspaceId}>
              <button
                type="button"
                className={styles.treeCard}
                onClick={() =>
                  navigate({
                    name: "workspace",
                    projectId,
                    workspaceId: node.workspaceId,
                    tab: "overview",
                  })
                }
              >
                <span className={styles.treeCardHead}>
                  <span className={styles.treeCardName}>{node.name}</span>
                  {node.parentWorkspaceId === null ? (
                    <Badge tone="branch">root</Badge>
                  ) : null}
                  <StatusBadge label={node.status} />
                  {node.subtreeAttention.attention > 0 ? (
                    <Badge tone="attention">{`attention ${String(
                      node.subtreeAttention.attention,
                    )}`}</Badge>
                  ) : null}
                  {node.subtreeAttention.actionRequired > 0 ? (
                    <Badge tone="danger">{`actionRequired ${String(
                      node.subtreeAttention.actionRequired,
                    )}`}</Badge>
                  ) : null}
                </span>
                {node.currentWork == null ? null : (
                  <span className={styles.treeCardObjective}>
                    {node.currentWork.objective}
                  </span>
                )}
                {node.usageSummary == null ? null : (
                  <span className={styles.treeCardUsage}>
                    <Mono>{`tokens ${String(
                      node.usageSummary.tokens,
                    )} · cost ${formatCost(node.usageSummary.cost)} · turns ${String(
                      node.usageSummary.turns,
                    )}`}</Mono>
                  </span>
                )}
              </button>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
