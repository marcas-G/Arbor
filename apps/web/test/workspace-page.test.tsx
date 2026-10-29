/**
 * W-05 — Workspace page（frozen §2.4）：头部 + 五 tab。jsdom + RTL，
 * QueryClientProvider 包裹；fetch 按 /views/:view URL 分流，body 形状
 * {ok:true,status:200,body:{value,watermark}}（problem 走 {ok:false,problem}）。
 */
import type { Problem, WorkspaceDetailRes } from "@arbor/api-contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceTab } from "../src/api/router.js";
import {
  detailNoCurrentWork,
  transcriptPage2,
  treeWsFixture,
  unavailableProblem,
} from "../src/pages/workspace/fixtures.js";
import { WorkspacePage } from "../src/pages/workspace/WorkspacePage.js";
import {
  SessionContext,
  type SessionContextValue,
} from "../src/session/SessionContext.js";
import {
  currentWorkNull,
  currentWorkTypical,
  dependencyTypical,
  detailTypical,
  inboxTypical,
  transcriptTypical,
} from "../src/views/fixtures.js";

type MockOutcome = { readonly dto: unknown } | { readonly problem: Problem };
type ViewHandler = (request: Record<string, unknown>) => MockOutcome;

const okBody = (dto: unknown): string =>
  JSON.stringify({ ok: true, status: 200, body: { value: dto, watermark: 1 } });

const problemBody = (problem: Problem): string =>
  JSON.stringify({ ok: false, status: 200, problem });

const defaultHandlers: Record<string, ViewHandler> = {
  "workspace-detail": () => ({ dto: detailTypical }),
  "current-work": () => ({ dto: currentWorkTypical }),
  "responsibility-tree": () => ({ dto: treeWsFixture }),
  "dependency-view": () => ({ dto: dependencyTypical }),
  transcript: (request) => ({
    dto: request.cursor === undefined ? transcriptTypical : transcriptPage2,
  }),
  "inbox-view": () => ({ dto: inboxTypical }),
};

const installViews = (
  handlers: Record<string, ViewHandler> = defaultHandlers,
): Array<{ view: string; request: Record<string, unknown> }> => {
  const calls: Array<{ view: string; request: Record<string, unknown> }> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: unknown, init?: { readonly body?: unknown }) => {
      const view = String(input).split("/views/")[1] ?? "unknown-view";
      const body = init?.body;
      const request: Record<string, unknown> =
        typeof body === "string"
          ? (JSON.parse(body) as Record<string, unknown>)
          : {};
      calls.push({ view, request });
      const handler = handlers[view] ?? ((): MockOutcome => ({ dto: null }));
      const outcome = handler(request);
      return new Response(
        "problem" in outcome
          ? problemBody(outcome.problem)
          : okBody(outcome.dto),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }),
  );
  return calls;
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

const sandboxCandidateId = `spc2_${"1".repeat(64)}`;
type CandidateRead = NonNullable<
  WorkspaceDetailRes["sandboxPolicyCandidateRead"]
>;
const candidateReadForDigest = (digest: string): CandidateRead =>
  ({
    reason: "InitialDecision",
    commonPreconditions: {
      expectedEpisodeRevision: 0,
      latestCommittedPolicyRevision: 0,
      episodeBinding: {
        _tag: "WorkEpisode",
        workId: "wrk_018f6a2e-0000-7000-8000-0000000000a1",
        targetWorkRevision: 0,
      },
      workspaceRevision: 4,
      resourceBoundaryRevision: 2,
      authorityBundleRevision: 3,
      authorityBundleDigest: "a".repeat(64),
      operatorConfigRevision: 1,
      operatorConfigDigest: "b".repeat(64),
    },
    candidates: [
      {
        kind: "OsEnforced",
        candidateId: sandboxCandidateId,
        sandboxHandleBindingDigest: digest,
        providerId: "linux-bwrap",
        providerVersion: "bwrap-v2",
        capabilityRevision: 7,
        profile: "WorkspaceWrite",
        networkMode: "Restricted",
        providerRegistryRevision: 3,
        providerRegistryDigest: "c".repeat(64),
      },
      {
        kind: "TrustedLocalUnconfinedV1",
        candidateId:
          "spc2_5ed13734a81314c653c0487eea6a454283c800b71f9c0a2bed72f4a6d49cc98d",
        sandboxHandleBindingDigest: "e".repeat(64),
      },
    ],
  }) as unknown as CandidateRead;

const detailWithSandboxCandidates = (digest: string): WorkspaceDetailRes =>
  ({
    ...detailTypical,
    sandboxPolicyCandidateRead: candidateReadForDigest(digest),
  }) as WorkspaceDetailRes;

const renderWorkspace = (tab: WorkspaceTab = "overview") => {
  const path =
    tab === "overview"
      ? "/p/prj_1/workspace/ws_1"
      : `/p/prj_1/workspace/ws_1/${tab}`;
  window.history.replaceState(null, "", path);
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: Number.POSITIVE_INFINITY },
    },
  });
  const view = render(
    <QueryClientProvider client={client}>
      <SessionContext.Provider value={sessionValue}>
        <WorkspacePage
          route={{
            name: "workspace",
            projectId: "prj_1",
            workspaceId: "ws_1",
            tab,
          }}
        />
      </SessionContext.Provider>
    </QueryClientProvider>,
  );
  return { ...view, client };
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("W-05 Workspace page", () => {
  it("shows only the path-free current sandbox policy projection", async () => {
    const detail = {
      ...detailTypical,
      executionSummary: {
        executionId: "exe_sandbox",
        admittedAt: "2026-10-19T09:00:00.000Z",
        sandboxPolicy: {
          kind: "OsEnforced" as const,
          policyRevision: 3,
          profile: "WorkspaceWrite" as const,
          providerId: "bwrap",
          providerVersion: "0.8.0",
          networkMode: "Restricted" as const,
          status: "Unavailable" as const,
          expiresAt: "2026-10-19T12:00:00.000Z",
        },
      },
    };
    installViews({
      ...defaultHandlers,
      "workspace-detail": () => ({ dto: detail }),
    });
    renderWorkspace();
    await waitFor(() => expect(screen.getByText("bwrap")).toBeTruthy());
    expect(screen.getByText("Unavailable")).toBeTruthy();
    expect(screen.getByText("WorkspaceWrite")).toBeTruthy();
    expect(screen.getByText("OS enforced")).toBeTruthy();
    expect(screen.getByText("Restricted")).toBeTruthy();
    expect(screen.getByText("3")).toBeTruthy();
    expect(
      within(screen.getByLabelText("Sandbox policy")).queryByText(
        /\/srv\/|C:\\\\Users/u,
      ),
    ).toBeNull();
  });

  it("renders NeedsDecision and TrustedLocal without implying a provider or network sandbox", async () => {
    const detail = {
      ...detailTypical,
      executionSummary: {
        executionId: "exe_sandbox",
        admittedAt: "2026-10-19T09:00:00.000Z",
        sandboxPolicy: {
          kind: "TrustedLocalUnconfinedV1" as const,
          profile: "FullAccess" as const,
          networkBoundary: "Unconfined" as const,
          policyRevision: 2,
          expiresAt: "2026-10-19T12:00:00.000Z",
          status: "NeedsDecision" as const,
        },
      },
    };
    installViews({
      ...defaultHandlers,
      "workspace-detail": () => ({ dto: detail }),
    });
    renderWorkspace();
    await waitFor(() => expect(screen.getByText("NeedsDecision")).toBeTruthy());
    expect(screen.getByText("Trusted local / unconfined")).toBeTruthy();
    expect(screen.queryByText("Network mode")).toBeNull();
    expect(screen.queryByText("os-sandbox")).toBeNull();
  });

  it("shows candidate choices with no default and does not expose binding digests", async () => {
    installViews({
      ...defaultHandlers,
      "workspace-detail": () => ({
        dto: detailWithSandboxCandidates("c".repeat(64)),
      }),
    });
    renderWorkspace();
    const osChoice = await screen.findByRole("radio", {
      name: /工作区写入隔离.*linux-bwrap.*capability 7/u,
    });
    const trustedChoice = screen.getByRole("radio", {
      name: /TrustedLocal：FullAccess/u,
    });
    expect((osChoice as HTMLInputElement).checked).toBe(false);
    expect((trustedChoice as HTMLInputElement).checked).toBe(false);
    expect(screen.queryByText("c".repeat(64))).toBeNull();
    expect(screen.queryByText("e".repeat(64))).toBeNull();
    expect(
      (
        screen.getByRole("button", {
          name: "明确提交此策略",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
  });

  it("clears a stale candidate read and requires a fresh deliberate reselection even when its ID is unchanged", async () => {
    let detailReads = 0;
    let commands = 0;
    let afterStale = false;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: unknown, init?: { readonly body?: unknown }) => {
        const url = String(input);
        if (url === "/commands") {
          commands += 1;
          afterStale = true;
          return new Response(
            JSON.stringify({
              ok: true,
              status: 200,
              body: {
                commandId: "cmd_sandbox_stale",
                resolution: "TerminalRejected",
                rejection: "StaleSandboxPolicyInputs",
              },
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        const view = url.split("/views/")[1] ?? "unknown-view";
        const request =
          typeof init?.body === "string"
            ? (JSON.parse(init.body) as Record<string, unknown>)
            : {};
        const handler =
          view === "workspace-detail"
            ? () => {
                detailReads += 1;
                return {
                  dto: detailWithSandboxCandidates(
                    afterStale ? "f".repeat(64) : "c".repeat(64),
                  ),
                };
              }
            : (defaultHandlers[view] ?? (() => ({ dto: null })));
        const outcome = handler(request);
        return new Response(
          "problem" in outcome
            ? problemBody(outcome.problem)
            : okBody(outcome.dto),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }),
    );
    renderWorkspace();
    const osChoice = await screen.findByRole("radio", {
      name: /工作区写入隔离.*linux-bwrap/u,
    });
    fireEvent.click(osChoice);
    fireEvent.change(
      screen.getByLabelText("策略过期时间（ISO 8601，需包含时区）"),
      { target: { value: "2099-10-12T08:30:00Z" } },
    );
    fireEvent.change(
      screen.getByLabelText("Restricted 网络目的地（每行一个 HTTPS origin）"),
      { target: { value: "https://a.example" } },
    );
    fireEvent.click(screen.getByRole("button", { name: "明确提交此策略" }));
    await waitFor(() => expect(commands).toBe(1));
    await waitFor(() => expect(detailReads).toBeGreaterThanOrEqual(2));
    await waitFor(() =>
      expect(
        (
          screen.getByRole("radio", {
            name: /工作区写入隔离.*linux-bwrap/u,
          }) as HTMLInputElement
        ).checked,
      ).toBe(false),
    );
    expect(commands).toBe(1);
    expect(screen.getByRole("status").textContent).toContain("策略输入已变化");
    expect(screen.queryByText("c".repeat(64))).toBeNull();
    expect(screen.queryByText("f".repeat(64))).toBeNull();
  });

  it("头部：workspaceId（Mono）/ purpose / status 徽章 / attention 计数 / boundary 简述", async () => {
    installViews();
    renderWorkspace();
    await waitFor(() =>
      expect(
        screen.getByText(detailTypical.responsibility.purpose),
      ).toBeTruthy(),
    );
    expect(screen.getByText("ws_1")).toBeTruthy();
    expect(screen.getAllByText("Open").length).toBeGreaterThan(0);
    expect(screen.getByText("attention 2")).toBeTruthy();
    expect(screen.getByText("actionRequired 1")).toBeTruthy();
    expect(screen.getByText(/FileTree \/srv\/arbor\/web/)).toBeTruthy();
  });

  it("六 tab 导航：点击各 tab → location.pathname 变化；默认路由无 tab → 概要", async () => {
    installViews();
    renderWorkspace();
    await waitFor(() =>
      expect(screen.getByText("交付 P13-004 视图渲染层")).toBeTruthy(),
    );
    expect(
      screen.getByRole("tab", { name: "概要" }).getAttribute("aria-selected"),
    ).toBe("true");
    const expectations: ReadonlyArray<[string, string]> = [
      ["概要", "/p/prj_1/workspace/ws_1"],
      ["依赖", "/p/prj_1/workspace/ws_1/dependencies"],
      ["验证", "/p/prj_1/workspace/ws_1/verification"],
      ["运行记录", "/p/prj_1/workspace/ws_1/transcript"],
      ["收件箱", "/p/prj_1/workspace/ws_1/inbox"],
      ["对话", "/p/prj_1/workspace/ws_1/conversation"],
    ];
    for (const [label, path] of expectations) {
      fireEvent.click(screen.getByRole("tab", { name: label }));
      expect(window.location.pathname).toBe(path);
    }
  });

  it("概要：currentWork objective 呈现；pendingWorks 行点击 → work 路由", async () => {
    installViews();
    renderWorkspace();
    await waitFor(() =>
      expect(screen.getByText("交付 P13-004 视图渲染层")).toBeTruthy(),
    );
    expect(screen.getByText("命令面板接线")).toBeTruthy();
    const row = screen.getByText("传输层连接管理").closest("button");
    expect(row).not.toBeNull();
    fireEvent.click(row as HTMLButtonElement);
    expect(window.location.pathname).toBe(
      "/p/prj_1/workspace/ws_1/work/wrk_018f6a2e-0000-7000-8000-0000000000a3",
    );
  });

  it("概要：currentWork null → 空态且无任何“选择”类按钮", async () => {
    installViews({
      ...defaultHandlers,
      "workspace-detail": () => ({ dto: detailNoCurrentWork }),
      "current-work": () => ({ dto: currentWorkNull }),
    });
    renderWorkspace();
    await waitFor(() =>
      expect(screen.getAllByText("无当前工作").length).toBeGreaterThan(0),
    );
    expect(screen.queryByRole("button", { name: /选择/ })).toBeNull();
  });

  it("运行记录：无输入框；加载更多触发带 cursor 的第二次 fetch", async () => {
    const calls = installViews();
    const { container } = renderWorkspace("transcript");
    await waitFor(() =>
      expect(screen.getByText("turn#12 请求评审")).toBeTruthy(),
    );
    expect(container.querySelectorAll("textarea")).toHaveLength(0);
    expect(container.querySelectorAll("input")).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: "加载更多记录" }));
    await waitFor(() =>
      expect(screen.getByText("turn#9 早期记录")).toBeTruthy(),
    );
    const transcriptCalls = calls.filter((call) => call.view === "transcript");
    expect(transcriptCalls.length).toBe(2);
    expect(transcriptCalls[1]?.request.cursor).toBe("cursor-018f6a2e-older");
  });

  it("收件箱：unconsumed 行呈现（只读）", async () => {
    installViews();
    renderWorkspace("inbox");
    await waitFor(() =>
      expect(screen.getByText("来自守护进程的阻塞通知")).toBeTruthy(),
    );
    expect(screen.getByText("治理决议待确认")).toBeTruthy();
  });

  it("上下文治理动作：纠偏/紧急停止存在（W-08 真实接线），未点击无 /commands fetch", async () => {
    const calls = installViews();
    renderWorkspace();
    await waitFor(() => expect(screen.getByText("上下文治理")).toBeTruthy());
    expect(screen.getByRole("button", { name: "纠偏" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "紧急停止" })).toBeTruthy();
    // view names only — the harness intercepts /views/*; any /commands
    // call would surface as "unknown-view"
    expect(calls.some((call) => call.view === "unknown-view")).toBe(false);
  });

  it("纠偏表单使用 workspace-detail 提供的 exact current-work revision", async () => {
    const revisionedDetail = {
      ...detailTypical,
      currentWork: { ...detailTypical.currentWork, revision: 9 as never },
    };
    installViews({
      ...defaultHandlers,
      "workspace-detail": () => ({ dto: revisionedDetail }),
    });
    renderWorkspace();
    await waitFor(() =>
      expect(
        screen.getByText(revisionedDetail.responsibility.purpose),
      ).toBeTruthy(),
    );
    fireEvent.click(screen.getByRole("button", { name: "纠偏" }));
    expect(screen.getByText("rev 9")).toBeTruthy();
  });

  it("查询 problem → 就地 ProblemCard", async () => {
    installViews({
      ...defaultHandlers,
      transcript: () => ({ problem: unavailableProblem }),
    });
    renderWorkspace("transcript");
    await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());
    expect(screen.getByText("服务不可用")).toBeTruthy();
    expect(screen.getByText(/view\/transcript-unavailable/)).toBeTruthy();
  });
});
