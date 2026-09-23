/**
 * P13-006 WS invalidation face (`05` §3 / `01` §3 I4): frames are
 * invalidation-only — {kind:"invalidate", view, watermark} with NO payload. A
 * frame triggers refetch of currently subscribed, viewId-matching entries; it
 * never carries view data and never updates cache content. No event replay,
 * no local state derivation: unsubscribed or malformed frames are dropped, and
 * the next successful fetch is the only freshness source. Connection failure
 * never throws — it degrades to a silent onClose.
 */

export interface InvalidationHandlers {
  onInvalidate(view: string, watermark: number): void;
  onOpen?(): void;
  onClose?(): void;
}

export interface InvalidationConnection {
  close(): void;
}

interface SocketLike {
  onmessage: ((event: { data: unknown }) => void) | null;
  onopen: (() => void) | null;
  onclose: (() => void) | null;
  close(): void;
}

const isInvalidationFrame = (
  value: unknown,
): value is { kind: "invalidate"; view: string; watermark: number } => {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    record.kind === "invalidate" &&
    typeof record.view === "string" &&
    typeof record.watermark === "number" &&
    Number.isFinite(record.watermark)
  );
};

const detach = (socket: SocketLike): void => {
  socket.onmessage = null;
  socket.onopen = null;
  socket.onclose = null;
};

export function connectInvalidation(
  url: string,
  handlers: InvalidationHandlers,
): InvalidationConnection {
  const socketFactory = (
    globalThis as unknown as {
      WebSocket?: new (url: string) => SocketLike;
    }
  ).WebSocket;
  let socket: SocketLike | null = null;
  if (socketFactory !== undefined) {
    try {
      socket = new socketFactory(url);
    } catch {
      socket = null;
    }
  }
  if (socket === null) {
    handlers.onClose?.();
    return {
      close() {},
    };
  }
  const ws = socket;
  ws.onopen = () => {
    handlers.onOpen?.();
  };
  ws.onclose = () => {
    detach(ws);
    handlers.onClose?.();
  };
  ws.onmessage = (event) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(String(event.data));
    } catch {
      return;
    }
    if (!isInvalidationFrame(parsed)) {
      return;
    }
    handlers.onInvalidate(parsed.view, parsed.watermark);
  };
  let closed = false;
  return {
    close() {
      if (closed) {
        return;
      }
      closed = true;
      detach(ws);
      ws.close();
    },
  };
}

/**
 * Per-view subscription face consumed by useView: connectInvalidation frames
 * are adapted into filtered per-view callbacks (frame.view →
 * store.invalidate(view)). A frame for a view nobody subscribed to is
 * dropped here — "currently subscribed and viewId-matching" (rule 2).
 */
export interface ViewInvalidationChannel {
  subscribeView(
    viewId: string,
    listener: (watermark: number) => void,
  ): () => void;
}

export function createViewInvalidationChannel(
  url: string,
): ViewInvalidationChannel & { close(): void } {
  const listenersByView = new Map<string, Set<(watermark: number) => void>>();
  const connection = connectInvalidation(url, {
    onInvalidate: (view, watermark) => {
      const listeners = listenersByView.get(view);
      if (listeners === undefined) {
        return;
      }
      for (const listener of [...listeners]) {
        listener(watermark);
      }
    },
  });
  return {
    subscribeView(viewId, listener) {
      const existing = listenersByView.get(viewId);
      if (existing === undefined) {
        listenersByView.set(viewId, new Set([listener]));
        return () => {
          listenersByView.get(viewId)?.delete(listener);
        };
      }
      existing.add(listener);
      return () => {
        listenersByView.get(viewId)?.delete(listener);
      };
    },
    close: connection.close,
  };
}
