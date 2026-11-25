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
import { ProjectDirectoryList } from "../../components/ProjectDirectoryList.js";
import { useSession } from "../../session/SessionContext.js";

export function BootstrapPage({
  onSubmitted,
}: {
  readonly onSubmitted: (receipt: CommandReceiptView) => void;
}): ReactNode {
  const session = useSession();
  return (
    <div className="mx-auto grid min-h-[calc(100vh-10rem)] w-full max-w-[66rem] grid-cols-[minmax(0,1.15fr)_minmax(22rem,0.85fr)] items-center gap-ui-6 max-[56rem]:grid-cols-1 max-[56rem]:content-center">
      <section className="flex max-w-[38rem] flex-col items-start gap-ui-3 max-[56rem]:hidden">
        <span className="grid h-14 w-14 place-items-center rounded-lg bg-accent text-primary">
          <Icon name="leaf" size={28} />
        </span>
        <p className="m-0 text-caption font-bold tracking-[0.12em] text-primary">
          开始使用 Arbor
        </p>
        <h1 className="m-0 text-display leading-tight tracking-[-0.03em] text-foreground">
          把复杂目标，变成持续推进的工作
        </h1>
        <p className="m-0 max-w-[32rem] leading-[1.7] text-muted-foreground">
          打开已有项目继续工作，或创建一个新项目。Arbor
          会用清晰分工组织工作，并在对话中与你协作推进。
        </p>
      </section>
      <div className="grid min-w-0 gap-ui-3">
        <h2 className="m-0 text-title text-foreground">已有项目</h2>
        <ProjectDirectoryList />
        <h2 className="m-0 text-title text-foreground">新建项目</h2>
        <CreateProjectForm
          actor={session.actor ?? "user:root"}
          token={session.token ?? undefined}
          onSubmitted={onSubmitted}
          quickStart
        />
      </div>
    </div>
  );
}
