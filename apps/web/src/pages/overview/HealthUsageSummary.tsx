/**
 * W-03 区块③ 健康与用量摘要：a) attention 按 severity 计数两枚 Badge；
 * b) usage(projectId, groupBy:"project") 汇总行——合计只在 server DTO
 * rows 存在时呈现，不做浏览器端跨行聚合；c) 钉死文案
 * "Root Workspace 最近活动"——root（tree.nodes[0]）workspace-detail 的
 * auditTimeline 尾部 ≤5 条。三个子小节各自独立呈现查询 Problem。
 */
import type { TreeViewRes } from "@arbor/api-contracts";
import type { UseQueryResult } from "@tanstack/react-query";
import { useViewQuery } from "../../api/useViewQuery.js";
import { Badge } from "../../components/Badge.js";
import { Card } from "../../components/Card.js";
import { Empty } from "../../components/Empty.js";
import { ProblemCard } from "../../problems/ProblemCard.js";
import { EnumBadge, formatCost, Mono, TimeText } from "../../views/shared.js";
import styles from "./overview.module.css";

const ACTIVITY_LIMIT = 5;

export function HealthUsageSummary({
  projectId,
  treeQuery,
}: {
  readonly projectId: string;
  readonly treeQuery: UseQueryResult<TreeViewRes>;
}) {
  const attentionQuery = useViewQuery("attention", {
    projectId: projectId as never,
  });
  const usageQuery = useViewQuery("usage", {
    projectId: projectId as never,
    groupBy: "project",
  });
  const rootWorkspaceId = treeQuery.data?.nodes[0]?.workspaceId ?? null;
  const detailQuery = useViewQuery(
    "workspace-detail",
    rootWorkspaceId === null ? null : { workspaceId: rootWorkspaceId },
  );

  const counts = new Map<string, number>();
  for (const row of attentionQuery.data?.rows ?? []) {
    counts.set(row.severity, (counts.get(row.severity) ?? 0) + 1);
  }
  const unknownSeverities = [...counts.keys()].filter(
    (severity) => severity !== "Attention" && severity !== "ActionRequired",
  );
  const activity = detailQuery.data?.auditTimeline.slice(-ACTIVITY_LIMIT) ?? [];

  return (
    <Card title="健康与用量摘要">
      <div className={styles.healthStack}>
        <section>
          <h3 className={styles.healthTitle}>Attention 分布</h3>
          {attentionQuery.isError ? (
            <ProblemCard problem={attentionQuery.error as never} />
          ) : attentionQuery.isPending ? (
            <p className={styles.loading}>加载中…</p>
          ) : (
            <div className={styles.badgeRow}>
              <Badge tone="attention">{`Attention ${String(
                counts.get("Attention") ?? 0,
              )}`}</Badge>
              <Badge tone="danger">{`ActionRequired ${String(
                counts.get("ActionRequired") ?? 0,
              )}`}</Badge>
              {unknownSeverities.map((severity) => (
                <EnumBadge
                  key={severity}
                  label={`${severity} ${String(counts.get(severity) ?? 0)}`}
                />
              ))}
            </div>
          )}
        </section>
        <section>
          <h3 className={styles.healthTitle}>项目用量（project）</h3>
          {usageQuery.isError ? (
            <ProblemCard problem={usageQuery.error as never} />
          ) : usageQuery.isPending ? (
            <p className={styles.loading}>加载中…</p>
          ) : (usageQuery.data?.rows ?? []).length === 0 ? (
            <Empty>无用量数据</Empty>
          ) : (
            <ul className={styles.usageList}>
              {(usageQuery.data?.rows ?? []).map((row) => (
                <li key={row.workspaceId}>
                  <Mono>{`tokens ${String(row.tokens)} · cost ${formatCost(
                    row.cost,
                  )} · turns ${String(row.turns)}`}</Mono>
                </li>
              ))}
            </ul>
          )}
        </section>
        <section>
          <h3 className={styles.healthTitle}>Root Workspace 最近活动</h3>
          {detailQuery.isError ? (
            <ProblemCard problem={detailQuery.error as never} />
          ) : activity.length === 0 ? (
            <Empty>无审计事件</Empty>
          ) : (
            <ul className={styles.activityList}>
              {activity.map((entry) => (
                <li key={String(entry.sequence)} className={styles.activityRow}>
                  <Mono>{String(entry.sequence)}</Mono>
                  <Mono>{entry.eventType}</Mono>
                  <TimeText at={entry.at} />
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </Card>
  );
}
