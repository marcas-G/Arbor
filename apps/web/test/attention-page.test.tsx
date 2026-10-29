/**
 * W-06 — 关注事项页测试（frozen §2.6，read-only）：severity 分组顺序
 * （ActionRequired 在前）与组头计数、source 单选筛选（chip → 仅该源；
 * 全部恢复；未知 source 原样行 + muted option）、行点击目标工作区导航、
 * 空态 Empty；断言全部 fetch 均为 /views/（0 个 command）。
 */
import type { Problem } from "@arbor/api-contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Route } from "../src/api/router.js";
import { AttentionPage } from "../src/pages/attention/AttentionPage.js";
import {
  attentionPageEmpty,
  attentionPageTypical,
} from "../src/pages/attention/fixtures.js";
import {
  SessionContext,
  type SessionContextValue,
} from "../src/session/SessionContext.js";

type MockOutcome = { readonly dto: unknown } | { readonly problem: Problem };

const okBody = (dto: unknown): string =>
  JSON.stringify({ ok: true, status: 200, body: { value: dto, watermark: 1 } });

const problemBody = (problem: Problem): string =>
  JSON.stringify({ ok: false, status: 200, problem });

const installAttention = (
  outcome: MockOutcome = { dto: attentionPageTypical },
): string[] => {
  const urls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: unknown): Promise<Response> => {
      const url = String(input);
      urls.push(url);
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

const installAttentionSequence = (outcomes: ReadonlyArray<MockOutcome>) => {
  const urls: string[] = [];
  let index = 0;
  const fetchMock = vi.fn(async (input: unknown): Promise<Response> => {
    const url = String(input);
    urls.push(url);
    const outcome = outcomes[Math.min(index, outcomes.length - 1)];
    index += 1;
    if (outcome === undefined) throw new Error("attention fixture is empty");
    return new Response(
      "problem" in outcome ? problemBody(outcome.problem) : okBody(outcome.dto),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  });
  vi.stubGlobal("fetch", fetchMock);
  return { fetchMock, urls };
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

const renderAttention = () => {
  const route: Extract<Route, { name: "attention" }> = {
    name: "attention",
    projectId: "prj_1",
  };
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: Number.POSITIVE_INFINITY },
    },
  });
  const rendered = render(
    <QueryClientProvider client={client}>
      <SessionContext.Provider value={sessionValue}>
        <AttentionPage route={route} />
      </SessionContext.Provider>
    </QueryClientProvider>,
  );
  return { client, ...rendered };
};

beforeEach(() => {
  window.history.replaceState(null, "", "/p/prj_1");
});

afterEach(() => {
  vi.unstubAllGlobals();
  Object.defineProperty(window, "innerWidth", {
    configurable: true,
    value: 1024,
  });
});

describe("W-06 关注事项页（只读）", () => {
  it("renders sandbox Attention sources as read-only safe rows", async () => {
    const urls = installAttention({
      dto: {
        rows: [
          {
            source: "SandboxProviderUnavailable",
            severity: "ActionRequired",
            targetWorkspaceId: "ws_1",
            dedupKey: "att_provider",
            summaryRef:
              "Required sandbox capabilities are unavailable; execution did not start.",
            occurredAt: "2026-10-19T10:00:00.000Z",
          },
          {
            source: "SandboxRecoveryBindingFailure",
            severity: "ActionRequired",
            targetWorkspaceId: "ws_2",
            dedupKey: "a".repeat(64),
            summaryRef:
              "Sandbox recovery binding evidence is missing or invalid; execution is paused.",
            occurredAt: "2026-10-19T10:00:01.000Z",
          },
        ],
      },
    });
    renderAttention();
    await waitFor(() =>
      expect(
        screen.getByText(
          "Sandbox recovery binding evidence is missing or invalid; execution is paused.",
        ),
      ).toBeTruthy(),
    );
    expect(
      screen.getAllByText(
        "Required sandbox capabilities are unavailable; execution did not start.",
      ),
    ).toHaveLength(3);
    fireEvent.click(
      screen.getByRole("button", {
        name: /Sandbox recovery binding evidence is missing or invalid/,
      }),
    );
    const inspection = screen.getByRole("complementary", {
      name: "关注事项检查面板",
    });
    expect(within(inspection).getByText("a".repeat(64))).toBeTruthy();
    expect(
      within(inspection).queryByRole("button", { name: /repair|rebind/i }),
    ).toBeNull();
    expect(urls.every((url) => url.startsWith("/views/"))).toBe(true);
  });

  it("renders terminal Provider failure code and exact Work revision without a retry action", async () => {
    installAttention({
      dto: {
        rows: [
          {
            source: "TerminalProviderFailure",
            severity: "ActionRequired",
            targetWorkspaceId: "ws_1",
            dedupKey: `terminal-provider-failure:wrk_1:2:${"a".repeat(64)}`,
            summaryRef:
              "The model provider rejected this Work execution. Review the provider configuration or request compatibility, then explicitly steer the Work to retry.",
            occurredAt: "2026-10-25T00:00:01.000Z",
            terminalProviderFailure: {
              kind: "TerminalProviderFailure",
              workId: "wrk_1",
              workRevision: 2,
              occurredAt: "2026-10-25T00:00:01.000Z",
              failureCode: "RequestRejected",
            },
          },
        ],
      },
    });
    renderAttention();
    await waitFor(() =>
      expect(screen.getByText("RequestRejected")).toBeTruthy(),
    );
    expect(screen.getByText("2")).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: /重新验证|Retry Verification/iu }),
    ).toBeNull();
  });

  it("severity 分组顺序：ActionRequired 组在前；组头 danger/attention Badge + 计数", async () => {
    installAttention();
    renderAttention();
    await waitFor(() => expect(screen.getByText("dep-report#9")).toBeTruthy());
    const headings = [
      ...within(screen.getByLabelText("关注事项分组")).getAllByRole("heading", {
        level: 2,
      }),
    ];
    expect(headings.length).toBe(2);
    expect(headings[0]?.textContent).toContain("ActionRequired");
    expect(headings[0]?.textContent).toContain("2 条");
    expect(headings[0]?.querySelector(".arbor-badge-danger")).not.toBeNull();
    expect(headings[1]?.textContent).toContain("Attention");
    expect(headings[1]?.textContent).toContain("2 条");
    expect(headings[1]?.querySelector(".arbor-badge-attention")).not.toBeNull();
  });

  it("source 筛选：单选 chip → 仅该源行；全部恢复；未知 source 原样行 + muted option", async () => {
    installAttention();
    renderAttention();
    await waitFor(() => expect(screen.getByText("mystery#1")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Deadlock" }));
    expect(
      within(screen.getByLabelText("关注事项分组")).getByText("wait-cycles#1"),
    ).toBeTruthy();
    expect(screen.queryByText("dep-report#9")).toBeNull();
    expect(screen.queryByText("verifier-orphan#4")).toBeNull();
    expect(screen.queryByText("mystery#1")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "全部" }));
    expect(screen.getByText("dep-report#9")).toBeTruthy();
    expect(screen.getByText("verifier-orphan#4")).toBeTruthy();
    expect(screen.getByText("mystery#1")).toBeTruthy();
    const unknowns = screen.getAllByText("MysterySource");
    expect(unknowns.length).toBe(2);
    for (const element of unknowns) {
      expect(element.className).toContain("arbor-badge-muted");
    }
    const chipBadge = unknowns.find((element) =>
      element.closest("button[aria-pressed]"),
    );
    expect(chipBadge).toBeDefined();
  });

  it("选择行后可从只读检查面导航到目标工作区", async () => {
    installAttention();
    renderAttention();
    await waitFor(() =>
      expect(
        within(screen.getByLabelText("关注事项分组")).getByText(
          "wait-cycles#1",
        ),
      ).toBeTruthy(),
    );
    fireEvent.click(screen.getByRole("button", { name: /wait-cycles#1/ }));
    const inspection = screen.getByRole("complementary", {
      name: "关注事项检查面板",
    });
    expect(within(inspection).getByText("dl-1")).toBeTruthy();
    expect(within(inspection).getByText("Deduplication key")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "打开目标工作区" }));
    expect(window.location.pathname).toBe("/p/prj_1/workspace/ws_1");
  });

  it("VerifierOrphan 检查展示精确 Work/Verification/revision 绑定但不暴露未经解析的重试动作", async () => {
    const urls = installAttention();
    renderAttention();
    await waitFor(() =>
      expect(screen.getByText("verifier-orphan#4")).toBeTruthy(),
    );
    fireEvent.click(screen.getByRole("button", { name: /verifier-orphan#4/ }));
    const inspection = screen.getByRole("complementary", {
      name: "关注事项检查面板",
    });
    expect(within(inspection).getByText("wrk_4")).toBeTruthy();
    expect(within(inspection).getByText("ver_4")).toBeTruthy();
    expect(within(inspection).getByText("Target Work revision")).toBeTruthy();
    expect(within(inspection).getByText("7")).toBeTruthy();
    expect(
      within(inspection).queryByRole("button", { name: /RetryVerification/ }),
    ).toBeNull();
    expect(urls.every((url) => url.startsWith("/views/"))).toBe(true);
  });

  it("只有服务端对当前 principal 精确解析通过后才显示 RetryVerification 表单", async () => {
    const rows = attentionPageTypical.rows.map((row) =>
      row.source === "VerifierOrphan"
        ? { ...row, availableActions: ["RetryVerification"] as const }
        : row,
    );
    installAttention({ dto: { rows } });
    renderAttention();
    await waitFor(() =>
      expect(screen.getByText("verifier-orphan#4")).toBeTruthy(),
    );
    fireEvent.click(screen.getByRole("button", { name: /verifier-orphan#4/ }));
    expect(screen.getByRole("form", { name: "重新启动验证" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "提交重试" })).toBeTruthy();
  });

  it("空态 Empty 无关注事项；全部 fetch 均为 /views/（无任何 command）", async () => {
    const urls = installAttention({ dto: attentionPageEmpty });
    renderAttention();
    await waitFor(() => expect(screen.getByText("无关注事项")).toBeTruthy());
    expect(urls.every((url) => url.startsWith("/views/"))).toBe(true);
    expect(urls.every((url) => url.startsWith("/views/attention"))).toBe(true);
  });

  it("activation Attention clears the Pending notice when a later read has no pending source", async () => {
    const pendingActivation = {
      source: "WorkspaceResourceActivationPending" as const,
      severity: "ActionRequired" as const,
      targetWorkspaceId: "ws_1" as never,
      dedupKey: "resource-activation:prj_1:ws_1:0",
      summaryRef: "resource-activation-pending",
      occurredAt: "2026-10-12T00:00:00.000Z",
    };
    const { fetchMock } = installAttentionSequence([
      { dto: { rows: [pendingActivation] } },
      { dto: attentionPageEmpty },
    ]);
    const { client } = renderAttention();
    const pendingNotice =
      "项目已创建，但资源尚未激活，文件操作暂不可用。该创建命令已经提交，请勿重复创建；此状态会随资源激活更新。";
    await waitFor(() => expect(screen.getByText(pendingNotice)).toBeTruthy());

    await client.invalidateQueries({ queryKey: ["view", "attention"] });

    await waitFor(() => expect(screen.queryByText(pendingNotice)).toBeNull());
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("an Attention read error shows Unknown and never claims resource activation", async () => {
    const pendingNotice =
      "项目已创建，但资源尚未激活，文件操作暂不可用。该创建命令已经提交，请勿重复创建；此状态会随资源激活更新。";
    const pendingActivation = {
      source: "WorkspaceResourceActivationPending" as const,
      severity: "ActionRequired" as const,
      targetWorkspaceId: "ws_1" as never,
      dedupKey: "resource-activation:prj_1:ws_1:0",
      summaryRef: "resource-activation-pending",
      occurredAt: "2026-10-12T00:00:00.000Z",
    };
    const { fetchMock } = installAttentionSequence([
      { dto: { rows: [pendingActivation] } },
      {
        problem: {
          code: "view/attention-unavailable",
          category: "unavailable",
          message: "attention view failed",
          correlationId: null,
          retryDisposition: "retryable",
          safeDetails: {},
        },
      },
    ]);
    const { client } = renderAttention();
    await waitFor(() => expect(screen.getByText(pendingNotice)).toBeTruthy());

    await client.invalidateQueries({ queryKey: ["view", "attention"] });

    await waitFor(() =>
      expect(
        screen.getByText(
          "无法确认此项目的资源激活状态。请勿重复创建；刷新关注事项后再确认。",
        ),
      ).toBeTruthy(),
    );
    expect(screen.queryByText(pendingNotice)).toBeNull();
    expect(screen.queryByText(/资源已经激活/u)).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("行交互后仍全部 fetch 均为 /views/", async () => {
    const urls = installAttention();
    renderAttention();
    await waitFor(() => expect(screen.getByText("dep-report#9")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Deadlock" }));
    fireEvent.click(screen.getByRole("button", { name: /wait-cycles#1/ }));
    fireEvent.click(screen.getByRole("button", { name: "打开目标工作区" }));
    expect(window.location.pathname).toBe("/p/prj_1/workspace/ws_1");
    expect(urls.every((url) => url.startsWith("/views/"))).toBe(true);
  });

  it("mobile selection opens a read-only inspection sheet", async () => {
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      value: 390,
    });
    const urls = installAttention();
    renderAttention();
    const row = await screen.findByRole("button", { name: /wait-cycles#1/ });
    expect(screen.queryByRole("dialog", { name: "关注事项检查" })).toBeNull();
    fireEvent.click(row);
    expect(screen.getByRole("dialog", { name: "关注事项检查" })).toBeTruthy();
    expect(
      within(screen.getByRole("dialog", { name: "关注事项检查" })).getByText(
        "ws_1",
      ),
    ).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: /acknowledge|snooze|修复/i }),
    ).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "关闭" }));
    expect(screen.queryByRole("dialog", { name: "关注事项检查" })).toBeNull();
    expect(urls.every((url) => url.startsWith("/views/attention"))).toBe(true);
  });

  it("查询 problem → 就地 ProblemCard", async () => {
    installAttention({
      problem: {
        code: "view/attention-unavailable",
        category: "unavailable",
        message: "attention view failed",
        correlationId: null,
        retryDisposition: "retryable",
        safeDetails: {},
      },
    });
    renderAttention();
    await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());
    expect(screen.getByText("服务不可用")).toBeTruthy();
  });
});
