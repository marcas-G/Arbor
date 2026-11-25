import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProjectDirectoryList } from "../src/components/ProjectDirectoryList.js";
import { BootstrapPage } from "../src/pages/bootstrap/BootstrapPage.js";
import {
  SessionContext,
  type SessionContextValue,
} from "../src/session/SessionContext.js";

const projects = [
  {
    projectId: "prj_first",
    name: "已有工程",
    lifecycle: "Open",
    rootWorkspaceId: "ws_first",
    revision: 2,
    updatedAt: "2026-11-11T12:00:00.000Z",
    resourceSource: { _tag: "ConversationOnly" },
  },
  {
    projectId: "prj_archived",
    name: "历史工程",
    lifecycle: "Closed",
    rootWorkspaceId: "ws_archived",
    revision: 3,
    updatedAt: "2026-11-10T12:00:00.000Z",
    resourceSource: { _tag: "ConversationOnly" },
  },
];

const setProjectId = vi.fn();
const session: SessionContextValue = {
  token: "local",
  actor: "user:local",
  projectId: null,
  unauthenticatedProblem: null,
  setSession: () => undefined,
  clearSession: () => undefined,
  setProjectId,
  reportUnauthenticated: () => undefined,
};

const response = (body: unknown) =>
  new Response(JSON.stringify({ ok: true, body }), { status: 200 });

const renderDirectory = (homepage = false) =>
  render(
    <QueryClientProvider
      client={
        new QueryClient({
          defaultOptions: { queries: { retry: false } },
        })
      }
    >
      <SessionContext.Provider value={session}>
        {homepage ? (
          <BootstrapPage onSubmitted={() => undefined} />
        ) : (
          <ProjectDirectoryList />
        )}
      </SessionContext.Provider>
    </QueryClientProvider>,
  );

const installFetch = () => {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) =>
    String(input) === "/projects"
      ? response({ projects })
      : response({ profiles: [], conversationOnlySupported: true }),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
};

afterEach(() => {
  history.replaceState(null, "", "/");
  setProjectId.mockClear();
  vi.unstubAllGlobals();
});

describe("existing project directory", () => {
  it("searches by the persisted directory path and copies that path", async () => {
    const path = "/projects/已有 工程";
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        response({
          projects: projects.map((project) => ({
            ...project,
            directoryPath: project.lifecycle === "Open" ? path : null,
          })),
        }),
      ),
    );
    renderDirectory();
    await screen.findByText(path);
    fireEvent.change(screen.getByLabelText("搜索项目"), {
      target: { value: "/projects/" },
    });
    const project = within(screen.getByRole("article", { name: "已有工程" }));
    fireEvent.click(project.getByRole("button", { name: "复制路径" }));
    expect(await screen.findByText("已复制项目路径。")).toBeTruthy();
    expect(writeText).toHaveBeenCalledWith(path);
  });

  it("shows existing projects on the homepage and resumes their own conversation", async () => {
    installFetch();
    renderDirectory(true);

    expect(screen.getByRole("heading", { name: "已有项目" })).toBeTruthy();
    const project = within(
      await screen.findByRole("article", { name: "已有工程" }),
    );
    expect(project.getByRole("button", { name: "已有工程" })).toBeTruthy();
    fireEvent.click(project.getByRole("button", { name: "继续对话" }));

    expect(location.pathname).toBe(
      "/p/prj_first/workspace/ws_first/conversation",
    );
    expect(setProjectId).toHaveBeenCalledWith("prj_first");
  });

  it("opens management for the selected project without submitting a mutation", async () => {
    const fetchMock = installFetch();
    renderDirectory();

    const project = within(
      await screen.findByRole("article", { name: "已有工程" }),
    );
    fireEvent.click(project.getByRole("button", { name: "项目管理" }));

    expect(location.pathname).toBe("/p/prj_first/settings");
    expect(setProjectId).toHaveBeenCalledWith("prj_first");
    expect(fetchMock.mock.calls.every(([url]) => url !== "/commands")).toBe(
      true,
    );
  });

  it("offers archived projects as history while keeping new-work actions unavailable", async () => {
    installFetch();
    renderDirectory();
    await screen.findByRole("article", { name: "已有工程" });
    expect(screen.queryByRole("article", { name: "历史工程" })).toBeNull();

    fireEvent.click(screen.getByLabelText("显示已归档项目"));
    fireEvent.change(screen.getByLabelText("搜索项目"), {
      target: { value: "历史" },
    });
    const archived = within(screen.getByRole("article", { name: "历史工程" }));
    expect(screen.queryByRole("article", { name: "已有工程" })).toBeNull();
    expect(archived.queryByRole("button", { name: "继续对话" })).toBeNull();
    expect(archived.queryByRole("button", { name: "项目管理" })).toBeNull();
    fireEvent.click(archived.getByRole("button", { name: "历史工程" }));
    expect(location.pathname).toBe("/p/prj_archived");
  });

  it("distinguishes a failed project read from an empty directory and allows retry", async () => {
    const fetchMock = installFetch();
    fetchMock.mockRejectedValueOnce(new Error("offline"));
    renderDirectory();

    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.queryByText("还没有项目，可以先创建一个项目。")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "重新加载项目" }));
    expect(
      await screen.findByRole("article", { name: "已有工程" }),
    ).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
