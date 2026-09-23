/**
 * W-00 ② — the project-scoped typed History router (frozen §2.1A).
 *
 * ALL product routes carry the projectId: the URL is the deep-link
 * authority; Session.projectId is only the "most recent" memory used for
 * the empty-path redirect. parse/format are total inverses (round-trip
 * tested); unknown paths parse to null ( callers render not-found).
 */

export type WorkspaceTab =
  | "overview"
  | "dependencies"
  | "verification"
  | "transcript"
  | "inbox"
  | "conversation";

export const WORKSPACE_TABS: ReadonlyArray<WorkspaceTab> = [
  "overview",
  "dependencies",
  "verification",
  "transcript",
  "inbox",
  "conversation",
];

export type Route =
  | { readonly name: "workbench"; readonly projectId: string }
  | { readonly name: "tree"; readonly projectId: string }
  | { readonly name: "queue"; readonly projectId: string }
  | { readonly name: "attention"; readonly projectId: string }
  | { readonly name: "usage"; readonly projectId: string }
  | { readonly name: "settings"; readonly projectId: string }
  | {
      readonly name: "workspace";
      readonly projectId: string;
      readonly workspaceId: string;
      readonly tab: WorkspaceTab;
    }
  | {
      readonly name: "work";
      readonly projectId: string;
      readonly workspaceId: string;
      readonly workId: string;
    };

const PROJECT_ID = /^([A-Za-z0-9_-]+)$/;
const WORKSPACE_ID = /^([A-Za-z0-9_-]+)$/;
const WORK_ID = /^([A-Za-z0-9_-]+)$/;

const isWorkspaceTab = (value: string): value is WorkspaceTab =>
  (WORKSPACE_TABS as ReadonlyArray<string>).includes(value);

export const parseRoute = (path: string): Route | null => {
  const clean = path.split("?")[0] ?? path;
  const segments = clean.split("/").filter((segment) => segment.length > 0);
  if (segments.length < 2 || segments[0] !== "p") {
    return null;
  }
  const projectId = segments[1];
  if (projectId === undefined || !PROJECT_ID.test(projectId)) {
    return null;
  }
  const section = segments[2];
  if (section === undefined) {
    return { name: "workbench", projectId };
  }
  switch (section) {
    case "tree":
    case "queue":
    case "attention":
    case "usage":
    case "settings":
      return segments.length === 3
        ? ({ name: section, projectId } as Route)
        : null;
    case "workspace": {
      const workspaceId = segments[3];
      if (workspaceId === undefined || !WORKSPACE_ID.test(workspaceId)) {
        return null;
      }
      const tabOrWork = segments[4];
      if (tabOrWork === undefined) {
        return { name: "workspace", projectId, workspaceId, tab: "overview" };
      }
      if (tabOrWork === "work") {
        const workId = segments[5];
        return workId !== undefined &&
          WORK_ID.test(workId) &&
          segments.length === 6
          ? { name: "work", projectId, workspaceId, workId }
          : null;
      }
      return isWorkspaceTab(tabOrWork) && segments.length === 5
        ? { name: "workspace", projectId, workspaceId, tab: tabOrWork }
        : null;
    }
    default:
      return null;
  }
};

export const formatRoute = (route: Route): string => {
  switch (route.name) {
    case "workbench":
      return `/p/${route.projectId}`;
    case "tree":
    case "queue":
    case "attention":
    case "usage":
    case "settings":
      return `/p/${route.projectId}/${route.name}`;
    case "workspace":
      return route.tab === "overview"
        ? `/p/${route.projectId}/workspace/${route.workspaceId}`
        : `/p/${route.projectId}/workspace/${route.workspaceId}/${route.tab}`;
    case "work":
      return `/p/${route.projectId}/workspace/${route.workspaceId}/work/${route.workId}`;
  }
};

/** navigation API over the History API (push/replace + popstate). */
export const navigate = (
  route: Route,
  options?: { readonly replace?: boolean },
): void => {
  const path = formatRoute(route);
  if (options?.replace === true) {
    history.replaceState(null, "", path);
  } else {
    history.pushState(null, "", path);
  }
  window.dispatchEvent(new PopStateEvent("popstate"));
};
