/**
 * web-v1 bootstrap entry: when connected with no project in the URL/session,
 * `/` has no project-scoped route. This page renders the CreateProject form
 * and, on commit, enters the new project's root-workspace conversation
 * (the chat-first main workspace surface). No new transport/command
 * semantics: it reuses the frozen CreateProjectForm + navigate.
 */
import type { ReactNode } from "react";
import { navigate } from "../../api/router.js";
import { Card } from "../../components/Card.js";
import { CreateProjectForm } from "../../commands/forms/CreateProjectForm.js";
import type { CommandReceiptView } from "../../commands/submitCommand.js";
import { useSession } from "../../session/SessionContext.js";

interface CreateProjectResultView {
  readonly projectId?: string;
  readonly workspaceId?: string;
}

export function BootstrapPage(): ReactNode {
  const session = useSession();
  const onSubmitted = (receipt: CommandReceiptView): void => {
    if (receipt.resolution !== "Committed") {
      return;
    }
    const result = receipt.result as CreateProjectResultView | undefined;
    const projectId = result?.projectId;
    if (projectId === undefined) {
      return;
    }
    session.setProjectId(projectId);
    const workspaceId = result?.workspaceId;
    if (workspaceId !== undefined) {
      navigate({
        name: "workspace",
        projectId,
        workspaceId,
        tab: "conversation",
      });
    } else {
      navigate({ name: "project-overview", projectId });
    }
  };
  return (
    <div className="arbor-session-login">
      <Card title="创建第一个项目">
        <CreateProjectForm
          actor={session.actor ?? "user:root"}
          token={session.token ?? undefined}
          onSubmitted={onSubmitted}
        />
      </Card>
    </div>
  );
}
