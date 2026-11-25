import { Resolver } from "node:dns/promises";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { createConnection, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Duplex, pipeline } from "node:stream";
import type { NetworkPolicyV1 } from "@arbor/domain";
import type { SandboxNetworkBrokerBindingV2 } from "@arbor/sandbox-native-posix";
import {
  authorizeEgressConnectV2,
  type EgressAddress,
  validateEgressAnswersV2,
} from "./network-egress.js";
import type { NetworkProxyBrokerDependencies } from "./network-proxy-broker.js";
import { NETWORK_PROXY_HELPER_PATH } from "./network-proxy-helper.js";

const PROXY_PORT = 3128;
const CONNECT_TIMEOUT_MS = 10_000;
const IDLE_TIMEOUT_MS = 30_000;
const MAX_PENDING_BYTES = 64 * 1024;
const CONNECT_PATTERN =
  /^([a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*):443$/u;

export interface NetworkProxyBrokerV2Dependencies
  extends Pick<NetworkProxyBrokerDependencies, "resolveAll"> {
  /** T2 transport fixture only. Production always dials the validated numeric
   * IPv4 address with Node's standard socket implementation. */
  readonly connect?: (options: {
    readonly host: string;
    readonly port: 443;
    readonly family: 4;
  }) => Socket;
}

/** Standard resolver shared with the independent qualification DNS fixture.
 * Production omits servers and uses the host's DNS configuration. */
export const resolveNetworkProxyHostV2 = async (
  hostname: string,
  signal: AbortSignal,
  servers?: ReadonlyArray<string>,
): Promise<ReadonlyArray<string>> => {
  signal.throwIfAborted();
  const resolver = new Resolver();
  if (servers !== undefined) resolver.setServers([...servers]);
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
      } else {
        const code = (result.reason as NodeJS.ErrnoException | undefined)?.code;
        if (code !== "ENODATA" && code !== "ENOTFOUND")
          throw new Error("sandbox/dns-unavailable");
      }
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
  dependencies: NetworkProxyBrokerV2Dependencies,
): Promise<EgressAddress> => {
  if (!authorizeEgressConnectV2(policy, hostname))
    throw new Error("sandbox/network-denied");
  const answers = await (dependencies.resolveAll ?? resolveNetworkProxyHostV2)(
    hostname,
    signal,
  );
  const candidates = validateEgressAnswersV2(answers);
  const pinned = candidates?.[0];
  if (pinned === undefined || pinned.family !== 4)
    throw new Error("sandbox/network-denied");
  return pinned;
};

const closeSocket = (socket: Duplex): void => {
  if (!socket.destroyed) socket.destroy();
};

/**
 * V2 is a real HTTP CONNECT relay. The broker never terminates TLS: the
 * client inside bubblewrap performs the normal certificate and hostname
 * verification against the origin. The helper exposes this Unix-socket
 * server as loopback TCP inside the workspace network namespace.
 */
export const openNetworkProxyBrokerV2 = async (
  inputPolicy: NetworkPolicyV1,
  dependencies: NetworkProxyBrokerV2Dependencies = {},
): Promise<SandboxNetworkBrokerBindingV2> => {
  if (inputPolicy.mode === "Disabled")
    throw new Error("sandbox/network-denied");
  const directory = await mkdtemp(join(tmpdir(), "arbor-network-broker-v2-"));
  try {
    await chmod(directory, 0o700);
    // Only the per-invocation socket is private writable state. The helper is
    // the exact installed file checked by the qualification artifact catalog.
    return await openNetworkProxyBrokerV2Server({
      inputPolicy,
      dependencies,
      directory,
      socketPath: join(directory, "egress.sock"),
      helperPath: NETWORK_PROXY_HELPER_PATH,
    });
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
};

const openNetworkProxyBrokerV2Server = async (input: {
  readonly inputPolicy: NetworkPolicyV1;
  readonly dependencies: NetworkProxyBrokerV2Dependencies;
  readonly directory: string;
  readonly socketPath: string;
  readonly helperPath: string;
}): Promise<SandboxNetworkBrokerBindingV2> => {
  const { inputPolicy, dependencies, directory, socketPath, helperPath } =
    input;

  const sockets = new Set<Duplex>();
  const operations = new Set<AbortController>();
  let closing = false;
  let closePromise: Promise<void> | undefined;
  const track = (socket: Duplex) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    socket.on("error", () => closeSocket(socket));
  };
  const server = createServer();
  server.maxConnections = 32;
  server.on("connection", (socket) => {
    track(socket);
    socket.setTimeout(IDLE_TIMEOUT_MS, () => closeSocket(socket));
  });
  server.on("request", (_request, response) => {
    response.writeHead(405, {
      Connection: "close",
      "Content-Type": "text/plain",
    });
    response.end("sandbox/connect-required");
  });
  server.on("connect", (request, socket, head) => {
    socket.pause();
    const hostname = CONNECT_PATTERN.exec(request.url ?? "")?.[1];
    const controller = new AbortController();
    let upstream: Socket | undefined;
    let established = false;
    let failed = false;
    const earlyChunks: Buffer[] = head.byteLength === 0 ? [] : [head];
    let earlyBytes = head.byteLength;
    const bufferEarly = (chunk: Buffer) => {
      earlyBytes += chunk.byteLength;
      if (earlyBytes > MAX_PENDING_BYTES) {
        fail(502, "sandbox/proxy-buffer-limit");
      } else {
        earlyChunks.push(chunk);
      }
    };
    operations.add(controller);
    const finish = () => {
      clearTimeout(connectTimer);
      operations.delete(controller);
      socket.removeListener("close", abort);
      socket.removeListener("end", abort);
      socket.removeListener("data", bufferEarly);
    };
    const abort = () => {
      controller.abort();
      if (upstream !== undefined) closeSocket(upstream);
      closeSocket(socket);
      finish();
    };
    socket.once("close", abort);
    socket.once("end", abort);
    const fail = (status: 403 | 502 | 504, message: string) => {
      if (failed || established) return;
      failed = true;
      controller.abort();
      if (upstream !== undefined) closeSocket(upstream);
      finish();
      if (!socket.destroyed) {
        const reason =
          status === 403
            ? "Forbidden"
            : status === 502
              ? "Bad Gateway"
              : "Gateway Timeout";
        socket.end(
          `HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Type: text/plain\r\nContent-Length: ${Buffer.byteLength(message)}\r\n\r\n${message}`,
          () => closeSocket(socket),
        );
      }
    };
    // One setup deadline includes DNS as well as dialing. A failed upstream
    // must complete the HTTP response; destroying it alone leaves CONNECT
    // clients waiting on a paused downstream indefinitely.
    const connectTimer = setTimeout(
      () => fail(504, "sandbox/upstream-connect-timeout"),
      CONNECT_TIMEOUT_MS,
    );
    if (
      closing ||
      hostname === undefined ||
      request.headers.host !== request.url ||
      !authorizeEgressConnectV2(inputPolicy, hostname)
    ) {
      fail(403, "sandbox/network-denied");
      return;
    }
    if (earlyBytes > MAX_PENDING_BYTES) {
      fail(502, "sandbox/proxy-buffer-limit");
      return;
    }
    // Read FIN while setup is pending without losing early TLS bytes or
    // accumulating an unbounded buffer behind a stalled DNS/connect attempt.
    socket.on("data", bufferEarly);
    socket.resume();
    void resolveTarget(inputPolicy, hostname, controller.signal, dependencies)
      .then((pinned) => {
        if (
          closing ||
          failed ||
          controller.signal.aborted ||
          socket.destroyed
        ) {
          finish();
          return;
        }
        const target = (dependencies.connect ?? createConnection)({
          host: pinned.address,
          port: 443,
          family: 4,
        });
        upstream = target;
        track(target);
        target.once("close", () => {
          if (established) abort();
          else fail(502, "sandbox/upstream-connect-failed");
        });
        target.once("connect", () => {
          clearTimeout(connectTimer);
          if (
            closing ||
            failed ||
            controller.signal.aborted ||
            socket.destroyed
          ) {
            closeSocket(target);
            return;
          }
          established = true;
          socket.pause();
          socket.removeListener("data", bufferEarly);
          target.setTimeout(IDLE_TIMEOUT_MS, abort);
          socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
          for (const chunk of earlyChunks) target.write(chunk);
          earlyChunks.length = 0;
          pipeline(socket, target, abort);
          pipeline(target, socket, abort);
        });
        target.once("error", () => {
          if (established) abort();
          else fail(502, "sandbox/upstream-connect-failed");
        });
      })
      .catch((error: unknown) =>
        fail(
          error instanceof Error && error.message === "sandbox/network-denied"
            ? 403
            : 502,
          error instanceof Error && error.message === "sandbox/network-denied"
            ? "sandbox/network-denied"
            : "sandbox/dns-unavailable",
        ),
      );
  });
  server.on("clientError", (_error, socket) => closeSocket(socket));
  server.on("error", () => {
    for (const socket of sockets) closeSocket(socket);
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, resolve);
    });
    await chmod(socketPath, 0o600);
  } catch (error) {
    server.close();
    for (const socket of sockets) closeSocket(socket);
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
  return {
    protocol: "V2",
    socketDirectory: directory,
    socketPath,
    helperPath,
    proxyPort: PROXY_PORT,
    close() {
      closing = true;
      closePromise ??= (async () => {
        for (const controller of operations) controller.abort();
        for (const socket of sockets) closeSocket(socket);
        await new Promise<void>((resolve) => server.close(() => resolve()));
        await rm(directory, { recursive: true, force: true });
      })();
      return closePromise;
    },
  };
};
