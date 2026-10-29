import { describe, expect, it, vi } from "vitest";
import { connectInvalidation } from "../src/data/invalidation.js";

/** W-00 — the WS channel contract (unit): JSON frames, kind-strict delivery,
 * silent failure, unsubscribe semantics. (Query integration lives in
 * ws-invalidation-query.test.tsx.) */

type FakeSocket = {
  readonly sentFrames: string[];
  send: (data: string) => void;
  close: () => void;
  open: () => void;
  disconnect: () => void;
  message: (data: string) => void;
};

const installFakeWebSocket = () => {
  const sockets: FakeSocket[] = [];
  class FakeWebSocket {
    readonly sentFrames: string[] = [];
    onopen: (() => void) | null = null;
    onmessage: ((event: { data: string }) => void) | null = null;
    onclose: (() => void) | null = null;
    send = (data: string) => {
      this.sentFrames.push(data);
      const frame = JSON.parse(data) as { kind?: string };
      if (frame.kind === "view") {
        this.message(
          JSON.stringify({ ok: true, status: 200, body: { value: {} } }),
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
    constructor() {
      sockets.push(this as unknown as FakeSocket);
    }
  }
  vi.stubGlobal("WebSocket", FakeWebSocket);
  return sockets;
};

describe("connectInvalidation channel", () => {
  it("delivers only well-formed invalidate frames", () => {
    const sockets = installFakeWebSocket();
    const seen: unknown[] = [];
    connectInvalidation(
      "ws://x/ws",
      {
        onInvalidate: (frame) => {
          seen.push(frame);
        },
      },
      {
        firstView: {
          token: "test-token",
          view: "attention",
          request: { projectId: "prj_test" },
        },
      },
    );
    const socket = sockets[0];
    socket?.open();
    socket?.message(
      JSON.stringify({ kind: "invalidate", view: "attention", watermark: 5 }),
    );
    socket?.message(JSON.stringify({ kind: "view", view: "attention" }));
    socket?.message("not json");
    socket?.message(
      JSON.stringify({ kind: "invalidate", view: 7, watermark: "x" }),
    );
    expect(seen).toEqual(["attention"]);
  });

  it("close stops delivery and clears callbacks", () => {
    const sockets = installFakeWebSocket();
    const seen: unknown[] = [];
    const channel = connectInvalidation(
      "ws://x/ws",
      {
        onInvalidate: (frame) => {
          seen.push(frame);
        },
      },
      {
        firstView: {
          token: "test-token",
          view: "attention",
          request: { projectId: "prj_test" },
        },
      },
    );
    channel.close();
    sockets[0]?.message(
      JSON.stringify({ kind: "invalidate", view: "usage", watermark: 1 }),
    );
    expect(seen).toEqual([]);
  });

  it("connection failure is silent (no throw)", () => {
    vi.stubGlobal(
      "WebSocket",
      class {
        constructor() {
          throw new Error("no server");
        }
      },
    );
    expect(() =>
      connectInvalidation(
        "ws://x/ws",
        { onInvalidate: () => undefined },
        {
          firstView: {
            token: "test-token",
            view: "attention",
            request: { projectId: "prj_test" },
          },
        },
      ),
    ).not.toThrow();
  });

  it("reconnects after a closed socket and resumes invalidation delivery", () => {
    vi.useFakeTimers();
    let channel: ReturnType<typeof connectInvalidation> | undefined;
    try {
      const sockets = installFakeWebSocket();
      const seen: unknown[] = [];
      channel = connectInvalidation(
        "ws://x/ws",
        {
          onInvalidate: (frame) => {
            seen.push(frame);
          },
        },
        {
          firstView: {
            token: "test-token",
            view: "attention",
            request: { projectId: "prj_test" },
          },
        },
      );

      expect(sockets).toHaveLength(1);
      sockets[0]?.open();
      sockets[0]?.disconnect();

      vi.advanceTimersByTime(1000);

      expect(sockets).toHaveLength(2);
      sockets[1]?.open();
      sockets[1]?.message(
        JSON.stringify({ kind: "invalidate", view: "usage", watermark: 2 }),
      );

      expect(seen).toEqual(["usage"]);
      sockets[1]?.disconnect();
      channel.close();
      vi.advanceTimersByTime(1000);
      expect(sockets).toHaveLength(2);
    } finally {
      channel?.close();
      vi.useRealTimers();
    }
  });
});
