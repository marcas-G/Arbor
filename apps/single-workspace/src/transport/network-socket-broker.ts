import { chmod, mkdtemp, rm } from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Duplex } from "node:stream";
import { createServer as createTlsServer } from "node:tls";
import { decodeNetworkPolicyV1, type NetworkPolicyV1 } from "@arbor/domain";
import {
  type BrokerDependencies,
  BrokerFailure,
  downloadThroughBroker,
} from "./network-broker.js";
import { authorizeEgressUrl } from "./network-egress.js";
import type { NetworkTlsAuthority } from "./network-tls-authority.js";

/** TLS over an exclusively mounted Unix socket. It needs no shared network
 * namespace, loopback listener, inherited proxy variables or host CA install.
 * This candidate supports GET downloads (curl --unix-socket); npm/git proxy
 * compatibility and production qualification remain separate work. */
export const openNetworkSocketBroker = async (input: {
  readonly policy: NetworkPolicyV1;
  readonly authority: NetworkTlsAuthority;
  readonly dependencies: BrokerDependencies;
  readonly maxBytes: number;
  readonly timeoutMs: number;
}): Promise<{
  readonly socketPath: string;
  readonly close: () => Promise<void>;
}> => {
  const decoded = decodeNetworkPolicyV1(input.policy);
  if (decoded === undefined || decoded.mode === "Disabled")
    throw new BrokerFailure("sandbox/network-denied");
  const policy = { ...decoded, destinations: [...decoded.destinations] };
  const directory = await mkdtemp(join(tmpdir(), "arbor-network-socket-"));
  await chmod(directory, 0o700);
  const socketPath = join(directory, "egress.sock");
  const sockets = new Set<Duplex>();
  const requests = new Set<AbortController>();
  const http = createHttpServer(
    { maxHeaderSize: 16 * 1024 },
    (request, response) => {
      const controller = new AbortController();
      requests.add(controller);
      request.once("aborted", () => controller.abort());
      response.once("close", () => {
        if (!response.writableEnded) controller.abort();
      });
      const servername = (request.socket as { servername?: string }).servername;
      const host = request.headers.host;
      const hostCount = request.rawHeaders.filter(
        (_, index) =>
          index % 2 === 0 &&
          request.rawHeaders[index]?.toLowerCase() === "host",
      ).length;
      const path = request.url ?? "";
      const deny = (status: number, code: string) => {
        response.writeHead(status, {
          Connection: "close",
          "Content-Type": "text/plain",
        });
        response.end(code);
      };
      void (async () => {
        try {
          if (
            servername === undefined ||
            hostCount !== 1 ||
            (host !== servername && host !== `${servername}:443`) ||
            !path.startsWith("/") ||
            request.method !== "GET" ||
            request.headers.upgrade !== undefined ||
            request.headers["transfer-encoding"] !== undefined ||
            (request.headers["content-length"] !== undefined &&
              request.headers["content-length"] !== "0")
          ) {
            deny(403, "sandbox/network-denied");
            return;
          }
          const url = `https://${servername}${path}`;
          if (authorizeEgressUrl(policy, url) === null) {
            deny(403, "sandbox/network-denied");
            return;
          }
          const result = await downloadThroughBroker(
            {
              policy,
              url,
              maxBytes: input.maxBytes,
              timeoutMs: input.timeoutMs,
              signal: controller.signal,
            },
            input.dependencies,
          );
          if (response.destroyed) return;
          response.writeHead(200, {
            Connection: "close",
            "Content-Type": "application/octet-stream",
            "Content-Length": result.bytes.byteLength,
          });
          response.end(result.bytes);
        } catch (error) {
          if (!response.destroyed)
            deny(
              502,
              error instanceof BrokerFailure
                ? error.code
                : "sandbox/network-unavailable",
            );
        } finally {
          requests.delete(controller);
        }
      })();
    },
  );
  http.maxRequestsPerSocket = 1;
  http.headersTimeout = 10_000;
  http.requestTimeout = 10_000;
  http.on("upgrade", (_request, socket) => socket.destroy());
  http.on("connect", (_request, socket) => socket.destroy());
  http.on("clientError", (_error, socket) => socket.destroy());
  const tls = createTlsServer(
    {
      minVersion: "TLSv1.2",
      handshakeTimeout: 10_000,
      SNICallback(hostname, callback) {
        if (authorizeEgressUrl(policy, `https://${hostname}/`) === null) {
          callback(new Error("sandbox/network-denied"));
          return;
        }
        input.authority.contextFor(hostname).then(
          (context) => callback(null, context),
          () => callback(new Error("sandbox/tls-authority-unavailable")),
        );
      },
    },
    (socket) => {
      const hostname = (socket as { servername?: string }).servername;
      if (
        hostname === undefined ||
        authorizeEgressUrl(policy, `https://${hostname}/`) === null
      ) {
        socket.destroy();
        return;
      }
      http.emit("connection", socket);
    },
  );
  tls.maxConnections = 8;
  tls.on("connection", (socket) => {
    sockets.add(socket);
    socket.setTimeout(30_000, () => socket.destroy());
    socket.once("close", () => sockets.delete(socket));
    socket.on("error", () => socket.destroy());
  });
  tls.on("tlsClientError", (_error, socket) => socket.destroy());
  try {
    await new Promise<void>((resolve, reject) => {
      tls.once("error", reject);
      tls.listen(socketPath, resolve);
    });
    await chmod(socketPath, 0o600);
  } catch (error) {
    for (const socket of sockets) socket.destroy();
    tls.close();
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
  return {
    socketPath,
    async close() {
      for (const controller of requests) controller.abort();
      for (const socket of sockets) socket.destroy();
      http.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        tls.close((error) => {
          if (error === undefined) resolve();
          else reject(error);
        }),
      );
      await rm(directory, { recursive: true, force: true });
    },
  };
};
