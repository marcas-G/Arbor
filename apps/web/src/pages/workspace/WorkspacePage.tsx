/**
 * W-05 — Workspace（master-detail，frozen §2.4）：常驻头部 + 五 tab。
 * URL 是 tab 的权威（navigate 切换）；各 tab 数据独立 view query；查询
 * 失败就地 ProblemCard。头部 subtreeAttention 无 detail 字段，按 Overview
 * 同款客户端组合从 responsibility-tree 节点取（找不到 = 空槽）。
 */
import type {
  Problem,
  TranscriptReq,
  VerificationRes,
  ViewRequestMap,
  WorkspaceDetailRes,
} from "@arbor/api-contracts";
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import {
  navigate,
  type Route,
  WORKSPACE_TABS,
  type WorkspaceTab,
} from "../../api/router.js";
import { useViewQuery } from "../../api/useViewQuery.js";
import { SteerWorkForm } from "../../commands/forms/SteerWorkForm.js";
import { StopExecutionForm } from "../../commands/forms/StopExecutionForm.js";
import type { CommandReceiptView } from "../../commands/submitCommand.js";
import { Badge } from "../../components/Badge.js";
import { Button } from "../../components/Button.js";
import { Card } from "../../components/Card.js";
import { Empty } from "../../components/Empty.js";
import { MonoText } from "../../components/MonoText.js";
import { StatusBadge } from "../../components/StatusBadge.js";
import { Tabs } from "../../components/Tabs.js";
import { ProblemCard } from "../../problems/ProblemCard.js";
import { useSession } from "../../session/SessionContext.js";
import { CurrentWorkView } from "../../views/CurrentWorkView.js";
import { DependencyView } from "../../views/DependencyView.js";
import { InboxView } from "../../views/InboxView.js";
import { TimeText } from "../../views/shared.js";
import { TranscriptView } from "../../views/TranscriptView.js";
import { VerificationView } from "../../views/VerificationView.js";
import styles from "./workspace.module.css";

type WorkspaceId = ViewRequestMap["workspace-detail"]["workspaceId"];
type ProjectId = ViewRequestMap["responsibility-tree"]["projectId"];
type Boundary = WorkspaceDetailRes["boundary"];
type Address = Boundary["addresses"][number];

const TAB_ITEMS: ReadonlyArray<{
  readonly key: WorkspaceTab;
  readonly label: string;
}> = [
  { key: "overview", label: "概要" },
  { key: "dependencies", label: "依赖" },
  { key: "verification", label: "验证" },
  { key: "transcript", label: "对话记录" },
  { key: "inbox", label: "收件箱" },
];

const isWorkspaceTab = (value: string): value is WorkspaceTab =>
  (WORKSPACE_TABS as ReadonlyArray<string>).includes(value);

const TRANSCRIPT_PAGE_SIZE = 20;

const EMPTY_VERIFICATION: VerificationRes = {
  criteriaResults: [],
  evidenceRefs: [],
};

/** transport 层抛出的就是 frozen Problem（useViewQuery queryFn 约定）。 */
const asProblem = (error: unknown): Problem => error as Problem;

const addressText = (address: Address): string => {
  switch (address._tag) {
    case "FileTree":
      return `FileTree ${address.path}`;
    case "GitWorktree":
      return `GitWorktree ${address.path}${
        address.branch === undefined ? "" : ` @${address.branch}`
      }`;
    case "DatabaseNamespace":
      return `DatabaseNamespace ${address.namespace}`;
    case "ExternalResource":
      return `ExternalResource ${address.address}`;
    default:
      return JSON.stringify(address) ?? "unknown-address";
  }
};

const boundaryBrief = (boundary: Boundary): string => {
  const first = boundary.addresses[0];
  if (first === undefined) {
    return "无资源地址";
  }
  const total = boundary.addresses.length;
  return `${addressText(first)}${total > 1 ? ` 等 ${String(total)} 个地址` : ""}`;
};

function WorkspaceHeader({
  projectId,
  workspaceId,
}: {
  readonly projectId: ProjectId;
  readonly workspaceId: WorkspaceId;
}) {
  const detail = useViewQuery("workspace-detail", { workspaceId });
  const tree = useViewQuery("responsibility-tree", { projectId });
  const attention = tree.data?.nodes.find(
    (node) => node.workspaceId === workspaceId,
  )?.subtreeAttention;
  return (
    <header className={styles.header}>
      <div className={styles.headerMain}>
        <div className={styles.idLine}>
          <MonoText>{workspaceId}</MonoText>
          {attention === undefined ? null : (
            <span className={styles.attentionRow}>
              {attention.attention > 0 ? (
                <Badge tone="attention">{`attention ${String(attention.attention)}`}</Badge>
              ) : null}
              {attention.actionRequired > 0 ? (
                <Badge tone="danger">{`actionRequired ${String(attention.actionRequired)}`}</Badge>
              ) : null}
            </span>
          )}
        </div>
        {detail.isPending ? (
          <Empty>加载中</Empty>
        ) : detail.isError ? (
          <ProblemCard problem={asProblem(detail.error)} />
        ) : (
          <>
            <div className={styles.metaLine}>
              <StatusBadge
                label={detail.data.currentWork?.status ?? "无当前工作"}
              />
            </div>
            <p className={styles.purpose}>
              {detail.data.responsibility.purpose}
            </p>
            <p className={styles.boundary}>
              {boundaryBrief(detail.data.boundary)}
            </p>
          </>
        )}
      </div>
      <ContextualGovernance
        projectId={projectId}
        workspaceId={workspaceId}
        currentWork={detail.data?.currentWork ?? null}
      />
    </header>
  );
}

function OverviewTab({
  projectId,
  workspaceId,
}: {
  readonly projectId: string;
  readonly workspaceId: WorkspaceId;
}) {
  const detail = useViewQuery("workspace-detail", { workspaceId });
  const currentWork = useViewQuery("current-work", { workspaceId });
  return (
    <div className="arbor-view-stack">
      {currentWork.isPending ? (
        <Empty>加载中</Empty>
      ) : currentWork.isError ? (
        <ProblemCard problem={asProblem(currentWork.error)} />
      ) : (
        <CurrentWorkView work={currentWork.data ?? null} />
      )}
      {detail.isPending ? (
        <Empty>加载中</Empty>
      ) : detail.isError ? (
        <ProblemCard problem={asProblem(detail.error)} />
      ) : (
        <>
          <Card title="Pending Works">
            {detail.data.pendingWorks.length === 0 ? (
              <Empty>无待办工作</Empty>
            ) : (
              <ul className={styles.pendingList}>
                {detail.data.pendingWorks.map((work) => (
                  <li key={work.workId}>
                    <button
                      type="button"
                      className={styles.pendingRow}
                      onClick={() => {
                        navigate({
                          name: "work",
                          projectId,
                          workspaceId,
                          workId: work.workId,
                        });
                      }}
                    >
                      <MonoText>{work.workId}</MonoText>
                      <span>{work.objective}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </Card>
          {detail.data.executionSummary == null ? null : (
            <Card title="执行摘要">
              <span>
                <MonoText>{detail.data.executionSummary.executionId}</MonoText>{" "}
                <TimeText at={detail.data.executionSummary.admittedAt} />
              </span>
            </Card>
          )}
        </>
      )}
    </div>
  );
}

function DependencyTab({ workspaceId }: { readonly workspaceId: WorkspaceId }) {
  const query = useViewQuery("dependency-view", { workspaceId });
  if (query.isPending) {
    return <Empty>加载中</Empty>;
  }
  if (query.isError) {
    return <ProblemCard problem={asProblem(query.error)} />;
  }
  return <DependencyView res={query.data} />;
}

function VerificationTab({
  workspaceId,
}: {
  readonly workspaceId: WorkspaceId;
}) {
  const detail = useViewQuery("workspace-detail", { workspaceId });
  if (detail.isPending) {
    return <Empty>加载中</Empty>;
  }
  if (detail.isError) {
    return <ProblemCard problem={asProblem(detail.error)} />;
  }
  return (
    <VerificationView view={detail.data.verification ?? EMPTY_VERIFICATION} />
  );
}

function TranscriptTab({ workspaceId }: { readonly workspaceId: WorkspaceId }) {
  const [cursor, setCursor] = useState<string | undefined>(undefined);
  const request: TranscriptReq =
    cursor === undefined
      ? { workspaceId, limit: TRANSCRIPT_PAGE_SIZE }
      : { workspaceId, cursor, limit: TRANSCRIPT_PAGE_SIZE };
  const query = useViewQuery("transcript", request);
  if (query.isPending) {
    return <Empty>加载中</Empty>;
  }
  if (query.isError) {
    return <ProblemCard problem={asProblem(query.error)} />;
  }
  return (
    <TranscriptView
      res={query.data}
      onLoadMore={(nextCursor) => {
        setCursor(nextCursor);
      }}
    />
  );
}

function InboxTab({ workspaceId }: { readonly workspaceId: WorkspaceId }) {
  const query = useViewQuery("inbox-view", { workspaceId });
  if (query.isPending) {
    return <Empty>加载中</Empty>;
  }
  if (query.isError) {
    return <ProblemCard problem={asProblem(query.error)} />;
  }
  return <InboxView res={query.data} />;
}

export function WorkspacePage({
  route,
}: {
  readonly route: Extract<Route, { name: "workspace" }>;
}) {
  const { projectId, workspaceId, tab } = route;
  const workspaceIdTyped = workspaceId as WorkspaceId;
  const handleTabChange = (key: string): void => {
    if (!isWorkspaceTab(key)) {
      return;
    }
    navigate({ name: "workspace", projectId, workspaceId, tab: key });
  };
  return (
    <div className={styles.page}>
      <WorkspaceHeader
        projectId={projectId as ProjectId}
        workspaceId={workspaceIdTyped}
      />
      <Tabs items={TAB_ITEMS} active={tab} onChange={handleTabChange} />
      <div className={styles.tabPanel} key={workspaceId}>
        {tab === "overview" ? (
          <OverviewTab projectId={projectId} workspaceId={workspaceIdTyped} />
        ) : tab === "dependencies" ? (
          <DependencyTab workspaceId={workspaceIdTyped} />
        ) : tab === "verification" ? (
          <VerificationTab workspaceId={workspaceIdTyped} />
        ) : tab === "transcript" ? (
          <TranscriptTab workspaceId={workspaceIdTyped} />
        ) : (
          <InboxTab workspaceId={workspaceIdTyped} />
        )}
      </div>
    </div>
  );
}

/** W-08 — contextual governance (frozen §5): SteerWork / StopExecution live
 * ONLY here and in Work/active-Execution contexts (never on the Tree). */
function ContextualGovernance({
  projectId,
  workspaceId,
  currentWork,
}: {
  readonly projectId: string;
  readonly workspaceId: string;
  readonly currentWork: {
    readonly workId?: string | undefined;
    readonly objective: string;
    readonly activeExecution?:
      | { readonly executionId: string; readonly admittedAt: string }
      | undefined;
  } | null;
}) {
  const session = useSession();
  const queryClient = useQueryClient();
  const [mode, setMode] = useState<"steer" | "stop" | null>(null);
  const onSubmitted = (receipt: CommandReceiptView): void => {
    setMode(null);
    void queryClient.invalidateQueries({ queryKey: ["view"] });
  };
  const executionId = currentWork?.activeExecution?.executionId ?? null;
  const workId = currentWork?.workId ?? null;
  return (
    <div className={styles.governance}>
      <span className={styles.governanceCaption}>上下文治理</span>
      <div className={styles.governanceActions}>
        <Button
          variant="quiet"
          disabled={workId === null}
          onClick={() => {
            setMode("steer");
          }}
        >
          纠偏
        </Button>
        <Button
          variant="danger"
          disabled={executionId === null}
          onClick={() => {
            setMode("stop");
          }}
        >
          紧急停止
        </Button>
      </div>
      {mode === "steer" && workId !== null ? (
        <SteerWorkForm
          actor={session.actor ?? ""}
          projectId={projectId}
          workId={workId}
          workspaceId={workspaceId}
          objective={currentWork?.objective ?? ""}
          expectedWorkRevision={0}
          token={session.token ?? undefined}
          onSubmitted={onSubmitted}
        />
      ) : null}
      {mode === "stop" && executionId !== null ? (
        <StopExecutionForm
          actor={session.actor ?? ""}
          projectId={projectId}
          executionId={executionId}
          token={session.token ?? undefined}
          onSubmitted={onSubmitted}
        />
      ) : null}
    </div>
  );
}
