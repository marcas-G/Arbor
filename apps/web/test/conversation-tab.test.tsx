/**
 * P14-005 `04` §2/§3 — conversation tab: root-only composer, frozen
 * SubmitHumanMessage envelope (msg_ preallocation, retry reuses the same
 * messageId), Zod empty-body rejection (no /commands fetch), and the
 * no-optimistic-message invariant: the authoritative turn appears only after
 * the invalidated transcript refetch resolves. Child workspace (wsId ≠
 * tree.nodes[0]) renders the read-only transcript with NO composer (S10).
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

const id = (value: string): never => value as never;

const node = (
  workspaceId: string,
  name: string,
  status: string,
): Record<string, unknown> => ({
  workspaceId: id(workspaceId),
  name,
  status: id(status),
  subtreeAttention: { attention: 0, actionRequired: 0 },
});

const rootTree = {
  nodes: [node("ws_1", "根工作区", "idle")],
} as never;

const childTree = {
  nodes: [
    node("ws_root", "平台根工作区", "idle"),
    node("ws_1", "子工作区", "executing"),
  ],
} as never;

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
  readonly transcriptCallCount: () => number;
}

const installFetch = (config: {
  readonly tree: unknown;
  readonly transcriptResponses: ReadonlyArray<Responder>;
  readonly commandResponses?: ReadonlyArray<Responder>;
}): Harness => {
  const commandCalls: Envelope[] = [];
  let transcriptCalls = 0;
  let commandCallsMade = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: unknown, init?: { readonly body?: unknown }) => {
      const url = String(input);
      if (url === "/commands") {
        const envelope = JSON.parse(String(init?.body)) as Envelope;
        commandCalls.push(envelope);
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
        const responder =
          config.transcriptResponses[
            Math.min(transcriptCalls, config.transcriptResponses.length - 1)
          ];
        transcriptCalls += 1;
        return responder === undefined
          ? okValue(transcriptTypical)
          : responder();
      }
      return okValue(null);
    }),
  );
  return {
    commandCalls,
    transcriptCallCount: () => transcriptCalls,
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

const renderConversation = () => {
  window.history.replaceState(null, "", "/p/prj_1/workspace/ws_1/conversation");
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: Number.POSITIVE_INFINITY },
    },
  });
  return render(
    <QueryClientProvider client={client}>
      <SessionContext.Provider value={sessionValue}>
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
  it("root workspace (nodes[0].workspaceId === wsId) renders the composer", async () => {
    installFetch({
      tree: rootTree,
      transcriptResponses: [() => okValue(transcriptTypical)],
    });
    renderConversation();
    await waitFor(() => expect(screen.getByLabelText("消息")).toBeTruthy());
    expect(screen.getByRole("button", { name: "发送" })).toBeTruthy();
  });

  it("child workspace renders read-only transcript with NO composer (S10)", async () => {
    installFetch({
      tree: childTree,
      transcriptResponses: [() => okValue(transcriptTypical)],
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

  it("Zod rejects an empty body without any /commands fetch", async () => {
    const harness = installFetch({
      tree: rootTree,
      transcriptResponses: [() => okValue(transcriptTypical)],
    });
    renderConversation();
    await waitFor(() => expect(screen.getByLabelText("消息")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "发送" })).toBeTruthy(),
    );
    expect(harness.commandCalls.length).toBe(0);
  });

  it("submits the frozen envelope shape to /commands", async () => {
    const harness = installFetch({
      tree: rootTree,
      transcriptResponses: [() => okValue(transcriptTypical)],
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

  it("reuses the same messageId across transport-failure retries", async () => {
    const harness = installFetch({
      tree: rootTree,
      transcriptResponses: [() => okValue(transcriptTypical)],
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

  it("never inserts the Human turn locally — it appears only after refetch resolves", async () => {
    let resolveSecond!: (response: Response) => void;
    const secondTranscript = new Promise<Response>((resolve) => {
      resolveSecond = resolve;
    });
    const authoritative: TranscriptRes = {
      entries: [
        {
          kind: "HumanConversationTurn",
          summaryRef: "用户：新消息内容",
          at: "2026-09-23T09:40:00.000Z",
        },
      ],
    };
    const harness = installFetch({
      tree: rootTree,
      transcriptResponses: [
        () => okValue(transcriptTypical),
        () => secondTranscript,
      ],
    });
    renderConversation();
    await waitFor(() =>
      expect(screen.getByText("turn#12 请求评审")).toBeTruthy(),
    );
    typeAndSend("新消息内容");
    await waitFor(() => expect(harness.commandCalls.length).toBe(1));
    await waitFor(() => expect(screen.getByLabelText("消息")).toBeTruthy());
    expect((screen.getByLabelText("消息") as HTMLTextAreaElement).value).toBe(
      "",
    );
    await waitFor(() =>
      expect(harness.transcriptCallCount()).toBeGreaterThan(1),
    );
    expect(screen.queryByText(/新消息内容/)).toBeNull();
    resolveSecond(okValue(authoritative));
    await waitFor(() =>
      expect(screen.getByText("用户：新消息内容")).toBeTruthy(),
    );
  });
});
