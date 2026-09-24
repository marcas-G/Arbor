/**
 * W-08 — Governance Queue page tests. Frozen rules: gov: entryKey structural
 * binding decides DecisionCards; unparseable Governance entries render
 * read-only with navigation, NEVER a fake action or manual proposalId path.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
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
      parentWorkspaceId: null,
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

const installProjectQueue = (
  nodes: ReadonlyArray<Record<string, unknown>>,
  inboxFor: (
    workspaceId: string,
  ) => ReadonlyArray<Record<string, unknown>> | { readonly problem: string },
  verificationFor: (workId: string) => unknown,
  onCommand?: (body: Record<string, unknown>) => unknown,
): Recorded => {
  const recorded: Recorded = { urls: [], bodies: [] };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: unknown, init?: { readonly body?: unknown }) => {
      const url = String(input);
      const body =
        typeof init?.body === "string"
          ? (JSON.parse(init.body) as Record<string, unknown>)
          : {};
      (recorded.urls as string[]).push(url);
      (recorded.bodies as unknown[]).push(body);
      if (url === "/commands") {
        const receipt = onCommand?.(body);
        return new Response(
          JSON.stringify({
            ok: true,
            status: 200,
            body: receipt ?? {
              commandId: "cmd_queue",
              resolution: "Committed",
            },
          }),
          { status: 200 },
        );
      }
      const view = url.split("/views/")[1] ?? "";
      if (view === "responsibility-tree") {
        return new Response(okBody({ nodes }), { status: 200 });
      }
      if (view === "inbox-view") {
        const request = body as { readonly workspaceId: string };
        const result = inboxFor(request.workspaceId);
        if (!Array.isArray(result) && "problem" in result) {
          return new Response(
            JSON.stringify({
              ok: false,
              status: 200,
              problem: {
                code: "view/inbox-unavailable",
                category: "unavailable",
                message: result.problem,
                correlationId: null,
                retryDisposition: "retryable",
                safeDetails: {},
              },
            }),
            { status: 200 },
          );
        }
        return new Response(okBody(inboxDto(result)), { status: 200 });
      }
      if (view === "verification") {
        const request = body as { readonly workId: string };
        return new Response(okBody(verificationFor(request.workId)), {
          status: 200,
        });
      }
      throw new Error(`unexpected request: ${url}`);
    }),
  );
  return recorded;
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
      screen.getAllByText("fpr_018f6a2e-0000-7000-8000-00000000000f").length,
    ).toBeGreaterThan(0);
    expect(screen.getAllByText(/revision 3/).length).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: "提交决策" })).toBeTruthy();
  });

  it("omits inbox entries without an exact structured action target", async () => {
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
    await waitFor(() =>
      expect(screen.getByText("没有等你处理的事项")).toBeTruthy(),
    );
    expect(screen.queryByText("格式未知的治理条目")).toBeNull();
    expect(screen.queryByText("普通消息")).toBeNull();
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
      expect(screen.getByRole("button", { name: "提交决策" })).toBeTruthy(),
    );
    expect(screen.getByText("记录治理决策")).toBeTruthy();
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
    expect(screen.queryByRole("button", { name: "提交决策" })).toBeNull();
  });

  it("keeps successful actionable inbox items when another workspace inbox fails, and does not truncate the tree", async () => {
    const nodes = Array.from({ length: 12 }, (_, index) => ({
      workspaceId: `ws_${index + 1}`,
      parentWorkspaceId: index === 0 ? null : "ws_1",
      name: `workspace ${index + 1}`,
      status: "idle",
      subtreeAttention: { attention: 0, actionRequired: 0 },
    }));
    installProjectQueue(
      nodes,
      (workspaceId) =>
        workspaceId === "ws_2"
          ? { problem: "workspace 2 inbox unavailable" }
          : [
              {
                entryKey: `gov:fpr_${workspaceId}:1`,
                kind: "Governance",
                summary: `proposal ${workspaceId}`,
                watermark: 1,
              },
              {
                entryKey: `unknown:${workspaceId}`,
                kind: "Message",
                summary: `read only ${workspaceId}`,
                watermark: 2,
              },
            ],
      () => ({
        criteriaResults: [],
        evidenceRefs: [],
      }),
    );
    renderQueue();

    expect(await screen.findByText("proposal ws_12")).toBeTruthy();
    expect(
      within(screen.getByLabelText("可处理事项列表")).getByText(
        "proposal ws_1",
      ),
    ).toBeTruthy();
    expect(screen.getByLabelText("工作区 ws_2 收件箱问题")).toBeTruthy();
    expect(screen.queryByText("proposal ws_2")).toBeNull();
    expect(screen.queryByText("read only ws_1")).toBeNull();
  });

  it("adds AcceptWorkOutcome only from a passing exact current-work verification binding", async () => {
    const nodes = [
      {
        workspaceId: "ws_valid",
        parentWorkspaceId: null,
        name: "valid workspace",
        status: "idle",
        currentWork: {
          workId: "wrk_valid",
          objective: "eligible work",
          status: "Open",
          revision: 4,
        },
        subtreeAttention: { attention: 0, actionRequired: 0 },
      },
      {
        workspaceId: "ws_mismatch",
        parentWorkspaceId: "ws_valid",
        name: "revision mismatch",
        status: "idle",
        currentWork: {
          workId: "wrk_mismatch",
          objective: "mismatched work",
          status: "Open",
          revision: 4,
        },
        subtreeAttention: { attention: 0, actionRequired: 0 },
      },
      {
        workspaceId: "ws_accepted",
        parentWorkspaceId: "ws_valid",
        name: "already accepted",
        status: "idle",
        currentWork: {
          workId: "wrk_accepted",
          objective: "accepted work",
          status: "Open",
          revision: 4,
        },
        subtreeAttention: { attention: 0, actionRequired: 0 },
      },
    ];
    const recorded = installProjectQueue(
      nodes,
      () => [],
      (workId) =>
        workId === "wrk_valid"
          ? {
              verificationId: "ver_valid",
              targetWorkRevision: 4,
              verdict: "Pass",
              criteriaResults: [],
              evidenceRefs: [],
            }
          : workId === "wrk_mismatch"
            ? {
                verificationId: "ver_mismatch",
                targetWorkRevision: 3,
                verdict: "Pass",
                criteriaResults: [],
                evidenceRefs: [],
              }
            : {
                verificationId: "ver_accepted",
                targetWorkRevision: 4,
                verdict: "Pass",
                criteriaResults: [],
                evidenceRefs: [],
                acceptance: {
                  acceptanceId: "acp_existing",
                  actor: "user:test",
                  acceptedAt: "2026-09-23T00:00:00.000Z",
                },
              },
      (body) => {
        expect(body.commandType).toBe("AcceptWorkOutcome");
        expect(body.payload).toMatchObject({
          workId: "wrk_valid",
          targetWorkRevision: 4,
          verificationId: "ver_valid",
        });
      },
    );
    renderQueue();

    expect(
      await screen.findByRole("button", { name: /eligible work/ }),
    ).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: /mismatched work/ }),
    ).toBeNull();
    expect(screen.queryByRole("button", { name: /accepted work/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /验收成果/ }));
    fireEvent.click(await screen.findByRole("button", { name: "记录验收" }));
    await waitFor(() =>
      expect(recorded.urls.some((url) => url === "/commands")).toBe(true),
    );
  });

  it("opens selected queue detail in a mobile dialog sheet", async () => {
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      value: 390,
    });
    installProjectQueue(
      treeDto.nodes,
      () => [
        {
          entryKey: "gov:fpr_mobile:1",
          kind: "Governance",
          summary: "mobile decision",
          watermark: 1,
        },
      ],
      () => ({ criteriaResults: [], evidenceRefs: [] }),
    );
    renderQueue();

    const item = await screen.findByRole("button", { name: /mobile decision/ });
    expect(screen.queryByRole("dialog", { name: "待处理详情" })).toBeNull();
    fireEvent.click(item);
    expect(screen.getByRole("dialog", { name: "待处理详情" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "关闭" }));
    expect(screen.queryByRole("dialog", { name: "待处理详情" })).toBeNull();
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      value: 1024,
    });
  });
});
