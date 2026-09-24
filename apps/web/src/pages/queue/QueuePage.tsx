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
import type { CommandReceiptView } from "../../commands/submitCommand.js";
import { Badge } from "../../components/Badge.js";
import { Button } from "../../components/Button.js";
import { Card } from "../../components/Card.js";
import { Empty } from "../../components/Empty.js";
import { MonoText } from "../../components/MonoText.js";
import { Sheet } from "../../components/Sheet.js";
import { useCompactLayout } from "../../components/useCompactLayout.js";
import { ProblemCard } from "../../problems/ProblemCard.js";
import {
  type GovernanceTarget,
  parseGovernanceEntryKey,
} from "../../queue/governance-target.js";
import { useSession } from "../../session/SessionContext.js";
import styles from "./queue.module.css";

type DecisionItem = {
  readonly type: "decision";
  readonly id: string;
  readonly workspaceId: string;
  readonly entryKey: string;
  readonly summary: string;
  readonly watermark: number;
  readonly target: GovernanceTarget;
};

type AcceptanceItem = {
  readonly type: "acceptance";
  readonly id: string;
  readonly workspaceId: string;
  readonly workId: string;
  readonly objective: string;
  readonly targetWorkRevision: number;
  readonly verificationId: string;
};

type QueueItem = DecisionItem | AcceptanceItem;

const asProblem = (error: unknown): Problem => error as Problem;

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
          <Empty>正在加载项目工作区</Empty>
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
          aria-label={`工作区 ${workspaceId} 收件箱问题`}
        >
          <h2>工作区 {workspaceId} 暂不可用</h2>
          <ProblemCard problem={problem} />
        </section>
      ))}
      {verificationProblems.map(({ workspaceId, workId, problem }) => (
        <section
          key={`verification-problem:${workId}`}
          className={styles.sourceProblem}
          aria-label={`工作区 ${workspaceId} 验证问题`}
        >
          <h2>工作 {workId} 的验收条件暂不可用</h2>
          <ProblemCard problem={problem} />
        </section>
      ))}
      {items.length === 0 ? (
        <Card title="待处理事项">
          {anyPending ? (
            <Empty>正在核对可精确绑定的待处理事项</Empty>
          ) : inboxProblems.length > 0 ? (
            <Empty>部分工作区无法加载，暂时不能确认队列为空</Empty>
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
                <p className={styles.eyebrow}>Actionable inbox</p>
                <h2>可处理事项</h2>
              </div>
              <Badge tone="attention">{items.length} 条</Badge>
            </header>
            {anyPending ? (
              <p className={styles.pendingNote} role="status">
                正在加载其余工作区事项
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
                        tone={item.type === "decision" ? "attention" : "leaf"}
                      >
                        {item.type === "decision" ? "待决策" : "等待验收"}
                      </Badge>
                      <MonoText>{item.workspaceId}</MonoText>
                    </span>
                    <span className={styles.itemSummary}>
                      {item.type === "decision" ? item.summary : item.objective}
                    </span>
                    {item.type === "decision" ? (
                      <span className={styles.itemTarget}>
                        {item.target.proposalId} · revision{" "}
                        {item.target.proposalRevision}
                      </span>
                    ) : (
                      <span className={styles.itemTarget}>
                        {item.workId} · revision {item.targetWorkRevision}
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
                item={selectedItem}
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
              item={selectedItem}
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
        <p className={styles.eyebrow}>Actionable inbox</p>
        <h1 className={styles.heading}>待处理</h1>
      </div>
      <p className={styles.intro}>仅显示具有精确结构化目标的决策与验收事项。</p>
    </header>
  );
}

function QueueDetail({
  item,
  projectId,
  actor,
  token,
  acceptanceOpen,
  lastReceipt,
  onOpenAcceptance,
  onSubmitted,
}: {
  readonly item: QueueItem | null;
  readonly projectId: string;
  readonly actor: string;
  readonly token?: string | undefined;
  readonly acceptanceOpen: boolean;
  readonly lastReceipt: CommandReceiptView | null;
  readonly onOpenAcceptance: () => void;
  readonly onSubmitted: (receipt: CommandReceiptView) => void;
}) {
  if (item === null) {
    return <Empty>选择一条待处理事项查看精确目标与可用动作。</Empty>;
  }
  const openTarget = (): void => {
    if (item.type === "decision") {
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
        <Badge tone={item.type === "decision" ? "attention" : "leaf"}>
          {item.type === "decision" ? "治理决策" : "工作验收"}
        </Badge>
        <span className={styles.detailWorkspace}>
          工作区 {item.workspaceId}
        </span>
      </div>
      {item.type === "decision" ? (
        <>
          <h2>{item.summary}</h2>
          <dl className={styles.targetList}>
            <div>
              <dt>提案</dt>
              <dd>
                <MonoText>{item.target.proposalId}</MonoText>
              </dd>
            </div>
            <div>
              <dt>目标版本</dt>
              <dd>
                <MonoText>{item.target.proposalRevision}</MonoText>
              </dd>
            </div>
            <div>
              <dt>收件箱水位</dt>
              <dd>
                <MonoText>{item.watermark}</MonoText>
              </dd>
            </div>
          </dl>
          <RecordDecisionForm
            actor={actor}
            projectId={projectId}
            target={{
              proposalId: item.target.proposalId,
              proposalRevision: item.target.proposalRevision,
              summary: item.summary,
            }}
            token={token}
            onSubmitted={onSubmitted}
          />
        </>
      ) : (
        <>
          <h2>{item.objective}</h2>
          <dl className={styles.targetList}>
            <div>
              <dt>工作</dt>
              <dd>
                <MonoText>{item.workId}</MonoText>
              </dd>
            </div>
            <div>
              <dt>目标版本</dt>
              <dd>
                <MonoText>{item.targetWorkRevision}</MonoText>
              </dd>
            </div>
            <div>
              <dt>验证</dt>
              <dd>
                <MonoText>{item.verificationId}</MonoText>
              </dd>
            </div>
          </dl>
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
        {item.type === "decision" ? "打开工作区收件箱" : "查看工作与验证"}
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
          最近命令：
          {lastReceipt.resolution === "Committed" ? "已提交" : "被拒绝"}{" "}
          <MonoText>{lastReceipt.commandId}</MonoText>
        </p>
      )}
    </div>
  );
}
