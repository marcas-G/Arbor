/**
 * W-08 — Governance Queue page tests. Frozen rules: gov: entryKey structural
 * binding decides DecisionCards; unparseable Governance entries render
 * read-only with navigation, NEVER a fake action or manual proposalId path.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { QueuePage } from "../src/pages/queue/QueuePage.js";
import { SessionContext } from "../src/session/SessionContext.js";

const okBody = (dto: unknown): string =>
  JSON.stringify({ ok: true, status: 200, body: { value: dto, watermark: 1 } });

const treeDto = {
  nodes: [
    {
      workspaceId: "ws_root",
      name: "root",
      status: "idle",
      subtreeAttention: { attention: 0, actionRequired: 0 },
    },
  ],
};

const inboxDto = (entries: ReadonlyArray<Record<string, unknown>>) => ({
  unconsumed: entries,
});

interface Recorded {
  readonly urls: string[];
  readonly bodies: unknown[];
}

const install = (
  handlers: Record<string, (request: Record<string, unknown>) => unknown>,
): Recorded => {
  const recorded: Recorded = { urls: [], bodies: [] };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: unknown, init?: { readonly body?: unknown }) => {
      const url = String(input);
      (recorded.urls as string[]).push(url);
      const body =
        typeof init?.body === "string"
          ? (JSON.parse(init.body) as Record<string, unknown>)
          : {};
      (recorded.bodies as unknown[]).push(body);
      const view = url.split("/views/")[1] ?? "";
      const dto = (handlers[view] ?? (() => null))(body);
      return new Response(okBody(dto), { status: 200 });
    }),
  );
  return recorded;
};

afterEach(() => {
  vi.unstubAllGlobals();
});

const sessionValue = {
  token: "tok_1",
  actor: "user:test",
  projectId: "prj_1",
  unauthenticatedProblem: null,
  setSession: () => undefined,
  clearSession: () => undefined,
  setProjectId: () => undefined,
  reportUnauthenticated: () => undefined,
};

const renderQueue = () => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <SessionContext.Provider value={sessionValue as never}>
        <QueuePage route={{ name: "queue", projectId: "prj_1" } as never} />
      </SessionContext.Provider>
    </QueryClientProvider>,
  );
};

describe("W-08 Governance Queue（待处理）", () => {
  it("binds DecisionCards from the gov: structured key (W-00 proof ③)", async () => {
    install({
      "responsibility-tree": () => treeDto,
      "inbox-view": () =>
        inboxDto([
          {
            entryKey: "gov:fpr_018f6a2e-0000-7000-8000-00000000000f:3",
            kind: "Governance",
            summary:
              'formation proposal "拆分" revision 3 awaiting human decision',
            watermark: 9,
          },
        ]),
    });
    renderQueue();
    await waitFor(() => expect(screen.getByText("待决策")).toBeTruthy());
    expect(
      screen.getByText("fpr_018f6a2e-0000-7000-8000-00000000000f"),
    ).toBeTruthy();
    expect(screen.getAllByText(/revision 3/).length).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: "记录决策" })).toBeTruthy();
  });

  it("unparseable Governance entries render read-only — no RecordDecision action, no manual entry", async () => {
    install({
      "responsibility-tree": () => treeDto,
      "inbox-view": () =>
        inboxDto([
          {
            entryKey: "weird-key",
            kind: "Governance",
            summary: "格式未知的治理条目",
            watermark: 4,
          },
          {
            entryKey: "msg:ses_1",
            kind: "Message",
            summary: "普通消息",
            watermark: 3,
          },
        ]),
    });
    renderQueue();
    await waitFor(() => expect(screen.getByText(/只读/)).toBeTruthy());
    expect(screen.queryByRole("button", { name: "记录决策" })).toBeNull();
    expect(screen.getByText("格式未知的治理条目")).toBeTruthy();
  });

  it("decision submit posts the frozen RecordDecision payload via /commands", async () => {
    const recorded = install({
      "responsibility-tree": () => treeDto,
      "inbox-view": () =>
        inboxDto([
          {
            entryKey: "gov:fpr_018f6a2e-0000-7000-8000-00000000000f:2",
            kind: "Governance",
            summary: "proposal",
            watermark: 9,
          },
        ]),
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: unknown, init?: { readonly body?: unknown }) => {
        const url = String(input);
        (recorded.urls as string[]).push(url);
        const body =
          typeof init?.body === "string"
            ? (JSON.parse(init.body) as Record<string, unknown>)
            : {};
        (recorded.bodies as unknown[]).push(body);
        if (url === "/commands") {
          return new Response(
            JSON.stringify({
              ok: true,
              status: 200,
              body: { commandId: "cmd_q1", resolution: "Committed" },
            }),
            { status: 200 },
          );
        }
        const view = url.split("/views/")[1] ?? "";
        const dto =
          view === "responsibility-tree"
            ? treeDto
            : view === "inbox-view"
              ? inboxDto([
                  {
                    entryKey: "gov:fpr_018f6a2e-0000-7000-8000-00000000000f:2",
                    kind: "Governance",
                    summary: "proposal",
                    watermark: 9,
                  },
                ])
              : null;
        return new Response(okBody(dto), { status: 200 });
      }),
    );
    renderQueue();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "记录决策" })).toBeTruthy(),
    );
    fireEvent.click(screen.getByRole("button", { name: "记录决策" }));
    await waitFor(() => expect(screen.getByText("记录治理决策")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "提交决策" }));
    await waitFor(() =>
      expect(recorded.urls.some((url) => url === "/commands")).toBe(true),
    );
    const commandBody = recorded.bodies[
      recorded.urls.indexOf("/commands")
    ] as Record<string, unknown>;
    expect(commandBody.commandType).toBe("RecordDecision");
    const payload = commandBody.payload as Record<string, unknown>;
    expect(payload.proposalId).toBe("fpr_018f6a2e-0000-7000-8000-00000000000f");
    expect(payload.expectedProposalRevision).toBe(2);
    expect(payload.outcome).toEqual({ _tag: "Approve" });
    expect(screen.getByText(/最近命令：已提交/)).toBeTruthy();
  });

  it("empty project → empty state, no fake cards", async () => {
    install({
      "responsibility-tree": () => ({ nodes: [] }),
      "inbox-view": () => inboxDto([]),
    });
    renderQueue();
    await waitFor(() =>
      expect(screen.getByText("没有等你处理的事项")).toBeTruthy(),
    );
    expect(screen.queryByRole("button", { name: "记录决策" })).toBeNull();
  });
});
