import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer } from "node:http";
import type { Duplex } from "node:stream";
import type { ConversationStreamFrame } from "@arbor/api-contracts";
import type { Principal } from "@arbor/domain";
import type {
  ProjectDirectoryService,
  ProjectResourceProfilePortService,
} from "@arbor/ports";
import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { type WebSocket, WebSocketServer } from "ws";
import { type ModelSetup, ModelSetupError } from "../model-setup.js";
import {
  type HostProjectDirectories,
  ProjectDirectoryError,
} from "../project-directories.js";
import type { RuntimeInfo } from "../runtime-info.js";
import type { AuthenticatorService } from "./auth.js";
import { LOCAL_PRINCIPAL } from "./auth.js";
import type { TransportResponse } from "./contracts.js";
import {
  type ConversationProgressHub,
  defaultConversationProgressHub,
} from "./conversation-progress.js";
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
  readonly authenticator?: AuthenticatorService | undefined;
  /** Explicit composition fact; do not infer configured auth from the
   * AuthenticatorService object because Composition supplies a local fallback. */
  readonly authenticatorConfigured: boolean;
  readonly conversationProgress?: ConversationProgressHub | undefined;
  /** Journal-tail watermark source (SqlClient-backed). */
  readonly sql: SqlClient;
  readonly projectDirectory: ProjectDirectoryService;
  /** P12 host-owned Profile registry; absent means an empty catalog. */
  readonly projectResourceProfiles?: ProjectResourceProfilePortService;
  readonly projectDirectories?: HostProjectDirectories;
  /** Vite build output; absent disables static hosting. */
  readonly staticRoot?: string | undefined;
  readonly host?: string | undefined;
  readonly port?: number | undefined;
  readonly pollIntervalMs?: number | undefined;
  readonly runtimeInfo?: RuntimeInfo;
  readonly modelSetup?: ModelSetup;
}

export interface WebTransportHandle {
  readonly port: number;
  readonly fanout: InvalidationFanout;
  /** Current count of local sockets admitted to the invalidation fanout. */
  readonly webSocketSubscriberCount: () => number;
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
  path === "/model-setup" ||
  path === "/runtime" ||
  path === "/commands" ||
  path === "/projects" ||
  path === "/project-resources" ||
  path === "/project-directories" ||
  path.startsWith("/views/") ||
  path === "/views" ||
  path.startsWith("/conversation-progress/");

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

/** Default body ceiling for command/view/JSON routes. A command payload is
 * bounded typed JSON; anything larger is a client defect or abuse, and the
 * previous unbounded default let a single request buffer without limit. */
const DEFAULT_MAX_BODY_BYTES = 10 * 1024 * 1024;

const readBody = (
  request: IncomingMessage,
  maxBytes = DEFAULT_MAX_BODY_BYTES,
): Promise<unknown> =>
  new Promise((resolveBody) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    request.on("data", (chunk: Buffer) => {
      bytes += chunk.byteLength;
      if (bytes <= maxBytes) chunks.push(chunk);
    });
    request.on("end", () => {
      if (bytes > maxBytes) {
        resolveBody(null);
        return;
      }
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

const sendJson = (
  response: ServerResponse,
  status: number,
  body: unknown,
): void => {
  const bytes = Buffer.from(JSON.stringify(body));
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "content-length": bytes.byteLength,
  });
  response.end(bytes);
};

const bearerToken = (authorization: string | undefined): string | null => {
  const basic = /^Basic\s+(.+)$/.exec(authorization ?? "");
  if (basic !== null) {
    return authorization ?? null;
  }
  const match = /^Bearer\s+(.+)$/.exec(authorization ?? "");
  return match?.[1] ?? null;
};

const isLoopbackListenerHost = (host: string | undefined): boolean => {
  const normalized = (host ?? "127.0.0.1")
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/gu, "");
  if (normalized === "localhost" || normalized === "::1") return true;
  if (normalized.startsWith("::ffff:")) {
    return isLoopbackListenerHost(normalized.slice("::ffff:".length));
  }
  const octets = normalized.split(".");
  return (
    octets.length === 4 &&
    octets.every((octet) => /^(0|[1-9][0-9]{0,2})$/u.test(octet)) &&
    octets.every((octet) => Number(octet) <= 255) &&
    Number(octets[0]) === 127
  );
};

/** Local-user authority is safe only on the intended loopback origin. Origin
 * alone is insufficient: a rebinding domain can resolve to the loopback IP.
 * Native clients may omit Origin; browser-supplied opaque/foreign origins fail.
 * Forwarded headers never establish local authority. */
const acceptsBrowserBoundary = (
  request: IncomingMessage,
  config: WebTransportConfig,
): boolean => {
  const host = request.headers.host;
  if (host === undefined) return false;
  try {
    const target = new URL(`http://${host}`);
    if (
      target.username !== "" ||
      target.password !== "" ||
      target.pathname !== "/" ||
      target.search !== "" ||
      target.hash !== ""
    )
      return false;
    if (!config.authenticatorConfigured) {
      if (
        !isLoopbackListenerHost(target.hostname) ||
        Number(target.port || "80") !== request.socket.localPort
      )
        return false;
    }
    const origin = request.headers.origin;
    if (origin !== undefined) {
      const source = new URL(origin);
      if (
        source.origin !== origin ||
        source.host !== target.host ||
        (source.protocol !== "http:" &&
          !(config.authenticatorConfigured && source.protocol === "https:"))
      )
        return false;
    }
    const path = (request.url ?? "/").split("?")[0] ?? "/";
    if (
      request.headers["sec-fetch-site"] === "cross-site" &&
      (isApiPath(path) || path === "/ws")
    )
      return false;
    return true;
  } catch {
    return false;
  }
};

const authenticateLocalSensitiveRead = async (
  request: IncomingMessage,
  response: ServerResponse,
  config: WebTransportConfig,
  unsupportedPrincipal: { readonly status: number; readonly code: string },
): Promise<Principal | null> => {
  if (!config.authenticatorConfigured && !isLoopbackListenerHost(config.host)) {
    sendJson(response, 503, {
      ok: false,
      problem: { code: "auth/local-listener-required" },
    });
    return null;
  }
  const token = bearerToken(request.headers.authorization);
  const principal = !config.authenticatorConfigured
    ? (LOCAL_PRINCIPAL as unknown as Principal)
    : config.authenticator === undefined
      ? null
      : await Effect.runPromise(
          config.authenticator.authenticate(token === null ? null : { token }),
        ).catch(() => null);
  if (principal === null) {
    sendJson(response, 401, {
      ok: false,
      problem: { code: "auth/unauthenticated" },
    });
    return null;
  }
  if (String(principal) !== LOCAL_PRINCIPAL) {
    sendJson(response, unsupportedPrincipal.status, {
      ok: false,
      problem: { code: unsupportedPrincipal.code },
    });
    return null;
  }
  return principal;
};

const streamConversationProgress = async (
  request: IncomingMessage,
  response: ServerResponse,
  messageId: string,
  config: WebTransportConfig,
): Promise<void> => {
  const hub = config.conversationProgress ?? defaultConversationProgressHub;
  const principal = await authenticateLocalSensitiveRead(
    request,
    response,
    config,
    { status: 403, code: "conversation-progress/forbidden" },
  );
  if (principal === null) {
    return;
  }
  const rows = await Effect.runPromise(
    config.sql.unsafe<{ human_principal: string }>(
      "SELECT human_principal FROM human_messages WHERE message_id = ?",
      [messageId],
    ),
  );
  const row = rows[0];
  if (row === undefined) {
    sendJson(response, 404, {
      ok: false,
      problem: { code: "conversation-progress/not-found" },
    });
    return;
  }
  if (row.human_principal !== String(principal)) {
    sendJson(response, 403, {
      ok: false,
      problem: { code: "conversation-progress/forbidden" },
    });
    return;
  }

  const after = Number.parseInt(
    request.headers["last-event-id"]?.toString() ?? "0",
    10,
  );
  response.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });
  response.flushHeaders();
  const writeFrame = (frame: ConversationStreamFrame): void => {
    if (response.writableEnded) {
      return;
    }
    response.write(
      `id: ${frame.sequence}\ndata: ${JSON.stringify(frame.event)}\n\n`,
    );
    if (frame.event.type === "settled" || frame.event.type === "interrupted") {
      response.end();
    }
  };
  const subscription = hub.subscribe(
    messageId,
    Number.isNaN(after) ? 0 : after,
    writeFrame,
  );
  if (subscription.terminal) {
    response.end();
    return;
  }
  const heartbeat = setInterval(() => {
    if (!response.writableEnded) {
      response.write(": keep-alive\n\n");
    }
  }, 15_000);
  const cleanup = (): void => {
    clearInterval(heartbeat);
    subscription.unsubscribe();
  };
  request.on("aborted", cleanup);
  response.on("close", cleanup);
};

/** P15 local-single-user directory face. It deliberately is not a `/views`
 * endpoint: no individual Project watermark can truthfully describe a
 * cross-project list. A multi-principal deployment must install the future
 * visibility resolver rather than silently exposing this SQL listing. */
const readLocalProjectDirectory = async (
  request: IncomingMessage,
  response: ServerResponse,
  config: WebTransportConfig,
): Promise<void> => {
  const principal = await authenticateLocalSensitiveRead(
    request,
    response,
    config,
    { status: 503, code: "project-directory/visibility-resolver-required" },
  );
  if (principal === null) {
    return;
  }
  const rows = await Effect.runPromise(config.projectDirectory.list());
  const boundaries =
    config.projectDirectories === undefined
      ? []
      : await Effect.runPromise(
          config.sql.unsafe<{ project_id: string; resource_boundary: string }>(
            "SELECT p.project_id, w.resource_boundary FROM projects p JOIN workspaces w ON w.workspace_id = p.root_workspace_id",
          ),
        );
  const paths = new Map(
    boundaries.map((row) => {
      const boundary = JSON.parse(row.resource_boundary) as {
        addresses?: ReadonlyArray<{ _tag: string; path?: string }>;
      };
      return [
        row.project_id,
        boundary.addresses?.find(
          (address) =>
            address._tag === "FileTree" && typeof address.path === "string",
        )?.path,
      ];
    }),
  );
  sendJson(response, 200, {
    ok: true,
    status: 200,
    body: {
      projects: rows.map((row) => ({
        projectId: row.projectId,
        name: row.name,
        lifecycle: row.lifecycle,
        rootWorkspaceId: row.rootWorkspaceId,
        revision: row.revision,
        updatedAt: row.updatedAt,
        resourceSource: row.resourceSource,
        ...(config.projectDirectories === undefined
          ? {}
          : { directoryPath: paths.get(row.projectId) ?? null }),
      })),
    },
  });
};

/** P12 `10` §9: authenticated, path-free host Profile catalog. Like the
 * local project directory this cross-project bootstrap surface is restricted
 * to the configured local principal until a multi-principal visibility
 * contract exists. */
const readLocalProjectResourceProfiles = async (
  request: IncomingMessage,
  response: ServerResponse,
  config: WebTransportConfig,
): Promise<void> => {
  // The no-auth LOCAL_PRINCIPAL fallback is only the local desktop identity.
  // Do not let a wildcard/non-loopback bind turn it into remote access to host
  // resource metadata. Other routes retain their existing auth behavior.
  if (!config.authenticatorConfigured && !isLoopbackListenerHost(config.host)) {
    sendJson(response, 503, {
      ok: false,
      problem: { code: "project-resource-profiles/local-listener-required" },
    });
    return;
  }
  const token = bearerToken(request.headers.authorization);
  const principal = !config.authenticatorConfigured
    ? (LOCAL_PRINCIPAL as unknown as Principal)
    : config.authenticator === undefined
      ? null
      : await Effect.runPromise(
          config.authenticator.authenticate(token === null ? null : { token }),
        ).catch(() => null);
  if (principal === null) {
    sendJson(response, 401, {
      ok: false,
      problem: { code: "auth/unauthenticated" },
    });
    return;
  }
  if (String(principal) !== LOCAL_PRINCIPAL) {
    sendJson(response, 503, {
      ok: false,
      problem: {
        code: "project-resource-profiles/visibility-resolver-required",
      },
    });
    return;
  }
  const profiles =
    config.projectResourceProfiles === undefined
      ? []
      : await Effect.runPromise(config.projectResourceProfiles.list());
  sendJson(response, 200, {
    ok: true,
    status: 200,
    body: {
      profiles,
      conversationOnlySupported: true,
      ...(config.projectDirectories === undefined
        ? {}
        : { directorySelectionSupported: true }),
    },
  });
};

const handleProjectDirectories = async (
  request: IncomingMessage,
  response: ServerResponse,
  config: WebTransportConfig,
): Promise<void> => {
  const principal = await authenticateLocalSensitiveRead(
    request,
    response,
    config,
    { status: 403, code: "project-directories/forbidden" },
  );
  if (principal === null) return;
  const directories = config.projectDirectories;
  if (directories === undefined) {
    sendJson(response, 404, {
      ok: false,
      problem: { code: "project-directories/unavailable" },
    });
    return;
  }
  try {
    if (request.method === "GET") {
      const query = new URL(request.url ?? "/", "http://localhost")
        .searchParams;
      const listing = await directories.browse(query.get("path") ?? undefined);
      sendJson(response, 200, { ok: true, body: listing });
      return;
    }
    if (
      request.method !== "POST" ||
      bearerToken(request.headers.authorization) === null ||
      !request.headers["content-type"]?.startsWith("application/json") ||
      (request.headers.origin !== undefined &&
        new URL(request.headers.origin).host !== request.headers.host)
    ) {
      sendJson(response, 403, {
        ok: false,
        problem: { code: "project-directories/invalid-request" },
      });
      return;
    }
    const body = await readBody(request);
    if (
      typeof body !== "object" ||
      body === null ||
      !("path" in body) ||
      typeof body.path !== "string" ||
      !("create" in body) ||
      typeof body.create !== "boolean" ||
      Object.keys(body).some((key) => key !== "path" && key !== "create")
    ) {
      sendJson(response, 400, {
        ok: false,
        problem: { code: "project-directories/invalid-path" },
      });
      return;
    }
    const prepared = await directories.prepare(body.path, body.create);
    const existing = await Effect.runPromise(
      config.sql.unsafe<{
        project_id: string;
        root_workspace_id: string;
        name: string;
        lifecycle: string;
      }>(
        `SELECT p.project_id, p.root_workspace_id, p.name, p.lifecycle
           FROM projects p JOIN workspaces w ON w.workspace_id = p.root_workspace_id
          WHERE EXISTS (SELECT 1 FROM json_each(w.resource_boundary, '$.addresses') a
            WHERE json_extract(a.value, '$._tag') = 'FileTree'
              AND json_extract(a.value, '$.path') = ?)
          ORDER BY p.created_at, p.project_id LIMIT 1`,
        [prepared.path],
      ),
    );
    const project = existing[0];
    sendJson(response, 200, {
      ok: true,
      body: {
        ...prepared,
        existingProject:
          project === undefined
            ? null
            : {
                projectId: project.project_id,
                rootWorkspaceId: project.root_workspace_id,
                name: project.name,
                lifecycle: project.lifecycle,
              },
      },
    });
  } catch (error) {
    const code =
      error instanceof ProjectDirectoryError ? error.code : "unavailable";
    sendJson(response, 400, {
      ok: false,
      problem: { code: `project-directories/${code}` },
    });
  }
};

export const startWebTransport = async (
  config: WebTransportConfig,
): Promise<WebTransportHandle> => {
  if (!config.authenticatorConfigured && !isLoopbackListenerHost(config.host)) {
    throw new Error(
      "web transport: a non-loopback listener requires an explicitly configured authenticator",
    );
  }

  const fanout = makeInvalidationFanout();
  const lastWatermark = { value: 0 };

  const server = createServer((request, response) => {
    void (async () => {
      if (!acceptsBrowserBoundary(request, config)) {
        sendJson(response, 403, {
          ok: false,
          problem: { code: "transport/untrusted-origin" },
        });
        return;
      }
      const url = request.url ?? "/";
      const path = url.split("?")[0] ?? url;
      const method = (request.method ?? "GET").toUpperCase();

      if (path === "/runtime" && method === "GET") {
        if (config.runtimeInfo === undefined) {
          response.writeHead(404).end();
        } else {
          sendJson(response, 200, config.runtimeInfo);
        }
        return;
      }

      if (path === "/model-setup") {
        const setup = config.modelSetup;
        if (setup === undefined) {
          response.writeHead(404).end();
          return;
        }
        if (method === "GET") {
          sendJson(response, 200, setup.status());
          return;
        }
        if (
          method !== "POST" ||
          config.authenticatorConfigured ||
          !isLoopbackListenerHost(config.host) ||
          !request.headers["content-type"]?.startsWith("application/json")
        ) {
          sendJson(response, 403, {
            ok: false,
            code: "model-setup/local-configuration-required",
          });
          return;
        }
        try {
          await setup.save(await readBody(request, 65536));
          response.once("finish", setup.requestRestart);
          sendJson(response, 200, { ok: true, restarting: true });
        } catch (error) {
          sendJson(response, 400, {
            ok: false,
            code: `model-setup/${error instanceof ModelSetupError ? error.code : "configuration-failed"}`,
          });
        }
        return;
      }

      if (config.modelSetup?.configured === false && isApiPath(path)) {
        sendJson(response, 503, {
          ok: false,
          problem: { code: "model/configuration-required" },
        });
        return;
      }

      const progressMatch = /^\/conversation-progress\/([^/]+)$/.exec(path);
      if (progressMatch !== null && method === "GET") {
        await streamConversationProgress(
          request,
          response,
          decodeURIComponent(progressMatch[1] ?? ""),
          config,
        );
        return;
      }

      if (path === "/projects" && method === "GET") {
        await readLocalProjectDirectory(request, response, config);
        return;
      }

      if (path === "/project-resources" && method === "GET") {
        await readLocalProjectResourceProfiles(request, response, config);
        return;
      }
      if (path === "/project-directories") {
        await handleProjectDirectories(request, response, config);
        return;
      }

      if (path.startsWith("/views/")) {
        if (method !== "POST") {
          sendJson(response, 400, {
            ok: false,
            problem: { code: "transport/invalid-request" },
          });
          return;
        }
        if (
          !config.authenticatorConfigured &&
          !isLoopbackListenerHost(config.host)
        ) {
          sendJson(response, 503, {
            ok: false,
            problem: { code: "auth/local-listener-required" },
          });
          return;
        }
        const authorizationFailure = await Effect.runPromise(
          config.http.authorizeSensitiveRead(request.headers.authorization),
        );
        if (authorizationFailure !== null) {
          sendJson(response, authorizationFailure.status, authorizationFailure);
          return;
        }
        const body = await readBody(request);
        const result = await Effect.runPromise(
          config.http.handleAuthorizedView({
            method,
            path,
            ...(request.headers.authorization === undefined
              ? {}
              : { authorization: request.headers.authorization }),
            body,
          }),
        );
        sendBytes(
          response,
          result.status,
          "application/json; charset=utf-8",
          "no-store",
          Buffer.from(JSON.stringify(result)),
          false,
        );
        return;
      }

      if (config.staticRoot !== undefined && isStaticCandidate(method, path)) {
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
    if (!acceptsBrowserBoundary(request, config)) {
      socket.end(
        "HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n",
      );
      return;
    }
    const path = (request.url ?? "").split("?")[0];
    if (path !== "/ws") {
      socket.destroy();
      return;
    }
    if (
      config.modelSetup?.configured === false ||
      (!config.authenticatorConfigured &&
        !isLoopbackListenerHost(config.host)) ||
      (config.authenticatorConfigured && config.authenticator === undefined)
    ) {
      socket.write(
        "HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\nContent-Length: 0\r\n\r\n",
      );
      socket.destroy();
      return;
    }
    wss.handleUpgrade(request, socket, head, (ws) => {
      let viewAuthenticated = !config.authenticatorConfigured;
      let connectionClosed = false;
      let firstViewAuthenticationInFlight = false;
      if (viewAuthenticated) sockets.add(ws);
      ws.on("close", () => {
        connectionClosed = true;
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
            if (!viewAuthenticated) {
              ws.close(1008, "view authentication required");
            }
            return;
          }
          let response: TransportResponse<unknown>;
          if (frame.kind === "view") {
            if (!viewAuthenticated) {
              if (firstViewAuthenticationInFlight) return;
              firstViewAuthenticationInFlight = true;
              const authorizationFailure = await Effect.runPromise(
                config.webSocket.authorizeViewFrame(frame),
              );
              firstViewAuthenticationInFlight = false;
              if (connectionClosed || ws.readyState !== ws.OPEN) return;
              if (authorizationFailure !== null) {
                ws.close(1008, "view authentication required");
                return;
              }
              viewAuthenticated = true;
              sockets.add(ws);
            }
            response = await Effect.runPromise(
              config.webSocket.handleAuthorizedViewFrame(frame),
            );
          } else {
            response = await Effect.runPromise(
              config.webSocket.handleFrame(frame),
            );
          }
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
    webSocketSubscriberCount: () => sockets.size,
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
