/**
 * W-02 — the Global App Shell (frozen §2.1): Rail + Topbar + route outlet.
 * Project-scoped routes only (/p/:projectId/**, §2.1A); Session.projectId is
 * the recent-selection memory used solely for the empty-path redirect.
 */

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useEffect, useState } from "react";
import {
  formatRoute,
  navigate,
  parseRoute,
  type Route,
} from "../api/router.js";
import { fetchProjectDirectory } from "../api/transport.js";
import { CreateProjectForm } from "../commands/forms/CreateProjectForm.js";
import type { CommandReceiptView } from "../commands/submitCommand.js";
import { Empty } from "../components/Empty.js";
import { FreshnessChip } from "../components/FreshnessChip.js";
import { Icon, type IconName } from "../components/Icon.js";
import { RefreshingStatus } from "../components/RefreshingStatus.js";
import { Sheet } from "../components/Sheet.js";
import { BootstrapPage } from "../pages/bootstrap/BootstrapPage.js";
import { useFreshness, usePath } from "../providers/AppProviders.js";
import { useSession } from "../session/SessionContext.js";
import { ProjectRouteContent } from "./ProjectRouteContent.js";
import styles from "./shell.module.css";

export interface ShellPageProps {
  readonly route: Route;
}

export function AppShell({
  pageFor,
}: {
  readonly pageFor: (route: Route) => ReactNode;
}) {
  const path = usePath();
  const route = parseRoute(path);
  const session = useSession();
  const connected = session.token !== null;
  const [projectPanelOpen, setProjectPanelOpen] = useState(false);

  useEffect(() => {
    if (
      connected &&
      (path === "/" || path === "") &&
      session.projectId !== null &&
      session.projectId.trim() !== ""
    ) {
      navigate(
        { name: "workbench", projectId: session.projectId },
        { replace: true },
      );
    }
  }, [connected, path, session.projectId]);

  return (
    <div className={styles.shell}>
      <SideRail
        route={route}
        onOpenProjects={() => setProjectPanelOpen(true)}
      />
      <div className={styles.main}>
        <Topbar
          route={route}
          onOpenProjects={() => setProjectPanelOpen(true)}
        />
        <main className={styles.content}>
          {!connected ? null : route === null ? (
            connected && (path === "/" || path === "") ? (
              <BootstrapPage />
            ) : (
              <RouteNotFound path={path} connected={connected} />
            )
          ) : session.unauthenticatedProblem !== null ? null : (
            <ProjectRouteContent
              key={routeScopeKey(route)}
              route={route}
              pageFor={pageFor}
            />
          )}
        </main>
      </div>
      <MobileTabbar route={route} />
      <ProjectPanel
        open={projectPanelOpen}
        route={route}
        onClose={() => setProjectPanelOpen(false)}
      />
    </div>
  );
}

const routeScopeKey = (route: Route): string =>
  route.name === "workspace" || route.name === "work"
    ? `${route.projectId}:${route.workspaceId}`
    : route.projectId;

function RouteNotFound({
  path,
  connected,
}: {
  readonly path: string;
  readonly connected: boolean;
}) {
  const session = useSession();
  return (
    <Empty>
      {connected && (path === "/" || path === "")
        ? "先选择或创建一个项目"
        : `未知路由 ${path}`}
      {connected && (path === "/" || path === "") && session.projectId === null
        ? ""
        : ""}
    </Empty>
  );
}

const NAV: ReadonlyArray<{
  readonly label: string;
  readonly description: string;
  readonly icon: IconName;
  readonly match: (route: Route) => boolean;
  readonly go: (projectId: string) => void;
}> = [
  {
    label: "工作台",
    description: "项目总览",
    icon: "workbench",
    match: (route) => route.name === "workbench",
    go: (projectId) => navigate({ name: "workbench", projectId }),
  },
  {
    label: "树",
    description: "责任结构",
    icon: "tree",
    match: (route) =>
      route.name === "tree" ||
      route.name === "workspace" ||
      route.name === "work",
    go: (projectId) => navigate({ name: "tree", projectId }),
  },
  {
    label: "待处理",
    description: "等待决策",
    icon: "queue",
    match: (route) => route.name === "queue",
    go: (projectId) => navigate({ name: "queue", projectId }),
  },
  {
    label: "关注事项",
    description: "风险与阻塞",
    icon: "attention",
    match: (route) => route.name === "attention",
    go: (projectId) => navigate({ name: "attention", projectId }),
  },
  {
    label: "用量",
    description: "资源消耗",
    icon: "usage",
    match: (route) => route.name === "usage",
    go: (projectId) => navigate({ name: "usage", projectId }),
  },
  {
    label: "设置",
    description: "项目配置",
    icon: "settings",
    match: (route) => route.name === "settings",
    go: (projectId) => navigate({ name: "settings", projectId }),
  },
];

function SideRail({
  route,
  onOpenProjects,
}: {
  readonly route: Route | null;
  readonly onOpenProjects: () => void;
}) {
  const session = useSession();
  if (session.token === null) {
    return null;
  }
  return (
    <nav className={styles.rail} aria-label="主导航">
      <div className={styles.brandBlock}>
        <span className={styles.brandMark}>
          <Icon name="leaf" size={20} />
        </span>
        <span className={styles.brandCopy}>
          <span className={styles.brand}>Arbor</span>
          <span className={styles.brandTagline}>让复杂工作持续生长</span>
        </span>
      </div>
      <ProjectSwitcher route={route} onOpen={onOpenProjects} />
      <div className={styles.navSection}>
        <span className={styles.navCaption}>项目空间</span>
        <div className={styles.navList}>
          {NAV.map((item) => (
            <button
              key={item.label}
              type="button"
              className={`${styles.navItem} ${route !== null && item.match(route) ? styles.navItemActive : ""}`}
              onClick={() => {
                if (route !== null) {
                  item.go(route.projectId);
                }
              }}
              disabled={route === null}
              aria-current={
                route !== null && item.match(route) ? "page" : undefined
              }
            >
              <Icon name={item.icon} size={18} />
              <span className={styles.navItemCopy}>
                <span>{item.label}</span>
                <small>{item.description}</small>
              </span>
            </button>
          ))}
        </div>
      </div>
      <div className={styles.sessionBlock}>
        <span className={styles.avatar} aria-hidden="true">
          {(session.actor ?? "U").slice(0, 1).toUpperCase()}
        </span>
        <span className={styles.sessionCopy}>
          <span className={styles.sessionLabel}>本地会话</span>
          <span className={styles.sessionActor}>{session.actor}</span>
        </span>
        <button
          type="button"
          className={styles.disconnect}
          onClick={session.clearSession}
          title="断开"
          aria-label="断开"
        >
          <Icon name="disconnect" size={17} />
        </button>
      </div>
    </nav>
  );
}

function ProjectSwitcher({
  route,
  onOpen,
}: {
  readonly route: Route | null;
  readonly onOpen: () => void;
}) {
  const session = useSession();
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
  const current = allProjects.find(
    (project) => project.projectId === route?.projectId,
  );
  return (
    <button
      type="button"
      className={styles.projectSwitch}
      aria-haspopup="dialog"
      onClick={onOpen}
    >
      <span className={styles.projectGlyph}>
        <Icon name="spark" size={17} />
      </span>
      <span className={styles.projectCopy}>
        <span className={styles.projectLabel}>当前项目</span>
        <span className={styles.projectName}>
          {current?.name ?? "选择项目"}
        </span>
      </span>
      <Icon name="chevron" size={15} className={styles.projectChevron} />
    </button>
  );
}

function ProjectPanel({
  open,
  route,
  onClose,
}: {
  readonly open: boolean;
  readonly route: Route | null;
  readonly onClose: () => void;
}) {
  const session = useSession();
  const queryClient = useQueryClient();
  const [mode, setMode] = useState<"directory" | "create">("directory");
  const [showArchived, setShowArchived] = useState(false);
  const directory = useQuery({
    queryKey: ["project-directory"],
    queryFn: () =>
      fetchProjectDirectory({
        token: session.token,
        onUnauthenticated: session.reportUnauthenticated,
      }),
    enabled: open && session.token !== null,
  });
  const allProjects =
    directory.data?.ok === true ? directory.data.dto.projects : [];
  const projects = allProjects.filter(
    (project) => showArchived || project.lifecycle === "Open",
  );
  const close = (): void => {
    setMode("directory");
    onClose();
  };
  const projectCreated = (receipt: CommandReceiptView): void => {
    if (receipt.resolution !== "Committed") return;
    const result = receipt.result as
      | { readonly projectId?: string }
      | undefined;
    const projectId = result?.projectId;
    if (projectId === undefined) return;
    session.setProjectId(projectId);
    void queryClient.invalidateQueries({ queryKey: ["project-directory"] });
    close();
    navigate({ name: "workbench", projectId });
  };

  return (
    <Sheet
      open={open}
      title={mode === "directory" ? "项目中心" : "新建项目"}
      onClose={close}
      mobileFullscreen
    >
      {mode === "create" ? (
        <div className={styles.projectPanelCreate}>
          <button
            type="button"
            className={styles.projectPanelBack}
            onClick={() => setMode("directory")}
          >
            ← 返回项目列表
          </button>
          {session.actor !== null && session.token !== null ? (
            <CreateProjectForm
              actor={session.actor}
              token={session.token}
              onSubmitted={projectCreated}
              embedded
            />
          ) : (
            <Empty>当前会话不可用</Empty>
          )}
        </div>
      ) : (
        <div className={styles.projectPanel}>
          <button
            type="button"
            className={styles.projectPanelCreateButton}
            aria-label="新建项目"
            onClick={() => setMode("create")}
          >
            <Icon name="spark" size={17} />
            <span>
              <strong>新建项目</strong>
              <small>创建独立的长期工作空间</small>
            </span>
          </button>
          <label className={styles.projectFilter}>
            <input
              type="checkbox"
              checked={showArchived}
              onChange={(event) => setShowArchived(event.target.checked)}
            />
            显示已归档项目
          </label>
          <section className={styles.projectPanelList} aria-label="项目列表">
            {projects.length === 0 ? (
              <Empty>还没有项目，请先创建一个项目</Empty>
            ) : (
              projects.map((project) => (
                <button
                  key={project.projectId}
                  type="button"
                  className={styles.projectPanelOption}
                  aria-current={
                    project.projectId === route?.projectId ? "true" : undefined
                  }
                  onClick={() => {
                    session.setProjectId(project.projectId);
                    close();
                    navigate({
                      name: "workbench",
                      projectId: project.projectId,
                    });
                  }}
                >
                  <span>
                    <strong>{project.name}</strong>
                    <small>
                      {project.lifecycle === "Open" ? "进行中" : "已归档"}
                    </small>
                  </span>
                  {project.projectId === route?.projectId ? (
                    <span className={styles.currentProjectLabel}>当前</span>
                  ) : (
                    <Icon name="chevron" size={15} />
                  )}
                </button>
              ))
            )}
          </section>
        </div>
      )}
    </Sheet>
  );
}

function Topbar({
  route,
  onOpenProjects,
}: {
  readonly route: Route | null;
  readonly onOpenProjects: () => void;
}) {
  const freshness = useFreshness();
  const session = useSession();
  const directory = useQuery({
    queryKey: ["project-directory"],
    queryFn: () =>
      fetchProjectDirectory({
        token: session.token,
        onUnauthenticated: session.reportUnauthenticated,
      }),
    enabled: session.token !== null,
  });
  const projects =
    directory.data?.ok === true ? directory.data.dto.projects : [];
  const projectName = projects.find(
    (project) => project.projectId === route?.projectId,
  )?.name;
  return (
    <header className={styles.topbar}>
      <div className={styles.breadcrumb}>
        <button
          type="button"
          className={styles.breadcrumbProject}
          onClick={onOpenProjects}
          aria-label="打开项目中心"
        >
          {projectName ?? "Arbor"}
          <Icon name="chevron" size={13} />
        </button>
        <span className={styles.breadcrumbSeparator}>/</span>
        <strong>{breadcrumbOf(route)}</strong>
      </div>
      <div className={styles.topbarStatus}>
        <RefreshingStatus />
        <FreshnessChip state={freshness.state} />
      </div>
    </header>
  );
}

const breadcrumbOf = (route: Route | null): string => {
  if (route === null) {
    return "项目";
  }
  switch (route.name) {
    case "workbench":
      return "工作台";
    case "tree":
    case "queue":
    case "attention":
    case "usage":
    case "settings":
      return labelOf(route.name);
    case "workspace":
      return `工作空间 / ${workspaceTabLabel(route.tab)}`;
    case "work":
      return "工作详情";
  }
};

const workspaceTabLabel = (tab: string): string =>
  ({
    overview: "概览",
    work: "工作",
    dependencies: "依赖",
    inbox: "收件箱",
    conversation: "对话",
    transcript: "记录",
  })[tab] ?? tab;

const labelOf = (name: string): string =>
  NAV.find((item) => item.label !== "工作台" && romanize(item.label) === name)
    ?.label ?? name;

const romanize = (label: string): string =>
  ({
    工作台: "workbench",
    树: "tree",
    待处理: "queue",
    关注事项: "attention",
    用量: "usage",
    设置: "settings",
  })[label as "工作台" | "树" | "待处理" | "关注事项" | "用量" | "设置"] ??
  label;

function MobileTabbar({ route }: { readonly route: Route | null }) {
  const session = useSession();
  const [moreOpen, setMoreOpen] = useState(false);
  const queryClient = useQueryClient();
  if (session.token === null) {
    return null;
  }
  const tabs = NAV.filter(
    (item) => item.label !== "用量" && item.label !== "设置",
  );
  return (
    <>
      {moreOpen ? (
        <Sheet
          open={moreOpen}
          title="更多"
          onClose={() => {
            setMoreOpen(false);
          }}
        >
          <div className={styles.moreItems}>
            <button
              type="button"
              className={styles.moreItem}
              onClick={() => {
                if (route !== null) {
                  navigate({ name: "usage", projectId: route.projectId });
                }
                setMoreOpen(false);
              }}
            >
              用量
            </button>
            <button
              type="button"
              className={styles.moreItem}
              onClick={() => {
                if (route !== null) {
                  navigate({ name: "settings", projectId: route.projectId });
                }
                setMoreOpen(false);
              }}
            >
              设置
            </button>
            <button
              type="button"
              className={styles.moreItem}
              onClick={() => {
                setMoreOpen(false);
                void queryClient.invalidateQueries({ queryKey: ["view"] });
              }}
            >
              刷新数据
            </button>
            <button
              type="button"
              className={styles.moreItem}
              onClick={() => {
                setMoreOpen(false);
                session.clearSession();
              }}
            >
              断开会话
            </button>
          </div>
        </Sheet>
      ) : null}
      <nav className={styles.tabbar} aria-label="移动导航">
        {tabs.map((item) => (
          <button
            key={item.label}
            type="button"
            className={`${styles.tabItem} ${route !== null && item.match(route) ? styles.tabItemActive : ""}`}
            onClick={() => {
              if (route !== null) {
                item.go(route.projectId);
              }
            }}
            disabled={route === null}
            aria-current={
              route !== null && item.match(route) ? "page" : undefined
            }
          >
            <Icon name={item.icon} size={18} />
            <span>{item.label}</span>
          </button>
        ))}
        <button
          type="button"
          className={styles.tabItem}
          aria-expanded={moreOpen}
          aria-haspopup="dialog"
          onClick={() => {
            setMoreOpen(true);
          }}
        >
          更多
        </button>
      </nav>
    </>
  );
}

export const pathFor = formatRoute;
