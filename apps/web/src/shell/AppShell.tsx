/**
 * W-02 — the Global App Shell (frozen §2.1): Rail + Topbar + route outlet.
 * Project-scoped routes only (/p/:projectId/**, §2.1A); Session.projectId is
 * the recent-selection memory used solely for the empty-path redirect.
 */

import { useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useEffect, useState } from "react";
import {
  formatRoute,
  navigate,
  parseRoute,
  type Route,
} from "../api/router.js";
import { Button } from "../components/Button.js";
import { Empty } from "../components/Empty.js";
import { FreshnessChip } from "../components/FreshnessChip.js";
import { RefreshingStatus } from "../components/RefreshingStatus.js";
import { Sheet } from "../components/Sheet.js";
import { BootstrapPage } from "../pages/bootstrap/BootstrapPage.js";
import { useFreshness, usePath } from "../providers/AppProviders.js";
import { useSession } from "../session/SessionContext.js";
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
      <SideRail route={route} />
      <div className={styles.main}>
        <Topbar route={route} />
        <main className={styles.content}>
          {!connected ? null : route === null ? (
            connected && (path === "/" || path === "") ? (
              <BootstrapPage />
            ) : (
              <RouteNotFound path={path} connected={connected} />
            )
          ) : session.unauthenticatedProblem !== null ? null : (
            pageFor(route)
          )}
        </main>
      </div>
      <MobileTabbar route={route} />
    </div>
  );
}

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
  readonly match: (route: Route) => boolean;
  readonly go: (projectId: string) => void;
}> = [
  {
    label: "工作台",
    match: (route) => route.name === "workbench",
    go: (projectId) => navigate({ name: "workbench", projectId }),
  },
  {
    label: "树",
    match: (route) =>
      route.name === "tree" ||
      route.name === "workspace" ||
      route.name === "work",
    go: (projectId) => navigate({ name: "tree", projectId }),
  },
  {
    label: "待处理",
    match: (route) => route.name === "queue",
    go: (projectId) => navigate({ name: "queue", projectId }),
  },
  {
    label: "关注事项",
    match: (route) => route.name === "attention",
    go: (projectId) => navigate({ name: "attention", projectId }),
  },
  {
    label: "用量",
    match: (route) => route.name === "usage",
    go: (projectId) => navigate({ name: "usage", projectId }),
  },
  {
    label: "设置",
    match: (route) => route.name === "settings",
    go: (projectId) => navigate({ name: "settings", projectId }),
  },
];

function SideRail({ route }: { readonly route: Route | null }) {
  const session = useSession();
  if (session.token === null) {
    return null;
  }
  return (
    <nav className={styles.rail} aria-label="主导航">
      <span className={styles.brand}>Arbor</span>
      <ProjectSwitcher route={route} />
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
            {item.label}
          </button>
        ))}
      </div>
      <div className={styles.sessionBlock}>
        <span className={styles.sessionActor}>{session.actor}</span>
        <Button variant="quiet" onClick={session.clearSession}>
          断开
        </Button>
      </div>
    </nav>
  );
}

function ProjectSwitcher({ route }: { readonly route: Route | null }) {
  const session = useSession();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState("");
  const commit = (): void => {
    const next = value.trim();
    setEditing(false);
    if (next.length > 0) {
      session.setProjectId(next);
      navigate({ name: "workbench", projectId: next });
    }
  };
  if (editing) {
    return (
      <form
        className={styles.projectSwitch}
        onSubmit={(event) => {
          event.preventDefault();
          commit();
        }}
      >
        <input
          ref={(element) => {
            element?.focus();
          }}
          className={styles.projectInput}
          value={value}
          placeholder="prj_…"
          onChange={(event) => {
            setValue(event.target.value);
          }}
          onBlur={commit}
        />
      </form>
    );
  }
  return (
    <button
      type="button"
      className={styles.projectSwitch}
      aria-label={`切换项目，当前 ${route?.projectId ?? "未选择"}`}
      onClick={() => {
        setValue(route?.projectId ?? "");
        setEditing(true);
      }}
    >
      <span className={styles.projectLabel}>项目</span>
      <span className={styles.projectId}>{route?.projectId ?? "未选择"}</span>
    </button>
  );
}

function Topbar({ route }: { readonly route: Route | null }) {
  const freshness = useFreshness();
  return (
    <header className={styles.topbar}>
      <span className={styles.breadcrumb}>{breadcrumbOf(route)}</span>
      <RefreshingStatus />
      <FreshnessChip state={freshness.state} />
    </header>
  );
}

const breadcrumbOf = (route: Route | null): string => {
  if (route === null) {
    return "Arbor";
  }
  const project = route.projectId;
  switch (route.name) {
    case "workbench":
      return `${project} / 工作台`;
    case "tree":
    case "queue":
    case "attention":
    case "usage":
    case "settings":
      return `${project} / ${labelOf(route.name)}`;
    case "workspace":
      return `${project} / ${route.workspaceId} / ${route.tab}`;
    case "work":
      return `${project} / ${route.workspaceId} / ${route.workId}`;
  }
};

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
            {item.label}
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
