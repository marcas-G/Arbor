import { Resolver } from "node:dns/promises";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import {
  type ClientRequest,
  createServer as createHttpServer,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type OutgoingHttpHeaders,
  type ServerResponse,
} from "node:http";
import { request as httpsRequest, type RequestOptions } from "node:https";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { type Duplex, pipeline, Transform } from "node:stream";
import { checkServerIdentity, createServer as createTlsServer } from "node:tls";
import { decodeNetworkPolicyV1, type NetworkPolicyV1 } from "@arbor/domain";
import type { SandboxNetworkBrokerBindingV1 } from "@arbor/sandbox-native-posix";
import {
  authorizeEgressUrl,
  type EgressAddress,
  validateEgressAnswers,
} from "./network-egress.js";
import { readNetworkProxyHelperSource } from "./network-proxy-helper.js";
import { createNetworkTlsAuthority } from "./network-tls-authority.js";
import { discoverRfc7050Prefixes } from "./pref64-discovery.js";

const PROXY_PORT = 3128;
const MAX_UPLOAD_BYTES = 16 * 1024 * 1024;
const METHODS = new Set([
  "GET",
  "HEAD",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "OPTIONS",
]);

export interface NetworkProxyBrokerDependencies {
  readonly discoverPref64?: (
    signal: AbortSignal,
  ) => Promise<ReadonlyArray<
    import("./network-egress.js").Pref64Prefix
  > | null>;
  readonly resolveAll?: (
    hostname: string,
    signal: AbortSignal,
  ) => Promise<ReadonlyArray<string>>;
  /** T2 transport injection; production always uses Node's verified TLS client. */
  readonly request?: (
    options: RequestOptions,
    response: (message: IncomingMessage) => void,
  ) => ClientRequest;
}

const resolveAll = async (
  hostname: string,
  signal: AbortSignal,
): Promise<ReadonlyArray<string>> => {
  signal.throwIfAborted();
  const resolver = new Resolver();
  const cancel = () => resolver.cancel();
  signal.addEventListener("abort", cancel, { once: true });
  try {
    const results = await Promise.allSettled([
      resolver.resolve4(hostname),
      resolver.resolve6(hostname),
    ]);
    signal.throwIfAborted();
    const addresses: string[] = [];
    for (const result of results) {
      if (result.status === "fulfilled") {
        addresses.push(...result.value);
        continue;
      }
      const code = (result.reason as NodeJS.ErrnoException | undefined)?.code;
      if (code !== "ENODATA" && code !== "ENOTFOUND")
        throw new Error("sandbox/dns-unavailable");
    }
    return addresses;
  } finally {
    signal.removeEventListener("abort", cancel);
  }
};

const resolveTarget = async (
  policy: NetworkPolicyV1,
  hostname: string,
  signal: AbortSignal,
  dependencies: NetworkProxyBrokerDependencies,
): Promise<EgressAddress> => {
  if (
    authorizeEgressUrl(policy, `https://${hostname}/`) === null ||
    !/^[a-z0-9.-]+$/u.test(hostname)
  )
    throw new Error("sandbox/network-denied");
  const prefixes = await (
    dependencies.discoverPref64 ?? discoverRfc7050Prefixes
  )(signal);
  if (prefixes === null) throw new Error("sandbox/pref64-unknown");
  const answers = await (dependencies.resolveAll ?? resolveAll)(
    hostname,
    signal,
  );
  const validated = validateEgressAnswers(answers, prefixes);
  if (validated === null || validated[0] === undefined)
    throw new Error("sandbox/network-denied");
  const connectionPrefixes = await (
    dependencies.discoverPref64 ?? discoverRfc7050Prefixes
  )(signal);
  const pinned = validateEgressAnswers(answers, connectionPrefixes)?.[0];
  if (pinned === undefined) throw new Error("sandbox/network-denied");
  return pinned;
};

const forwardedHeaders = (
  headers: IncomingHttpHeaders,
): OutgoingHttpHeaders => {
  const hopHeaders = new Set([
    "connection",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "proxy-connection",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
    ...(headers.connection ?? "")
      .split(",")
      .map((value) => value.trim().toLowerCase()),
  ]);
  return Object.fromEntries(
    Object.entries(headers).filter(([key]) => !hopHeaders.has(key)),
  );
};

const sendError = (
  response: ServerResponse,
  status: number,
  code: string,
): void => {
  if (response.destroyed) return;
  if (response.headersSent) {
    response.destroy();
    return;
  }
  response.writeHead(status, {
    Connection: "close",
    "Content-Type": "text/plain",
  });
  response.end(code);
};

/** Standard HTTP CONNECT over a per-execution Unix socket. The sandbox-side
 * listener is just a byte relay. Node owns HTTP framing, streaming and TLS;
 * Arbor binds policy, DNS pins and the CONNECT/SNI/Host identity. This remains
 * an unqualified candidate for the existing frozen contract. */
export const openNetworkProxyBroker = async (
  inputPolicy: NetworkPolicyV1,
  dependencies: NetworkProxyBrokerDependencies = {},
): Promise<SandboxNetworkBrokerBindingV1> => {
  const decoded = decodeNetworkPolicyV1(inputPolicy);
  if (decoded === undefined || decoded.mode === "Disabled")
    throw new Error("sandbox/network-denied");
  const policy = { ...decoded, destinations: [...decoded.destinations] };
  const authority = await createNetworkTlsAuthority();
  let directory: string | undefined;
  const helperPath = join(
    dirname(authority.certificatePath),
    "network-proxy-helper.mjs",
  );
  try {
    await writeFile(helperPath, readNetworkProxyHelperSource(), {
      mode: 0o500,
      flag: "wx",
    });
    directory = await mkdtemp(join(tmpdir(), "arbor-network-broker-"));
    await chmod(directory, 0o700);
  } catch (error) {
    if (directory !== undefined)
      await rm(directory, { recursive: true, force: true });
    await authority.close();
    throw error;
  }
  const socketPath = join(directory, "egress.sock");
  const sockets = new Set<Duplex>();
  const operations = new Set<AbortController>();
  const targets = new WeakMap<Duplex, string>();
  let closing = false;
  let closePromise: Promise<void> | undefined;
  const track = (socket: Duplex) => {
    sockets.add(socket);
    socket.on("error", () => socket.destroy());
    socket.once("close", () => sockets.delete(socket));
  };
  const proxy = async (request: IncomingMessage, response: ServerResponse) => {
    const controller = new AbortController();
    operations.add(controller);
    request.once("aborted", () => controller.abort());
    response.once("close", () => {
      if (!response.writableFinished) controller.abort();
    });
    const hostname = targets.get(request.socket);
    const path = request.url ?? "";
    const hosts = request.rawHeaders.filter(
      (key, index) => index % 2 === 0 && key.toLowerCase() === "host",
    );
    try {
      if (
        closing ||
        hostname === undefined ||
        hosts.length !== 1 ||
        (request.headers.host !== hostname &&
          request.headers.host !== `${hostname}:443`) ||
        !path.startsWith("/") ||
        path.startsWith("//") ||
        !METHODS.has(request.method ?? "") ||
        request.headers.upgrade !== undefined ||
        authorizeEgressUrl(policy, `https://${hostname}${path}`) === null
      ) {
        sendError(response, 403, "sandbox/request-denied");
        return;
      }
      if (Number(request.headers["content-length"] ?? 0) > MAX_UPLOAD_BYTES) {
        sendError(response, 413, "sandbox/upload-limit");
        return;
      }
      const pinned = await resolveTarget(
        policy,
        hostname,
        controller.signal,
        dependencies,
      );
      if (closing || request.destroyed || response.destroyed) return;
      await new Promise<void>((resolve, reject) => {
        const headers = forwardedHeaders(request.headers);
        headers.host = hostname;
        headers.connection = "close";
        const upstream = (dependencies.request ?? httpsRequest)(
          {
            hostname: pinned.address,
            family: pinned.family,
            port: 443,
            servername: hostname,
            path,
            method: request.method,
            headers,
            agent: false,
            rejectUnauthorized: true,
            checkServerIdentity: (_hostname, certificate) =>
              checkServerIdentity(hostname, certificate),
            signal: controller.signal,
          },
          (reply) => {
            if (reply.statusCode === undefined) {
              reply.destroy();
              reject(new Error("sandbox/upstream-status-missing"));
              return;
            }
            const responseHeaders = forwardedHeaders(reply.headers);
            responseHeaders.connection = "close";
            // Node decodes upstream chunking and supplies correct downstream
            // framing. Never copy Transfer-Encoding from the upstream stream.
            response.writeHead(reply.statusCode, responseHeaders);
            pipeline(reply, response, (error) =>
              error ? reject(error) : resolve(),
            );
          },
        );
        // ClientRequest.setTimeout does not bound TCP/TLS establishment.
        // Give connection setup its own deadline; active streaming keeps the
        // independent inactivity timer below.
        const connectionDeadline = setTimeout(
          () => upstream.destroy(new Error("sandbox/upstream-connect-timeout")),
          10_000,
        );
        upstream.once("socket", (socket) => {
          socket.once("secureConnect", () => clearTimeout(connectionDeadline));
        });
        upstream.once("close", () => clearTimeout(connectionDeadline));
        upstream.setTimeout(30_000, () =>
          upstream.destroy(new Error("sandbox/upstream-timeout")),
        );
        upstream.once("error", reject);
        upstream.once("upgrade", (_reply, socket) => {
          socket.destroy();
          reject(new Error("sandbox/upgrade-denied"));
        });
        let uploaded = 0;
        const limiter = new Transform({
          transform(chunk: Buffer, _encoding, callback) {
            uploaded += chunk.byteLength;
            callback(
              uploaded > MAX_UPLOAD_BYTES
                ? new Error("sandbox/upload-limit")
                : null,
              chunk,
            );
          },
        });
        pipeline(request, limiter, upstream, (error) => {
          if (error) reject(error);
        });
      });
    } catch (error) {
      const timeout =
        error instanceof Error &&
        [
          "sandbox/upstream-connect-timeout",
          "sandbox/upstream-timeout",
        ].includes(error.message);
      sendError(
        response,
        timeout ? 504 : 502,
        timeout ? error.message : "sandbox/network-unavailable",
      );
    } finally {
      controller.abort();
      operations.delete(controller);
    }
  };
  const http = createHttpServer(
    { maxHeaderSize: 16 * 1024 },
    (request, response) => {
      void proxy(request, response);
    },
  );
  http.maxRequestsPerSocket = 1;
  http.headersTimeout = 10_000;
  http.requestTimeout = 30_000;
  http.setTimeout(35_000, (socket) => socket.destroy());
  http.on("upgrade", (_request, socket) => socket.destroy());
  http.on("connect", (_request, socket) => socket.destroy());
  http.on("clientError", (_error, socket) => socket.destroy());
  const server = createHttpServer(
    { maxHeaderSize: 4096 },
    (_request, response) => {
      sendError(response, 403, "sandbox/connect-required");
    },
  );
  server.headersTimeout = 10_000;
  server.requestTimeout = 10_000;
  server.maxConnections = 32;
  server.setTimeout(35_000, (socket) => socket.destroy());
  server.on("connection", track);
  server.on("clientError", (_error, socket) => socket.destroy());
  server.on("upgrade", (_request, socket) => socket.destroy());
  server.on("connect", (request, socket, head) => {
    socket.pause();
    const hostname = /^([a-z0-9.-]+):443$/u.exec(request.url ?? "")?.[1];
    const deny = () => {
      if (!socket.destroyed)
        socket.end(
          "HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n",
        );
    };
    if (
      closing ||
      hostname === undefined ||
      authorizeEgressUrl(policy, `https://${hostname}/`) === null
    ) {
      deny();
      return;
    }
    const controller = new AbortController();
    operations.add(controller);
    const abort = () => controller.abort();
    socket.once("close", abort);
    void resolveTarget(policy, hostname, controller.signal, dependencies)
      .then(() => {
        if (closing || socket.destroyed) return;
        const tls = createTlsServer(
          {
            minVersion: "TLSv1.2",
            handshakeTimeout: 10_000,
            ALPNProtocols: ["http/1.1"],
            SNICallback(servername, callback) {
              if (closing || servername !== hostname) {
                callback(new Error("sandbox/sni-binding-denied"));
                return;
              }
              authority.contextFor(hostname).then(
                (context) => callback(null, context),
                () => callback(new Error("sandbox/tls-authority-unavailable")),
              );
            },
          },
          (secured) => {
            if (
              closing ||
              (secured as { servername?: string }).servername !== hostname
            ) {
              secured.destroy();
              return;
            }
            track(secured);
            targets.set(secured, hostname);
            http.emit("connection", secured);
          },
        );
        tls.on("tlsClientError", (_error, failed) => failed.destroy());
        socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (head.byteLength > 0) socket.unshift(head);
        tls.emit("connection", socket);
        socket.resume();
      })
      .catch(deny)
      .finally(() => {
        operations.delete(controller);
        socket.removeListener("close", abort);
      });
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, resolve);
    });
    await chmod(socketPath, 0o600);
  } catch (error) {
    server.close();
    for (const socket of sockets) socket.destroy();
    await Promise.allSettled([
      rm(directory, { recursive: true, force: true }),
      authority.close(),
    ]);
    throw error;
  }
  return {
    protocol: "V1",
    socketDirectory: directory,
    socketPath,
    certificatePath: authority.certificatePath,
    helperPath,
    proxyPort: PROXY_PORT,
    close() {
      closing = true;
      closePromise ??= (async () => {
        for (const controller of operations) controller.abort();
        for (const socket of sockets) socket.destroy();
        http.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
        const cleanup = await Promise.allSettled([
          rm(directory, { recursive: true, force: true }),
          authority.close(),
        ]);
        const failures = cleanup
          .filter((result) => result.status === "rejected")
          .map((result) => result.reason);
        if (failures.length > 0)
          throw new AggregateError(failures, "network broker cleanup failed");
      })();
      return closePromise;
    },
  };
};
