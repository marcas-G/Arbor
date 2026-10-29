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
  verificationEligible,
  verificationFull,
  WORK_CURRENT,
  WORK_PENDING,
  WS,
  workDetailCompleted,
  workDetailCurrent,
  workDetailPending,
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
  "work-detail": () => ({ dto: workDetailCurrent }),
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
  it("工作详情来自 exact Work Detail view + 返回工作区导航", async () => {
    installViews();
    renderWork(WORK_CURRENT);
    await waitFor(() => expect(screen.getByText("当前工作目标")).toBeTruthy());
    expect(screen.getByText("测试当前工作详情")).toBeTruthy();
    expect(screen.getByText(WORK_CURRENT).closest("details")?.open).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "返回工作区" }));
    expect(window.location.pathname).toBe(`/p/prj_1/workspace/${WS}`);
  });

  it("历史 Work 的 objective 来自 Work Detail view", async () => {
    installViews({
      ...defaultHandlers,
      "workspace-detail": () => ({ dto: detailPendingOnly }),
      "work-detail": () => ({ dto: workDetailPending }),
    });
    renderWork(WORK_PENDING);
    await waitFor(() => expect(screen.getByText("待办工作目标")).toBeTruthy());
    expect(screen.getByText(WORK_PENDING)).toBeTruthy();
  });

  it("目标不存在由 Work Detail 的 not-found Problem 呈现", async () => {
    const urls = installViews({
      ...defaultHandlers,
      "work-detail": () => ({
        problem: {
          code: "projection/work-not-found",
          category: "not-found",
          message: "projection/work-not-found",
          correlationId: null,
          retryDisposition: "non-retryable",
          safeDetails: {},
        },
      }),
    });
    renderWork("wrk_missing");
    await waitFor(() => expect(screen.getByText("对象不存在")).toBeTruthy());
    expect(urls.some((url) => url.includes("/views/work-detail"))).toBe(true);
    expect(urls.some((url) => url.includes("/views/workspace-detail"))).toBe(
      false,
    );
    expect(urls.some((url) => url.includes("/views/verification"))).toBe(false);
  });

  it("验证与验收区：verdict 徽章 / criteria 行 / evidence / acceptance", async () => {
    installViews();
    renderWork(WORK_CURRENT);
    await waitFor(() => expect(screen.getByText("crit-render")).toBeTruthy());
    expect(screen.getByText("10 视图 ×3 fixture 全部可渲染")).toBeTruthy();
    expect(screen.getByText("crit-problem")).toBeTruthy();
    expect(screen.getAllByText("Pass").length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText(/human:root/)).toBeTruthy();
    expect(screen.getByText("evd_1")).toBeTruthy();
    expect(screen.getByText("evd_2")).toBeTruthy();
  });

  it("已验收 verification 不再重复暴露验收，但 exact current revision 仍可纠偏", async () => {
    const urls = installViews();
    renderWork(WORK_CURRENT);
    await waitFor(() => expect(screen.getByText("当前工作目标")).toBeTruthy());
    await waitFor(() => expect(screen.getByText("治理动作")).toBeTruthy());
    const accept = screen.getByRole("button", {
      name: "验收工作成果",
    }) as HTMLButtonElement;
    const steer = screen.getByRole("button", {
      name: "纠偏",
    }) as HTMLButtonElement;
    expect(accept.disabled).toBe(true);
    expect(steer.disabled).toBe(false);
    expect(urls.every((url) => url.startsWith("/views/"))).toBe(true);
  });

  it("仅 PASS、未验收且 exact target revision 一致时暴露冻结验收 identity", async () => {
    installViews({
      ...defaultHandlers,
      verification: () => ({ dto: verificationEligible }),
    });
    renderWork(WORK_CURRENT);
    await waitFor(() => expect(screen.getByText("crit-render")).toBeTruthy());
    const accept = screen.getByRole("button", {
      name: "验收工作成果",
    }) as HTMLButtonElement;
    expect(accept.disabled).toBe(false);
    fireEvent.click(accept);
    expect(screen.getByText(`rev 7 · ${"ver_1"}`)).toBeTruthy();
  });

  it("target revision 与 canonical current revision 不一致时不暴露验收", async () => {
    installViews({
      ...defaultHandlers,
      verification: () => ({
        dto: { ...verificationEligible, targetWorkRevision: 8 as never },
      }),
    });
    renderWork(WORK_CURRENT);
    await waitFor(() => expect(screen.getByText("crit-render")).toBeTruthy());
    expect(
      (
        screen.getByRole("button", {
          name: "验收工作成果",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
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

  it("Completed Work shows accepted result and has no governance commands", async () => {
    const urls = installViews({
      ...defaultHandlers,
      "work-detail": () => ({ dto: workDetailCompleted }),
    });
    renderWork(WORK_CURRENT);
    await waitFor(() => expect(screen.getByText("已完成")).toBeTruthy());
    expect(screen.getByText("验收记录")).toBeTruthy();
    expect(screen.getByText("acc_1")).toBeTruthy();
    expect(screen.queryByText("治理动作")).toBeNull();
    expect(urls.some((url) => url.includes("/views/work-detail"))).toBe(true);
  });

  it("Accepted but Open stays Open on the route", async () => {
    installViews({
      ...defaultHandlers,
      "work-detail": () => ({
        dto: { ...workDetailCompleted, lifecycle: "Open" },
      }),
    });
    renderWork(WORK_CURRENT);
    await waitFor(() =>
      expect(screen.getByText("已验收、待完成")).toBeTruthy(),
    );
    expect(screen.queryByText("已完成")).toBeNull();
    expect(screen.getByText("验收结果")).toBeTruthy();
    expect(screen.getByText("acc_1")).toBeTruthy();
  });

  it("Cancelled Work keeps its lifecycle and has no governance commands", async () => {
    installViews({
      ...defaultHandlers,
      "work-detail": () => ({
        dto: { ...workDetailCompleted, lifecycle: "Cancelled" },
      }),
    });
    renderWork(WORK_CURRENT);
    await waitFor(() => expect(screen.getByText("已取消")).toBeTruthy());
    expect(screen.getByText("历史验收")).toBeTruthy();
    expect(screen.queryByText("治理动作")).toBeNull();
  });
});
