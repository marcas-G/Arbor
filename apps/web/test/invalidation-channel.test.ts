import { describe, expect, it, vi } from "vitest";
import { connectInvalidation } from "../src/data/invalidation.js";

/** W-00 — the WS channel contract (unit): JSON frames, kind-strict delivery,
 * silent failure, unsubscribe semantics. (Query integration lives in
 * ws-invalidation-query.test.tsx.) */

type FakeSocket = {
  send: (data: string) => void;
  close: () => void;
  open: () => void;
  message: (data: string) => void;
};

const installFakeWebSocket = () => {
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
  return sockets;
};

describe("connectInvalidation channel", () => {
  it("delivers only well-formed invalidate frames", () => {
    const sockets = installFakeWebSocket();
    const seen: unknown[] = [];
    connectInvalidation("ws://x/ws", {
      onInvalidate: (frame) => {
        seen.push(frame);
      },
    });
    const socket = sockets[0];
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
    const channel = connectInvalidation("ws://x/ws", {
      onInvalidate: (frame) => {
        seen.push(frame);
      },
    });
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
      connectInvalidation("ws://x/ws", { onInvalidate: () => undefined }),
    ).not.toThrow();
  });
});
