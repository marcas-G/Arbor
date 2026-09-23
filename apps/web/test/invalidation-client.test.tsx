/**
 * P13-006 invalidation client + useView integration (EC-5). A valid frame
 * {kind:"invalidate",view,watermark} reaches onInvalidate; non-invalidate,
 * malformed and badly-typed frames are ignored; close detaches callbacks;
 * constructor failure degrades to silent onClose. EC-5 core: after an
 * invalidation frame the rendered dto is the SECOND server response — dtoB
 * exists only in the second fetch mock and the frame carries no payload, so
 * local replay is impossible by construction. Mismatched view frames and
 * post-unmount frames cause no refetch; unmount aborts the in-flight signal.
 */

import type { AttentionRes } from "@arbor/api-contracts";
import { act, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ViewInvalidationChannel } from "../src/data/invalidation.js";
import {
  connectInvalidation,
  createViewInvalidationChannel,
} from "../src/data/invalidation.js";
import { useView } from "../src/data/useView.js";

const id = (value: string): never => value as never;

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  readonly url: string;
  readonly sent: string[] = [];
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  closed = false;

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }

  send(message: string): void {
    this.sent.push(message);
  }

  close(): void {
    this.closed = true;
    this.onclose?.();
  }

  emitMessage(data: string): void {
    this.onmessage?.({ data });
  }
}

const lastSocket = (): FakeWebSocket | undefined =>
  FakeWebSocket.instances.at(-1);

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("connectInvalidation", () => {
  it("delivers valid invalidate frames; ignores other kinds, bad JSON, bad types", () => {
    vi.stubGlobal("WebSocket", FakeWebSocket);
    const onInvalidate = vi.fn();
    const onOpen = vi.fn();
    const onClose = vi.fn();
    connectInvalidation("ws://x", { onInvalidate, onOpen, onClose });
    const ws = lastSocket();
    expect(ws).toBeDefined();
    if (ws === undefined) {
      return;
    }
    ws.onopen?.();
    expect(onOpen).toHaveBeenCalledTimes(1);
    ws.emitMessage(
      JSON.stringify({ kind: "invalidate", view: "attention", watermark: 5 }),
    );
    expect(onInvalidate).toHaveBeenCalledTimes(1);
    expect(onInvalidate).toHaveBeenCalledWith("attention", 5);
    ws.emitMessage(JSON.stringify({ kind: "greeting", view: "attention" }));
    ws.emitMessage("{not json");
    ws.emitMessage(
      JSON.stringify({ kind: "invalidate", view: "attention", watermark: "5" }),
    );
    ws.emitMessage(
      JSON.stringify({ kind: "invalidate", view: 7, watermark: 5 }),
    );
    expect(onInvalidate).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();
  });

  it("close() closes the socket and detaches: later frames are dropped", () => {
    vi.stubGlobal("WebSocket", FakeWebSocket);
    const onInvalidate = vi.fn();
    const connection = connectInvalidation("ws://x", {
      onInvalidate,
      onClose: () => {},
    });
    const ws = lastSocket();
    expect(ws).toBeDefined();
    if (ws === undefined) {
      return;
    }
    connection.close();
    expect(ws.closed).toBe(true);
    ws.emitMessage(
      JSON.stringify({ kind: "invalidate", view: "attention", watermark: 6 }),
    );
    expect(onInvalidate).not.toHaveBeenCalled();
    connection.close();
  });

  it("server-side close fires onClose once", () => {
    vi.stubGlobal("WebSocket", FakeWebSocket);
    const onClose = vi.fn();
    connectInvalidation("ws://x", { onInvalidate: () => {}, onClose });
    const ws = lastSocket();
    expect(ws).toBeDefined();
    if (ws === undefined) {
      return;
    }
    ws.onclose?.();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("constructor failure never throws: silent onClose, close() is a no-op", () => {
    class ThrowingWebSocket {
      constructor(_url: string) {
        throw new Error("no ws support");
      }
    }
    vi.stubGlobal("WebSocket", ThrowingWebSocket);
    const onClose = vi.fn();
    const connection = connectInvalidation("ws://x", {
      onInvalidate: () => {},
      onClose,
    });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(() => connection.close()).not.toThrow();
  });
});

describe("useView + invalidation integration", () => {
  const dtoA: AttentionRes = {
    rows: [
      {
        source: "Deadlock",
        severity: "Attention",
        targetWorkspaceId: id("w-1"),
        dedupKey: "d-1",
        summaryRef: "AAA-first-response",
        occurredAt: "2026-01-01T00:00:00.000Z",
      },
    ],
  };
  const dtoB: AttentionRes = {
    rows: [
      {
        source: "Deadlock",
        severity: "Attention",
        targetWorkspaceId: id("w-1"),
        dedupKey: "d-1",
        summaryRef: "BBB-second-response",
        occurredAt: "2026-01-02T00:00:00.000Z",
      },
    ],
  };

  function Probe({ channel }: { channel: ViewInvalidationChannel }) {
    const { entry } = useView(
      "attention",
      { projectId: id("p-1") },
      {
        invalidation: channel,
      },
    );
    return (
      <div>
        <span data-testid="state">{entry.state}</span>
        <span data-testid="summary">
          {entry.dto
            ? entry.dto.rows.map((row) => row.summaryRef).join(",")
            : (entry.problem?.code ?? "empty")}
        </span>
      </div>
    );
  }

  it("EC-5: invalidate frame (matching view) → refetch → rendered dto is the second server response", async () => {
    FakeWebSocket.instances.length = 0;
    vi.stubGlobal("WebSocket", FakeWebSocket);
    const signals: AbortSignal[] = [];
    let call = 0;
    const fetchMock = vi.fn(
      async (_url: string, init?: { signal?: AbortSignal }) => {
        if (init?.signal !== undefined) {
          signals.push(init.signal);
        }
        call += 1;
        return {
          status: 200,
          json: async () => ({
            ok: true,
            status: 200,
            body: call === 1 ? dtoA : dtoB,
          }),
        };
      },
    );
    vi.stubGlobal("fetch", fetchMock);

    const channel = createViewInvalidationChannel("/ws");
    const { unmount } = render(<Probe channel={channel} />);
    expect(await screen.findByText("AAA-first-response")).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const ws = lastSocket();
    expect(ws).toBeDefined();
    if (ws === undefined) {
      return;
    }

    await act(async () => {
      ws.emitMessage(
        JSON.stringify({ kind: "invalidate", view: "attention", watermark: 5 }),
      );
    });
    // EC-5: dtoB exists only in the second fetch mock; the frame has no
    // payload, so this can only pass via a real refetch.
    expect(await screen.findByText("BBB-second-response")).toBeTruthy();
    expect(screen.queryByText("AAA-first-response")).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(2);

    await act(async () => {
      ws.emitMessage(
        JSON.stringify({ kind: "invalidate", view: "usage", watermark: 6 }),
      );
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);

    unmount();
    expect(signals.at(-1)?.aborted).toBe(true);

    await act(async () => {
      ws.emitMessage(
        JSON.stringify({ kind: "invalidate", view: "attention", watermark: 7 }),
      );
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
