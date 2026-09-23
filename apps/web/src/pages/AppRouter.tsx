/**
 * W-02 — route outlet wiring. Pages are delivered by W-03..W-07; this
 * router mounts the page registry so the shell IA is walkthrough-ready
 * (each stub names its owning task).
 */
import type { ReactNode } from "react";
import type { Route } from "../api/router.js";
import { AppShell } from "../shell/AppShell.js";
import { PageStub } from "./PageStub.js";

export function AppRouter(): ReactNode {
  return (
    <AppShell
      pageFor={(route: Route): ReactNode => {
        switch (route.name) {
          case "project-overview":
            return <PageStub route={route} label="概览（W-03）" />;
          case "tree":
            return <PageStub route={route} label="责任树（W-04，只读导航）" />;
          case "queue":
            return <PageStub route={route} label="待处理（W-08）" />;
          case "attention":
            return <PageStub route={route} label="关注事项（W-06，只读）" />;
          case "usage":
            return <PageStub route={route} label="用量（W-07）" />;
          case "settings":
            return <PageStub route={route} label="设置（W-07）" />;
          case "workspace":
            return (
              <PageStub
                route={route}
                label={`工作区 ${route.workspaceId} · ${route.tab}（W-05）`}
              />
            );
          case "work":
            return (
              <PageStub route={route} label={`工作 ${route.workId}（W-06）`} />
            );
        }
      }}
    />
  );
}
