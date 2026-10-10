import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { navigate } from "../src/api/router.js";
import { useViewQuery } from "../src/api/useViewQuery.js";
import { AppProviders, useFreshness } from "../src/providers/AppProviders.js";
import { useSession } from "../src/session/SessionContext.js";

type FakeSocket = {
  readonly url: string;
  readonly sentFrames: string[];
  readonly closed: boolean;
  send(data: string): void;
  close(): void;
  open(): void;
  message(data: string): void;
};

const installFakeWebSocket = (): FakeSocket[] => {
  const sockets: FakeSocket[] = [];
  class FakeWebSocket {
    readonly url: string;
    readonly sentFrames: string[] = [];
    closed = false;
    onopen: (() => void) | null = null;
    onmessage: ((event: { data: string }) => void) | null = null;
    onclose: ((event?: { readonly code: number }) => void) | null = null;

    constructor(url: string) {
      this.url = url;
      sockets.push(this as FakeSocket);
    }

    send(data: string): void {
      this.sentFrames.push(data);
      const frame = JSON.parse(data) as { readonly kind?: string };
      if (frame.kind === "view") {
        this.message(
          JSON.stringify({
            ok: true,
            status: 200,
            body: { value: { rows: [] }, watermark: 1 },
          }),
        );
      }
    }

    close(): void {
      this.closed = true;
    }

    open(): void {
      this.onopen?.();
    }

    message(data: string): void {
      this.onmessage?.({ data });
    }
  }
  vi.stubGlobal("WebSocket", FakeWebSocket);
  return sockets;
};

const project = (projectId: string) => ({
  projectId,
  name: projectId,
  lifecycle: "Open" as const,
  rootWorkspaceId: `ws_${projectId}`,
  revision: 0,
  updatedAt: "2026-10-10T00:00:00.000Z",
});

const installFetch = (projectIds: ReadonlyArray<string>) => {
  let inboxReads = 0;
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === "/projects") {
      return new Response(
        JSON.stringify({
          ok: true,
          status: 200,
          body: { projects: projectIds.map(project) },
        }),
        { status: 200 },
      );
    }
    if (url === "/views/inbox-view") {
      inboxReads += 1;
      const kind = inboxReads === 1 ? "HumanConversation" : "Governance";
      return new Response(
        JSON.stringify({
          ok: true,
          status: 200,
          body: {
            value: {
              unconsumed: [
                {
                  entryKey:
                    kind === "HumanConversation"
                      ? "humanmsg:msg_1"
                      : "cap:cap_1:0",
                  kind,
                  summary: kind === "HumanConversation" ? "queued" : "approve",
                  watermark: inboxReads,
                },
              ],
            },
            watermark: inboxReads,
            lag: 0,
          },
        }),
        { status: 200 },
      );
    }
    return new Response(
      JSON.stringify({
        ok: true,
        status: 200,
        body: { value: { rows: [] }, watermark: 1, lag: 0 },
      }),
      { status: 200 },
    );
  });
  vi.stubGlobal("fetch", fetchMock);
  return { fetchMock, inboxReads: () => inboxReads };
};

const RouteProbe = ({
  workspaceId = "ws_default",
}: {
  readonly workspaceId?: string;
}) => {
  const session = useSession();
  const freshness = useFreshness();
  const inbox = useViewQuery("inbox-view", {
    workspaceId: workspaceId as never,
  });
  return (
    <output data-testid="route-state">
      {JSON.stringify({
        selectedProjectId: session.projectId,
        freshness: freshness.state,
        inboxKinds: inbox.data?.unconsumed.map((entry) => entry.kind) ?? [],
      })}
    </output>
  );
};

const routeState = () =>
  JSON.parse(screen.getByTestId("route-state").textContent ?? "{}") as {
    readonly selectedProjectId: string | null;
    readonly freshness: string;
    readonly inboxKinds: ReadonlyArray<string>;
  };

const pushPath = (path: string): void => {
  history.pushState(null, "", path);
  window.dispatchEvent(new PopStateEvent("popstate"));
};

afterEach(() => {
  cleanup();
  history.replaceState(null, "", "/");
  vi.unstubAllGlobals();
});

describe("URL-backed recent project selection", () => {
  it("ignores a stale A response after an A-to-B-to-A route generation", async () => {
    const firstProjectId = "prj_aba_first";
    const secondProjectId = "prj_aba_second";
    const directoryResponses: Array<(response: Response) => void> = [];
    const directoryRequestCount = () => directoryResponses.length;
    const directoryResponse = (projectIds: ReadonlyArray<string>) =>
      new Response(
        JSON.stringify({
          ok: true,
          status: 200,
          body: { projects: projectIds.map(project) },
        }),
        { status: 200 },
      );
    installFakeWebSocket();
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL) => {
        if (String(input) === "/projects") {
          return new Promise<Response>((resolve) => {
            directoryResponses.push(resolve);
          });
        }
        return Promise.resolve(
          new Response(
            JSON.stringify({
              ok: true,
              status: 200,
              body: { value: { unconsumed: [] }, watermark: 1, lag: 0 },
            }),
            { status: 200 },
          ),
        );
      }),
    );
    history.replaceState(null, "", `/p/${firstProjectId}`);

    render(
      <AppProviders>
        <RouteProbe workspaceId="ws_aba" />
      </AppProviders>,
    );

    await waitFor(() => expect(directoryRequestCount()).toBe(1));
    act(() => pushPath(`/p/${secondProjectId}`));
    await waitFor(() => expect(directoryRequestCount()).toBe(2));
    act(() => pushPath(`/p/${firstProjectId}/queue`));
    await waitFor(() => expect(directoryRequestCount()).toBe(3));

    await act(async () => {
      directoryResponses[2]?.(directoryResponse([]));
    });
    await waitFor(() => expect(routeState().selectedProjectId).toBeNull());

    await act(async () => {
      directoryResponses[0]?.(directoryResponse([firstProjectId]));
    });
    expect(routeState().selectedProjectId).toBeNull();

    await act(async () => {
      directoryResponses[1]?.(directoryResponse([secondProjectId]));
    });
    expect(routeState().selectedProjectId).toBeNull();
  });

  it("selects a valid direct route and refreshes queued Inbox after WS invalidation", async () => {
    const projectId = "prj_direct";
    const sockets = installFakeWebSocket();
    const fixture = installFetch([projectId]);
    history.replaceState(null, "", `/p/${projectId}/queue`);

    render(
      <AppProviders>
        <RouteProbe workspaceId="ws_direct" />
      </AppProviders>,
    );

    await waitFor(() => expect(sockets).toHaveLength(1), { timeout: 1_000 });
    expect(routeState().selectedProjectId).toBe(projectId);
    sockets[0]?.open();
    await waitFor(() => expect(routeState().freshness).toBe("fresh"));
    const proof = JSON.parse(sockets[0]?.sentFrames[0] ?? "null") as {
      readonly request?: { readonly projectId?: string };
    };
    expect(proof.request?.projectId).toBe(projectId);
    await waitFor(() =>
      expect(routeState().inboxKinds).toContain("HumanConversation"),
    );
    expect(fixture.inboxReads()).toBe(1);

    act(() => {
      sockets[0]?.message(
        JSON.stringify({
          kind: "invalidate",
          view: "inbox-view",
          watermark: 2,
        }),
      );
    });
    await waitFor(() =>
      expect(routeState().inboxKinds).toContain("Governance"),
    );
    expect(fixture.inboxReads()).toBe(2);
    expect(
      fixture.fetchMock.mock.calls.some(([url]) => url === "/projects"),
    ).toBe(true);
  });

  it("rebinds and closes the old socket on project routes and browser popstate", async () => {
    const firstProjectId = "prj_first";
    const secondProjectId = "prj_second";
    const sockets = installFakeWebSocket();
    installFetch([firstProjectId, secondProjectId]);
    history.replaceState(null, "", `/p/${firstProjectId}`);

    render(
      <AppProviders>
        <RouteProbe workspaceId="ws_first" />
      </AppProviders>,
    );

    await waitFor(() => expect(sockets).toHaveLength(1), { timeout: 1_000 });
    sockets[0]?.open();
    await waitFor(() => expect(routeState().freshness).toBe("fresh"));

    act(() => navigate({ name: "workbench", projectId: secondProjectId }));
    await waitFor(() => expect(sockets).toHaveLength(2), { timeout: 1_000 });
    expect(sockets[0]?.closed).toBe(true);
    expect(routeState().selectedProjectId).toBe(secondProjectId);
    sockets[1]?.open();
    await waitFor(() => expect(routeState().freshness).toBe("fresh"));
    expect(
      (
        JSON.parse(sockets[1]?.sentFrames[0] ?? "null") as {
          readonly request?: { readonly projectId?: string };
        }
      ).request?.projectId,
    ).toBe(secondProjectId);

    act(() => pushPath(`/p/${firstProjectId}/queue`));
    await waitFor(() => expect(sockets).toHaveLength(3), { timeout: 1_000 });
    expect(sockets[1]?.closed).toBe(true);
    expect(routeState().selectedProjectId).toBe(firstProjectId);
    sockets[2]?.open();
    await waitFor(() => expect(routeState().freshness).toBe("fresh"));
    expect(
      (
        JSON.parse(sockets[2]?.sentFrames[0] ?? "null") as {
          readonly request?: { readonly projectId?: string };
        }
      ).request?.projectId,
    ).toBe(firstProjectId);
  });

  it("fails closed and closes the old socket for unknown or invalid routes", async () => {
    const projectId = "prj_known";
    const sockets = installFakeWebSocket();
    installFetch([projectId]);
    history.replaceState(null, "", `/p/${projectId}`);

    render(
      <AppProviders>
        <RouteProbe workspaceId="ws_known" />
      </AppProviders>,
    );

    await waitFor(() => expect(sockets).toHaveLength(1), { timeout: 1_000 });
    sockets[0]?.open();
    await waitFor(() => expect(routeState().freshness).toBe("fresh"));

    act(() => navigate({ name: "workbench", projectId: "prj_foreign" }));
    await waitFor(() => expect(sockets[0]?.closed).toBe(true));
    await waitFor(() => expect(routeState().selectedProjectId).toBeNull());
    expect(sockets).toHaveLength(1);
    expect(routeState().freshness).toBe("offline");

    act(() => pushPath("/p/not-a-project/id/queue"));
    await waitFor(() => expect(routeState().selectedProjectId).toBeNull());
    expect(sockets).toHaveLength(1);
    expect(sockets[0]?.closed).toBe(true);
  });
});
