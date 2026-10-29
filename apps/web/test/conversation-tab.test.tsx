/**
 * P14-005 `04` §2/§3 — conversation tab: root-only composer, frozen
 * SubmitHumanMessage envelope (msg_ preallocation, retry reuses the same
 * messageId), Zod empty-body rejection (no /commands fetch), and the
 * no-optimistic-message invariant: the authoritative turn appears only after
 * the invalidated transcript refetch resolves. Child workspace (the Tree node
 * has a non-null server parent) renders read-only with NO composer (S10).
 */
import type { TranscriptRes } from "@arbor/api-contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkspacePage } from "../src/pages/workspace/WorkspacePage.js";
import {
  SessionContext,
  type SessionContextValue,
} from "../src/session/SessionContext.js";
import {
  currentWorkTypical,
  detailTypical,
  transcriptTypical,
} from "../src/views/fixtures.js";

// jsdom has no layout: Virtuoso renders zero items without measurements.
// Replace it with a flat renderer that preserves the data/key/startReached
// contract the component relies on.
vi.mock("react-virtuoso", () => ({
  Virtuoso: (props: {
    readonly data: ReadonlyArray<unknown>;
    readonly computeItemKey: (index: number, item: unknown) => string;
    readonly itemContent: (index: number, item: unknown) => React.ReactNode;
    readonly startReached?: (() => void) | undefined;
    readonly components?:
      | { readonly Header?: () => React.ReactNode }
      | undefined;
  }) => {
    const { data, computeItemKey, itemContent, components } = props;
    const Header = components?.Header;
    return (
      <div data-testid="virtuoso-flat">
        {Header ? <Header /> : null}
        {data.map((item, index) => (
          <div key={computeItemKey(index, item)}>
            {itemContent(index, item)}
          </div>
        ))}
        <button
          data-testid="virtuoso-load-older"
          onClick={() => props.startReached?.()}
          type="button"
        >
          load-older
        </button>
      </div>
    );
  },
}));

const id = (value: string): never => value as never;

const node = (
  workspaceId: string,
  parentWorkspaceId: string | null,
  name: string,
  status: string,
): Record<string, unknown> => ({
  workspaceId: id(workspaceId),
  parentWorkspaceId: parentWorkspaceId === null ? null : id(parentWorkspaceId),
  name,
  status: id(status),
  subtreeAttention: { attention: 0, actionRequired: 0 },
});

const rootTree = {
  nodes: [node("ws_1", null, "根工作区", "idle")],
} as never;

const childTree = {
  nodes: [
    node("ws_root", null, "平台根工作区", "idle"),
    node("ws_1", "ws_root", "子工作区", "executing"),
  ],
} as never;

const conversationTypical: TranscriptRes = {
  entries: [
    {
      kind: "HumanConversationTurn",
      messageId: "msg_latest_1",
      body: "turn#12 请求评审",
      occurredAt: "2026-09-23T09:20:00.000Z",
    },
    {
      kind: "AssistantConversationTurn",
      executionId: "exe_latest_1",
      body: "Arbor 已收到评审请求",
      occurredAt: "2026-09-23T09:21:00.000Z",
    },
  ],
};

type Responder = () => Response | Promise<Response>;

const okValue = (dto: unknown): Response =>
  new Response(
    JSON.stringify({
      ok: true,
      status: 200,
      body: { value: dto, watermark: 1 },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );

const committed = (): Response =>
  new Response(
    JSON.stringify({
      ok: true,
      status: 200,
      body: { commandId: "cmd_server_1", resolution: "Committed" },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );

type Envelope = Record<string, unknown>;

interface Harness {
  readonly commandCalls: ReadonlyArray<Envelope>;
  readonly commandHeaders: ReadonlyArray<Headers>;
  readonly transcriptCallCount: () => number;
  readonly transcriptRequests: ReadonlyArray<Record<string, unknown>>;
  readonly transcriptHeaders: ReadonlyArray<Headers>;
}

const installFetch = (config: {
  readonly tree: unknown;
  readonly transcriptResponses: ReadonlyArray<Responder>;
  readonly commandResponses?: ReadonlyArray<Responder>;
}): Harness => {
  const commandCalls: Envelope[] = [];
  const commandHeaders: Headers[] = [];
  const transcriptRequests: Record<string, unknown>[] = [];
  const transcriptHeaders: Headers[] = [];
  let transcriptCalls = 0;
  let commandCallsMade = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async (
        input: unknown,
        init?: {
          readonly body?: unknown;
          readonly headers?: HeadersInit;
        },
      ) => {
        const url = String(input);
        if (url === "/commands") {
          const envelope = JSON.parse(String(init?.body)) as Envelope;
          commandCalls.push(envelope);
          commandHeaders.push(new Headers(init?.headers));
          const responder =
            config.commandResponses?.[commandCallsMade] ?? committed;
          commandCallsMade += 1;
          return responder();
        }
        const view = url.split("/views/")[1] ?? "";
        if (view.startsWith("responsibility-tree")) {
          return okValue(config.tree);
        }
        if (view.startsWith("workspace-detail")) {
          return okValue(detailTypical);
        }
        if (view.startsWith("current-work")) {
          return okValue(currentWorkTypical);
        }
        if (view.startsWith("transcript")) {
          const body = JSON.parse(String(init?.body)) as Record<
            string,
            unknown
          >;
          transcriptRequests.push(body);
          transcriptHeaders.push(new Headers(init?.headers));
          const responder =
            config.transcriptResponses[
              Math.min(transcriptCalls, config.transcriptResponses.length - 1)
            ];
          transcriptCalls += 1;
          return responder === undefined
            ? okValue(
                body.conversationOnly === true
                  ? conversationTypical
                  : transcriptTypical,
              )
            : responder();
        }
        return okValue(null);
      },
    ),
  );
  return {
    commandCalls,
    commandHeaders,
    transcriptCallCount: () => transcriptCalls,
    transcriptRequests,
    transcriptHeaders,
  };
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

const renderConversation = (session = sessionValue) => {
  window.history.replaceState(null, "", "/p/prj_1/workspace/ws_1/conversation");
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: Number.POSITIVE_INFINITY },
    },
  });
  return render(
    <QueryClientProvider client={client}>
      <SessionContext.Provider value={session}>
        <WorkspacePage
          route={{
            name: "workspace",
            projectId: "prj_1",
            workspaceId: "ws_1",
            tab: "conversation",
          }}
        />
      </SessionContext.Provider>
    </QueryClientProvider>,
  );
};

const typeAndSend = (text: string): void => {
  fireEvent.change(screen.getByLabelText("消息"), { target: { value: text } });
  fireEvent.click(screen.getByRole("button", { name: "发送" }));
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("P14-005 conversation tab", () => {
  it("root workspace (parentWorkspaceId === null) renders the composer", async () => {
    installFetch({
      tree: rootTree,
      transcriptResponses: [() => okValue(conversationTypical)],
    });
    renderConversation();
    await waitFor(() => expect(screen.getByLabelText("消息")).toBeTruthy());
    expect(screen.getByRole("button", { name: "发送" })).toBeTruthy();
  });

  it("uses the active non-local session for transcript and command requests", async () => {
    const harness = installFetch({
      tree: rootTree,
      transcriptResponses: [() => okValue(conversationTypical)],
    });
    renderConversation({
      ...sessionValue,
      token: "tok_remote_user",
      actor: "user:remote",
    });
    await waitFor(() => expect(screen.getByLabelText("消息")).toBeTruthy());
    expect(harness.transcriptHeaders[0]?.get("authorization")).toBe(
      "Bearer tok_remote_user",
    );
    typeAndSend("远程用户消息");
    await waitFor(() => expect(harness.commandCalls).toHaveLength(1));
    expect(harness.commandHeaders[0]?.get("authorization")).toBe(
      "Bearer tok_remote_user",
    );
    expect(harness.commandCalls[0]?.actor).toBe("user:remote");
  });

  it("child workspace renders read-only transcript with NO composer (S10)", async () => {
    installFetch({
      tree: childTree,
      transcriptResponses: [() => okValue(conversationTypical)],
    });
    const rendered = renderConversation();
    await waitFor(() =>
      expect(screen.getByText("turn#12 请求评审")).toBeTruthy(),
    );
    expect(screen.queryByLabelText("消息")).toBeNull();
    expect(screen.queryByRole("button", { name: "发送" })).toBeNull();
    expect(rendered.container.querySelectorAll("textarea")).toHaveLength(0);
    expect(rendered.container.querySelectorAll("input")).toHaveLength(0);
  });

  it("follows a three-page cursor chain without requesting the second page twice", async () => {
    const secondPage: TranscriptRes = {
      entries: [
        {
          kind: "HumanConversationTurn",
          messageId: "msg_older_1",
          body: "较早的用户消息",
          occurredAt: "2026-09-23T09:00:00.000Z",
        },
      ],
      nextCursor: "conversation-cursor-oldest",
    };
    const thirdPage: TranscriptRes = {
      entries: [
        {
          kind: "HumanConversationTurn",
          messageId: "msg_oldest_1",
          body: "最早的用户消息",
          occurredAt: "2026-09-23T08:00:00.000Z",
        },
      ],
    };
    const harness = installFetch({
      tree: childTree,
      transcriptResponses: [
        () =>
          okValue({
            ...conversationTypical,
            nextCursor: "conversation-cursor-older",
          }),
        () => okValue(secondPage),
        () => okValue(thirdPage),
      ],
    });
    renderConversation();
    await waitFor(() =>
      expect(screen.getByText("turn#12 请求评审")).toBeTruthy(),
    );
    // The flat Virtuoso mock triggers startReached on demand.
    const olderButton = screen.getByTestId("virtuoso-load-older");
    fireEvent.click(olderButton);
    await waitFor(() =>
      expect(screen.getByText("较早的用户消息")).toBeTruthy(),
    );
    fireEvent.click(olderButton);
    await waitFor(() =>
      expect(screen.getByText("最早的用户消息")).toBeTruthy(),
    );
    expect(screen.getByText("turn#12 请求评审")).toBeTruthy();
    expect(harness.transcriptRequests.map((request) => request.cursor)).toEqual(
      [undefined, "conversation-cursor-older", "conversation-cursor-oldest"],
    );
  });

  it("Zod rejects an empty body without any /commands fetch", async () => {
    const harness = installFetch({
      tree: rootTree,
      transcriptResponses: [() => okValue(conversationTypical)],
    });
    renderConversation();
    await waitFor(() => expect(screen.getByLabelText("消息")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "发送" })).toBeTruthy(),
    );
    expect(harness.commandCalls.length).toBe(0);
  });

  it("Enter submits while Shift+Enter remains a text-only newline gesture", async () => {
    const harness = installFetch({
      tree: rootTree,
      transcriptResponses: [() => okValue(conversationTypical)],
    });
    renderConversation();
    const composer = (await screen.findByLabelText(
      "消息",
    )) as HTMLTextAreaElement;
    fireEvent.change(composer, { target: { value: "第一行" } });
    fireEvent.keyDown(composer, { key: "Enter", shiftKey: true });
    expect(harness.commandCalls).toHaveLength(0);
    fireEvent.keyDown(composer, { key: "Enter" });
    await waitFor(() => expect(harness.commandCalls).toHaveLength(1));
  });

  it("submits the frozen envelope shape to /commands", async () => {
    const harness = installFetch({
      tree: rootTree,
      transcriptResponses: [() => okValue(conversationTypical)],
    });
    renderConversation();
    await waitFor(() => expect(screen.getByLabelText("消息")).toBeTruthy());
    typeAndSend("请总结当前进展");
    await waitFor(() => expect(harness.commandCalls.length).toBe(1));
    const envelope = harness.commandCalls[0];
    if (envelope === undefined) {
      throw new Error("expected a /commands envelope");
    }
    expect(envelope.commandType).toBe("SubmitHumanMessage");
    const payload = envelope.payload as Record<string, unknown>;
    expect(String(payload.messageId)).toMatch(/^msg_/);
    expect(payload.targetWorkspaceId).toBe("ws_1");
    expect(payload.bodyRef).toBe("请总结当前进展");
    const commandFetch = (
      globalThis.fetch as unknown as {
        mock: { calls: ReadonlyArray<readonly [unknown, unknown]> };
      }
    ).mock.calls.filter((call) => String(call[0]) === "/commands");
    expect(commandFetch.length).toBe(1);
  });

  it("renders a failed transcript envelope as a retryable problem, not empty history", async () => {
    installFetch({
      tree: rootTree,
      transcriptResponses: [
        () =>
          new Response(
            JSON.stringify({
              ok: false,
              status: 503,
              problem: {
                code: "view/transcript-unavailable",
                category: "unavailable",
                message: "transcript unavailable",
                correlationId: null,
                retryDisposition: "retryable",
                safeDetails: {},
              },
            }),
            { status: 503, headers: { "content-type": "application/json" } },
          ),
      ],
    });
    renderConversation();
    await waitFor(() => expect(screen.getByText("服务不可用")).toBeTruthy());
    expect(screen.getByRole("button", { name: "重试" })).toBeTruthy();
    expect(screen.queryByText("无会话记录")).toBeNull();
  });

  it("reuses the same messageId across transport-failure retries", async () => {
    const harness = installFetch({
      tree: rootTree,
      transcriptResponses: [() => okValue(conversationTypical)],
      commandResponses: [
        () => Promise.reject(new Error("network down")),
        () => Promise.resolve(committed()),
      ],
    });
    renderConversation();
    await waitFor(() => expect(screen.getByLabelText("消息")).toBeTruthy());
    typeAndSend("重试内容");
    await waitFor(() => expect(screen.getByText("服务不可用")).toBeTruthy());
    expect(harness.commandCalls.length).toBe(1);
    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    await waitFor(() => expect(harness.commandCalls.length).toBe(2));
    const first = harness.commandCalls[0]?.payload as Record<string, unknown>;
    const second = harness.commandCalls[1]?.payload as Record<string, unknown>;
    expect(second.messageId).toBe(first.messageId);
  });

  it("shows no optimistic turn, then renders the authoritative correlated pair after refetch", async () => {
    let resolveRefetch: ((response: Response) => void) | undefined;
    const refetch = new Promise<Response>((resolve) => {
      resolveRefetch = resolve;
    });
    const settled: TranscriptRes = {
      entries: [
        ...conversationTypical.entries,
        {
          kind: "HumanConversationTurn",
          messageId: "msg_server_new",
          body: "最新的权威消息",
          occurredAt: "2026-09-23T09:30:00.000Z",
        },
        {
          kind: "AssistantConversationTurn",
          executionId: "exe_server_new",
          messageId: "msg_server_new",
          body: "权威回复",
          occurredAt: "2026-09-23T09:31:00.000Z",
        },
      ],
    };
    const harness = installFetch({
      tree: rootTree,
      transcriptResponses: [() => okValue(conversationTypical), () => refetch],
    });
    const commandCalls = harness.commandCalls;
    renderConversation();
    await waitFor(() =>
      expect(screen.getByText("turn#12 请求评审")).toBeTruthy(),
    );
    const input = screen.getByLabelText(/消息/);
    fireEvent.change(input, { target: { value: "最新的权威消息" } });
    fireEvent.submit(input.closest("form") as HTMLElement);
    await waitFor(() => expect(commandCalls.length).toBe(1));
    expect(screen.queryByText("最新的权威消息")).toBeNull();
    resolveRefetch?.(okValue(settled));
    await waitFor(() => {
      expect(screen.getAllByText("最新的权威消息")).toHaveLength(1);
      expect(screen.getAllByText("权威回复")).toHaveLength(1);
    });
  });

  it("renders the authoritative response status instead of inferring from a missing answer", async () => {
    installFetch({
      tree: rootTree,
      transcriptResponses: [
        () =>
          okValue({
            entries: [
              {
                kind: "HumanConversationTurn",
                messageId: "msg_pending_1",
                body: "请执行长任务",
                occurredAt: "2026-09-23T10:00:00.000Z",
                responseStatus: {
                  state: "Running",
                  revision: 1,
                  executionId: "exe_running_1",
                  attemptNo: 0,
                },
              },
            ],
          } satisfies TranscriptRes),
      ],
    });
    renderConversation();
    await waitFor(() => expect(screen.getByText("请执行长任务")).toBeTruthy());
    expect(screen.getByText("正在处理（第 1 次执行）")).toBeTruthy();
    expect(screen.getByText("紧急停止执行")).toBeTruthy();
  });

  it("submits an explicit resume command for NeedsAttention", async () => {
    const harness = installFetch({
      tree: rootTree,
      transcriptResponses: [
        () =>
          okValue({
            entries: [
              {
                kind: "HumanConversationTurn",
                messageId: "msg_attention_1",
                body: "请继续",
                occurredAt: "2026-09-23T10:00:00.000Z",
                responseStatus: {
                  state: "NeedsAttention",
                  revision: 4,
                  reason: "DeterministicModelFailure",
                  canResume: true,
                },
              },
            ],
          } satisfies TranscriptRes),
      ],
    });
    renderConversation();
    await waitFor(() =>
      expect(screen.getByText("模型没有返回可用回复")).toBeTruthy(),
    );
    fireEvent.click(screen.getByText("再次尝试"));
    await waitFor(() => expect(harness.commandCalls).toHaveLength(1));
    const envelope = harness.commandCalls[0] as {
      commandType?: string;
      payload?: { messageId?: string; expectedJobRevision?: number };
    };
    expect(envelope).toMatchObject({
      commandType: "ResumeConversationResponse",
      payload: {
        messageId: "msg_attention_1",
        expectedJobRevision: 4,
      },
    });
  });
});
