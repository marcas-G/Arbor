/**
 * W-06 — Work Detail 页测试（frozen §2.5）：头部 objective 匹配
 * （currentWork / pendingWorks 两分支）、未找到 Empty、验证与验收区
 * VerificationView 呈现、治理占位 disabled（W-08）且 0 个 /commands
 * fetch、查询 problem 就地 ProblemCard。jsdom + RTL，fetch 按 URL
 * 分流，body 形状 {ok:true,status:200,body:{value,watermark}}。
 */
import type { Problem } from "@arbor/api-contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Route } from "../src/api/router.js";
import {
  detailCurrentWork,
  detailPendingOnly,
  unavailableProblem,
  verificationFull,
  WORK_CURRENT,
  WORK_PENDING,
  WS,
} from "../src/pages/work/fixtures.js";
import { WorkPage } from "../src/pages/work/WorkPage.js";
import {
  SessionContext,
  type SessionContextValue,
} from "../src/session/SessionContext.js";

type MockOutcome = { readonly dto: unknown } | { readonly problem: Problem };
type ViewHandler = () => MockOutcome;

const okBody = (dto: unknown): string =>
  JSON.stringify({ ok: true, status: 200, body: { value: dto, watermark: 1 } });

const problemBody = (problem: Problem): string =>
  JSON.stringify({ ok: false, status: 200, problem });

const defaultHandlers: Record<string, ViewHandler> = {
  "workspace-detail": () => ({ dto: detailCurrentWork }),
  verification: () => ({ dto: verificationFull }),
};

const installViews = (
  handlers: Record<string, ViewHandler> = defaultHandlers,
): string[] => {
  const urls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: unknown): Promise<Response> => {
      const url = String(input);
      urls.push(url);
      const view = url.split("/views/")[1] ?? "unknown-view";
      const handler = handlers[view];
      const outcome: MockOutcome =
        handler === undefined ? { dto: null } : handler();
      return new Response(
        "problem" in outcome
          ? problemBody(outcome.problem)
          : okBody(outcome.dto),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }),
  );
  return urls;
};

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

const renderWork = (workId: string) => {
  const route: Extract<Route, { name: "work" }> = {
    name: "work",
    projectId: "prj_1",
    workspaceId: WS,
    workId,
  };
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: Number.POSITIVE_INFINITY },
    },
  });
  return render(
    <QueryClientProvider client={client}>
      <SessionContext.Provider value={sessionValue}>
        <WorkPage route={route} />
      </SessionContext.Provider>
    </QueryClientProvider>,
  );
};

beforeEach(() => {
  window.history.replaceState(null, "", "/p/prj_1");
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("W-06 Work Detail 页", () => {
  it("头部：workId（Mono）+ objective（currentWork 匹配）+ 返回工作区导航", async () => {
    installViews();
    renderWork(WORK_CURRENT);
    await waitFor(() => expect(screen.getByText("当前工作目标")).toBeTruthy());
    expect(screen.getByText(WORK_CURRENT)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "返回工作区" }));
    expect(window.location.pathname).toBe(`/p/prj_1/workspace/${WS}`);
  });

  it("头部：objective 来自 pendingWorks 匹配分支", async () => {
    installViews({
      ...defaultHandlers,
      "workspace-detail": () => ({ dto: detailPendingOnly }),
    });
    renderWork(WORK_PENDING);
    await waitFor(() => expect(screen.getByText("待办工作目标")).toBeTruthy());
    expect(screen.getByText(WORK_PENDING)).toBeTruthy();
  });

  it("未找到匹配 workId → Empty 未找到该工作（且不发 verification 查询）", async () => {
    const urls = installViews();
    renderWork("wrk_missing");
    await waitFor(() => expect(screen.getByText("未找到该工作")).toBeTruthy());
    expect(urls.every((url) => !url.includes("/views/verification"))).toBe(
      true,
    );
  });

  it("验证与验收区：verdict 徽章 / criteria 行 / evidence / acceptance", async () => {
    installViews();
    renderWork(WORK_CURRENT);
    await waitFor(() => expect(screen.getByText("crit-render")).toBeTruthy());
    expect(screen.getByText("9 视图 ×3 fixture 全部可渲染")).toBeTruthy();
    expect(screen.getByText("crit-problem")).toBeTruthy();
    expect(screen.getAllByText("Pass").length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText(/human:root/)).toBeTruthy();
    expect(screen.getByText("evd_1")).toBeTruthy();
    expect(screen.getByText("evd_2")).toBeTruthy();
  });

  it("治理动作占位：验收/纠偏均 disabled + W-08 标注；无 /commands fetch", async () => {
    const urls = installViews();
    renderWork(WORK_CURRENT);
    await waitFor(() => expect(screen.getByText("当前工作目标")).toBeTruthy());
    const accept = screen.getByRole("button", { name: "验收工作成果" });
    const steer = screen.getByRole("button", { name: "纠偏" });
    expect((accept as HTMLButtonElement).disabled).toBe(true);
    expect((steer as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/W-08/)).toBeTruthy();
    expect(urls.every((url) => url.startsWith("/views/"))).toBe(true);
  });

  it("查询 problem → 就地 ProblemCard", async () => {
    installViews({
      ...defaultHandlers,
      verification: () => ({ problem: unavailableProblem }),
    });
    renderWork(WORK_CURRENT);
    await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());
    expect(screen.getByText("服务不可用")).toBeTruthy();
    expect(screen.getByText(/view\/verification-unavailable/)).toBeTruthy();
  });
});
