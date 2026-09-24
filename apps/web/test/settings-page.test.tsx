/**
 * W-07 page tests — Settings 页（frozen §2.10）三块：权限管理 / 项目 / 会话。
 * 页面零 view 查询（fetch 全程不被调用——命令表单的提交回执路径已有
 * command-forms 测试覆盖，这里只断言 placement 与冻结合同）；Grant issuer
 * 只读负向断言是 W-00 证明④的页面级延续；Revoke 区无 grants 数据源 →
 * 说明 Empty + 表单内置空态；CreateProjectForm 仅在项目块渲染。
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, within } from "@testing-library/react";
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
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  localStorage.clear();
});

afterEach(() => {
  expect(fetchMock).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
});

describe("W-07 SettingsPage (frozen §2.10)", () => {
  it("三块标题呈现；会话块 actor 展示 + 断开回登录态（真实 SessionProvider）", () => {
    renderSettingsLive();
    expect(screen.getAllByText("user:test").length).toBeGreaterThan(0);
    expect(screen.getByRole("heading", { name: "权限管理" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "项目" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "会话" })).toBeTruthy();
    expect(screen.getByText("令牌仅保存在内存，刷新页面即失效")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "断开" }));
    expect(screen.getByText(/已断开/)).toBeTruthy();
    expect(screen.queryByText("user:test")).toBeNull();
  });

  it("Grant 表单可用：capability 选项来自 HUMAN_ACTIONABLE_COMMANDS，issuer 无可编辑控件（W-00 证明④延续）", () => {
    renderSettings();
    const permissions = screen.getByLabelText("权限管理");
    const capability = within(permissions).getByLabelText("capability");
    for (const command of HUMAN_ACTIONABLE_COMMANDS) {
      expect(
        within(capability as HTMLElement).getByRole("option", {
          name: command,
        }),
      ).toBeTruthy();
    }
    expect(screen.queryByLabelText(/issuer/i)).toBeNull();
    expect(screen.queryByPlaceholderText(/issuer/i)).toBeNull();
  });

  it("grant inventory unavailable is not presented as an empty grant list or actionable Revoke UI", () => {
    renderSettings();
    const permissions = screen.getByLabelText("权限管理");
    expect(
      within(permissions).getByText(
        "当前冻结接口未提供授权清单，无法定位可撤销授权。",
      ),
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

  it("CreateProject 表单仅在项目块渲染，权限块不出现", () => {
    renderSettings();
    const project = screen.getByLabelText("项目");
    expect(
      within(project).getByRole("heading", { name: "创建项目" }),
    ).toBeTruthy();
    expect(within(project).getByLabelText("项目名称")).toBeTruthy();
    expect(within(project).getByText(/项目切换/)).toBeTruthy();
    expect(within(project).queryByLabelText("capability")).toBeNull();
    const permissions = screen.getByLabelText("权限管理");
    expect(
      within(permissions).queryByRole("heading", { name: "创建项目" }),
    ).toBeNull();
    expect(
      within(permissions).getByRole("heading", {
        name: "授予权限（GrantPermission）",
      }),
    ).toBeTruthy();
  });

  it("shows the route project, exact authenticated issuer, and frozen capability-unavailable sections", () => {
    renderSettings();
    const project = screen.getByLabelText("项目");
    expect(within(project).getByText("prj_1")).toBeTruthy();
    const permissions = screen.getByLabelText("权限管理");
    expect(within(permissions).getByText("user:test")).toBeTruthy();
    expect(screen.getByLabelText("成员管理")).toBeTruthy();
    expect(screen.getByLabelText("供应商与模型")).toBeTruthy();
    expect(screen.getByLabelText("运行时、资源与存储")).toBeTruthy();
    expect(screen.getByLabelText("通知与安全策略")).toBeTruthy();
    expect(
      screen.queryByRole("textbox", { name: /provider|model|runtime/i }),
    ).toBeNull();
  });

  it("saves only the existing local Workbench layout preference", () => {
    renderSettings();
    fireEvent.click(screen.getByRole("radio", { name: "树优先" }));
    expect(
      JSON.parse(localStorage.getItem("arbor.workbench-layout.v1") ?? "null"),
    ).toMatchObject({ order: "tree-first" });
    expect(localStorage.getItem("arbor.workbench-layout.v1")).not.toMatch(
      /token|actor|projectId|workspace/i,
    );
  });
});
