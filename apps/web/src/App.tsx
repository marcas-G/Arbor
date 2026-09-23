/**
 * P13 integration shell (contract `03` §4 IA): SessionProvider wraps
 * everything; before a session exists only the LoginCard shows. Connected:
 * top bar (projectId / actor / disconnect), main nav Tree·Attention·Usage,
 * workspace drill-down (detail + current-work/verification/dependency/
 * transcript/inbox tabs), governance command panel, and the WS invalidation
 * channel driving refetch (`01` §3). Any request returning an
 * `unauthenticated` problem swaps the main area for the UnauthorizedGate.
 */

import type {
  AttentionRes,
  CurrentWorkRes,
  DependencyRes,
  InboxViewRes,
  Problem,
  TranscriptRes,
  TreeViewRes,
  UsageRes,
  WorkspaceDetailRes,
} from "@arbor/api-contracts";
import { type UseQueryResult, useQueryClient } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useViewQuery } from "./api/useViewQuery.js";
import { AcceptWorkOutcomeForm } from "./commands/forms/AcceptWorkOutcomeForm.js";
import { CreateProjectForm } from "./commands/forms/CreateProjectForm.js";
import { RecordDecisionForm } from "./commands/forms/RecordDecisionForm.js";
import { SteerWorkForm } from "./commands/forms/SteerWorkForm.js";
import { StopExecutionForm } from "./commands/forms/StopExecutionForm.js";
import type { CommandReceiptView } from "./commands/submitCommand.js";
import { Button } from "./components/Button.js";
import { Card } from "./components/Card.js";
import { Empty } from "./components/Empty.js";
import { Field } from "./components/Field.js";
import { ProblemCard } from "./problems/ProblemCard.js";
import { AppProviders } from "./providers/AppProviders.js";
import { LoginCard } from "./session/LoginCard.js";
import { useSession } from "./session/SessionContext.js";
import { UnauthorizedGate } from "./session/UnauthorizedGate.js";
import { AttentionView } from "./views/AttentionView.js";
import { CurrentWorkView } from "./views/CurrentWorkView.js";
import { DependencyView } from "./views/DependencyView.js";
import { InboxView } from "./views/InboxView.js";
import { ResponsibilityTreeView } from "./views/ResponsibilityTreeView.js";
import { TranscriptView } from "./views/TranscriptView.js";
import { UsageView } from "./views/UsageView.js";
import { VerificationView } from "./views/VerificationView.js";
import { WorkspaceDetailView } from "./views/WorkspaceDetailView.js";
import "./components/components.css";
import "./views/views.css";
import "./problems/problems.css";
import "./session/session.css";

export function App() {
  return (
    <AppProviders>
      <AppShell />
    </AppProviders>
  );
}

/** A query-bound view section: loading / Problem / DTO (`03` §3).
 * Refetch is Query-driven (WS invalidation → invalidateQueries). */
function ViewSection({
  query,
  children,
}: {
  readonly query: UseQueryResult<never> | UseQueryResult<unknown>;
  readonly children: (dto: unknown) => ReactNode;
}) {
  if (query.isPending) {
    return <Empty>加载中…</Empty>;
  }
  if (query.isError) {
    return (
      <ProblemCard
        problem={query.error as unknown as Problem}
        onRetry={() => {
          void query.refetch();
        }}
      />
    );
  }
  return <>{children(query.data)}</>;
}

function AppShell() {
  const session = useSession();
  const connected = session.token !== null;
  const projectIdReady =
    session.projectId !== null && session.projectId.trim() !== ""
      ? session.projectId
      : null;
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState<string | null>(
    null,
  );
  const [workspaceTab, setWorkspaceTab] = useState<
    | "detail"
    | "current-work"
    | "verification"
    | "dependency"
    | "transcript"
    | "inbox"
  >("detail");

  return (
    <div className="arbor-app">
      <header className="arbor-topbar">
        <span className="arbor-brand">Arbor</span>
        {connected ? (
          <div className="arbor-topbar-session">
            <Field
              control="input"
              label="项目 ID"
              placeholder="prj_…"
              value={session.projectId ?? ""}
              onChange={session.setProjectId}
            />
            <span className="arbor-topbar-actor">{session.actor}</span>
            <Button variant="quiet" onClick={session.clearSession}>
              断开
            </Button>
          </div>
        ) : null}
      </header>
      <main aria-label="arbor-main" className="arbor-main">
        {!connected ? (
          <LoginCard />
        ) : session.unauthenticatedProblem !== null ? (
          <UnauthorizedGate
            problem={session.unauthenticatedProblem}
            onRelogin={session.clearSession}
          />
        ) : (
          <div className="arbor-view-stack">
            {projectIdReady === null ? (
              <Card title="责任树">
                <Empty>先在顶栏设置项目 ID，或通过下方“创建项目”新建</Empty>
              </Card>
            ) : (
              <>
                <TreeCard
                  projectId={projectIdReady}
                  onOpenWorkspace={setSelectedWorkspaceId}
                />
                <AttentionCard
                  projectId={projectIdReady}
                  onOpenWorkspace={setSelectedWorkspaceId}
                />
                <UsageCard projectId={projectIdReady} />
              </>
            )}
            {selectedWorkspaceId !== null && projectIdReady !== null ? (
              <WorkspaceCard
                projectId={projectIdReady}
                workspaceId={selectedWorkspaceId}
                tab={workspaceTab}
                onTab={setWorkspaceTab}
              />
            ) : null}
            <CommandPanel
              projectIdReady={projectIdReady}
              selectedWorkspaceId={selectedWorkspaceId}
              onProjectCreated={session.setProjectId}
            />
          </div>
        )}
      </main>
    </div>
  );
}

function TreeCard({
  projectId,
  onOpenWorkspace,
}: {
  readonly projectId: string;
  readonly onOpenWorkspace: (workspaceId: string) => void;
}) {
  const query = useViewQuery("responsibility-tree", {
    projectId: projectId as never,
  });
  return (
    <Card title="责任树">
      <ViewSection query={query}>
        {(dto) => (
          <ResponsibilityTreeView
            res={dto as TreeViewRes}
            onOpenWorkspace={onOpenWorkspace}
          />
        )}
      </ViewSection>
    </Card>
  );
}

function AttentionCard({
  projectId,
  onOpenWorkspace,
}: {
  readonly projectId: string;
  readonly onOpenWorkspace: (workspaceId: string) => void;
}) {
  const query = useViewQuery("attention", { projectId: projectId as never });
  return (
    <Card title="关注事项（Attention）">
      <ViewSection query={query}>
        {(dto) => (
          <AttentionView
            res={dto as AttentionRes}
            onOpenWorkspace={onOpenWorkspace}
          />
        )}
      </ViewSection>
    </Card>
  );
}

function UsageCard({ projectId }: { readonly projectId: string }) {
  const [groupBy, setGroupBy] = useState<"workspace" | "subtree" | "project">(
    "workspace",
  );
  const query = useViewQuery("usage", {
    projectId: projectId as never,
    groupBy,
  });
  return (
    <Card title="用量（Usage）">
      <ViewSection query={query}>
        {(dto) => (
          <UsageView
            res={dto as UsageRes}
            groupBy={groupBy}
            onGroupByChange={setGroupBy}
          />
        )}
      </ViewSection>
    </Card>
  );
}

const WORKSPACE_TABS = [
  "detail",
  "current-work",
  "verification",
  "dependency",
  "transcript",
  "inbox",
] as const;

function WorkspaceCard({
  projectId,
  workspaceId,
  tab,
  onTab,
}: {
  readonly projectId: string;
  readonly workspaceId: string;
  readonly tab: (typeof WORKSPACE_TABS)[number];
  readonly onTab: (tab: (typeof WORKSPACE_TABS)[number]) => void;
}) {
  const [transcriptCursor, setTranscriptCursor] = useState<string | undefined>(
    undefined,
  );

  const detail = useViewQuery("workspace-detail", {
    workspaceId: workspaceId as never,
  });
  const currentWork = useViewQuery("current-work", {
    workspaceId: workspaceId as never,
  });
  // workspace-detail already carries the verification block; the dedicated
  // verification view is work-scoped, so the tab reuses the detail payload.
  const verification = detail;
  const dependency = useViewQuery("dependency-view", {
    workspaceId: workspaceId as never,
  } as never);
  const transcript = useViewQuery("transcript", {
    workspaceId: workspaceId as never,
    ...(transcriptCursor !== undefined ? { cursor: transcriptCursor } : {}),
    limit: 20,
  } as never);
  const inbox = useViewQuery("inbox-view", {
    workspaceId: workspaceId as never,
  });

  return (
    <Card title={`工作区 ${workspaceId}`}>
      <div className="arbor-workspace-tabs">
        {WORKSPACE_TABS.map((name) => (
          <Button
            key={name}
            variant={name === tab ? "primary" : "quiet"}
            onClick={() => {
              onTab(name);
            }}
          >
            {name}
          </Button>
        ))}
      </div>
      {tab === "detail" ? (
        <ViewSection query={detail}>
          {(dto) => <WorkspaceDetailView res={dto as WorkspaceDetailRes} />}
        </ViewSection>
      ) : null}
      {tab === "current-work" ? (
        <ViewSection query={currentWork}>
          {(dto) => <CurrentWorkView work={dto as CurrentWorkRes} />}
        </ViewSection>
      ) : null}
      {tab === "verification" ? (
        <ViewSection query={verification}>
          {(dto) => (
            <VerificationView
              view={
                (dto as WorkspaceDetailRes).verification ?? {
                  criteriaResults: [],
                  evidenceRefs: [],
                }
              }
            />
          )}
        </ViewSection>
      ) : null}
      {tab === "dependency" ? (
        <ViewSection query={dependency}>
          {(dto) => <DependencyView res={dto as DependencyRes} />}
        </ViewSection>
      ) : null}
      {tab === "transcript" ? (
        <ViewSection query={transcript}>
          {(dto) => (
            <TranscriptView
              res={dto as TranscriptRes}
              onLoadMore={setTranscriptCursor}
            />
          )}
        </ViewSection>
      ) : null}
      {tab === "inbox" ? (
        <ViewSection query={inbox}>
          {(dto) => <InboxView res={dto as InboxViewRes} />}
        </ViewSection>
      ) : null}
    </Card>
  );
}

type PanelForm =
  | "CreateProject"
  | "RecordDecision"
  | "SteerWork"
  | "StopExecution"
  | "AcceptWorkOutcome";

function CommandPanel({
  projectIdReady,
  selectedWorkspaceId,
  onProjectCreated,
}: {
  readonly projectIdReady: string | null;
  readonly selectedWorkspaceId: string | null;
  readonly onProjectCreated: (projectId: string) => void;
}) {
  const queryClient = useQueryClient();
  const onReload = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: ["view"] });
  }, [queryClient]);
  const workspaceId = selectedWorkspaceId ?? "ws_demo";
  const { actor, token } = useSession();
  const [activeForm, setActiveForm] = useState<PanelForm | null>(null);
  const [lastReceipt, setLastReceipt] = useState<CommandReceiptView | null>(
    null,
  );
  const handleSubmitted = useCallback(
    (receipt: CommandReceiptView): void => {
      setLastReceipt(receipt);
      setActiveForm(null);
      onReload();
      const result = receipt.result as { readonly projectId?: unknown } | null;
      if (
        typeof result === "object" &&
        result !== null &&
        typeof result.projectId === "string"
      ) {
        onProjectCreated(result.projectId);
      }
    },
    [onProjectCreated, onReload],
  );
  const formToken = token === null ? undefined : token;
  return (
    <Card title="治理命令面板">
      <div className="arbor-view-stack">
        {lastReceipt !== null ? (
          <p className="arbor-command-receipt arbor-command-receipt-committed">
            最近命令：
            {lastReceipt.resolution === "Committed" ? "已提交" : "被拒绝"}{" "}
            <span className="arbor-mono">{lastReceipt.commandId}</span>
          </p>
        ) : null}
        <div className="arbor-command-panel-actions">
          {projectIdReady === null ? (
            <Button
              variant="primary"
              onClick={() => setActiveForm("CreateProject")}
            >
              创建项目
            </Button>
          ) : (
            <>
              <Button onClick={() => setActiveForm("RecordDecision")}>
                记录决策
              </Button>
              <Button onClick={() => setActiveForm("SteerWork")}>纠偏</Button>
              <Button onClick={() => setActiveForm("AcceptWorkOutcome")}>
                验收成果
              </Button>
              <Button
                variant="danger"
                onClick={() => setActiveForm("StopExecution")}
              >
                紧急停止
              </Button>
            </>
          )}
        </div>
        {activeForm !== null && projectIdReady !== null ? (
          <>
            {activeForm === "RecordDecision" ? (
              <RecordDecisionForm
                actor={actor ?? ""}
                projectId={projectIdReady}
                proposal={{
                  proposalId: "fml_demo",
                  revision: 1,
                  summary: "demo",
                }}
                token={formToken}
                onSubmitted={handleSubmitted}
              />
            ) : null}
            {activeForm === "SteerWork" ? (
              <SteerWorkForm
                actor={actor ?? ""}
                projectId={projectIdReady}
                workId="wrk_demo"
                workspaceId={workspaceId}
                objective="（占位）当前工作目标"
                expectedWorkRevision={0}
                token={formToken}
                onSubmitted={handleSubmitted}
              />
            ) : null}
            {activeForm === "AcceptWorkOutcome" ? (
              <AcceptWorkOutcomeForm
                actor={actor ?? ""}
                projectId={projectIdReady}
                workId="wrk_demo"
                targetWorkRevision={0}
                verificationId="ver_demo"
                token={formToken}
                onSubmitted={handleSubmitted}
              />
            ) : null}
            {activeForm === "StopExecution" ? (
              <StopExecutionForm
                actor={actor ?? ""}
                projectId={projectIdReady}
                executionId="exe_demo"
                token={formToken}
                onSubmitted={handleSubmitted}
              />
            ) : null}
          </>
        ) : null}
        {activeForm === "CreateProject" ? (
          <CreateProjectForm
            actor={actor ?? ""}
            token={formToken}
            onSubmitted={handleSubmitted}
          />
        ) : null}
      </div>
    </Card>
  );
}
