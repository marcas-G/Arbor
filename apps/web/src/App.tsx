/**
 * P13-007 integration shell: SessionProvider wraps everything; before a
 * session exists only the LoginCard shows. Once connected the top bar holds
 * the projectId input, the remembered actor, and the disconnect button; the
 * main area pairs the responsibility-tree section (useArborFetch → view) with
 * a minimal governance command panel (placeholder targets prove the wiring;
 * P13-008 replaces them with real data + routing/layout). Any request that
 * returns an `unauthenticated` problem swaps the whole main area for the
 * UnauthorizedGate (EC-4).
 */

import type { TreeViewRes } from "@arbor/api-contracts";
import { useCallback, useEffect, useMemo, useState } from "react";
import { CreateProjectForm } from "./commands/forms/CreateProjectForm.js";
import { RecordDecisionForm } from "./commands/forms/RecordDecisionForm.js";
import { SteerWorkForm } from "./commands/forms/SteerWorkForm.js";
import { StopExecutionForm } from "./commands/forms/StopExecutionForm.js";
import { Button } from "./components/Button.js";
import { Card } from "./components/Card.js";
import { Empty } from "./components/Empty.js";
import { Field } from "./components/Field.js";
import { ProblemCard } from "./problems/ProblemCard.js";
import { LoginCard } from "./session/LoginCard.js";
import { SessionProvider, useSession } from "./session/SessionContext.js";
import { UnauthorizedGate } from "./session/UnauthorizedGate.js";
import type { ViewOutcome } from "./session/useSessionFetch.js";
import { useArborFetch } from "./session/useSessionFetch.js";
import { ResponsibilityTreeView } from "./views/ResponsibilityTreeView.js";
import "./components/components.css";
import "./views/views.css";
import "./problems/problems.css";
import "./session/session.css";

export function App() {
  return (
    <SessionProvider>
      <AppShell />
    </SessionProvider>
  );
}

function AppShell() {
  const session = useSession();
  const connected = session.token !== null;
  const projectIdReady =
    session.projectId !== null && session.projectId.trim() !== ""
      ? session.projectId
      : null;
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
            <Card title="责任树">
              {projectIdReady === null ? (
                <Empty>先在顶栏设置项目 ID</Empty>
              ) : (
                <ResponsibilityTreeSection projectId={projectIdReady} />
              )}
            </Card>
            <CommandPanel projectIdReady={projectIdReady} />
          </div>
        )}
      </main>
    </div>
  );
}

function ResponsibilityTreeSection({
  projectId,
}: {
  readonly projectId: string;
}) {
  const { get } = useArborFetch();
  const [outcome, setOutcome] = useState<ViewOutcome<TreeViewRes> | null>(null);
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState<string | null>(
    null,
  );
  const [attempt, setAttempt] = useState(0);
  const request = useMemo(() => ({ projectId, attempt }), [projectId, attempt]);

  useEffect(() => {
    let cancelled = false;
    setOutcome(null);
    setSelectedWorkspaceId(null);
    get("responsibility-tree", {
      projectId: request.projectId as never,
    }).then((next) => {
      if (!cancelled) {
        setOutcome(next);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [get, request]);

  const retry = useCallback((): void => {
    setAttempt((count) => count + 1);
  }, []);

  if (outcome === null) {
    return <Empty>责任树加载中…</Empty>;
  }
  if (!outcome.ok) {
    return <ProblemCard problem={outcome.problem} onRetry={retry} />;
  }
  return (
    <div className="arbor-view-stack">
      <ResponsibilityTreeView
        res={outcome.dto}
        onOpenWorkspace={setSelectedWorkspaceId}
      />
      {selectedWorkspaceId === null ? null : (
        <p className="arbor-tree-id">已选工作区 {selectedWorkspaceId}</p>
      )}
    </div>
  );
}

type PanelForm =
  | "CreateProject"
  | "RecordDecision"
  | "SteerWork"
  | "StopExecution";

function CommandPanel({
  projectIdReady,
}: {
  readonly projectIdReady: string | null;
}) {
  const { actor, token } = useSession();
  const [activeForm, setActiveForm] = useState<PanelForm | null>(null);
  const onSubmitted = useCallback((): void => {
    setActiveForm(null);
  }, []);
  const formToken = token === null ? undefined : token;
  return (
    <Card title="治理命令面板">
      <div className="arbor-view-stack">
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
                onSubmitted={onSubmitted}
              />
            ) : null}
            {activeForm === "SteerWork" ? (
              <SteerWorkForm
                actor={actor ?? ""}
                projectId={projectIdReady}
                workId="wrk_demo"
                objective="（占位）当前工作目标"
                token={formToken}
                onSubmitted={onSubmitted}
              />
            ) : null}
            {activeForm === "StopExecution" ? (
              <StopExecutionForm
                actor={actor ?? ""}
                projectId={projectIdReady}
                executionId="exe_demo"
                token={formToken}
                onSubmitted={onSubmitted}
              />
            ) : null}
          </>
        ) : null}
        {activeForm === "CreateProject" ? (
          <CreateProjectForm
            actor={actor ?? ""}
            token={formToken}
            onSubmitted={onSubmitted}
          />
        ) : null}
      </div>
    </Card>
  );
}
