import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Route } from "../src/api/router.js";
import { useViewQuery } from "../src/api/useViewQuery.js";
import { AppProviders } from "../src/providers/AppProviders.js";
import { AppShell } from "../src/shell/AppShell.js";

const projectId = "prj_owner";
const rootWorkspaceId = "ws_owner";
const foreignWorkspaceId = "ws_foreign";

const directory = {
  projectId,
  name: "owner project",
  lifecycle: "Open" as const,
  rootWorkspaceId,
  revision: 0,
  updatedAt: "2026-10-10T00:00:00.000Z",
};

const installWebSocket = (): void => {
  class FakeWebSocket {
    onopen: (() => void) | null = null;
    onmessage: ((event: { data: string }) => void) | null = null;
    onclose: (() => void) | null = null;
    send(): void {}
    close(): void {}
  }
  vi.stubGlobal("WebSocket", FakeWebSocket);
};

const installFetch = () => {
  const fetchMock = vi.fn(
    async (input: RequestInfo | URL, _init?: RequestInit) => {
      const url = String(input);
      if (url === "/projects") {
        return new Response(
          JSON.stringify({
            ok: true,
            status: 200,
            body: { projects: [directory] },
          }),
          { status: 200 },
        );
      }
      if (url === "/views/responsibility-tree") {
        return new Response(
          JSON.stringify({
            ok: true,
            status: 200,
            body: {
              value: {
                nodes: [
                  {
                    workspaceId: rootWorkspaceId,
                    parentWorkspaceId: null,
                    name: "owner root",
                    status: "Open",
                    subtreeAttention: { attention: 0, actionRequired: 0 },
                  },
                ],
              },
              watermark: 1,
            },
          }),
          { status: 200 },
        );
      }
      if (url === "/views/workspace-detail") {
        return new Response(
          JSON.stringify({
            ok: true,
            status: 200,
            body: {
              value: {
                responsibility: { purpose: "FOREIGN PRIVATE WORKSPACE DATA" },
                boundary: { addresses: [] },
                pendingWorks: [],
                dependencies: [],
                inboxUnconsumed: [],
                auditTimeline: [],
              },
              watermark: 1,
            },
          }),
          { status: 200 },
        );
      }
      return new Response(
        JSON.stringify({
          ok: true,
          status: 200,
          body: { value: { rows: [] }, watermark: 1 },
        }),
        { status: 200 },
      );
    },
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
};

const RoutePageProbe = ({ route }: { readonly route: Route }) => {
  const workspaceId = route.name === "workspace" ? route.workspaceId : null;
  const projectView = useViewQuery(
    "attention",
    route.name === "workspace" || route.name === "work"
      ? null
      : { projectId: route.projectId as never },
  );
  const workspaceView = useViewQuery(
    "workspace-detail",
    workspaceId === null ? null : { workspaceId: workspaceId as never },
  );
  const workView = useViewQuery(
    "work-detail",
    route.name === "work"
      ? {
          projectId: route.projectId as never,
          workspaceId: route.workspaceId as never,
          workId: route.workId as never,
        }
      : null,
  );
  return (
    <output data-testid="routed-content">
      {workspaceView.data?.responsibility.purpose ??
        workView.data?.objective ??
        (projectView.data === undefined ? "loading" : "project view")}
    </output>
  );
};

const renderRoute = (path: string) => {
  history.replaceState(null, "", path);
  installWebSocket();
  const fetchMock = installFetch();
  render(
    <AppProviders>
      <AppShell pageFor={(route) => <RoutePageProbe route={route} />} />
    </AppProviders>,
  );
  return fetchMock;
};

afterEach(() => {
  cleanup();
  history.replaceState(null, "", "/");
  vi.unstubAllGlobals();
});

describe("project route admission", () => {
  it("does not request project-scoped views for a project absent from ProjectDirectory", async () => {
    const fetchMock = renderRoute("/p/prj_unknown/queue");

    await waitFor(() => expect(screen.getByText("对象不存在")).toBeTruthy());
    expect(
      fetchMock.mock.calls.filter(([url]) => String(url).startsWith("/views/")),
    ).toEqual([]);
  });

  it("proves workspace membership in the route project before workspace views", async () => {
    const fetchMock = renderRoute(
      `/p/${projectId}/workspace/${foreignWorkspaceId}/overview`,
    );

    await waitFor(() => expect(screen.getByText("对象不存在")).toBeTruthy());
    const viewRequests = fetchMock.mock.calls
      .filter(([url]) => String(url).startsWith("/views/"))
      .map(([url, init]) => ({
        url: String(url),
        body: JSON.parse(
          String((init as RequestInit).body ?? "null"),
        ) as unknown,
      }));
    expect(viewRequests).toEqual([
      {
        url: "/views/responsibility-tree",
        body: { projectId },
      },
    ]);
    expect(screen.queryByText("FOREIGN PRIVATE WORKSPACE DATA")).toBeNull();
  });

  it("uses the exact Work triple as the only pre-render work affiliation read", async () => {
    const workId = "wrk_hidden";
    const fetchMock = renderRoute(
      `/p/${projectId}/workspace/${foreignWorkspaceId}/work/${workId}`,
    );

    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(([url]) => url === "/views/work-detail"),
      ).toBe(true),
    );
    const viewRequests = fetchMock.mock.calls
      .filter(([url]) => String(url).startsWith("/views/"))
      .map(([url, init]) => ({
        url: String(url),
        body: JSON.parse(
          String((init as RequestInit).body ?? "null"),
        ) as unknown,
      }));
    expect(viewRequests).toEqual([
      {
        url: "/views/work-detail",
        body: { projectId, workspaceId: foreignWorkspaceId, workId },
      },
    ]);
    expect(screen.queryByText("FOREIGN PRIVATE WORKSPACE DATA")).toBeNull();
  });
});
