import { useQuery } from "@tanstack/react-query";
import { useId, useState } from "react";
import { navigate, type Route } from "../api/router.js";
import { fetchProjectDirectory } from "../api/transport.js";
import { useSession } from "../session/SessionContext.js";
import { Button } from "./Button.js";
import { Empty } from "./Empty.js";
import { Icon } from "./Icon.js";
import { TimeText } from "./TimeText.js";
import { Input } from "./ui/input.js";

export function ProjectDirectoryList({
  currentProjectId,
  onNavigate,
}: {
  readonly currentProjectId?: string | undefined;
  readonly onNavigate?: (() => void) | undefined;
}) {
  const session = useSession();
  const searchId = useId();
  const [search, setSearch] = useState("");
  const [showArchived, setShowArchived] = useState(false);
  const [copyStatus, setCopyStatus] = useState<string | null>(null);
  const directory = useQuery({
    queryKey: ["project-directory"],
    queryFn: () =>
      fetchProjectDirectory({
        token: session.token,
        onUnauthenticated: session.reportUnauthenticated,
      }),
    enabled: session.token !== null,
  });
  const allProjects =
    directory.data?.ok === true ? directory.data.dto.projects : [];
  const projects = allProjects.filter(
    (project) =>
      (showArchived || project.lifecycle === "Open") &&
      `${project.name} ${project.directoryPath ?? ""}`
        .toLocaleLowerCase()
        .includes(search.trim().toLocaleLowerCase()),
  );
  const openRoute = (route: Route): void => {
    session.setProjectId(route.projectId);
    onNavigate?.();
    navigate(route);
  };

  return (
    <section className="grid min-w-0 gap-ui-2" aria-label="项目列表">
      <div className="flex flex-wrap items-end gap-ui-3 text-caption text-muted-foreground">
        <label htmlFor={searchId} className="grid min-w-0 flex-1 gap-ui-1">
          搜索项目
          <Input
            id={searchId}
            type="search"
            value={search}
            placeholder="输入项目名称或路径"
            onChange={(event) => setSearch(event.target.value)}
            className="box-border min-w-0 w-full rounded-sm border border-solid border-border bg-card p-ui-2 text-foreground"
          />
        </label>
        <label className="flex items-center gap-ui-1 py-ui-2">
          <input
            type="checkbox"
            checked={showArchived}
            onChange={(event) => setShowArchived(event.target.checked)}
          />
          显示已归档项目
        </label>
      </div>
      {copyStatus !== null ? <p role="status">{copyStatus}</p> : null}
      {directory.isPending ? (
        <Empty>正在加载项目…</Empty>
      ) : directory.isError || directory.data?.ok !== true ? (
        <div role="alert" className="m-0 text-small text-destructive">
          <p>无法加载已有项目，请重试。</p>
          <Button
            loading={directory.isFetching}
            onClick={() => void directory.refetch()}
          >
            重新加载项目
          </Button>
        </div>
      ) : projects.length === 0 ? (
        <Empty>
          {search.trim().length > 0
            ? "没有匹配的项目，请尝试其他名称。"
            : allProjects.length > 0
              ? "没有进行中的项目，可勾选“显示已归档项目”查看历史。"
              : "还没有项目，可以先创建一个项目。"}
        </Empty>
      ) : (
        <div className="grid min-w-0 gap-ui-2">
          {projects.map((project) => (
            <article
              key={project.projectId}
              aria-label={project.name}
              className="overflow-hidden rounded-sm border border-solid border-border bg-card"
            >
              <button
                type="button"
                className="aria-current:bg-accent group flex w-full items-center justify-between gap-ui-3 border-0 bg-transparent p-ui-3 text-left font-sans text-foreground hover:bg-accent"
                aria-label={project.name}
                aria-current={
                  project.projectId === currentProjectId ? "true" : undefined
                }
                title={project.lifecycle === "Open" ? "打开项目" : "查看历史"}
                onClick={() =>
                  openRoute({
                    name: "workbench",
                    projectId: project.projectId,
                  })
                }
              >
                <span className="grid min-w-0 gap-ui-1 wrap-anywhere">
                  <strong>{project.name}</strong>
                  {project.directoryPath ? (
                    <span
                      className="wrap-anywhere font-mono text-caption text-muted-foreground"
                      title={project.directoryPath}
                    >
                      {project.directoryPath}
                    </span>
                  ) : project.directoryPath === null ? (
                    <span className="font-mono text-caption text-muted-foreground">
                      未绑定文件夹
                    </span>
                  ) : null}
                  <span className="flex flex-wrap gap-ui-2 text-caption text-muted-foreground">
                    <span>
                      {project.lifecycle === "Open"
                        ? "进行中"
                        : "已归档 · 查看历史"}
                    </span>
                    {project.updatedAt ? (
                      <span>
                        更新于 <TimeText iso={project.updatedAt} />
                      </span>
                    ) : null}
                  </span>
                </span>
                {project.projectId === currentProjectId ? (
                  <span className="text-caption text-primary">当前</span>
                ) : (
                  <Icon name="chevron" size={15} />
                )}
              </button>
              {project.directoryPath ? (
                <div className="flex flex-wrap gap-ui-2 p-0 px-ui-3 pb-ui-3">
                  <Button
                    onClick={() => {
                      void (async () => {
                        try {
                          await navigator.clipboard.writeText(
                            project.directoryPath ?? "",
                          );
                          setCopyStatus("已复制项目路径。");
                        } catch {
                          setCopyStatus(
                            "无法自动复制，请选择上方目录文字进行复制。",
                          );
                        }
                      })();
                    }}
                  >
                    复制路径
                  </Button>
                </div>
              ) : null}
              {project.lifecycle === "Open" ? (
                <div className="flex flex-wrap gap-ui-2 p-0 px-ui-3 pb-ui-3">
                  <Button
                    onClick={() =>
                      openRoute({
                        name: "workspace",
                        projectId: project.projectId,
                        workspaceId: project.rootWorkspaceId,
                        tab: "conversation",
                      })
                    }
                  >
                    继续对话
                  </Button>
                  <Button
                    onClick={() =>
                      openRoute({
                        name: "settings",
                        projectId: project.projectId,
                      })
                    }
                  >
                    项目管理
                  </Button>
                </div>
              ) : null}
            </article>
          ))}
        </div>
      )}
    </section>
  );
}
