/**
 * W-04 — Responsibility Tree 页（只读导航面，frozen §2.3）。
 * 只做三件事：navigate（节点卡点击→工作区概览）、select（本地选中高亮）、
 * inspect（右侧 mini-detail）。已知限制：wire DTO 是扁平前序列表（无
 * depth/parent 字段），v1 平铺有序节点卡（root 在首），不发明层级。
 * 硬约束：本页 0 个 command 发起——只有 view 查询与本地导航状态。
 */
import type { Problem, TreeViewNode } from "@arbor/api-contracts";
import { useState } from "react";
import type { Route } from "../../api/router.js";
import { navigate } from "../../api/router.js";
import { useViewQuery } from "../../api/useViewQuery.js";
import { Badge } from "../../components/Badge.js";
import { Button } from "../../components/Button.js";
import { Card } from "../../components/Card.js";
import { cx } from "../../components/cx.js";
import { Empty } from "../../components/Empty.js";
import { KeyValue, type KeyValuePair } from "../../components/KeyValue.js";
import { MonoText } from "../../components/MonoText.js";
import { StatusBadge } from "../../components/StatusBadge.js";
import { ProblemCard } from "../../problems/ProblemCard.js";
import { formatCost } from "../../views/shared.js";
import styles from "./tree.module.css";

const DEPTH_OPTIONS: ReadonlyArray<number> = [1, 2, 3, 4, 5, 6];
const DEFAULT_DEPTH = 3;

function openWorkspace(projectId: string, workspaceId: string): void {
  navigate({ name: "workspace", projectId, workspaceId, tab: "overview" });
}

function usageText(
  usageSummary: NonNullable<TreeViewNode["usageSummary"]>,
): string {
  return `tokens ${String(usageSummary.tokens)} · cost ${formatCost(usageSummary.cost)} · turns ${String(usageSummary.turns)}`;
}

function attentionText(node: TreeViewNode): string {
  return `attention ${String(node.subtreeAttention.attention)} · actionRequired ${String(node.subtreeAttention.actionRequired)}`;
}

function TreeNodeCard({
  node,
  selected,
  onActivate,
}: {
  readonly node: TreeViewNode;
  readonly selected: boolean;
  readonly onActivate: (node: TreeViewNode) => void;
}) {
  return (
    <li>
      <button
        type="button"
        className={cx([styles.node, selected ? styles.nodeSelected : null])}
        aria-pressed={selected}
        onClick={() => {
          onActivate(node);
        }}
      >
        <span className={styles.nodeHead}>
          <span className={styles.nodeName}>{node.name}</span>
          <StatusBadge label={node.status} />
          {node.subtreeAttention.attention > 0 ? (
            <Badge tone="attention">{`attention ${String(node.subtreeAttention.attention)}`}</Badge>
          ) : null}
          {node.subtreeAttention.actionRequired > 0 ? (
            <Badge tone="danger">{`actionRequired ${String(node.subtreeAttention.actionRequired)}`}</Badge>
          ) : null}
        </span>
        {node.currentWork == null ? null : (
          <span className={styles.nodeObjective}>
            {node.currentWork.objective}
          </span>
        )}
        {node.usageSummary == null ? null : (
          <span className={styles.nodeUsage}>
            {usageText(node.usageSummary)}
          </span>
        )}
      </button>
    </li>
  );
}

function MiniDetail({
  node,
  projectId,
}: {
  readonly node: TreeViewNode;
  readonly projectId: string;
}) {
  const pairs: ReadonlyArray<KeyValuePair> = [
    { label: "名称", value: node.name },
    { label: "工作区", value: <MonoText>{node.workspaceId}</MonoText> },
    { label: "状态", value: <StatusBadge label={node.status} /> },
    {
      label: "当前工作",
      value: node.currentWork == null ? "—" : node.currentWork.objective,
    },
    { label: "子树关注", value: attentionText(node) },
    {
      label: "用量",
      value: node.usageSummary == null ? "—" : usageText(node.usageSummary),
    },
  ];
  return (
    <Card title="节点详情">
      <div className={styles.detailBody}>
        <KeyValue pairs={pairs} />
        <Button
          variant="primary"
          onClick={() => {
            openWorkspace(projectId, node.workspaceId);
          }}
        >
          打开工作区
        </Button>
      </div>
    </Card>
  );
}

export function TreePage({
  route,
}: {
  readonly route: Extract<Route, { name: "tree" }>;
}) {
  const [depth, setDepth] = useState<number>(DEFAULT_DEPTH);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const query = useViewQuery("responsibility-tree", {
    projectId: route.projectId as never,
    depth,
  });
  const nodes = query.data?.nodes ?? [];
  const selected =
    nodes.find((node) => node.workspaceId === selectedId) ?? null;

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        {/* W-02 shell smoke（不可改）锁定页面标记为单一文本节点。 */}
        <h1 className={styles.title} aria-label="责任树">
          责任树（W-04，只读导航）
        </h1>
        <label className={styles.depthLabel}>
          深度
          <select
            className={styles.depthSelect}
            aria-label="树深度"
            value={depth}
            onChange={(event) => {
              setDepth(Number(event.target.value));
            }}
          >
            {DEPTH_OPTIONS.map((option) => (
              <option key={option} value={option}>
                {String(option)}
              </option>
            ))}
          </select>
        </label>
      </header>
      <div className={styles.layout}>
        <section className={styles.listSection} aria-label="节点列表">
          {query.isPending ? (
            <Empty>加载中</Empty>
          ) : query.isError ? (
            <ProblemCard
              problem={query.error as unknown as Problem}
              onRetry={() => {
                void query.refetch();
              }}
            />
          ) : nodes.length === 0 ? (
            <Empty>无工作区</Empty>
          ) : (
            <ul className={styles.list}>
              {nodes.map((node) => (
                <TreeNodeCard
                  key={node.workspaceId}
                  node={node}
                  selected={node.workspaceId === selectedId}
                  onActivate={(activated) => {
                    setSelectedId(activated.workspaceId);
                    openWorkspace(route.projectId, activated.workspaceId);
                  }}
                />
              ))}
            </ul>
          )}
        </section>
        <aside className={styles.detail} aria-label="节点详情">
          {selected === null ? (
            <Card title="节点详情">
              <Empty>选中节点查看详情</Empty>
            </Card>
          ) : (
            <MiniDetail node={selected} projectId={route.projectId} />
          )}
        </aside>
      </div>
    </div>
  );
}
