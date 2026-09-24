import { readFileSync } from "node:fs";
import { join } from "node:path";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_WORKBENCH_LAYOUT,
  parseWorkbenchLayout,
  RootWorkbenchPage,
  WORKBENCH_LAYOUT_KEY,
} from "../src/pages/workbench/RootWorkbenchPage.js";
import { SessionContext } from "../src/session/SessionContext.js";
import { transcriptTypical, treeTypical } from "../src/views/fixtures.js";

const route = { name: "workbench", projectId: "prj_workbench" } as const;

const session = {
  token: "tok",
  actor: "human:test",
  projectId: route.projectId,
  unauthenticatedProblem: null,
  setSession: () => undefined,
  clearSession: () => undefined,
  setProjectId: () => undefined,
  reportUnauthenticated: () => undefined,
};

const renderWorkbench = () => {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: Number.POSITIVE_INFINITY },
    },
  });
  return render(
    <QueryClientProvider client={client}>
      <SessionContext.Provider value={session}>
        <RootWorkbenchPage route={route} />
      </SessionContext.Provider>
    </QueryClientProvider>,
  );
};

const installTree = () => {
  const commandCalls: Array<Record<string, unknown>> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: unknown, init?: { readonly body?: unknown }) => {
      const url = String(input);
      if (url === "/commands") {
        commandCalls.push(
          JSON.parse(String(init?.body)) as Record<string, unknown>,
        );
        return new Response(
          JSON.stringify({
            ok: true,
            status: 200,
            body: { commandId: "cmd_1", resolution: "Committed" },
          }),
          { status: 200 },
        );
      }
      const value = url.includes("/transcript")
        ? transcriptTypical
        : treeTypical;
      return new Response(
        JSON.stringify({
          ok: true,
          status: 200,
          body: { value, watermark: 1 },
        }),
        { status: 200 },
      );
    }),
  );
  return commandCalls;
};

afterEach(() => {
  localStorage.clear();
  vi.unstubAllGlobals();
});

describe("D3 Root Workbench shell", () => {
  it("uses the responsibility-tree view for real read-only Workbench context", async () => {
    installTree();
    renderWorkbench();
    expect(screen.getByRole("heading", { name: "工作台" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "责任树" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "对话" })).toBeTruthy();
    expect(await screen.findByText("平台根工作区")).toBeTruthy();
    fireEvent.click(screen.getByText("前端渲染"));
    expect(screen.getByText("打开工作区")).toBeTruthy();
    expect(location.pathname).toBe("/");
  });

  it("keeps the composer bound to the unique root when tree inspection changes", async () => {
    const commandCalls = installTree();
    renderWorkbench();
    await screen.findByText("turn#12 请求评审");
    fireEvent.click(screen.getByText("前端渲染"));
    fireEvent.change(screen.getByLabelText("消息"), {
      target: { value: "根工作区消息" },
    });
    fireEvent.keyDown(screen.getByLabelText("消息"), { key: "Enter" });
    await waitFor(() => expect(commandCalls).toHaveLength(1));
    const payload = commandCalls[0]?.payload as Record<string, unknown>;
    expect(payload.targetWorkspaceId).toBe(
      "ws_018f6a2e-0000-7000-8000-000000000001",
    );
  });

  it("swaps panes, drags the local divider, and resets it on double click", () => {
    installTree();
    renderWorkbench();
    const shell = screen.getByTestId("workbench-layout");
    const divider = screen.getByRole("separator", {
      name: "调整责任树与对话比例",
    });
    vi.spyOn(shell, "getBoundingClientRect").mockReturnValue({
      left: 0,
      width: 1000,
    } as DOMRect);

    expect(shell.dataset.order).toBe("tree-first");
    expect(shell.dataset.treeBasis).toBe(
      String(DEFAULT_WORKBENCH_LAYOUT.treeBasis),
    );
    fireEvent.click(screen.getByRole("button", { name: "交换树与对话位置" }));
    expect(shell.dataset.order).toBe("conversation-first");
    fireEvent.pointerDown(divider, { pointerId: 1, clientX: 600 });
    fireEvent.pointerMove(document, { pointerId: 1, clientX: 600 });
    expect(shell.dataset.treeBasis).toBe("40");
    fireEvent.pointerCancel(document, { pointerId: 1 });
    fireEvent.pointerMove(document, { pointerId: 1, clientX: 700 });
    expect(shell.dataset.treeBasis).toBe("40");
    fireEvent.doubleClick(divider);
    expect(shell.dataset.treeBasis).toBe(
      String(DEFAULT_WORKBENCH_LAYOUT.treeBasis),
    );
    fireEvent.keyDown(divider, { key: "ArrowRight" });
    expect(shell.dataset.treeBasis).toBe(
      String(DEFAULT_WORKBENCH_LAYOUT.treeBasis + 2),
    );
    fireEvent.keyDown(divider, { key: "End" });
    expect(shell.dataset.treeBasis).toBe("70");
    fireEvent.keyDown(divider, { key: "ArrowRight" });
    expect(shell.dataset.treeBasis).toBe("70");
    fireEvent.keyDown(divider, { key: "Home" });
    expect(shell.dataset.treeBasis).toBe("30");
  });

  it("keeps the preference local, exact, and rejects malformed payloads", () => {
    expect(
      parseWorkbenchLayout('{"order":"conversation-first","treeBasis":56}'),
    ).toEqual({
      order: "conversation-first",
      treeBasis: 56,
    });
    expect(
      parseWorkbenchLayout('{"order":"tree-first","treeBasis":0}'),
    ).toEqual(DEFAULT_WORKBENCH_LAYOUT);
    expect(
      parseWorkbenchLayout(
        '{"order":"tree-first","treeBasis":42,"projectId":"prj_x"}',
      ),
    ).toEqual(DEFAULT_WORKBENCH_LAYOUT);

    installTree();
    renderWorkbench();
    const saved = JSON.parse(
      localStorage.getItem(WORKBENCH_LAYOUT_KEY) ?? "null",
    ) as Record<string, unknown>;
    expect(Object.keys(saved).sort()).toEqual(["order", "treeBasis"]);
    expect(JSON.stringify(saved)).not.toContain("prj_workbench");
    expect(JSON.stringify(saved)).not.toMatch(/token|actor|workspace|command/i);
  });

  it("persists an edited local layout and restores it without project data", () => {
    installTree();
    const { unmount } = renderWorkbench();
    const shell = screen.getByTestId("workbench-layout");
    const divider = screen.getByRole("separator", {
      name: "调整责任树与对话比例",
    });
    vi.spyOn(shell, "getBoundingClientRect").mockReturnValue({
      left: 0,
      width: 1000,
    } as DOMRect);
    fireEvent.click(screen.getByRole("button", { name: "交换树与对话位置" }));
    fireEvent.pointerDown(divider, { pointerId: 1, clientX: 600 });
    fireEvent.pointerUp(document, { pointerId: 1 });
    expect(
      JSON.parse(localStorage.getItem(WORKBENCH_LAYOUT_KEY) ?? "null"),
    ).toEqual({
      order: "conversation-first",
      treeBasis: 40,
    });
    unmount();
    installTree();
    renderWorkbench();
    expect(screen.getByTestId("workbench-layout").dataset.order).toBe(
      "conversation-first",
    );
    expect(screen.getByTestId("workbench-layout").dataset.treeBasis).toBe("40");
  });

  it("uses a local mobile pane switch without changing the route", () => {
    installTree();
    renderWorkbench();
    const shell = screen.getByTestId("workbench-layout");
    const tree = screen.getByRole("button", { name: "责任树" });
    const conversation = screen.getByRole("button", { name: "对话" });
    expect(conversation.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(tree);
    expect(tree.getAttribute("aria-pressed")).toBe("true");
    expect(conversation.getAttribute("aria-pressed")).toBe("false");
    expect(shell.dataset.mobilePane).toBe("tree");
    expect(location.pathname).not.toContain("conversation");
  });

  it("declares desktop, tablet, and mobile breakpoints for the shell", () => {
    const css = readFileSync(
      join(process.cwd(), "src/pages/workbench/workbench.module.css"),
      { encoding: "utf8" },
    );
    expect(css).toMatch(
      /grid-template-columns:\s*minmax\(0, var\(--workbench-tree-basis\)\)/,
    );
    expect(css).toContain("@media (max-width: 63.99rem)");
    expect(css).toContain("grid-template-columns: 1fr");
    expect(css).toContain("@media (max-width: 47.99rem)");
    expect(css).toMatch(
      /@media \(max-width: 47\.99rem\)[\s\S]*?\.mobileTabs\s*\{\s*display: flex;/,
    );
    expect(css).toMatch(
      /@media \(max-width: 63\.99rem\)[\s\S]*?\.divider\s*\{\s*display: none;/,
    );
  });
});
