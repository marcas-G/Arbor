/**
 * W-08 — Governance Queue（待处理，frozen §2.7）。
 * 条目 = 存在 concrete human action affordance 的事项：
 *  - 决策卡：frozen inbox DTO 的 gov:{proposalId}:{revision} 结构化绑定
 *    （W-00 proof ③；解析失败的 Governance 条目只读展示 + 跳转工作区，
 *    绝无手填 proposalId 路径、绝无假 action）
 *  - 只读折叠：其余未消费 inbox 条目
 */

import { useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import type { Route } from "../../api/router.js";
import { navigate } from "../../api/router.js";
import { useViewQuery } from "../../api/useViewQuery.js";
import { RecordDecisionForm } from "../../commands/forms/RecordDecisionForm.js";
import type { CommandReceiptView } from "../../commands/submitCommand.js";
import { Badge } from "../../components/Badge.js";
import { Button } from "../../components/Button.js";
import { Card } from "../../components/Card.js";
import { Empty } from "../../components/Empty.js";
import { MonoText } from "../../components/MonoText.js";
import { StatusBadge } from "../../components/StatusBadge.js";
import {
  type GovernanceTarget,
  parseGovernanceEntryKey,
} from "../../queue/governance-target.js";
import { useSession } from "../../session/SessionContext.js";
import styles from "./queue.module.css";

export function QueuePage({
  route,
}: {
  readonly route: Extract<Route, { name: "queue" }>;
}) {
  const { projectId } = route;
  const tree = useViewQuery("responsibility-tree", {
    projectId: projectId as never,
  });
  const workspaceIds = useMemo(() => {
    const nodes =
      (
        tree.data as
          | { nodes: ReadonlyArray<{ workspaceId: string }> }
          | undefined
      )?.nodes ?? [];
    return nodes.slice(0, 10).map((node) => node.workspaceId);
  }, [tree.data]);

  return (
    <div className={styles.page}>
      <h1 className={styles.heading}>待处理</h1>
      {tree.isPending ? (
        <Card title="待处理">
          <Empty>加载中…</Empty>
        </Card>
      ) : workspaceIds.length === 0 ? (
        <Card title="待处理">
          <Empty>没有等你处理的事项</Empty>
        </Card>
      ) : (
        workspaceIds.map((workspaceId) => (
          <WorkspaceQueueSection
            key={workspaceId}
            projectId={projectId}
            workspaceId={workspaceId}
          />
        ))
      )}
    </div>
  );
}

function WorkspaceQueueSection({
  projectId,
  workspaceId,
}: {
  readonly projectId: string;
  readonly workspaceId: string;
}) {
  const session = useSession();
  const queryClient = useQueryClient();
  const [activeDecision, setActiveDecision] = useState<{
    entryKey: string;
    target: GovernanceTarget;
    summary: string;
  } | null>(null);
  const [lastReceipt, setLastReceipt] = useState<CommandReceiptView | null>(
    null,
  );
  const inbox = useViewQuery("inbox-view", {
    workspaceId: workspaceId as never,
  });
  const entries =
    (
      inbox.data as
        | {
            unconsumed: ReadonlyArray<{
              entryKey: string;
              kind: string;
              summary: string;
              watermark: number;
            }>;
          }
        | undefined
    )?.unconsumed ?? [];
  const decisions = entries
    .map((entry) => ({
      entry,
      target: parseGovernanceEntryKey(entry.entryKey, entry.kind),
    }))
    .filter((item) => item.target !== null)
    .sort((a, b) => b.entry.watermark - a.entry.watermark);
  const readOnly = entries
    .map((entry) => ({
      entry,
      target: parseGovernanceEntryKey(entry.entryKey, entry.kind),
    }))
    .filter((item) => item.target === null);

  if (entries.length === 0) {
    return null;
  }
  return (
    <Card
      title={`工作区 ${workspaceId}`}
      actions={
        <button
          type="button"
          className={styles.workspaceLink}
          onClick={() => {
            navigate({
              name: "workspace",
              projectId,
              workspaceId,
              tab: "inbox",
            });
          }}
        >
          打开收件箱
        </button>
      }
    >
      <div className={styles.stack}>
        {lastReceipt !== null ? (
          <p className="arbor-command-receipt arbor-command-receipt-committed">
            最近命令：
            {lastReceipt.resolution === "Committed" ? "已提交" : "被拒绝"}{" "}
            <span className="arbor-mono">{lastReceipt.commandId}</span>
          </p>
        ) : null}
        {decisions.length > 0 ? (
          <ul className={styles.list}>
            {decisions.map(({ entry, target }) => (
              <li key={entry.entryKey} className={styles.decisionCard}>
                <div className={styles.decisionMeta}>
                  <Badge tone="attention">待决策</Badge>
                  <MonoText>{target?.proposalId}</MonoText>
                  <span className={styles.revision}>
                    revision {target?.proposalRevision}
                  </span>
                </div>
                <p className={styles.summary}>{entry.summary}</p>
                <Button
                  variant="primary"
                  onClick={() => {
                    setActiveDecision({
                      entryKey: entry.entryKey,
                      target: target as GovernanceTarget,
                      summary: entry.summary,
                    });
                  }}
                >
                  记录决策
                </Button>
              </li>
            ))}
          </ul>
        ) : null}
        {readOnly.length > 0 ? (
          <details className={styles.fold}>
            <summary className={styles.foldTitle}>
              其他未消费条目（{readOnly.length}，只读）
            </summary>
            <ul className={styles.list}>
              {readOnly.map(({ entry }) => (
                <li key={entry.entryKey} className={styles.readOnlyRow}>
                  <StatusBadge label={entry.kind} />
                  <span className={styles.summary}>{entry.summary}</span>
                  <span className={styles.watermark}>w{entry.watermark}</span>
                </li>
              ))}
            </ul>
          </details>
        ) : null}
        {activeDecision !== null ? (
          <RecordDecisionForm
            actor={session.actor ?? ""}
            projectId={projectId}
            target={{
              proposalId: activeDecision.target.proposalId,
              proposalRevision: activeDecision.target.proposalRevision,
              summary: activeDecision.summary,
            }}
            token={session.token ?? undefined}
            onSubmitted={(receipt) => {
              setLastReceipt(receipt);
              setActiveDecision(null);
              void queryClient.invalidateQueries({ queryKey: ["view"] });
            }}
          />
        ) : null}
      </div>
    </Card>
  );
}
