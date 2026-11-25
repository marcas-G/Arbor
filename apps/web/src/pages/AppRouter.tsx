/**
 * W-02 — route outlet wiring (W-03..W-07 own the page modules).
 */
import { lazy, type ReactNode, Suspense } from "react";
import type { Route } from "../api/router.js";
import { Empty } from "../components/Empty.js";
import { AppShell } from "../shell/AppShell.js";

const AttentionPage = lazy(() =>
  import("./attention/AttentionPage.js").then((module) => ({
    default: module.AttentionPage,
  })),
);
const QueuePage = lazy(() =>
  import("./queue/QueuePage.js").then((module) => ({
    default: module.QueuePage,
  })),
);
const SettingsPage = lazy(() =>
  import("./settings/SettingsPage.js").then((module) => ({
    default: module.SettingsPage,
  })),
);
const TreePage = lazy(() =>
  import("./tree/TreePage.js").then((module) => ({ default: module.TreePage })),
);
const UsagePage = lazy(() =>
  import("./usage/UsagePage.js").then((module) => ({
    default: module.UsagePage,
  })),
);
const WorkPage = lazy(() =>
  import("./work/WorkPage.js").then((module) => ({ default: module.WorkPage })),
);
const RootWorkbenchPage = lazy(() =>
  import("./workbench/RootWorkbenchPage.js").then((module) => ({
    default: module.RootWorkbenchPage,
  })),
);
const WorkspacePage = lazy(() =>
  import("./workspace/WorkspacePage.js").then((module) => ({
    default: module.WorkspacePage,
  })),
);

function ProjectPage({ route }: { readonly route: Route }): ReactNode {
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
}

export function AppRouter(): ReactNode {
  return (
    <AppShell
      pageFor={(route) => (
        <Suspense fallback={<Empty>正在打开页面…</Empty>}>
          <ProjectPage route={route} />
        </Suspense>
      )}
    />
  );
}
