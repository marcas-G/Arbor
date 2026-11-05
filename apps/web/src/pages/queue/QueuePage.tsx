import type {
  InboxViewRes,
  Problem,
  TreeViewNode,
  VerificationRes,
} from "@arbor/api-contracts";
import { useQueries, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import type { Route } from "../../api/router.js";
import { navigate } from "../../api/router.js";
import { fetchView } from "../../api/transport.js";
import { useViewQuery } from "../../api/useViewQuery.js";
import { AcceptWorkOutcomeForm } from "../../commands/forms/AcceptWorkOutcomeForm.js";
import { RecordDecisionForm } from "../../commands/forms/RecordDecisionForm.js";
import {
  approvalTitle,
  ResolveControlApprovalForm,
} from "../../commands/forms/ResolveControlApprovalForm.js";
import type { CommandReceiptView } from "../../commands/submitCommand.js";
import { Badge } from "../../components/Badge.js";
import { Button } from "../../components/Button.js";
import { Card } from "../../components/Card.js";
import { Empty } from "../../components/Empty.js";
import { Sheet } from "../../components/Sheet.js";
import { useCompactLayout } from "../../components/useCompactLayout.js";
import { ProblemCard } from "../../problems/ProblemCard.js";
import {
  type ControlApprovalTarget,
  type GovernanceTarget,
  parseControlApprovalEntryKey,
  parseGovernanceEntryKey,
} from "../../queue/governance-target.js";
import { useSession } from "../../session/SessionContext.js";
import styles from "./queue.module.css";

type DecisionItem = {
  readonly type: "decision";
  readonly id: string;
  readonly workspaceId: string;
  readonly workspaceName: string;
  readonly entryKey: string;
  readonly summary: string;
  readonly watermark: number;
  readonly target: GovernanceTarget;
};

type AcceptanceItem = {
  readonly type: "acceptance";
  readonly id: string;
  readonly workspaceId: string;
  readonly workspaceName: string;
  readonly workId: string;
  readonly objective: string;
  readonly targetWorkRevision: number;
  readonly verificationId: string;
};

type ControlApprovalItem = {
  readonly type: "control-approval";
  readonly id: string;
  readonly workspaceId: string;
  readonly workspaceName: string;
  readonly entryKey: string;
  readonly summary: string;
  readonly watermark: number;
  readonly target: ControlApprovalTarget;
};

type QueueItem = DecisionItem | AcceptanceItem | ControlApprovalItem;

const asProblem = (error: unknown): Problem => error as Problem;

const decisionSummary = (summary: string): string => {
  const match =
    /^formation proposal "(.+)" revision \d+ awaiting human decision$/.exec(
      summary,
    );
  return match?.[1] === undefined
    ? summary
    : `创建分工“${match[1]}”需要你的决定`;
};

const fetchInbox = async (
  workspaceId: TreeViewNode["workspaceId"],
  token: string | null,
  signal: AbortSignal,
  onUnauthenticated: (problem: Problem) => void,
): Promise<InboxViewRes> => {
  const outcome = await fetchView(
    "inbox-view",
    { workspaceId },
    { token, signal, onUnauthenticated },
  );
  if (!outcome.ok) {
    throw outcome.problem;
  }
  return outcome.dto;
};

const fetchVerification = async (
  workId: NonNullable<TreeViewNode["currentWork"]>["workId"],
  token: string | null,
  signal: AbortSignal,
  onUnauthenticated: (problem: Problem) => void,
): Promise<VerificationRes> => {
  if (workId === undefined) {
    throw new Error("verification query requires an exact workId");
  }
  const outcome = await fetchView(
    "verification",
    { workId },
    { token, signal, onUnauthenticated },
  );
  if (!outcome.ok) {
    throw outcome.problem;
  }
  return outcome.dto;
};

export function QueuePage({
  route,
}: {
  readonly route: Extract<Route, { name: "queue" }>;
}) {
  const { projectId } = route;
  const { token, actor, reportUnauthenticated } = useSession();
  const queryClient = useQueryClient();
  const compact = useCompactLayout();
  const tree = useViewQuery("responsibility-tree", {
    projectId: projectId as never,
  });
  const workspaces = tree.data?.nodes ?? [];
  const inboxQueries = useQueries({
    queries: workspaces.map((node) => ({
      queryKey: ["view", "inbox-view", { workspaceId: node.workspaceId }],
      enabled: token !== null,
      queryFn: ({ signal }: { readonly signal: AbortSignal }) =>
        fetchInbox(node.workspaceId, token, signal, reportUnauthenticated),
    })),
  });
  const currentWorkCandidates = useMemo(
    () =>
      workspaces.flatMap((node) => {
        const currentWork = node.currentWork;
        if (currentWork?.workId === undefined) {
          return [];
        }
        return [{ node, currentWork, workId: currentWork.workId }];
      }),
    [workspaces],
  );
  const verificationQueries = useQueries({
    queries: currentWorkCandidates.map(({ workId }) => ({
      queryKey: ["view", "verification", { workId }],
      enabled: token !== null,
      queryFn: ({ signal }: { readonly signal: AbortSignal }) =>
        fetchVerification(workId, token, signal, reportUnauthenticated),
    })),
  });

  const items: QueueItem[] = [];
  const inboxProblems: Array<{ workspaceId: string; problem: Problem }> = [];
  const verificationProblems: Array<{
    workspaceId: string;
    workId: string;
    problem: Problem;
  }> = [];

  workspaces.forEach((node, index) => {
    const inbox = inboxQueries[index];
    if (inbox?.isError) {
      inboxProblems.push({
        workspaceId: node.workspaceId,
        problem: asProblem(inbox.error),
      });
    }
    const entries = inbox?.data?.unconsumed ?? [];
    const decisions = entries
      .map((entry) => ({
        entry,
        target: parseGovernanceEntryKey(entry.entryKey, entry.kind),
      }))
      .filter(
        (
          item,
        ): item is {
          readonly entry: (typeof entries)[number];
          readonly target: GovernanceTarget;
        } => item.target !== null,
      )
      .sort((left, right) => right.entry.watermark - left.entry.watermark);
    for (const { entry, target } of decisions) {
      items.push({
        type: "decision",
        id: `decision:${node.workspaceId}:${entry.entryKey}`,
        workspaceId: node.workspaceId,
        workspaceName: node.name,
        entryKey: entry.entryKey,
        summary: entry.summary,
        watermark: entry.watermark,
        target,
      });
    }
    const controlApprovals = entries
      .map((entry) => ({
        entry,
        target: parseControlApprovalEntryKey(entry.entryKey, entry.kind),
      }))
      .filter(
        (
          item,
        ): item is {
          readonly entry: (typeof entries)[number];
          readonly target: ControlApprovalTarget;
        } => item.target !== null,
      );
    for (const { entry, target } of controlApprovals) {
      items.push({
        type: "control-approval",
        id: `control-approval:${node.workspaceId}:${entry.entryKey}`,
        workspaceId: node.workspaceId,
        workspaceName: node.name,
        entryKey: entry.entryKey,
        summary: entry.summary,
        watermark: entry.watermark,
        target,
      });
    }

    const candidateIndex = currentWorkCandidates.findIndex(
      (candidate) => candidate.node.workspaceId === node.workspaceId,
    );
    const verification = verificationQueries[candidateIndex];
    const currentWork = node.currentWork;
    if (verification?.isError && currentWork?.workId !== undefined) {
      verificationProblems.push({
        workspaceId: node.workspaceId,
        workId: currentWork.workId,
        problem: asProblem(verification.error),
      });
    }
    const selectedVerification = verification?.data;
    if (
      currentWork?.workId !== undefined &&
      selectedVerification?.verificationId !== undefined &&
      selectedVerification.targetWorkRevision === currentWork.revision &&
      selectedVerification.verdict === "Pass" &&
      selectedVerification.acceptance === undefined
    ) {
      items.push({
        type: "acceptance",
        id: `acceptance:${currentWork.workId}:${selectedVerification.verificationId}:${selectedVerification.targetWorkRevision}`,
        workspaceId: node.workspaceId,
        workspaceName: node.name,
        workId: currentWork.workId,
        objective: currentWork.objective,
        targetWorkRevision: selectedVerification.targetWorkRevision,
        verificationId: selectedVerification.verificationId,
      });
    }
  });

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [acceptanceOpenFor, setAcceptanceOpenFor] = useState<string | null>(
    null,
  );
  const [lastReceipt, setLastReceipt] = useState<CommandReceiptView | null>(
    null,
  );
  const selectedItem =
    items.find((item) => item.id === selectedId) ?? items[0] ?? null;
  const mobileSheetOpen =
    compact && selectedId !== null && selectedItem?.id === selectedId;
  const hasInboxPending = inboxQueries.some((query) => query.isPending);
  const hasVerificationPending = verificationQueries.some(
    (query) => query.isPending,
  );
  const anyPending = hasInboxPending || hasVerificationPending;

  const onSubmitted = (receipt: CommandReceiptView): void => {
    setLastReceipt(receipt);
    setAcceptanceOpenFor(null);
    void queryClient.invalidateQueries({ queryKey: ["view"] });
  };

  if (tree.isPending) {
    return (
      <div className={styles.page}>
        <QueueHeader />
        <Card title="待处理">
          <Empty>正在加载项目分工</Empty>
        </Card>
      </div>
    );
  }
  if (tree.isError) {
    return (
      <div className={styles.page}>
        <QueueHeader />
        <ProblemCard
          problem={asProblem(tree.error)}
          onRetry={() => {
            void tree.refetch();
          }}
        />
      </div>
    );
  }
  if (workspaces.length === 0) {
    return (
      <div className={styles.page}>
        <QueueHeader />
        <Empty>没有等你处理的事项</Empty>
      </div>
    );
  }

  return (
    <div className={styles.page}>
      <QueueHeader />
      {tree.isRefetching ? (
        <p className={styles.refreshing} role="status">
          正在刷新待处理事项
        </p>
      ) : null}
      {inboxProblems.map(({ workspaceId, problem }) => (
        <section
          key={`inbox-problem:${workspaceId}`}
          className={styles.sourceProblem}
          aria-label="相关消息加载问题"
        >
          <h2>一项分工暂时不可用</h2>
          <ProblemCard problem={problem} />
        </section>
      ))}
      {verificationProblems.map(({ workId, problem }) => (
        <section
          key={`verification-problem:${workId}`}
          className={styles.sourceProblem}
          aria-label="分工验收问题"
        >
          <h2>一项工作的验收条件暂不可用</h2>
          <ProblemCard problem={problem} />
        </section>
      ))}
      {items.length === 0 ? (
        <Card title="待处理事项">
          {anyPending ? (
            <Empty>正在核对待处理事项</Empty>
          ) : inboxProblems.length > 0 || verificationProblems.length > 0 ? (
            <Empty>部分分工无法加载，暂时不能确认是否还有待处理事项</Empty>
          ) : (
            <Empty>没有等你处理的事项</Empty>
          )}
        </Card>
      ) : (
        <div className={styles.masterDetail}>
          <section
            className={styles.listPanel}
            aria-label="可处理事项列表"
            aria-busy={anyPending}
          >
            <header className={styles.listHeader}>
              <div>
                <p className={styles.eyebrow}>需要你处理</p>
                <h2>可处理事项</h2>
              </div>
              <Badge tone="attention">{items.length} 条</Badge>
            </header>
            {anyPending ? (
              <p className={styles.pendingNote} role="status">
                正在加载其余分工事项
              </p>
            ) : null}
            <ul className={styles.list}>
              {items.map((item) => (
                <li key={item.id}>
                  <button
                    type="button"
                    className={styles.itemButton}
                    aria-pressed={item.id === selectedItem?.id}
                    onClick={() => {
                      setSelectedId(item.id);
                      setAcceptanceOpenFor(null);
                    }}
                  >
                    <span className={styles.itemMeta}>
                      <Badge
                        tone={item.type === "acceptance" ? "leaf" : "attention"}
                      >
                        {item.type === "decision"
                          ? "待决策"
                          : item.type === "control-approval"
                            ? "待授权"
                            : "等待验收"}
                      </Badge>
                      <span>{item.workspaceName}</span>
                    </span>
                    <span className={styles.itemSummary}>
                      {item.type === "acceptance"
                        ? item.objective
                        : item.type === "decision"
                          ? decisionSummary(item.summary)
                          : approvalTitle(item.summary)}
                    </span>
                    {item.type === "decision" ? (
                      <span className={styles.itemTarget}>等待你的决定</span>
                    ) : item.type === "control-approval" ? (
                      <span className={styles.itemTarget}>敏感操作待审批</span>
                    ) : (
                      <span className={styles.itemTarget}>
                        验证通过，等待验收
                      </span>
                    )}
                  </button>
                </li>
              ))}
            </ul>
          </section>
          {!compact ? (
            <aside className={styles.detailPanel} aria-label="待处理详情">
              <QueueDetail
                key={selectedItem?.id ?? "empty"}
                item={selectedItem}
                workspaceNames={
                  new Map(
                    workspaces.map((node) => [node.workspaceId, node.name]),
                  )
                }
                projectId={projectId}
                actor={actor ?? ""}
                token={token ?? undefined}
                acceptanceOpen={acceptanceOpenFor === selectedItem?.id}
                lastReceipt={lastReceipt}
                onOpenAcceptance={() =>
                  setAcceptanceOpenFor(selectedItem?.id ?? null)
                }
                onSubmitted={onSubmitted}
              />
            </aside>
          ) : null}
          <Sheet
            open={mobileSheetOpen}
            title="待处理详情"
            mobileFullscreen
            onClose={() => {
              setSelectedId(null);
              setAcceptanceOpenFor(null);
            }}
          >
            <QueueDetail
              key={selectedItem?.id ?? "empty"}
              item={selectedItem}
              workspaceNames={
                new Map(workspaces.map((node) => [node.workspaceId, node.name]))
              }
              projectId={projectId}
              actor={actor ?? ""}
              token={token ?? undefined}
              acceptanceOpen={acceptanceOpenFor === selectedItem?.id}
              lastReceipt={lastReceipt}
              onOpenAcceptance={() =>
                setAcceptanceOpenFor(selectedItem?.id ?? null)
              }
              onSubmitted={onSubmitted}
            />
          </Sheet>
        </div>
      )}
    </div>
  );
}

function QueueHeader() {
  return (
    <header className={styles.header}>
      <div>
        <p className={styles.eyebrow}>需要你处理</p>
        <h1 className={styles.heading}>待处理</h1>
      </div>
      <p className={styles.intro}>这里集中显示需要你确认、授权或验收的事项。</p>
    </header>
  );
}

function QueueDetail({
  item,
  workspaceNames,
  projectId,
  actor,
  token,
  acceptanceOpen,
  lastReceipt,
  onOpenAcceptance,
  onSubmitted,
}: {
  readonly item: QueueItem | null;
  readonly workspaceNames: ReadonlyMap<string, string>;
  readonly projectId: string;
  readonly actor: string;
  readonly token?: string | undefined;
  readonly acceptanceOpen: boolean;
  readonly lastReceipt: CommandReceiptView | null;
  readonly onOpenAcceptance: () => void;
  readonly onSubmitted: (receipt: CommandReceiptView) => void;
}) {
  if (item === null) {
    return <Empty>选择一条待处理事项查看详情和可用操作。</Empty>;
  }
  const openTarget = (): void => {
    if (item.type !== "acceptance") {
      navigate({
        name: "workspace",
        projectId,
        workspaceId: item.workspaceId,
        tab: "inbox",
      });
    } else {
      navigate({
        name: "work",
        projectId,
        workspaceId: item.workspaceId,
        workId: item.workId,
      });
    }
  };
  return (
    <div className={styles.detailContent}>
      <div className={styles.detailTopline}>
        <Badge tone={item.type === "acceptance" ? "leaf" : "attention"}>
          {item.type === "decision"
            ? "待决事项"
            : item.type === "control-approval"
              ? "操作审批"
              : "工作验收"}
        </Badge>
        <span className={styles.detailWorkspace}>{item.workspaceName}</span>
      </div>
      {item.type === "decision" ? (
        <>
          <h2>{decisionSummary(item.summary)}</h2>
          <RecordDecisionForm
            actor={actor}
            projectId={projectId}
            target={{
              proposalId: item.target.proposalId,
              proposalRevision: item.target.proposalRevision,
              summary: decisionSummary(item.summary),
            }}
            token={token}
            onSubmitted={onSubmitted}
          />
        </>
      ) : item.type === "control-approval" ? (
        <>
          <h2>{approvalTitle(item.summary)}</h2>
          <ResolveControlApprovalForm
            actor={actor}
            projectId={projectId}
            approvalId={item.target.approvalId}
            approvalRevision={item.target.approvalRevision}
            summary={item.summary}
            workspaceId={item.workspaceId}
            workspaceNames={workspaceNames}
            token={token}
            onSubmitted={onSubmitted}
          />
        </>
      ) : (
        <>
          <h2>{item.objective}</h2>
          {acceptanceOpen ? (
            <AcceptWorkOutcomeForm
              actor={actor}
              projectId={projectId}
              workId={item.workId}
              targetWorkRevision={item.targetWorkRevision}
              verificationId={item.verificationId}
              token={token}
              onSubmitted={onSubmitted}
            />
          ) : (
            <Button variant="primary" onClick={onOpenAcceptance}>
              验收成果
            </Button>
          )}
        </>
      )}
      <Button variant="quiet" onClick={openTarget}>
        {item.type === "acceptance" ? "查看工作与验证" : "查看相关消息"}
      </Button>
      {lastReceipt === null ? null : (
        <p
          className={
            lastReceipt.resolution === "Committed"
              ? styles.receiptCommitted
              : styles.receiptRejected
          }
          role="status"
        >
          {lastReceipt.resolution === "Committed"
            ? "已完成处理"
            : "这项操作未能完成，请检查后重试"}
        </p>
      )}
    </div>
  );
}
