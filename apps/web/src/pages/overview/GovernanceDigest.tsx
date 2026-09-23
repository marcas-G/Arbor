/**
 * W-03 区块① 待处理摘要（governance digest）：树内各工作区 inbox
 * 未消费中 kind="Governance" 的条目（parseGovernanceEntryKey 成功 →
 * "待决策" + 跳队列页；失败 → 只读降级，W-00 冻结规则）+ attention
 * 中 severity=ActionRequired 的 Top 条目；合计 Top-N ≤ 5。
 * inbox 聚合用 useQueries 并行（与 useViewQuery 同 key 约定
 * ["view", view, request]，WS invalidation 前缀匹配自动生效）。
 */
import type { InboxViewRes, TreeViewRes } from "@arbor/api-contracts";
import type { UseQueryResult } from "@tanstack/react-query";
import { useQueries } from "@tanstack/react-query";
import { navigate } from "../../api/router.js";
import { fetchView } from "../../api/transport.js";
import { useViewQuery } from "../../api/useViewQuery.js";
import { Badge } from "../../components/Badge.js";
import { Button } from "../../components/Button.js";
import { Card } from "../../components/Card.js";
import { Empty } from "../../components/Empty.js";
import { ProblemCard } from "../../problems/ProblemCard.js";
import {
  isGovernanceKind,
  parseGovernanceEntryKey,
} from "../../queue/governance-target.js";
import { useSession } from "../../session/SessionContext.js";
import { EnumBadge, TimeText } from "../../views/shared.js";
import styles from "./overview.module.css";

const TOP_N = 5;
const MAX_WORKSPACES = 10;

type DigestEntry =
  | {
      readonly kind: "governance";
      readonly entryKey: string;
      readonly workspaceName: string;
      readonly summary: string;
      readonly watermark: number;
      readonly decidable: boolean;
    }
  | {
      readonly kind: "attention";
      readonly source: string;
      readonly summaryRef: string;
      readonly occurredAt: string;
    };

export function GovernanceDigest({
  projectId,
  treeQuery,
}: {
  readonly projectId: string;
  readonly treeQuery: UseQueryResult<TreeViewRes>;
}) {
  const { token, reportUnauthenticated } = useSession();
  const attentionQuery = useViewQuery("attention", {
    projectId: projectId as never,
  });
  const workspaces = (treeQuery.data?.nodes ?? []).slice(0, MAX_WORKSPACES);
  const inboxQueries = useQueries({
    queries: workspaces.map((node) => ({
      queryKey: ["view", "inbox-view", { workspaceId: node.workspaceId }],
      enabled: token !== null,
      staleTime: Number.POSITIVE_INFINITY,
      retry: false,
      queryFn: ({ signal }: { readonly signal: AbortSignal | undefined }) =>
        fetchView(
          "inbox-view",
          { workspaceId: node.workspaceId },
          { token, signal, onUnauthenticated: reportUnauthenticated },
        ).then((outcome) => {
          if (!outcome.ok) {
            throw outcome.problem;
          }
          return outcome.dto;
        }),
    })),
  });

  if (attentionQuery.isError) {
    return (
      <Card title="待处理摘要">
        <ProblemCard problem={attentionQuery.error as never} />
      </Card>
    );
  }
  const failedInbox = inboxQueries.find((query) => query.isError);
  if (failedInbox?.isError) {
    return (
      <Card title="待处理摘要">
        <ProblemCard problem={failedInbox.error as never} />
      </Card>
    );
  }
  if (
    treeQuery.isPending ||
    attentionQuery.isPending ||
    inboxQueries.some((query) => query.isPending)
  ) {
    return (
      <Card title="待处理摘要">
        <p className={styles.loading}>加载中…</p>
      </Card>
    );
  }

  const governance: Array<
    Extract<DigestEntry, { readonly kind: "governance" }>
  > = [];
  workspaces.forEach((node, index) => {
    const inbox: InboxViewRes | undefined = inboxQueries[index]?.data;
    for (const entry of inbox?.unconsumed ?? []) {
      if (!isGovernanceKind(entry.kind)) {
        continue;
      }
      governance.push({
        kind: "governance",
        entryKey: entry.entryKey,
        workspaceName: node.name,
        summary: entry.summary,
        watermark: entry.watermark,
        decidable: parseGovernanceEntryKey(entry.entryKey, entry.kind) !== null,
      });
    }
  });
  governance.sort((a, b) => b.watermark - a.watermark);
  const actionRequired: DigestEntry[] = (attentionQuery.data?.rows ?? [])
    .filter((row) => row.severity === "ActionRequired")
    .sort((a, b) => (a.occurredAt < b.occurredAt ? 1 : -1))
    .map((row) => ({
      kind: "attention" as const,
      source: row.source,
      summaryRef: row.summaryRef,
      occurredAt: row.occurredAt,
    }));
  const items = [...governance, ...actionRequired].slice(0, TOP_N);

  return (
    <Card title="待处理摘要">
      {items.length === 0 ? (
        <Empty>没有等你处理的事项</Empty>
      ) : (
        <ul className={styles.digestList}>
          {items.map((item) =>
            item.kind === "governance" ? (
              <li key={item.entryKey} className={styles.digestItem}>
                <EnumBadge label="Governance" />
                <span className={styles.digestWorkspace}>
                  {item.workspaceName}
                </span>
                <span>{item.summary}</span>
                {item.decidable ? (
                  <>
                    <Badge tone="attention">待决策</Badge>
                    <Button
                      variant="quiet"
                      onClick={() => navigate({ name: "queue", projectId })}
                    >
                      去队列
                    </Button>
                  </>
                ) : null}
              </li>
            ) : (
              <li
                key={`attention:${item.source}:${item.summaryRef}`}
                className={styles.digestItem}
              >
                <button
                  type="button"
                  className={styles.digestAttentionButton}
                  onClick={() => navigate({ name: "attention", projectId })}
                >
                  <EnumBadge label={item.source} />
                  <span>{item.summaryRef}</span>
                  <TimeText at={item.occurredAt} />
                </button>
              </li>
            ),
          )}
        </ul>
      )}
    </Card>
  );
}
