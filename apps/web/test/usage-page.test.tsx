/**
 * W-07 page tests — Usage 页（frozen §2.9）跑在真实 view-query 栈上
 * （每用例独立 QueryClient；fetch 在传输边界打桩且只放行 /views/）。
 * 合同：groupBy 三态本地切换进 query body（URL 不携带）；rows 逐行呈现、
 * 无浏览器端合计行（`03` §2 I2）；cost Unknown 原样 "unknown"（≠0，
 * P12 `04` TR-5）；空态与查询失败 Problem 就地；DTO 无 ceilings 字段 →
 * 不渲染对照条（不发明）。
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { UsagePage } from "../src/pages/usage/UsagePage.js";
import { SessionContext } from "../src/session/SessionContext.js";
import { usageMinimal, usageTypical } from "../src/views/fixtures.js";

type Thunk = () => unknown | Promise<unknown>;

const okBody =
  (value: unknown): Thunk =>
  () => ({
    ok: true,
    body: { value, watermark: 1 },
  });

/** Every URL the stub sees is recorded; afterEach enforces /views/-only. */
const seenUrls: string[] = [];

const makeFetch = (responses: ReadonlyArray<Thunk>) => {
  const bodies: Array<Record<string, unknown>> = [];
  let calls = 0;
  const fn = vi.fn(
    async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = typeof input === "string" ? input : input.toString();
      seenUrls.push(url);
      if (!url.startsWith("/views/")) {
        throw new Error(`non-view fetch blocked: ${url}`);
      }
      const thunk = responses[Math.min(calls, responses.length - 1)];
      calls += 1;
      const payload = thunk === undefined ? null : await thunk();
      bodies.push(
        init?.body === undefined
          ? {}
          : (JSON.parse(String(init.body)) as Record<string, unknown>),
      );
      return new Response(JSON.stringify(payload), { status: 200 });
    },
  );
  return { bodies, fn };
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

const renderUsage = (): ReturnType<typeof render> => {
  const client = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
        staleTime: Number.POSITIVE_INFINITY,
        refetchOnWindowFocus: false,
      },
    },
  });
  return render(
    <QueryClientProvider client={client}>
      <SessionContext.Provider value={sessionValue as never}>
        <UsagePage route={{ name: "usage", projectId: "prj_1" }} />
      </SessionContext.Provider>
    </QueryClientProvider>,
  );
};

beforeEach(() => {
  window.history.replaceState(null, "", "/");
  seenUrls.length = 0;
});

afterEach(() => {
  vi.unstubAllGlobals();
  expect(seenUrls.every((url) => url.startsWith("/views/"))).toBe(true);
});

describe("W-07 UsagePage (frozen §2.9)", () => {
  it("groupBy 三态切换各自触发新 fetch，body.groupBy 跟随变化（URL 不携带）", async () => {
    const fetchMock = makeFetch([
      okBody(usageTypical),
      okBody(usageTypical),
      okBody(usageTypical),
    ]);
    vi.stubGlobal("fetch", fetchMock.fn);
    renderUsage();
    expect(await screen.findByText("0.42 USD")).toBeTruthy();
    expect(fetchMock.bodies).toEqual([
      { projectId: "prj_1", groupBy: "workspace" },
    ]);
    fireEvent.click(screen.getByRole("button", { name: "subtree" }));
    await waitFor(() => expect(fetchMock.bodies.length).toBe(2));
    expect(fetchMock.bodies[1]).toEqual({
      projectId: "prj_1",
      groupBy: "subtree",
    });
    fireEvent.click(screen.getByRole("button", { name: "project" }));
    await waitFor(() => expect(fetchMock.bodies.length).toBe(3));
    expect(fetchMock.bodies[2]).toEqual({
      projectId: "prj_1",
      groupBy: "project",
    });
    expect(window.location.pathname).toBe("/");
  });

  it("rows 逐行呈现（workspaceId/tokens/cost/turns），无浏览器端合计行", async () => {
    vi.stubGlobal("fetch", makeFetch([okBody(usageTypical)]).fn);
    const { container } = renderUsage();
    expect(await screen.findByText("0.42 USD")).toBeTruthy();
    expect(
      Array.from(
        container.querySelectorAll("tbody td"),
        (cell) => cell.textContent,
      ),
    ).toEqual([
      "ws_018f6a2e-0000-7000-8000-000000000001",
      "1200",
      "0.42 USD",
      "7",
      "ws_018f6a2e-0000-7000-8000-000000000002",
      "300",
      "unknown",
      "2",
    ]);
    expect(container.querySelectorAll("tbody tr").length).toBe(2);
    expect(container.querySelector("tfoot")).toBeNull();
    expect(screen.queryByText(/合计/)).toBeNull();
    expect(screen.queryByText(/total/i)).toBeNull();
  });

  it("cost Unknown 原样渲染 unknown，绝不为 0", async () => {
    vi.stubGlobal("fetch", makeFetch([okBody(usageTypical)]).fn);
    renderUsage();
    expect((await screen.findAllByText("unknown")).length).toBeGreaterThan(0);
    expect(screen.queryByText(/^0(\.0+)?\sUSD$/)).toBeNull();
  });

  it("空 rows 呈现空态，无表格无合计", async () => {
    vi.stubGlobal("fetch", makeFetch([okBody(usageMinimal)]).fn);
    renderUsage();
    expect(await screen.findByText("无用量数据")).toBeTruthy();
    expect(screen.queryByRole("table")).toBeNull();
  });

  it("server problem renders ProblemCard in place", async () => {
    vi.stubGlobal(
      "fetch",
      makeFetch([
        () => ({
          ok: false,
          problem: {
            code: "view/usage-unavailable",
            category: "unavailable",
            message: "usage projection unavailable",
            correlationId: null,
            retryDisposition: "retryable",
            safeDetails: {},
          },
        }),
      ]).fn,
    );
    renderUsage();
    expect(await screen.findByText("服务不可用")).toBeTruthy();
    expect(screen.getByText("问题详情")).toBeTruthy();
  });

  it("DTO 无 ceilings 字段 → 不渲染任何对照条（不发明）", async () => {
    vi.stubGlobal("fetch", makeFetch([okBody(usageTypical)]).fn);
    renderUsage();
    expect(await screen.findByText("0.42 USD")).toBeTruthy();
    expect(screen.queryByText(/ceiling/i)).toBeNull();
    expect(screen.queryByText(/上限/)).toBeNull();
  });
});
