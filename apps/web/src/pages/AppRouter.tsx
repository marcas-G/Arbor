/**
 * W-02 — route outlet wiring (W-03..W-07 own the page modules).
 */
import type { ReactNode } from "react";
import type { Route } from "../api/router.js";
import { AppShell } from "../shell/AppShell.js";
import { AttentionPage } from "./attention/AttentionPage.js";
import { QueuePage } from "./queue/QueuePage.js";
import { SettingsPage } from "./settings/SettingsPage.js";
import { TreePage } from "./tree/TreePage.js";
import { UsagePage } from "./usage/UsagePage.js";
import { WorkPage } from "./work/WorkPage.js";
import { RootWorkbenchPage } from "./workbench/RootWorkbenchPage.js";
import { WorkspacePage } from "./workspace/WorkspacePage.js";

export function AppRouter(): ReactNode {
  return (
    <AppShell
      pageFor={(route: Route): ReactNode => {
        switch (route.name) {
          case "workbench":
            return <RootWorkbenchPage route={route} />;
          case "tree":
            return <TreePage route={route} />;
          case "workspace":
            return <WorkspacePage route={route} />;
          case "work":
            return <WorkPage route={route} />;
          case "queue":
            return <QueuePage route={route} />;
          case "attention":
            return <AttentionPage route={route} />;
          case "usage":
            return <UsagePage route={route} />;
          case "settings":
            return <SettingsPage route={route} />;
        }
      }}
    />
  );
}
