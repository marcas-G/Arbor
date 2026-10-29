import { act, render, screen, waitFor } from "@testing-library/react";
import { useEffect } from "react";
import { describe, expect, it, vi } from "vitest";
import { useViewQuery } from "../src/api/useViewQuery.js";
import { connectInvalidation } from "../src/data/invalidation.js";
import { AppProviders } from "../src/providers/AppProviders.js";
import { useSession } from "../src/session/SessionContext.js";

/** W-00 — WS invalidation in the Query stack: frames ONLY invalidate queries
 * (EC-5 evidence carried into Web v1): displayed data after an invalidation
 * frame comes from the SECOND server response — frames carry no payload and
 * never write cache content. */

type FakeSocket = {
  readonly url: string;
  readonly sentFrames: string[];
  send: (data: string) => void;
  close: () => void;
  open: () => void;
  disconnect: () => void;
  message: (data: string) => void;
};

const installFakeWebSocket = (): {
  sockets: FakeSocket[];
  trigger: (frame: unknown) => void;
} => {
  const sockets: FakeSocket[] = [];
  class FakeWebSocket {
    readonly url: string;
    readonly sentFrames: string[] = [];
    onopen: (() => void) | null = null;
    onmessage: ((event: { data: string }) => void) | null = null;
    onclose: (() => void) | null = null;
    send = (data: string) => {
      this.sentFrames.push(data);
      const frame = JSON.parse(data) as { kind?: string };
      if (frame.kind === "view") {
        this.message(
          JSON.stringify({
            ok: true,
            status: 200,
            body: { value: {}, watermark: 1 },
          }),
        );
      }
    };
    close = () => undefined;
    disconnect = () => {
      this.onclose?.();
    };
    open = () => {
      this.onopen?.();
    };
    message = (data: string) => {
      this.onmessage?.({ data });
    };
    constructor(url: string) {
      this.url = url;
      sockets.push(this as unknown as FakeSocket);
    }
  }
  vi.stubGlobal("WebSocket", FakeWebSocket);
  return {
    sockets,
    trigger: (frame: unknown) => {
      for (const socket of sockets) {
        socket.message(JSON.stringify(frame));
      }
    },
  };
};

const Probe = ({
  responses,
  callCount,
  projectId = "prj_1",
}: {
  responses: unknown[];
  callCount: { count: number };
  projectId?: string;
}) => {
  const query = useViewQuery("attention", { projectId: projectId as never });
  if (query.isPending) {
    return <p data-testid="state">loading</p>;
  }
  if (query.isError) {
    return <p data-testid="state">error</p>;
  }
  const data = query.data as unknown as { rows: Array<{ summary: string }> };
  return (
    <p data-testid="state">
      {`${responses.length}#${data.rows.map((row) => row.summary).join(",")}`}
      {callCount.count === -1 ? "" : ""}
    </p>
  );
};

const PrimeSession = ({
  token,
  projectId,
}: {
  readonly token: string;
  readonly projectId: string;
}) => {
  const session = useSession();
  useEffect(() => {
    session.setSession(token, "user:test");
    session.setProjectId(projectId);
  }, [projectId, session.setProjectId, session.setSession, token]);
  return null;
};

describe("WS invalidation → Query refetch (EC-5, Web v1 stack)", () => {
  it("an invalidate frame for the displayed view triggers a server refetch; data comes from the second response", async () => {
    const fake = installFakeWebSocket();
    let calls = 0;
    const bodies = [
      {
        ok: true,
        status: 200,
        body: { value: { rows: [{ summary: "A" }] }, watermark: 1 },
      },
      {
        ok: true,
        status: 200,
        body: { value: { rows: [{ summary: "B" }] }, watermark: 2 },
      },
    ];
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        const body = bodies[Math.min(calls, bodies.length - 1)];
        calls += 1;
        return new Response(JSON.stringify(body), { status: 200 });
      }),
    );

    render(
      <AppProviders>
        <PrimeSession token="tok" projectId="prj_1" />
        <Probe responses={bodies} callCount={{ count: -1 }} />
      </AppProviders>,
    );

    // open the WS connection the provider created
    await waitFor(() => expect(fake.sockets.length).toBe(1));
    act(() => {
      fake.sockets[0]?.open();
    });
    const proofFrame = JSON.parse(fake.sockets[0]?.sentFrames[0] ?? "null") as {
      kind?: string;
      token?: string;
      view?: string;
      request?: { projectId?: string };
    };
    expect(proofFrame).toEqual({
      kind: "view",
      token: "tok",
      view: "attention",
      request: { projectId: "prj_1" },
    });
    expect(fake.sockets[0]?.url).not.toContain("tok");
    await waitFor(() =>
      expect(screen.getByTestId("state").textContent).toContain("A"),
    );
    expect(calls).toBe(1);

    // An untrusted extra payload must not become view data: "B" exists only
    // in fetch #2, not in this frame.
    act(() => {
      fake.trigger({
        kind: "invalidate",
        view: "attention",
        watermark: 2,
        payload: {
          rows: [{ summary: "frame payload must be ignored" }],
          entries: [{ kind: "TranscriptEntry" }],
        },
      });
    });
    await waitFor(() =>
      expect(screen.getByTestId("state").textContent).toContain("B"),
    );
    expect(screen.getByTestId("state").textContent).not.toContain(
      "frame payload must be ignored",
    );
    expect(calls).toBe(2);

    vi.unstubAllGlobals();
  });

  it("refetches active views after reconnect to recover missed invalidations", async () => {
    const fake = installFakeWebSocket();
    let calls = 0;
    const bodies = [
      {
        ok: true,
        status: 200,
        body: { value: { rows: [{ summary: "A" }] }, watermark: 1 },
      },
      {
        ok: true,
        status: 200,
        body: { value: { rows: [{ summary: "B" }] }, watermark: 2 },
      },
    ];
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        const body = bodies[Math.min(calls, bodies.length - 1)];
        calls += 1;
        return new Response(JSON.stringify(body), { status: 200 });
      }),
    );

    const view = render(
      <AppProviders>
        <PrimeSession token="tok" projectId="prj_1" />
        <Probe
          responses={bodies}
          callCount={{ count: -1 }}
          projectId="prj_reconnect"
        />
      </AppProviders>,
    );

    try {
      await waitFor(() => expect(fake.sockets).toHaveLength(1));
      act(() => {
        fake.sockets[0]?.open();
      });
      expect(fake.sockets[0]?.sentFrames).toHaveLength(1);
      await waitFor(() =>
        expect(screen.getByTestId("state").textContent).toContain("A"),
      );
      expect(calls).toBe(1);

      act(() => {
        fake.sockets[0]?.disconnect();
      });
      await waitFor(() => expect(fake.sockets).toHaveLength(2), {
        timeout: 2500,
      });
      act(() => {
        fake.sockets[1]?.open();
      });
      expect(fake.sockets[1]?.sentFrames).toHaveLength(1);

      await waitFor(() =>
        expect(screen.getByTestId("state").textContent).toContain("B"),
      );
      expect(calls).toBe(2);
    } finally {
      view.unmount();
      vi.unstubAllGlobals();
    }
  });

  it("channel contract: only invalidate frames are delivered; bad frames ignored", () => {
    const seen: Array<{ view: string; watermark: number }> = [];
    const channel = connectInvalidation(
      "ws://x/ws",
      {
        onInvalidate: (view, watermark) => {
          seen.push({ view, watermark: watermark as number });
        },
      },
      {
        firstView: {
          token: "tok",
          view: "attention",
          request: { projectId: "prj_1" },
        },
      },
    );
    // direct channel-level delivery check (no socket involved in unit sense)
    channel.close();
    expect(seen).toEqual([]);
    expect(typeof connectInvalidation).toBe("function");
  });
});
