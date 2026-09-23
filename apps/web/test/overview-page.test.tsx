/**
 * W-03 — Overview 落地页（frozen §2.2）：三区块渲染 / 空态 / 钉死文案
 * "Root Workspace 最近活动"（绝不出现"项目最近活动"）/ 查询失败就地
 * ProblemCard（category:"unavailable"，unauthenticated 全局门归
 * Session 外层）/ cost Unknown ≠ 0 原样 "unknown"。
 * mock 响应统一走 QueryResult 包装 {ok,status,body:{value,watermark}}。
 */
import type { Problem } from "@arbor/api-contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { inboxGovernanceDecidable } from "../src/pages/overview/fixtures.js";
import { OverviewPage } from "../src/pages/overview/OverviewPage.js";
import { SessionContext } from "../src/session/SessionContext.js";
import {
  attentionMinimal,
  attentionTypical,
  detailTypical,
  inboxMinimal,
  treeTypical,
  usageMinimal,
  usageTypical,
} from "../src/views/fixtures.js";

const ROOT_WORKSPACE_ID = "ws_018f6a2e-0000-7000-8000-000000000001";

type ViewHandler = (
  body: Record<string, unknown>,
) => Response | Promise<Response>;

const okResponse = (value: unknown): Response =>
  new Response(
    JSON.stringify({ ok: true, status: 200, body: { value, watermark: 1 } }),
    { status: 200 },
  );

const unavailableProblem = (): Problem => ({
  code: "view/projection-unavailable",
  category: "unavailable",
  message: "projection unavailable",
  correlationId: null,
  retryDisposition: "retryable",
  safeDetails: {},
});

const problemResponse = (problem: Problem): Response =>
  new Response(JSON.stringify({ ok: false, status: 503, problem }), {
    status: 503,
  });

const typicalRoutes: Record<string, ViewHandler> = {
  "/views/responsibility-tree": () => okResponse(treeTypical),
  "/views/attention": () => okResponse(attentionTypical),
  "/views/usage": () => okResponse(usageTypical),
  "/views/workspace-detail": () => okResponse(detailTypical),
  "/views/inbox-view": (body) =>
    body.workspaceId === ROOT_WORKSPACE_ID
      ? okResponse(inboxGovernanceDecidable)
      : okResponse(inboxMinimal),
};

const installFetch = (routes: Record<string, ViewHandler>): void => {
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async (
        input: string | URL | Request,
        init?: RequestInit,
      ): Promise<Response> => {
        const clean =
          (input instanceof Request ? input.url : String(input)).split(
            "?",
          )[0] ?? "";
        const entry = Object.entries(routes).find(([route]) =>
          clean.includes(route),
        );
        if (entry === undefined) {
          throw new Error(`unexpected view fetch: ${clean}`);
        }
        const body = JSON.parse(String(init?.body ?? "{}")) as Record<
          string,
          unknown
        >;
        return entry[1](body);
      },
    ),
  );
};

const sessionValue = {
  token: "tok",
  actor: "user:test",
  projectId: "prj_1",
  unauthenticatedProblem: null,
  setSession: () => undefined,
  clearSession: () => undefined,
  setProjectId: () => undefined,
  reportUnauthenticated: () => undefined,
};

const renderOverview = (): void => {
  const client = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
        staleTime: Number.POSITIVE_INFINITY,
        refetchOnWindowFocus: false,
      },
    },
  });
  render(
    <QueryClientProvider client={client}>
      <SessionContext.Provider value={sessionValue as never}>
        <OverviewPage projectId="prj_1" />
      </SessionContext.Provider>
    </QueryClientProvider>,
  );
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("W-03 OverviewPage", () => {
  it("三区块渲染：待处理摘要（Governance 条目 + 待决策）、树顶卡名、Root Workspace 最近活动（Mono 时间）、attention 计数", async () => {
    installFetch(typicalRoutes);
    renderOverview();

    expect(
      screen.getByRole("heading", { level: 1, name: "概览" }),
    ).toBeTruthy();

    // 区块①：governance 条目（可解析 → 待决策；不合规 key → 只读降级）
    await waitFor(() =>
      expect(screen.getByText("组建评审：前端渲染合同变更")).toBeTruthy(),
    );
    expect(screen.getByText("待决策")).toBeTruthy();
    expect(screen.getByText("key 不合规的治理条目（只读降级）")).toBeTruthy();
    expect(screen.getByText("wait-cycles#1")).toBeTruthy();

    // 区块②：树顶卡名 + root usage（Known cost）
    expect(screen.getAllByText("平台根工作区").length).toBeGreaterThan(0);
    expect(screen.getByText("前端渲染")).toBeTruthy();

    // 区块③：钉死文案 + Mono 时间 + attention 计数
    await waitFor(() =>
      expect(screen.getByText("Root Workspace 最近活动")).toBeTruthy(),
    );
    const time = screen.getByTitle("2026-09-23T09:00:00.000Z");
    expect(time.tagName).toBe("TIME");
    expect(screen.getByText("CurrentWorkChanged")).toBeTruthy();
    expect(screen.getByText("Attention 1")).toBeTruthy();
    expect(screen.getByText("ActionRequired 2")).toBeTruthy();

    // 导航：待决策 → 队列页；attention 行 → attention 页；树顶卡 → workspace
    fireEvent.click(screen.getByRole("button", { name: "去队列" }));
    expect(location.pathname).toBe("/p/prj_1/queue");
    fireEvent.click(screen.getByRole("button", { name: /wait-cycles#1/ }));
    expect(location.pathname).toBe("/p/prj_1/attention");
    fireEvent.click(screen.getByRole("button", { name: /平台根工作区/ }));
    expect(location.pathname).toBe(`/p/prj_1/workspace/${ROOT_WORKSPACE_ID}`);
  });

  it("空态：全部空 → 各区块 Empty 文案，attention 计数为 0", async () => {
    installFetch({
      "/views/responsibility-tree": () => okResponse({ nodes: [] }),
      "/views/attention": () => okResponse(attentionMinimal),
      "/views/usage": () => okResponse(usageMinimal),
    });
    renderOverview();

    await waitFor(() =>
      expect(screen.getByText("没有等你处理的事项")).toBeTruthy(),
    );
    expect(screen.getByText("无工作区")).toBeTruthy();
    expect(screen.getByText("无用量数据")).toBeTruthy();
    expect(screen.getByText("无审计事件")).toBeTruthy();
    expect(screen.getByText("Attention 0")).toBeTruthy();
    expect(screen.getByText("ActionRequired 0")).toBeTruthy();
  });

  it('文案钉死：包含 "Root Workspace 最近活动"，不含 "项目最近活动"', async () => {
    installFetch(typicalRoutes);
    renderOverview();
    await waitFor(() =>
      expect(screen.getByText("Root Workspace 最近活动")).toBeTruthy(),
    );
    expect(screen.queryByText(/项目最近活动/)).toBeNull();
  });

  it("attention 查询 unavailable problem → 相关区块就地 ProblemCard，其余区块不崩", async () => {
    installFetch({
      ...typicalRoutes,
      "/views/attention": () => problemResponse(unavailableProblem()),
    });
    renderOverview();

    await waitFor(() =>
      expect(screen.getAllByText("服务不可用").length).toBeGreaterThan(0),
    );
    expect(screen.queryByText("没有等你处理的事项")).toBeNull();
    await waitFor(() => expect(screen.getByText("平台根工作区")).toBeTruthy());
    await waitFor(() =>
      expect(screen.getByText("CurrentWorkChanged")).toBeTruthy(),
    );
  });

  it("cost Unknown ≠ 0：树顶卡与用量行均原样呈现 unknown", async () => {
    installFetch(typicalRoutes);
    renderOverview();
    await waitFor(() =>
      expect(
        screen.getAllByText("tokens 300 · cost unknown · turns 2").length,
      ).toBe(2),
    );
    expect(
      screen.getAllByText("tokens 1200 · cost 0.42 USD · turns 7").length,
    ).toBe(2);
  });
});
