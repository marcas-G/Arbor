import { execFile } from "node:child_process";
import {
  chmod,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect } from "node:tls";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { BrokerDependencies } from "../src/transport/network-broker.js";
import { openNetworkSocketBroker } from "../src/transport/network-socket-broker.js";
import {
  createNetworkTlsAuthority,
  type NetworkTlsAuthority,
} from "../src/transport/network-tls-authority.js";

const execute = promisify(execFile);
const restricted = {
  version: 1,
  mode: "Restricted",
  destinations: ["https://registry.npmjs.org"],
} as const;
const payload =
  "socket transport fixture; not an external network qualification";
const harness = () => ({
  // Explicit T2 known-answer discovery and upstream fixture. These tests
  // qualify the real child/TLS/socket transport, not public Internet/T3.
  discoverPref64: vi.fn<BrokerDependencies["discoverPref64"]>(async () => [
    { address: "64:ff9b::", length: 96 },
  ]),
  resolveAll: vi.fn(async () => ["8.8.8.8"]),
  connect: vi.fn<NonNullable<BrokerDependencies["connect"]>>(async () => ({
    status: 200,
    location: undefined,
    body: (async function* () {
      yield new TextEncoder().encode(payload);
    })(),
    close() {},
  })),
});

describe("T2 TLS Unix-socket broker, real clients and fixture upstream", () => {
  let authority: NetworkTlsAuthority;
  beforeAll(async () => {
    authority = await createNetworkTlsAuthority();
  });
  afterAll(async () => {
    await authority?.close();
  });

  const request = async (
    socketPath: string,
    options: {
      readonly servername?: string;
      readonly trusted?: boolean;
      readonly raw?: string;
    } = {},
  ): Promise<string> =>
    new Promise((resolve, reject) => {
      const socket = connect({
        path: socketPath,
        ...(options.servername === undefined
          ? {}
          : { servername: options.servername }),
        ...(options.trusted === false ? {} : { ca: authority.certificate }),
        rejectUnauthorized: true,
      });
      let result = "";
      socket.setTimeout(10_000, () =>
        socket.destroy(new Error("client deadline")),
      );
      socket.once("secureConnect", () =>
        socket.write(
          options.raw ??
            "GET /package HTTP/1.1\r\nHost: registry.npmjs.org\r\nConnection: close\r\n\r\n",
        ),
      );
      socket.on("data", (data) => {
        result += data.toString();
      });
      socket.once("error", reject);
      socket.once("close", () => resolve(result));
    });

  const open = (dependencies = harness()) =>
    openNetworkSocketBroker({
      policy: restricted,
      authority,
      dependencies,
      maxBytes: 1024,
      timeoutMs: 5000,
    });

  it("serves a real curl HTTPS download over a private Unix socket", async () => {
    const dependencies = harness();
    const broker = await open(dependencies);
    try {
      const result = await execute(
        "/usr/bin/curl",
        [
          "--fail",
          "--silent",
          "--show-error",
          "--max-time",
          "10",
          "--noproxy",
          "*",
          "--unix-socket",
          broker.socketPath,
          "--cacert",
          authority.certificatePath,
          "https://registry.npmjs.org/package",
        ],
        { env: { PATH: "/usr/bin:/bin", LANG: "C" } },
      );
      expect(result.stdout).toBe(payload);
      expect(dependencies.connect).toHaveBeenCalledOnce();
      expect((await stat(broker.socketPath)).mode & 0o777).toBe(0o600);
      expect((await stat(join(broker.socketPath, ".."))).mode & 0o777).toBe(
        0o700,
      );
    } finally {
      await broker.close();
    }
  });

  it.each([
    { servername: "github.com" },
    { servername: "registry.npmjs.org", trusted: false },
    {},
  ])(
    "refuses unauthorized SNI, untrusted CA and absent SNI: %j",
    async (options) => {
      const dependencies = harness();
      const broker = await open(dependencies);
      try {
        await expect(request(broker.socketPath, options)).rejects.toBeDefined();
        expect(dependencies.discoverPref64).not.toHaveBeenCalled();
        expect(dependencies.connect).not.toHaveBeenCalled();
      } finally {
        await broker.close();
      }
    },
  );

  it.each([
    "GET /package HTTP/1.1\r\nHost: github.com\r\n\r\n",
    "GET https://github.com/package HTTP/1.1\r\nHost: registry.npmjs.org\r\n\r\n",
    "POST /package HTTP/1.1\r\nHost: registry.npmjs.org\r\nContent-Length: 0\r\n\r\n",
    "GET /package HTTP/1.1\r\nHost: registry.npmjs.org\r\nContent-Length: 1\r\n\r\nx",
    "GET /package HTTP/1.1\r\nHost: registry.npmjs.org\r\nHost: github.com\r\n\r\n",
  ])(
    "rejects authority switching or unsupported requests before discovery: %j",
    async (raw) => {
      const dependencies = harness();
      const broker = await open(dependencies);
      try {
        const result = await request(broker.socketPath, {
          servername: "registry.npmjs.org",
          raw,
        });
        expect(result).toContain("403");
        expect(dependencies.discoverPref64).not.toHaveBeenCalled();
        expect(dependencies.connect).not.toHaveBeenCalled();
      } finally {
        await broker.close();
      }
    },
  );

  it("preserves unknown discovery as refusal, without opening upstream", async () => {
    const dependencies = harness();
    dependencies.discoverPref64.mockResolvedValue(null);
    const broker = await open(dependencies);
    try {
      const result = await request(broker.socketPath, {
        servername: "registry.npmjs.org",
      });
      expect(result).toContain("502");
      expect(result).toContain("sandbox/pref64-unknown");
      expect(dependencies.connect).not.toHaveBeenCalled();
    } finally {
      await broker.close();
    }
  });

  it("aborts an in-flight transfer when the socket broker closes", async () => {
    const dependencies = harness();
    let operationSignal: AbortSignal | undefined;
    let entered: () => void = () => {};
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    dependencies.discoverPref64.mockImplementation(async (signal) => {
      operationSignal = signal;
      entered();
      return new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), {
          once: true,
        });
      });
    });
    const broker = await open(dependencies);
    const response = request(broker.socketPath, {
      servername: "registry.npmjs.org",
    });
    try {
      await started;
      await broker.close();
      await response;
      expect(operationSignal?.aborted).toBe(true);
      await expect(stat(broker.socketPath)).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      if (operationSignal?.aborted !== true) await broker.close();
    }
  });

  it.runIf(process.env.ARBOR_RUN_NATIVE_POSIX === "1")(
    "downloads through real bwrap netns while direct network and host files stay inaccessible",
    async () => {
      const dependencies = harness();
      const broker = await open(dependencies);
      const project = await mkdtemp(join(tmpdir(), "arbor-netns-project-"));
      const privateRoot = await mkdtemp(join(tmpdir(), "arbor-netns-private-"));
      await chmod(privateRoot, 0o700);
      await writeFile(join(privateRoot, "secret"), "must not enter sandbox");
      try {
        const args = [
          "--die-with-parent",
          "--new-session",
          "--unshare-user",
          "--unshare-pid",
          "--unshare-ipc",
          "--unshare-uts",
          "--unshare-net",
          "--clearenv",
          "--tmpfs",
          "/",
          "--dir",
          "/arbor",
          "--proc",
          "/proc",
          "--dev",
          "/dev",
          "--tmpfs",
          "/tmp",
          "--bind",
          project,
          "/project",
          "--ro-bind",
          broker.socketPath,
          "/arbor/egress.sock",
          "--ro-bind",
          authority.certificatePath,
          "/arbor/authority.pem",
        ];
        for (const root of ["/usr", "/bin", "/sbin", "/lib", "/lib64"])
          args.push("--ro-bind", root, root);
        args.push(
          "--setenv",
          "PATH",
          "/usr/bin:/bin",
          "--chdir",
          "/project",
          "--",
          "/bin/bash",
          "-eu",
          "-c",
          [
            `test ! -e '${privateRoot}/secret'`,
            "test ! -e /home/lgao/.codex/auth.json",
            "if curl -kfsS --noproxy '*' --max-time 2 https://1.1.1.1/ >/dev/null 2>&1; then exit 91; fi",
            "curl -fSs --noproxy '*' --max-time 10 --unix-socket /arbor/egress.sock --cacert /arbor/authority.pem https://registry.npmjs.org/package -o /project/package",
          ].join("\n"),
        );
        await execute("/usr/bin/bwrap", args, { timeout: 20_000 });
        expect(await readFile(join(project, "package"), "utf8")).toBe(payload);
        expect(dependencies.connect).toHaveBeenCalledOnce();
        // No private authority material or host files were mounted.
        expect(args).not.toContain(privateRoot);
        expect(args.some((value) => value.endsWith("authority.key"))).toBe(
          false,
        );
      } finally {
        await broker.close();
        await rm(project, { recursive: true, force: true });
        await rm(privateRoot, { recursive: true, force: true });
      }
    },
  );
});
