/**
 * W-04 page tests — Responsibility Tree 页跑在真实 view-query 栈上（每个用例
 * 独立 QueryClient；global fetch 在传输边界打桩）。冻结 §2.3 只读导航合同：
 * 节点卡渲染（空位不补零、未知枚举原样）、点击→工作区导航、depth 变更→
 * 新 query（body 带 depth）、选中→mini-detail + “打开工作区”、Problem 就地。
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TreePage } from "../src/pages/tree/TreePage.js";
import { SessionContext } from "../src/session/SessionContext.js";
import {
  treeExplicitNulls,
  treeTypical,
  treeUnknownEnum,
} from "../src/views/fixtures.js";

type Thunk = () => unknown | Promise<unknown>;

const okBody =
  (value: unknown): Thunk =>
  () => ({
    ok: true,
    body: { value, watermark: 1 },
  });

const pending = (): Thunk => () => new Promise(() => undefined);

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

const renderTree = (): void => {
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
        <TreePage route={{ name: "tree", projectId: "prj_1" }} />
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

describe("W-04 TreePage (read-only navigation)", () => {
  it("renders node cards: name, status badge, attention counts, usage (cost unknown ≠ 0)", async () => {
    vi.stubGlobal("fetch", makeFetch([okBody(treeTypical)]).fn);
    renderTree();
    expect(await screen.findByText("平台根工作区")).toBeTruthy();
    expect(screen.getByText("前端渲染")).toBeTruthy();
    expect(screen.getByText("守护进程")).toBeTruthy();
    expect(screen.getByText("executing")).toBeTruthy();
    expect(screen.getByText("idle")).toBeTruthy();
    expect(screen.getByText("waiting-blocked")).toBeTruthy();
    expect(screen.getByText("attention 2")).toBeTruthy();
    expect(screen.getByText("actionRequired 1")).toBeTruthy();
    expect(screen.getByText("维护 P13 视图渲染合同")).toBeTruthy();
    expect(
      screen.getByText("tokens 1200 · cost 0.42 USD · turns 7"),
    ).toBeTruthy();
    expect(
      screen.getByText("tokens 300 · cost unknown · turns 2"),
    ).toBeTruthy();
  });

  it("unknown status enum renders verbatim with the muted badge", async () => {
    vi.stubGlobal("fetch", makeFetch([okBody(treeUnknownEnum)]).fn);
    renderTree();
    const badge = await screen.findByText("weird-state");
    expect(badge.className).toContain("arbor-badge-muted");
  });

  it("explicit null optionals leave blank slots and do not crash", async () => {
    vi.stubGlobal("fetch", makeFetch([okBody(treeExplicitNulls)]).fn);
    renderTree();
    expect(await screen.findByText("显式空值节点")).toBeTruthy();
    expect(screen.queryByText(/tokens \d+/)).toBeNull();
    expect(screen.queryByText(/^attention \d+$/)).toBeNull();
    expect(screen.queryByText(/^actionRequired \d+$/)).toBeNull();
  });

  it("node card click navigates to the workspace overview route", async () => {
    vi.stubGlobal("fetch", makeFetch([okBody(treeTypical)]).fn);
    renderTree();
    fireEvent.click(await screen.findByText("平台根工作区"));
    expect(window.location.pathname).toBe(
      "/p/prj_1/workspace/ws_018f6a2e-0000-7000-8000-000000000001",
    );
    fireEvent.click(screen.getByText("守护进程"));
    expect(window.location.pathname).toBe(
      "/p/prj_1/workspace/ws_018f6a2e-0000-7000-8000-000000000003",
    );
  });

  it("depth control change triggers a second fetch whose body carries depth", async () => {
    const fetchMock = makeFetch([okBody(treeTypical), okBody(treeTypical)]);
    vi.stubGlobal("fetch", fetchMock.fn);
    renderTree();
    await screen.findByText("平台根工作区");
    expect(fetchMock.bodies).toEqual([{ projectId: "prj_1", depth: 3 }]);
    fireEvent.change(screen.getByLabelText("树深度"), {
      target: { value: "5" },
    });
    await waitFor(() => expect(fetchMock.bodies.length).toBe(2));
    expect(fetchMock.bodies[1]).toEqual({ projectId: "prj_1", depth: 5 });
  });

  it("selection shows the mini-detail KeyValue panel; 打开工作区 navigates", async () => {
    vi.stubGlobal("fetch", makeFetch([okBody(treeTypical)]).fn);
    renderTree();
    fireEvent.click(await screen.findByText("前端渲染"));
    expect(await screen.findByText("子树关注")).toBeTruthy();
    expect(screen.getByText("名称")).toBeTruthy();
    expect(screen.getByText("工作区")).toBeTruthy();
    expect(screen.getByText("状态")).toBeTruthy();
    expect(screen.getByText("当前工作")).toBeTruthy();
    expect(screen.getByText("用量")).toBeTruthy();
    expect(screen.getByText("attention 0 · actionRequired 0")).toBeTruthy();
    expect(screen.getByText("—")).toBeTruthy();
    window.history.replaceState(null, "", "/");
    fireEvent.click(screen.getByRole("button", { name: "打开工作区" }));
    expect(window.location.pathname).toBe(
      "/p/prj_1/workspace/ws_018f6a2e-0000-7000-8000-000000000002",
    );
  });

  it("server problem renders ProblemCard in place", async () => {
    vi.stubGlobal(
      "fetch",
      makeFetch([
        () => ({
          ok: false,
          problem: {
            code: "view/tree-not-found",
            category: "not-found",
            message: "tree missing",
            correlationId: null,
            retryDisposition: "none",
            safeDetails: {},
          },
        }),
      ]).fn,
    );
    renderTree();
    expect(await screen.findByText("对象不存在")).toBeTruthy();
    expect(screen.getByText("问题详情")).toBeTruthy();
  });

  it("pending query shows the 加载中 empty state", () => {
    vi.stubGlobal("fetch", makeFetch([pending()]).fn);
    renderTree();
    expect(screen.getByText("加载中")).toBeTruthy();
  });
});
