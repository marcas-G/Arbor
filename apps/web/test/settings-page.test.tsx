/**
 * W-07 page tests — Settings 页（frozen §2.10）三块：权限管理 / 项目 / 会话。
 * 页面零 view 查询（fetch 全程不被调用——命令表单的提交回执路径已有
 * command-forms 测试覆盖，这里只断言 placement 与冻结合同）；Grant issuer
 * 只读负向断言是 W-00 证明④的页面级延续；Revoke 区无 grants 数据源 →
 * 说明 Empty + 表单内置空态；CreateProjectForm 仅在项目块渲染。
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { useEffect } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HUMAN_ACTIONABLE_COMMANDS } from "../src/commands/catalog.js";
import { SettingsPage } from "../src/pages/settings/SettingsPage.js";
import {
  SessionContext,
  type SessionContextValue,
  SessionProvider,
  useSession,
} from "../src/session/SessionContext.js";

const sessionValue: SessionContextValue = {
  token: "tok",
  actor: "user:test",
  projectId: "prj_1",
  unauthenticatedProblem: null,
  setSession: () => undefined,
  clearSession: () => undefined,
  setProjectId: () => undefined,
  reportUnauthenticated: () => undefined,
};

/** 真实 SessionProvider 需要先建立会话（clearSession 要真的改变状态）。 */
function SessionSetter({
  token,
  actor,
}: {
  readonly token: string;
  readonly actor: string;
}) {
  const { setSession } = useSession();
  useEffect(() => {
    setSession(token, actor);
  }, [token, actor, setSession]);
  return null;
}

const newClient = (): QueryClient =>
  new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });

const renderSettings = (): ReturnType<typeof render> =>
  render(
    <QueryClientProvider client={newClient()}>
      <SessionContext.Provider value={sessionValue}>
        <SettingsPage route={{ name: "settings", projectId: "prj_1" }} />
      </SessionContext.Provider>
    </QueryClientProvider>,
  );

const renderSettingsLive = (): ReturnType<typeof render> =>
  render(
    <QueryClientProvider client={newClient()}>
      <SessionProvider>
        <SessionSetter token="tok" actor="user:test" />
        <SettingsPage route={{ name: "settings", projectId: "prj_1" }} />
      </SessionProvider>
    </QueryClientProvider>,
  );

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn().mockResolvedValue({
    json: async () => ({ ok: true, body: { projects: [] } }),
  });
  vi.stubGlobal("fetch", fetchMock);
  localStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("W-07 SettingsPage (frozen §2.10)", () => {
  it("项目、权限和连接入口呈现；断开回登录态（真实 SessionProvider）", () => {
    renderSettingsLive();
    expect(screen.getByRole("heading", { name: "高级权限设置" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "项目" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "连接" })).toBeTruthy();
    expect(screen.getByText("Arbor 已连接到当前工作环境。")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "断开连接" }));
    expect(screen.getByText(/已断开/)).toBeTruthy();
  });

  it("requires confirmation before archiving the current project", async () => {
    fetchMock.mockResolvedValue({
      json: async () => ({
        ok: true,
        body: {
          projects: [
            {
              projectId: "prj_1",
              name: "当前项目",
              lifecycle: "Open",
              revision: 4,
            },
          ],
        },
      }),
    });
    renderSettingsLive();
    expect(
      await screen.findByRole("button", { name: "归档项目" }),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "归档项目" }));
    expect(screen.getByText("确认归档这个项目？")).toBeTruthy();
    expect(screen.getByRole("button", { name: "确认归档" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    expect(screen.queryByText("确认归档这个项目？")).toBeNull();
  });

  it("Grant 表单可用：capability 选项来自 HUMAN_ACTIONABLE_COMMANDS，issuer 无可编辑控件（W-00 证明④延续）", () => {
    renderSettings();
    const permissions = screen.getByLabelText("权限管理");
    fireEvent.click(
      within(permissions).getByText("为特定用户或自动分工开放额外操作"),
    );
    const capability = within(permissions).getByLabelText("允许的操作");
    for (const command of HUMAN_ACTIONABLE_COMMANDS) {
      expect(
        (capability as HTMLSelectElement).querySelector(
          `option[value="${command}"]`,
        ),
      ).not.toBeNull();
    }
    expect(screen.queryByLabelText(/issuer/i)).toBeNull();
    expect(screen.queryByPlaceholderText(/issuer/i)).toBeNull();
  });

  it("grant inventory unavailable is not presented as an empty grant list or actionable Revoke UI", () => {
    renderSettings();
    const permissions = screen.getByLabelText("权限管理");
    fireEvent.click(
      within(permissions).getByText("为特定用户或自动分工开放额外操作"),
    );
    expect(
      within(permissions).getByText("已授予的权限暂时不能在这里撤销。"),
    ).toBeTruthy();
    expect(
      within(permissions).queryByRole("button", { name: "撤销" }),
    ).toBeNull();
    expect(
      within(permissions).queryByRole("heading", {
        name: /RevokePermission/,
      }),
    ).toBeNull();
  });

  it("项目设置只管理当前项目，不重复提供全局创建入口", () => {
    renderSettings();
    const project = screen.getByLabelText("项目");
    expect(
      within(project).queryByRole("heading", { name: "创建项目" }),
    ).toBeNull();
    expect(within(project).getByText(/全局项目中心/)).toBeTruthy();
    expect(within(project).queryByLabelText("capability")).toBeNull();
    const permissions = screen.getByLabelText("权限管理");
    expect(
      within(permissions).queryByRole("heading", { name: "创建项目" }),
    ).toBeNull();
    expect(
      within(permissions).getByRole("heading", {
        name: "开放额外操作",
      }),
    ).toBeTruthy();
  });

  it("does not expose internal project, actor, or unavailable backend sections", () => {
    renderSettings();
    expect(screen.queryByText("prj_1")).toBeNull();
    expect(screen.queryByText("user:test")).toBeNull();
    expect(screen.queryByLabelText("成员管理")).toBeNull();
    expect(screen.queryByLabelText("供应商与模型")).toBeNull();
    expect(screen.queryByLabelText("运行时、资源与存储")).toBeNull();
    expect(
      screen.queryByRole("textbox", { name: /provider|model|runtime/i }),
    ).toBeNull();
  });

  it("saves only the existing local Workbench layout preference", () => {
    renderSettings();
    fireEvent.click(screen.getByRole("radio", { name: "分工优先" }));
    expect(
      JSON.parse(localStorage.getItem("arbor.workbench-layout.v1") ?? "null"),
    ).toMatchObject({ order: "tree-first" });
    expect(localStorage.getItem("arbor.workbench-layout.v1")).not.toMatch(
      /token|actor|projectId|workspace/i,
    );
  });
});
