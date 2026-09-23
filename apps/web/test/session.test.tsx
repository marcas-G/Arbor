/**
 * P13-007 session wiring: LoginCard validation + memory-only session state,
 * the mechanical no-web-storage scan (frozen contract `01` §4), the global
 * unauthenticated gate on 401 view problems (EC-4), and the App integration
 * smoke (login → tree view via mocked transport → command panel wiring →
 * disconnect).
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/App.js";
import { LoginCard } from "../src/session/LoginCard.js";
import { SessionProvider, useSession } from "../src/session/SessionContext.js";
import { treeTypical } from "../src/views/fixtures.js";

type FetchImpl = (url: string, init: RequestInit) => Promise<Response>;

interface FetchMock {
  readonly mock: {
    readonly calls: ReadonlyArray<readonly [string, RequestInit]>;
  };
}

type FetchFn = ReturnType<typeof vi.fn<FetchImpl>> & FetchMock;

const jsonResponse = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

const unauthenticatedProblem = {
  code: "auth/unauthenticated",
  category: "unauthenticated",
  message: "令牌无效或已过期",
  correlationId: null,
  retryDisposition: "non-retryable",
  safeDetails: {},
};

function stubFetch(impl: FetchImpl): FetchFn {
  const fetchMock = vi.fn(impl);
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock as unknown as FetchFn;
}

function readCall(
  fetchMock: FetchMock,
  index = 0,
): readonly [string, RequestInit] {
  const call = fetchMock.mock.calls[index];
  if (call === undefined) {
    throw new Error(`fetch call ${index} was not made`);
  }
  return call;
}

async function login(actor = "human:root", token = "tok_1"): Promise<void> {
  fireEvent.change(screen.getByLabelText(/token/), {
    target: { value: token },
  });
  fireEvent.change(screen.getByLabelText(/actor/), {
    target: { value: actor },
  });
  fireEvent.click(screen.getByRole("button", { name: "连接" }));
  await waitFor(() => expect(screen.getByLabelText("项目 ID")).toBeTruthy());
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("P13-007 LoginCard", () => {
  function SessionProbe() {
    const session = useSession();
    return (
      <span data-testid="session-probe">
        {JSON.stringify({ token: session.token, actor: session.actor })}
      </span>
    );
  }

  it("keeps 连接 disabled on empty inputs and stores token+actor in memory on submit", () => {
    render(
      <SessionProvider>
        <LoginCard />
        <SessionProbe />
      </SessionProvider>,
    );
    const connect = screen.getByRole("button", {
      name: "连接",
    }) as HTMLButtonElement;
    expect(connect.disabled).toBe(true);
    expect(
      JSON.parse(screen.getByTestId("session-probe").textContent ?? "null"),
    ).toEqual({
      token: null,
      actor: null,
    });
    fireEvent.change(screen.getByLabelText(/token/), {
      target: { value: "tok_1" },
    });
    expect(connect.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText(/actor/), {
      target: { value: "human:root" },
    });
    expect(connect.disabled).toBe(false);
    fireEvent.click(connect);
    expect(
      JSON.parse(screen.getByTestId("session-probe").textContent ?? "null"),
    ).toEqual({
      token: "tok_1",
      actor: "human:root",
    });
  });
});

describe("P13-007 memory-only session (frozen contract 01 §4)", () => {
  it("App.tsx + session/** sources never touch web storage or cookies", () => {
    const srcRoot = join(process.cwd(), "src");
    const targets: string[] = [join(srcRoot, "App.tsx")];
    const collect = (dir: string): void => {
      for (const entry of readdirSync(dir)) {
        const path = join(dir, entry);
        if (statSync(path).isDirectory()) {
          collect(path);
        } else if (/\.(ts|tsx|css)$/.test(entry)) {
          targets.push(path);
        }
      }
    };
    collect(join(srcRoot, "session"));
    expect(targets.length).toBeGreaterThan(1);
    const violations: string[] = [];
    for (const path of targets) {
      const source = readFileSync(path, { encoding: "utf8" });
      for (const forbidden of [
        "localStorage",
        "sessionStorage",
        "document.cookie",
      ]) {
        if (source.includes(forbidden)) {
          violations.push(`${path}: ${forbidden}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });
});

describe("P13-007 unauthenticated gate (EC-4)", () => {
  it("a 401 unauthenticated view problem blocks content and offers re-login", async () => {
    const fetchMock = stubFetch(() =>
      Promise.resolve(
        jsonResponse(401, {
          ok: false,
          status: 401,
          problem: unauthenticatedProblem,
        }),
      ),
    );
    render(<App />);
    await login();
    fireEvent.change(screen.getByLabelText("项目 ID"), {
      target: { value: "prj_demo" },
    });
    await waitFor(() => expect(screen.getByText("未认证")).toBeTruthy());
    expect(screen.queryByText("责任树")).toBeNull();
    const [url, init] = readCall(fetchMock);
    expect(url).toBe("/views/responsibility-tree");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).Authorization).toBe(
      "Bearer tok_1",
    );
    fireEvent.click(screen.getByRole("button", { name: "重新登录" }));
    await waitFor(() => expect(screen.getByLabelText(/token/)).toBeTruthy());
    expect(screen.queryByText("未认证")).toBeNull();
  });
});

describe("P13-007 App integration smoke", () => {
  it("login → tree view renders → command panel wires → disconnect returns to login", async () => {
    stubFetch((input) => {
      const url = String(input);
      const body =
        url === "/views/attention"
          ? { rows: [] }
          : url === "/views/usage"
            ? { rows: [] }
            : url === "/views/workspace-detail"
              ? {
                  responsibility: {
                    purpose: "demo",
                    ownedResponsibilities: [],
                    obligations: [],
                    includes: [],
                    excludes: [],
                    interfaces: [],
                  },
                  boundary: { basisResponsibilityRevision: 0, addresses: [] },
                  pendingWorks: [],
                  dependencies: [],
                  inboxUnconsumed: [],
                  auditTimeline: [],
                }
              : treeTypical;
      return Promise.resolve(
        jsonResponse(200, {
          ok: true,
          status: 200,
          body: { value: body, watermark: 1 },
        }),
      );
    });
    render(<App />);
    expect(screen.getByText("Arbor")).toBeTruthy();
    await login();
    expect(screen.getByText("human:root")).toBeTruthy();
    expect(screen.getByRole("button", { name: "创建项目" })).toBeTruthy();
    fireEvent.change(screen.getByLabelText("项目 ID"), {
      target: { value: "prj_demo" },
    });
    await waitFor(() => expect(screen.getByText("平台根工作区")).toBeTruthy());
    expect(screen.getByText("前端渲染")).toBeTruthy();
    expect(screen.getByText("守护进程")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "创建项目" })).toBeNull();
    fireEvent.click(screen.getByText("前端渲染"));
    await waitFor(() => expect(screen.getByText(/工作区 ws_/)).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "记录决策" }));
    await waitFor(() => expect(screen.getByText("记录治理决策")).toBeTruthy());
    expect(screen.getByText("fml_demo")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "断开" }));
    await waitFor(() => expect(screen.getByLabelText(/token/)).toBeTruthy());
    expect(screen.queryByText("平台根工作区")).toBeNull();
  });
});
