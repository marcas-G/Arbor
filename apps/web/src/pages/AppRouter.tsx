/**
 * W-02 — route outlet wiring (W-03..W-07 own the page modules).
 */
import type { ReactNode } from "react";
import type { Route } from "../api/router.js";
import { AppShell } from "../shell/AppShell.js";
import { OverviewPage } from "./overview/OverviewPage.js";
import { PageStub } from "./PageStub.js";
import { TreePage } from "./tree/TreePage.js";
import { WorkspacePage } from "./workspace/WorkspacePage.js";

export function AppRouter(): ReactNode {
  return (
    <AppShell
      pageFor={(route: Route): ReactNode => {
        switch (route.name) {
          case "project-overview":
            return <OverviewPage route={route} />;
          case "tree":
            return <TreePage route={route} />;
          case "workspace":
            return <WorkspacePage route={route} />;
          case "work":
            return (
              <PageStub route={route} label={`工作 ${route.workId}（W-06）`} />
            );
          case "queue":
            return <PageStub route={route} label="待处理（W-08）" />;
          case "attention":
            return <PageStub route={route} label="关注事项（W-06，只读）" />;
          case "usage":
            return <PageStub route={route} label="用量（W-07）" />;
          case "settings":
            return <PageStub route={route} label="设置（W-07）" />;
        }
      }}
    />
  );
}
