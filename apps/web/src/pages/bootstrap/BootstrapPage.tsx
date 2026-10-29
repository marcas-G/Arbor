/**
 * web-v1 bootstrap entry: when connected with no project in the URL/session,
 * `/` has no project-scoped route. This page renders the CreateProject form
 * and, on commit, enters the new project's Root Workbench. No new
 * transport/command semantics: it reuses the frozen CreateProjectForm +
 * navigate.
 */
import type { ReactNode } from "react";
import { CreateProjectForm } from "../../commands/forms/CreateProjectForm.js";
import type { CommandReceiptView } from "../../commands/submitCommand.js";
import { Icon } from "../../components/Icon.js";
import { useSession } from "../../session/SessionContext.js";

export function BootstrapPage({
  onSubmitted,
}: {
  readonly onSubmitted: (receipt: CommandReceiptView) => void;
}): ReactNode {
  const session = useSession();
  return (
    <div className="arbor-bootstrap">
      <section className="arbor-bootstrap-intro">
        <span className="arbor-bootstrap-mark">
          <Icon name="leaf" size={28} />
        </span>
        <p className="arbor-bootstrap-eyebrow">ARBOR WORKSPACE</p>
        <h1>把复杂目标，变成持续推进的工作</h1>
        <p>
          创建一个项目。Arbor 会用长期责任组织工作，并在对话中与你协作推进。
        </p>
      </section>
      <div className="arbor-session-login">
        <CreateProjectForm
          actor={session.actor ?? "user:root"}
          token={session.token ?? undefined}
          onSubmitted={onSubmitted}
        />
      </div>
    </div>
  );
}
