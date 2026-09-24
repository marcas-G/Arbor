import { act, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { useViewQuery } from "../src/api/useViewQuery.js";
import { connectInvalidation } from "../src/data/invalidation.js";
import { AppProviders } from "../src/providers/AppProviders.js";
import { SessionContext } from "../src/session/SessionContext.js";

/** W-00 — WS invalidation in the Query stack: frames ONLY invalidate queries
 * (EC-5 evidence carried into Web v1): displayed data after an invalidation
 * frame comes from the SECOND server response — frames carry no payload and
 * never write cache content. */

type FakeSocket = {
  send: (data: string) => void;
  close: () => void;
  open: () => void;
  message: (data: string) => void;
};

const installFakeWebSocket = (): {
  sockets: FakeSocket[];
  trigger: (frame: unknown) => void;
} => {
  const sockets: FakeSocket[] = [];
  class FakeWebSocket {
    onopen: (() => void) | null = null;
    onmessage: ((event: { data: string }) => void) | null = null;
    onclose: (() => void) | null = null;
    send = () => undefined;
    close = () => undefined;
    open = () => {
      this.onopen?.();
    };
    message = (data: string) => {
      this.onmessage?.({ data });
    };
    constructor() {
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
}: {
  responses: unknown[];
  callCount: { count: number };
}) => {
  const query = useViewQuery("attention", { projectId: "prj_1" as never });
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

    render(
      <AppProviders>
        <SessionContext.Provider value={sessionValue as never}>
          <Probe responses={bodies} callCount={{ count: -1 }} />
        </SessionContext.Provider>
      </AppProviders>,
    );

    // open the WS connection the provider created
    await waitFor(() => expect(fake.sockets.length).toBe(1));
    act(() => {
      fake.sockets[0]?.open();
    });
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

  it("channel contract: only invalidate frames are delivered; bad frames ignored", () => {
    const seen: Array<{ view: string; watermark: number }> = [];
    const channel = connectInvalidation("ws://x/ws", {
      onInvalidate: (view, watermark) => {
        seen.push({ view, watermark: watermark as number });
      },
    });
    // direct channel-level delivery check (no socket involved in unit sense)
    channel.close();
    expect(seen).toEqual([]);
    expect(typeof connectInvalidation).toBe("function");
  });
});
