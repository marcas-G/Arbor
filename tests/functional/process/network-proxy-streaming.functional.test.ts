import { readFile } from "node:fs/promises";
import { Agent, request as httpRequest } from "node:http";
import {
  request as httpsRequest,
  createServer as httpsServer,
} from "node:https";
import { createConnection, createServer as netServer, Socket } from "node:net";
import { type TLSSocket, connect as tlsConnect } from "node:tls";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  type NetworkProxyBrokerDependencies,
  openNetworkProxyBroker,
} from "../../../apps/single-workspace/src/transport/network-proxy-broker.js";
import { openNetworkProxyBrokerV2 } from "../../../apps/single-workspace/src/transport/network-proxy-broker-v2.js";
import {
  createNetworkTlsAuthority,
  type NetworkTlsAuthority,
} from "../../../apps/single-workspace/src/transport/network-tls-authority.js";

const policy = {
  version: 1,
  mode: "Restricted",
  destinations: ["https://registry.npmjs.org"],
} as const;

/** Both TLS connections, CONNECT, HTTP parsers and streaming are real. Only
 * DNS/discovery and the upstream destination are T2 known-answer fixtures. */
describe("HTTP CONNECT streaming and identity binding (T2)", () => {
  let authority: NetworkTlsAuthority;
  let origin: ReturnType<typeof httpsServer>;
  let port: number;
  const received: Array<{
    body: string;
    headers: import("node:http").IncomingHttpHeaders;
  }> = [];
  beforeAll(async () => {
    authority = await createNetworkTlsAuthority();
    origin = httpsServer(
      {
        SNICallback(hostname, callback) {
          authority
            .contextFor(hostname)
            .then((context) => callback(null, context), callback);
        },
      },
      (request, response) => {
        void (async () => {
          const chunks: Buffer[] = [];
          for await (const chunk of request) chunks.push(Buffer.from(chunk));
          const body = Buffer.concat(chunks).toString();
          received.push({ body, headers: request.headers });
          if (request.url === "/pending") return;
          response.setHeader("Connection", "close, x-origin-hop");
          response.setHeader("X-Origin-Hop", "must disappear");
          response.setHeader("X-Origin", "preserved");
          response.write("reply:");
          response.write(body || "empty");
          response.end(":end");
        })().catch(() => response.destroy());
      },
    );
    await new Promise<void>((resolve) =>
      origin.listen(0, "127.0.0.1", resolve),
    );
    const address = origin.address();
    if (address === null || typeof address === "string")
      throw new Error("origin address missing");
    port = address.port;
  });
  afterAll(async () => {
    origin.closeAllConnections();
    await new Promise<void>((resolve) => origin.close(() => resolve()));
    await authority.close();
  });

  const harness = () => ({
    discoverPref64: vi.fn<
      NonNullable<NetworkProxyBrokerDependencies["discoverPref64"]>
    >(async () => [{ address: "64:ff9b::", length: 96 }]),
    resolveAll: vi.fn(async () => ["8.8.8.8"]),
    request: vi.fn<NonNullable<NetworkProxyBrokerDependencies["request"]>>(
      (options, callback) =>
        httpsRequest(
          {
            ...options,
            hostname: "127.0.0.1",
            port,
            ca: authority.certificate,
          },
          callback,
        ),
    ),
  });
  const tunnel = async (
    broker: Awaited<ReturnType<typeof openNetworkProxyBroker>>,
    options: { servername?: string; trusted?: boolean } = {
      servername: "registry.npmjs.org",
    },
  ): Promise<TLSSocket> => {
    const ca = await readFile(broker.certificatePath);
    return new Promise((resolve, reject) => {
      const request = httpRequest({
        socketPath: broker.socketPath,
        method: "CONNECT",
        path: "registry.npmjs.org:443",
      });
      request.once("error", reject);
      request.setTimeout(5000, () =>
        request.destroy(new Error("CONNECT deadline")),
      );
      request.once("connect", (response, socket, head) => {
        if (response.statusCode !== 200) {
          socket.destroy();
          reject(new Error(`CONNECT ${response.statusCode}`));
          return;
        }
        if (head.length > 0) socket.unshift(head);
        const tls = tlsConnect({
          socket,
          ...options,
          ...(options.trusted === false ? {} : { ca }),
          rejectUnauthorized: true,
        });
        tls.setTimeout(5000, () => tls.destroy(new Error("TLS deadline")));
        tls.once("error", reject);
        tls.once("secureConnect", () => resolve(tls));
      });
      request.end();
    });
  };

  it("streams fragmented chunked POST and response while stripping hop headers", async () => {
    const dependencies = harness();
    const broker = await openNetworkProxyBroker(policy, dependencies);
    const agent = new Agent();
    try {
      const socket = await tunnel(broker);
      agent.createConnection = () => socket;
      const response = await new Promise<{
        body: string;
        headers: import("node:http").IncomingHttpHeaders;
      }>((resolve, reject) => {
        const request = httpRequest(
          {
            hostname: "registry.npmjs.org",
            path: "/echo",
            method: "POST",
            agent,
            headers: {
              Connection: "close, x-client-hop",
              "X-Client-Hop": "must disappear",
              "Proxy-Authorization": "not for origin",
              Authorization: "origin credential",
            },
          },
          (reply) => {
            const chunks: Buffer[] = [];
            reply.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
            reply.once("error", reject);
            reply.once("end", () =>
              resolve({
                body: Buffer.concat(chunks).toString(),
                headers: reply.headers,
              }),
            );
          },
        );
        request.once("error", reject);
        request.write("first ");
        setImmediate(() => request.end("second"));
      });
      expect(response.body).toBe("reply:first second:end");
      expect(response.headers["x-origin"]).toBe("preserved");
      expect(response.headers["x-origin-hop"]).toBeUndefined();
      expect(received.at(-1)).toMatchObject({
        body: "first second",
        headers: { authorization: "origin credential" },
      });
      expect(received.at(-1)?.headers["x-client-hop"]).toBeUndefined();
      expect(received.at(-1)?.headers["proxy-authorization"]).toBeUndefined();
      expect(dependencies.request).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          hostname: "8.8.8.8",
          servername: "registry.npmjs.org",
          rejectUnauthorized: true,
          port: 443,
        }),
        expect.any(Function),
      );
      expect(dependencies.discoverPref64).toHaveBeenCalledTimes(4);
    } finally {
      agent.destroy();
      await broker.close();
    }
  });

  it("bounds an upstream TLS handshake and returns a readable HTTP timeout", async () => {
    const stalled = netServer();
    const held = new Set<Socket>();
    stalled.on("connection", (socket) => {
      held.add(socket);
      socket.once("close", () => held.delete(socket));
    });
    await new Promise<void>((resolve) =>
      stalled.listen(0, "127.0.0.1", resolve),
    );
    const address = stalled.address();
    if (address === null || typeof address === "string")
      throw new Error("fixture address missing");
    const dependencies = harness();
    dependencies.request.mockImplementation((options, callback) =>
      httpsRequest(
        { ...options, hostname: "127.0.0.1", port: address.port },
        callback,
      ),
    );
    const broker = await openNetworkProxyBroker(policy, dependencies);
    try {
      const socket = await tunnel(broker);
      socket.setTimeout(15_000, () =>
        socket.destroy(new Error("timeout fixture exceeded its bound")),
      );
      const result = await new Promise<string>((resolve, reject) => {
        const chunks: Buffer[] = [];
        socket.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
        socket.once("error", reject);
        socket.once("close", () => resolve(Buffer.concat(chunks).toString()));
        socket.write(
          "GET / HTTP/1.1\r\nHost: registry.npmjs.org\r\nConnection: close\r\n\r\n",
        );
      });
      expect(result).toContain("HTTP/1.1 504");
      expect(result).toContain("sandbox/upstream-connect-timeout");
    } finally {
      await broker.close();
      for (const socket of held) socket.destroy();
      await new Promise<void>((resolve) => stalled.close(() => resolve()));
    }
  });

  it("returns an HTTP error instead of dropping TLS when upstream fails before headers", async () => {
    const dependencies = harness();
    dependencies.request.mockImplementation((options, callback) => {
      const upstream = httpsRequest(
        {
          ...options,
          hostname: "127.0.0.1",
          port,
          path: "/pending",
          ca: authority.certificate,
        },
        callback,
      );
      setTimeout(
        () =>
          upstream.destroy(new Error("upstream fixture connection failure")),
        50,
      );
      return upstream;
    });
    const broker = await openNetworkProxyBroker(policy, dependencies);
    try {
      const socket = await tunnel(broker);
      const result = await new Promise<string>((resolve, reject) => {
        const chunks: Buffer[] = [];
        socket.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
        socket.once("error", reject);
        socket.once("close", () => resolve(Buffer.concat(chunks).toString()));
        socket.write(
          "GET / HTTP/1.1\r\nHost: registry.npmjs.org\r\nConnection: close\r\n\r\n",
        );
      });
      expect(result).toContain("HTTP/1.1 502");
      expect(result).toContain("sandbox/network-unavailable");
    } finally {
      await broker.close();
    }
  });

  it.each([
    "GET / HTTP/1.1\r\nHost: github.com\r\n\r\n",
    "GET https://github.com/ HTTP/1.1\r\nHost: registry.npmjs.org\r\n\r\n",
    "GET / HTTP/1.1\r\nHost: registry.npmjs.org\r\nHost: github.com\r\n\r\n",
    "POST / HTTP/1.1\r\nHost: registry.npmjs.org\r\nContent-Length: 16777217\r\n\r\n",
  ])(
    "denies invalid request without opening an upstream connection: %j",
    async (raw) => {
      const dependencies = harness();
      const broker = await openNetworkProxyBroker(policy, dependencies);
      try {
        const socket = await tunnel(broker);
        const result = await new Promise<string>((resolve, reject) => {
          const chunks: Buffer[] = [];
          socket.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
          socket.once("error", reject);
          socket.once("close", () => resolve(Buffer.concat(chunks).toString()));
          socket.write(raw);
        });
        expect(result).toMatch(/HTTP\/1.1 (403|413)/);
        expect(dependencies.request).not.toHaveBeenCalled();
      } finally {
        await broker.close();
      }
    },
  );

  it.each([
    { servername: "github.com" },
    {},
    { servername: "registry.npmjs.org", trusted: false },
  ])(
    "denies SNI mismatch, absent SNI or untrusted authority: %j",
    async (options) => {
      const dependencies = harness();
      const broker = await openNetworkProxyBroker(policy, dependencies);
      try {
        await expect(tunnel(broker, options)).rejects.toBeDefined();
        expect(dependencies.request).not.toHaveBeenCalled();
      } finally {
        await broker.close();
      }
    },
  );

  it("aborts pending discovery and removes the channel on repeated close", async () => {
    const dependencies = harness();
    let signal: AbortSignal | undefined;
    let entered: () => void = () => {};
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    dependencies.discoverPref64.mockImplementation(async (current) => {
      signal = current;
      entered();
      return new Promise((_resolve, reject) =>
        current.addEventListener("abort", () => reject(current.reason), {
          once: true,
        }),
      );
    });
    const broker = await openNetworkProxyBroker(policy, dependencies);
    const attempt = tunnel(broker).catch(() => undefined);
    await started;
    await Promise.all([broker.close(), broker.close()]);
    await attempt;
    expect(signal?.aborted).toBe(true);
    expect(dependencies.request).not.toHaveBeenCalled();
    await expect(readFile(broker.certificatePath)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});

/** Real Unix client/HTTP response boundary, with controlled DNS and pending
 * upstream sockets. These are T2 lifecycle checks, not Internet qualification. */
describe("V2 CONNECT connection lifecycle (T2)", () => {
  const barrier = <T>() => {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((complete) => {
      resolve = complete;
    });
    return { promise, resolve };
  };
  const connectClient = (socketPath: string, earlyPayload = "") => {
    const client = createConnection({ path: socketPath });
    const chunks: Buffer[] = [];
    const response = new Promise<string>((resolveResponse, rejectResponse) => {
      client.on("data", (data) => chunks.push(Buffer.from(data)));
      client.once("error", rejectResponse);
      client.once("close", () =>
        resolveResponse(Buffer.concat(chunks).toString()),
      );
      client.once("connect", () =>
        client.write(
          `CONNECT registry.npmjs.org:443 HTTP/1.1\r\nHost: registry.npmjs.org:443\r\n\r\n${earlyPayload}`,
        ),
      );
    });
    return { client, response };
  };

  it("returns a readable failure when an upstream closes before connecting", async () => {
    const upstream = new Socket();
    const dialed = barrier<void>();
    const broker = await openNetworkProxyBrokerV2(policy, {
      resolveAll: async () => ["8.8.8.8"],
      connect: (options) => {
        expect(options).toEqual({ host: "8.8.8.8", port: 443, family: 4 });
        dialed.resolve();
        return upstream;
      },
    });
    const attempt = connectClient(broker.socketPath);
    try {
      await dialed.promise;
      upstream.destroy();
      const response = await Promise.race([
        attempt.response,
        new Promise<string>((resolveTimeout) =>
          setTimeout(() => resolveTimeout("client still waiting"), 1000),
        ),
      ]);
      expect(response).toContain("502 Bad Gateway");
      expect(response).toContain("sandbox/upstream-connect-failed");
    } finally {
      attempt.client.destroy();
      await broker.close();
      await attempt.response.catch(() => undefined);
    }
  });

  it("closes the pending upstream when its client disconnects", async () => {
    const upstream = new Socket();
    const dialed = barrier<void>();
    const broker = await openNetworkProxyBrokerV2(policy, {
      resolveAll: async () => ["8.8.8.8"],
      connect: () => {
        dialed.resolve();
        return upstream;
      },
    });
    const attempt = connectClient(broker.socketPath);
    try {
      await dialed.promise;
      attempt.client.destroy();
      await vi.waitFor(() => expect(upstream.destroyed).toBe(true), {
        timeout: 1000,
      });
    } finally {
      attempt.client.destroy();
      await broker.close();
      await attempt.response.catch(() => undefined);
    }
  });

  it("bounds client bytes buffered behind a pending upstream", async () => {
    const upstream = new Socket();
    const dialed = barrier<void>();
    const broker = await openNetworkProxyBrokerV2(policy, {
      resolveAll: async () => ["8.8.8.8"],
      connect: () => {
        dialed.resolve();
        return upstream;
      },
    });
    const attempt = connectClient(broker.socketPath);
    try {
      await dialed.promise;
      attempt.client.write(Buffer.alloc(64 * 1024 + 1, 97));
      const response = await attempt.response;
      expect(response).toContain("502 Bad Gateway");
      expect(response).toContain("sandbox/proxy-buffer-limit");
      expect(upstream.destroyed).toBe(true);
    } finally {
      attempt.client.destroy();
      await broker.close();
      await attempt.response.catch(() => undefined);
    }
  });

  it("rejects ordinary HTTP requests instead of leaving them unanswered", async () => {
    const connect = vi.fn();
    const broker = await openNetworkProxyBrokerV2(policy, { connect });
    try {
      const response = await new Promise<{
        status: number | undefined;
        body: string;
      }>((resolveResponse, rejectResponse) => {
        const request = httpRequest(
          { socketPath: broker.socketPath, path: "/", method: "GET" },
          (incoming) => {
            const chunks: Buffer[] = [];
            incoming.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
            incoming.once("end", () =>
              resolveResponse({
                status: incoming.statusCode,
                body: Buffer.concat(chunks).toString(),
              }),
            );
          },
        );
        request.once("error", rejectResponse);
        request.end();
      });
      expect(response).toEqual({
        status: 405,
        body: "sandbox/connect-required",
      });
      expect(connect).not.toHaveBeenCalled();
    } finally {
      await broker.close();
    }
  });

  it.each(["DNS", "connect"])(
    "bounds stalled %s with a readable timeout and cancellation",
    async (stage) => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const started = barrier<void>();
      const upstream = new Socket();
      let operationSignal: AbortSignal | undefined;
      const broker = await openNetworkProxyBrokerV2(policy, {
        resolveAll: async (_hostname, signal) => {
          operationSignal = signal;
          if (stage === "connect") return ["8.8.8.8"];
          started.resolve();
          return new Promise((_resolve, reject) =>
            signal.addEventListener("abort", () => reject(signal.reason), {
              once: true,
            }),
          );
        },
        connect: () => {
          started.resolve();
          return upstream;
        },
      });
      const attempt = connectClient(broker.socketPath);
      try {
        await started.promise;
        await vi.advanceTimersByTimeAsync(10_001);
        expect(await attempt.response).toContain("504 Gateway Timeout");
        expect(operationSignal?.aborted).toBe(true);
        if (stage === "connect") expect(upstream.destroyed).toBe(true);
      } finally {
        attempt.client.destroy();
        await broker.close();
        await attempt.response.catch(() => undefined);
        vi.useRealTimers();
      }
    },
  );

  it("preserves early bytes and a large response under backpressure", async () => {
    const lookupStarted = barrier<void>();
    const allowLookup = barrier<ReadonlyArray<string>>();
    const sent = "early-client-bytes|later-client-bytes";
    const payload = "opaque-response|".repeat(150_000);
    let received = "";
    const origin = netServer((socket) => {
      socket.on("error", () => {});
      socket.on("data", (chunk) => {
        received += chunk.toString();
        if (received.length === sent.length) socket.end(payload);
      });
    });
    await new Promise<void>((resolveListen, rejectListen) => {
      origin.once("error", rejectListen);
      origin.listen(0, "127.0.0.1", resolveListen);
    });
    const address = origin.address();
    if (address === null || typeof address === "string")
      throw new Error("no fixture TCP port");
    const broker = await openNetworkProxyBrokerV2(policy, {
      resolveAll: () => {
        lookupStarted.resolve();
        return allowLookup.promise;
      },
      connect: () =>
        createConnection({ host: "127.0.0.1", port: address.port }),
    });
    const attempt = connectClient(broker.socketPath, "early-client-bytes|");
    let resumeTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      await lookupStarted.promise;
      attempt.client.write("later-client-bytes");
      attempt.client.pause();
      allowLookup.resolve(["8.8.8.8"]);
      resumeTimer = setTimeout(() => attempt.client.resume(), 50);
      expect(await attempt.response).toBe(
        `HTTP/1.1 200 Connection Established\r\n\r\n${payload}`,
      );
      expect(received).toBe(sent);
    } finally {
      clearTimeout(resumeTimer);
      attempt.client.destroy();
      await broker.close();
      await attempt.response.catch(() => undefined);
      await new Promise<void>((resolveClose) =>
        origin.close(() => resolveClose()),
      );
    }
  });
});
