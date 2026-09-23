import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer } from "node:http";
import type { Duplex } from "node:stream";
import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { type WebSocket, WebSocketServer } from "ws";
import type { TransportResponse } from "./contracts.js";
import type { HttpShell, HttpTransportRequest } from "./http.js";
import {
  type InvalidationFanout,
  type InvalidationFrame,
  JOURNAL_WATERMARK_SQL,
  makeInvalidationFanout,
} from "./invalidation.js";
import { resolveStatic } from "./static-assets.js";
import type { WebSocketFrame, WebSocketShell } from "./websocket.js";

/**
 * P13 TR-W1/TR-W2 (`05` §2–§3): the same-origin node binding — static dist
 * hosting, the frozen HTTP shell (`/views/:view`, `/commands`), the WS shell
 * (request frames unchanged) plus the server-push invalidation channel.
 * Transport semantics stay in the frozen pure shells; this file is wiring.
 */

export interface WebTransportConfig {
  readonly http: HttpShell;
  readonly webSocket: WebSocketShell;
  /** Journal-tail watermark source (SqlClient-backed). */
  readonly sql: SqlClient;
  /** Vite build output; absent disables static hosting. */
  readonly staticRoot?: string | undefined;
  readonly host?: string | undefined;
  readonly port?: number | undefined;
  readonly pollIntervalMs?: number | undefined;
}

export interface WebTransportHandle {
  readonly port: number;
  readonly fanout: InvalidationFanout;
  /** Force one watermark poll (test hook). */
  readonly pollNow: () => Promise<void>;
  readonly close: () => Promise<void>;
}

/** TR-W2 (`05` §2): every GET/HEAD that is NOT an API path goes to the
 * static face (which serves /assets/* and falls back to index.html for
 * client routes like /p/:projectId/... — no server route semantics). */
const isStaticCandidate = (method: string, path: string): boolean =>
  (method === "GET" || method === "HEAD") && !isApiPath(path);

const isApiPath = (path: string): boolean =>
  path === "/commands" || path.startsWith("/views/") || path === "/views";

const sendBytes = (
  response: ServerResponse,
  status: number,
  contentType: string,
  cacheControl: string,
  bytes: Buffer,
  headOnly: boolean,
): void => {
  response.writeHead(status, {
    "content-type": contentType,
    "cache-control": cacheControl,
    "content-length": bytes.byteLength,
  });
  response.end(headOnly ? undefined : bytes);
};

const readBody = (request: IncomingMessage): Promise<unknown> =>
  new Promise((resolveBody) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
    });
    request.on("end", () => {
      if (chunks.length === 0) {
        resolveBody(undefined);
        return;
      }
      try {
        resolveBody(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        resolveBody(null);
      }
    });
    request.on("error", () => resolveBody(null));
  });

export const startWebTransport = async (
  config: WebTransportConfig,
): Promise<WebTransportHandle> => {
  const fanout = makeInvalidationFanout();
  const lastWatermark = { value: 0 };

  const server = createServer((request, response) => {
    void (async () => {
      const url = request.url ?? "/";
      const path = url.split("?")[0] ?? url;
      const method = (request.method ?? "GET").toUpperCase();

      if (
        config.staticRoot !== undefined &&
        isStaticCandidate(method, path)
      ) {
        const resolution = resolveStatic(config.staticRoot, url);
        if (resolution.kind === "file") {
          sendBytes(
            response,
            200,
            resolution.contentType,
            resolution.cacheControl,
            resolution.bytes,
            method === "HEAD",
          );
          return;
        }
        if (resolution.kind === "rejected") {
          response.writeHead(404).end();
          return;
        }
        sendBytes(
          response,
          503,
          "text/plain; charset=utf-8",
          "no-store",
          Buffer.from("web dist not built"),
          method === "HEAD",
        );
        return;
      }

      const body =
        method === "GET" || method === "HEAD"
          ? undefined
          : await readBody(request);
      const authorization = request.headers.authorization;
      const shellRequest: HttpTransportRequest = {
        method,
        path,
        ...(authorization !== undefined ? { authorization } : {}),
        body,
      };
      const result = await Effect.runPromise(config.http.handle(shellRequest));
      const payload: TransportResponse<unknown> = result;
      sendBytes(
        response,
        payload.status,
        "application/json; charset=utf-8",
        "no-store",
        Buffer.from(JSON.stringify(payload)),
        method === "HEAD",
      );
    })().catch(() => {
      if (!response.headersSent) {
        response.writeHead(500).end();
      } else {
        response.end();
      }
    });
  });

  const wss = new WebSocketServer({ noServer: true });
  const sockets = new Set<WebSocket>();

  server.on("upgrade", (request, socket: Duplex, head: Buffer) => {
    const path = (request.url ?? "").split("?")[0];
    if (path !== "/ws") {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(request, socket, head, (ws) => {
      sockets.add(ws);
      ws.on("close", () => {
        sockets.delete(ws);
      });
      ws.on("message", (data) => {
        void (async () => {
          let frame: WebSocketFrame;
          try {
            frame = JSON.parse(data.toString()) as WebSocketFrame;
          } catch {
            ws.send(
              JSON.stringify({
                ok: false,
                status: 400,
                problem: { code: "transport/invalid-request" },
              }),
            );
            return;
          }
          const response = await Effect.runPromise(
            config.webSocket.handleFrame(frame),
          );
          if (ws.readyState === ws.OPEN) {
            ws.send(JSON.stringify(response));
          }
        })();
      });
    });
  });

  const pushInvalidations = (frame: InvalidationFrame): void => {
    const payload = JSON.stringify(frame);
    for (const ws of sockets) {
      if (ws.readyState === ws.OPEN) {
        ws.send(payload);
      }
    }
  };
  fanout.subscribe(pushInvalidations);

  const pollOnce = async (): Promise<void> => {
    const rows = await Effect.runPromise(
      config.sql.unsafe<{ watermark: number }>(JOURNAL_WATERMARK_SQL),
    );
    const row = rows[0];
    const watermark = row === undefined ? 0 : Number(row.watermark);
    if (watermark > lastWatermark.value) {
      lastWatermark.value = watermark;
      fanout.publishWatermark(watermark);
    }
  };

  const timer = setInterval(() => {
    void pollOnce().catch(() => undefined);
  }, config.pollIntervalMs ?? 300);

  await new Promise<void>((resolveListening) => {
    server.once("error", (error) => {
      clearInterval(timer);
      throw error;
    });
    server.listen(config.port ?? 0, config.host ?? "127.0.0.1", () => {
      resolveListening();
    });
  });

  const address = server.address();
  const port =
    typeof address === "object" && address !== null
      ? address.port
      : (config.port ?? 0);

  return {
    port,
    fanout,
    pollNow: pollOnce,
    close: async () => {
      clearInterval(timer);
      for (const ws of sockets) {
        ws.close();
      }
      await new Promise<void>((resolveClosed) => {
        wss.close(() => {
          resolveClosed();
        });
      });
      await new Promise<void>((resolveClosed) => {
        server.close(() => {
          resolveClosed();
        });
      });
    },
  };
};

/** Effect wiring face: builds the handle from the slice's SqlClient. */
export const startWebTransportEffect = (
  config: Omit<WebTransportConfig, "sql">,
): Effect.Effect<WebTransportHandle, never, SqlClient> =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    return yield* Effect.promise(() => startWebTransport({ ...config, sql }));
  });
