import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join, resolve } from "node:path";
import {
  childHasExited,
  stopChildBounded as stopChild,
  waitForDaemonListening as waitForNonceBoundPort,
} from "./daemon-process-lifecycle.js";
import {
  cloneFunctionalSchema42Database,
  createFunctionalFixtureDirectory,
  removeFunctionalFixtureDirectory,
} from "./schema42-bootstrap.js";

const DAEMON_ENTRY = resolve("apps/single-workspace/dist/main.js");
const NONCE_DAEMON_ENTRY = resolve(
  "tests/functional/support/nonce-daemon-child.mjs",
);
const WEB_DIST = resolve("apps/web/dist");
const MAX_DAEMON_ERROR_CHARS = 12_000;

const redactDaemonText = (value: string): string =>
  value
    .replaceAll("test-only", "[REDACTED]")
    .replace(
      /(authorization["']?\s*[:=]\s*["']?bearer\s+)["']?[^"'\s,;]+/giu,
      "$1[REDACTED]",
    )
    .replace(
      /((?:api[_-]?key|token|secret)["']?\s*[:=]\s*["']?)[^"'\s,;]+/giu,
      "$1[REDACTED]",
    )
    .slice(-MAX_DAEMON_ERROR_CHARS);

export interface CapturedProviderCall {
  readonly messages: ReadonlyArray<{ role?: string; content?: string }>;
  readonly tools: ReadonlyArray<{ function?: { name?: string } }>;
}

export type ScriptedProviderResponse =
  | string
  | { readonly _tag: "Text"; readonly text: string }
  | {
      readonly _tag: "ToolCall";
      readonly name: string;
      readonly arguments: unknown;
    }
  | {
      readonly _tag: "ToolCalls";
      readonly calls: ReadonlyArray<{
        readonly name: string;
        readonly arguments: unknown;
      }>;
    }
  | { readonly _tag: "HttpError"; readonly status: number };

export type ProviderResponseGate = (
  call: CapturedProviderCall,
  index: number,
) => Promise<"respond" | "abort" | undefined>;

export interface ProductionFixtureSetupProbeEvent {
  readonly stage: "after-clone" | "provider-started";
  readonly directory: string;
  readonly providerPort?: number;
}

export interface ProductionFixture {
  readonly baseUrl: string;
  readonly directory: string;
  readonly databaseFile: string;
  readonly workspaceDirectory: string;
  readonly providerCalls: ReadonlyArray<CapturedProviderCall>;
  readonly daemonErrors: ReadonlyArray<string>;
  /** Sanitized state of the last primary daemon launcher (never env values). */
  readonly daemonProcessSnapshot: () => {
    readonly pid: number | undefined;
    readonly exitCode: number | null;
    readonly signalCode: NodeJS.Signals | null;
    readonly killed: boolean;
    readonly executable: string | undefined;
    readonly args: ReadonlyArray<string>;
    readonly requestedPort: number;
    readonly environmentKeys: ReadonlyArray<string>;
    readonly alive: boolean;
  } | null;
  readonly crash: () => Promise<void>;
  readonly restart: (options?: {
    /** Custom entries must emit the PID/nonce/listening handshake. */
    readonly entry?: string;
    readonly daemonEnvironment?: Readonly<Record<string, string>>;
  }) => Promise<void>;
  readonly startAdditionalDaemon: (options: {
    /** Custom entries must emit the PID/nonce/listening handshake. */
    readonly entry: string;
    readonly daemonEnvironment?: Readonly<Record<string, string>>;
    readonly onStdout?: (line: string) => void;
  }) => Promise<{
    readonly baseUrl: string;
    readonly httpPort: number;
    readonly daemonErrors: ReadonlyArray<string>;
    readonly daemonProcessSnapshot: () => {
      readonly pid: number | undefined;
      readonly exitCode: number | null;
      readonly signalCode: NodeJS.Signals | null;
      readonly killed: boolean;
      readonly alive: boolean;
    };
    readonly crash: () => Promise<void>;
  }>;
  readonly stop: () => Promise<void>;
}

const waitFor = async <A>(
  read: () => Promise<A>,
  predicate: (value: A) => boolean,
  timeoutMs = 30_000,
): Promise<A> => {
  const deadline = Date.now() + timeoutMs;
  let last: A | undefined;
  while (Date.now() < deadline) {
    try {
      last = await read();
      if (predicate(last)) return last;
    } catch {
      // Process startup and restart races are retried until the public bound.
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw new Error(`functional timeout; last=${String(last)}`);
};

const sendTextResponse = (
  response: import("node:http").ServerResponse,
  text: string,
) => {
  response.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  response.write(
    `data: ${JSON.stringify({
      id: `chatcmpl-${randomUUID()}`,
      object: "chat.completion.chunk",
      choices: [
        {
          index: 0,
          delta: { role: "assistant", content: text },
          finish_reason: null,
        },
      ],
      usage: null,
    })}\n\n`,
  );
  response.write(
    `data: ${JSON.stringify({
      id: `chatcmpl-${randomUUID()}`,
      object: "chat.completion.chunk",
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      usage: {
        prompt_tokens: 10,
        completion_tokens: 5,
        total_tokens: 15,
      },
    })}\n\n`,
  );
  response.end("data: [DONE]\n\n");
};

const sendToolCallsResponse = (
  response: import("node:http").ServerResponse,
  calls: ReadonlyArray<{ readonly name: string; readonly arguments: unknown }>,
) => {
  if (calls.length === 0)
    throw new Error("tool response needs at least one call");
  response.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  response.write(
    `data: ${JSON.stringify({
      id: `chatcmpl-${randomUUID()}`,
      object: "chat.completion.chunk",
      choices: [
        {
          index: 0,
          delta: {
            role: "assistant",
            tool_calls: calls.map((call, index) => ({
              index,
              id: `call_${randomUUID().replaceAll("-", "")}`,
              type: "function",
              function: {
                name: call.name,
                arguments: JSON.stringify(call.arguments),
              },
            })),
          },
          finish_reason: null,
        },
      ],
      usage: null,
    })}\n\n`,
  );
  response.write(
    `data: ${JSON.stringify({
      id: `chatcmpl-${randomUUID()}`,
      object: "chat.completion.chunk",
      choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
      usage: {
        prompt_tokens: 10,
        completion_tokens: 5,
        total_tokens: 15,
      },
    })}\n\n`,
  );
  response.end("data: [DONE]\n\n");
};

const sendToolResponse = (
  response: import("node:http").ServerResponse,
  name: string,
  argumentsValue: unknown,
) => sendToolCallsResponse(response, [{ name, arguments: argumentsValue }]);

const startProvider = (
  reply: (
    call: CapturedProviderCall,
    index: number,
  ) => ScriptedProviderResponse,
  onResponseSent?: (call: CapturedProviderCall, index: number) => void,
  beforeResponse?: ProviderResponseGate,
) =>
  new Promise<{
    readonly server: Server;
    readonly port: number;
    readonly calls: CapturedProviderCall[];
  }>((resolveStart, rejectStart) => {
    const calls: CapturedProviderCall[] = [];
    const server = createServer((request, response) => {
      if (request.method === "GET" && request.url?.endsWith("/models")) {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            object: "list",
            data: [
              {
                id: "functional-model",
                context_window: 16_384,
                max_output_tokens: 2_048,
              },
            ],
          }),
        );
        return;
      }
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        void (async () => {
          const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
            messages?: CapturedProviderCall["messages"];
            tools?: CapturedProviderCall["tools"];
          };
          const call = {
            messages: body.messages ?? [],
            tools: body.tools ?? [],
          } satisfies CapturedProviderCall;
          calls.push(call);
          const responseIndex = calls.length - 1;
          const scripted = reply(call, responseIndex);
          const gateResult = await beforeResponse?.(call, responseIndex);
          if (gateResult === "abort" || response.destroyed) {
            response.destroy();
            return;
          }
          if (typeof scripted === "string") {
            sendTextResponse(response, scripted);
            onResponseSent?.(call, responseIndex);
            return;
          }
          switch (scripted._tag) {
            case "Text":
              sendTextResponse(response, scripted.text);
              onResponseSent?.(call, responseIndex);
              return;
            case "ToolCall":
              sendToolResponse(response, scripted.name, scripted.arguments);
              onResponseSent?.(call, responseIndex);
              return;
            case "ToolCalls":
              sendToolCallsResponse(response, scripted.calls);
              onResponseSent?.(call, responseIndex);
              return;
            case "HttpError":
              response.writeHead(scripted.status, {
                "content-type": "application/json",
              });
              response.end(
                JSON.stringify({ error: { message: "scripted unavailable" } }),
              );
              onResponseSent?.(call, responseIndex);
              return;
          }
        })().catch((error: unknown) => {
          response.destroy(
            error instanceof Error ? error : new Error(String(error)),
          );
        });
      });
    });
    const onListening = () => {
      server.removeListener("error", onStartError);
      const address = server.address();
      resolveStart({
        server,
        port:
          typeof address === "object" && address !== null ? address.port : -1,
        calls,
      });
    };
    const onStartError = (error: Error) => {
      if (server.listening) {
        server.close(() => rejectStart(error));
      } else {
        rejectStart(error);
      }
    };
    server.once("error", onStartError);
    server.listen(0, "127.0.0.1", onListening);
  });

export const startProductionFixture = async (input: {
  readonly reply: (
    call: CapturedProviderCall,
    index: number,
  ) => ScriptedProviderResponse;
  readonly onResponseSent?: (call: CapturedProviderCall, index: number) => void;
  /** Test-only gate after a complete provider request arrives but before any
   * response headers or bytes are written. Returning `abort` closes the
   * held connection without producing a provider response. */
  readonly beforeResponse?: ProviderResponseGate;
  /** Host-side resource admission for the pending F21 browser contract. */
  readonly admitWorkspaceDirectory?: boolean;
  /** Preserve isolated DB/process diagnostics after the test fixture is stopped. */
  readonly preserveDirectoryOnStop?: boolean;
  /** Test-only entrypoint for the first daemon incarnation. It must emit the
   * PID/nonce/listening handshake. Restarts default to the ordinary production
   * binary so recovery is never run with a fault hook. */
  readonly firstDaemonEntry?: string;
  /** Deprecated compatibility flag. All fixture daemons now use an
   * OS-selected port and a child-PID/nonce-bound listen report. */
  readonly isolatedPortHandshake?: boolean;
  readonly daemonEnvironment?: Readonly<Record<string, string>>;
  readonly onDaemonStdout?: (line: string) => void;
  /** Test-only fault probe for verifying early fixture setup cleanup. */
  readonly setupProbe?: (
    event: ProductionFixtureSetupProbeEvent,
  ) => void | Promise<void>;
}): Promise<ProductionFixture> => {
  const directory = createFunctionalFixtureDirectory();
  let workspaceDirectory: string;
  let databaseFile: string;
  let provider: Awaited<ReturnType<typeof startProvider>> | undefined;
  try {
    workspaceDirectory = join(directory, "workspace");
    mkdirSync(workspaceDirectory, { recursive: true });
    writeFileSync(join(workspaceDirectory, "proof.txt"), "FUNCTIONAL_VERIFIED");
    const clones = cloneFunctionalSchema42Database(directory);
    databaseFile = clones.databaseFile;
    await input.setupProbe?.({ stage: "after-clone", directory });
    provider = await startProvider(
      input.reply,
      input.onResponseSent,
      input.beforeResponse,
    );
    await input.setupProbe?.({
      stage: "provider-started",
      directory,
      providerPort: provider.port,
    });
  } catch (error) {
    try {
      if (provider !== undefined) {
        await new Promise<void>((resolveClose) =>
          provider?.server.close(() => resolveClose()),
        );
      }
    } finally {
      removeFunctionalFixtureDirectory(directory);
    }
    throw error;
  }
  if (provider === undefined) {
    removeFunctionalFixtureDirectory(directory);
    throw new Error("Functional provider did not start.");
  }
  const activeProvider = provider;
  let httpPort = 0;
  let baseUrl = `http://127.0.0.1:${httpPort}`;
  const daemonErrors: string[] = [];
  const recordDaemonError = (message: string) => {
    daemonErrors.push(redactDaemonText(message));
    if (daemonErrors.length > 24)
      daemonErrors.splice(0, daemonErrors.length - 24);
  };
  const daemonErrorSummary = () =>
    redactDaemonText(
      daemonErrors.slice(-12).join("\n").slice(-MAX_DAEMON_ERROR_CHARS),
    );
  const additionalDaemons: ChildProcess[] = [];
  let daemon: ChildProcess | undefined;
  let lastDaemonLaunch:
    | {
        readonly child: ChildProcess;
        readonly requestedPort: number;
        readonly environmentKeys: ReadonlyArray<string>;
      }
    | undefined;
  let stopped = false;
  let daemonStarts = 0;

  const startDaemon = async (override?: {
    readonly entry?: string;
    readonly daemonEnvironment?: Readonly<Record<string, string>>;
  }) => {
    const isFirstDaemon = daemonStarts === 0;
    const requestedPort = isFirstDaemon ? 0 : httpPort;
    const daemonEnv: NodeJS.ProcessEnv = {
      ...process.env,
      ARBOR_DB: databaseFile,
      ARBOR_HTTP_PORT: String(requestedPort),
      ARBOR_HTTP_HOST: "127.0.0.1",
      ARBOR_WEB_DIST: WEB_DIST,
      ARBOR_AUTH_TOKENS: "",
      ARBOR_MODEL_BASE_URL: `http://127.0.0.1:${activeProvider.port}/v1`,
      ARBOR_MODEL_NAME: "functional-model",
      ARBOR_MODEL_API_KEY_VAR: "ARBOR_FUNCTIONAL_TEST_KEY",
      ARBOR_FUNCTIONAL_TEST_KEY: "test-only",
      ARBOR_CONFIG: join(directory, "no-provider-config.json"),
      ...input.daemonEnvironment,
      ...override?.daemonEnvironment,
    };
    if (input.admitWorkspaceDirectory === true) {
      daemonEnv.ARBOR_PROJECT_ROOT = workspaceDirectory;
    } else {
      delete daemonEnv.ARBOR_PROJECT_ROOT;
    }
    delete daemonEnv.FORCE_COLOR;
    delete daemonEnv.NO_COLOR;
    const requestedEntry =
      override?.entry ??
      (isFirstDaemon && input.firstDaemonEntry !== undefined
        ? input.firstDaemonEntry
        : DAEMON_ENTRY);
    const entry =
      resolve(requestedEntry) === DAEMON_ENTRY
        ? NONCE_DAEMON_ENTRY
        : requestedEntry;
    daemonStarts += 1;
    daemon = spawn(process.execPath, [entry], {
      cwd: directory,
      env: daemonEnv,
      stdio: ["ignore", "pipe", "pipe"],
    });
    lastDaemonLaunch = {
      child: daemon,
      requestedPort,
      environmentKeys: Object.keys(daemonEnv).sort(),
    };
    daemon.stderr?.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8").trim();
      if (text.length > 0 && !text.includes("ExperimentalWarning")) {
        recordDaemonError(text);
      }
    });
    daemon.on("error", (error) => {
      recordDaemonError(`spawn error=${error.message}`);
    });
    try {
      httpPort = await waitForNonceBoundPort(daemon, requestedPort, {
        onStdoutLine: (line) => input.onDaemonStdout?.(line),
      });
    } catch (error) {
      await stopChild(daemon);
      throw new Error(
        `functional daemon startup handshake failed: ${error instanceof Error ? error.message : String(error)}; exitCode=${String(daemon.exitCode)}; signal=${String(daemon.signalCode)}; stderr=${daemonErrorSummary() || "<empty>"}`,
        { cause: error },
      );
    }
    baseUrl = `http://127.0.0.1:${httpPort}`;
    try {
      await waitFor(
        () => fetch(baseUrl),
        (response) =>
          response.ok && daemon !== undefined && !childHasExited(daemon),
        60_000,
      );
    } catch (error) {
      await stopChild(daemon);
      throw new Error(
        `functional daemon startup failed: ${error instanceof Error ? error.message : String(error)}; exitCode=${String(daemon?.exitCode)}; signal=${String(daemon?.signalCode)}; stderr=${daemonErrorSummary() || "<empty>"}`,
        { cause: error },
      );
    }
  };

  try {
    await startDaemon();
  } catch (error) {
    await new Promise<void>((resolveClose) =>
      activeProvider.server.close(() => resolveClose()),
    );
    removeFunctionalFixtureDirectory(directory);
    throw error;
  }

  const fixture: ProductionFixture = {
    baseUrl,
    directory,
    databaseFile,
    workspaceDirectory,
    providerCalls: activeProvider.calls,
    daemonErrors,
    daemonProcessSnapshot: () => {
      const launch = lastDaemonLaunch;
      if (launch === undefined) return null;
      const child = launch.child;
      let alive = false;
      if (child.pid !== undefined && child.exitCode === null) {
        try {
          process.kill(child.pid, 0);
          alive = true;
        } catch {
          alive = false;
        }
      }
      return {
        pid: child.pid,
        exitCode: child.exitCode,
        signalCode: child.signalCode,
        killed: child.killed,
        executable: child.spawnfile,
        args: [...child.spawnargs],
        requestedPort: launch.requestedPort,
        environmentKeys: launch.environmentKeys,
        alive,
      };
    },
    crash: () => stopChild(daemon),
    restart: async (override) => {
      await stopChild(daemon);
      await startDaemon(override);
    },
    startAdditionalDaemon: async (options) => {
      let additionalPort = 0;
      let additionalBaseUrl = `http://127.0.0.1:${additionalPort}`;
      const additionalErrors: string[] = [];
      const daemonEnv: NodeJS.ProcessEnv = {
        ...process.env,
        ARBOR_DB: databaseFile,
        ARBOR_HTTP_PORT: String(additionalPort),
        ARBOR_HTTP_HOST: "127.0.0.1",
        ARBOR_WEB_DIST: WEB_DIST,
        ARBOR_AUTH_TOKENS: "",
        ARBOR_MODEL_BASE_URL: `http://127.0.0.1:${activeProvider.port}/v1`,
        ARBOR_MODEL_NAME: "functional-model",
        ARBOR_MODEL_API_KEY_VAR: "ARBOR_FUNCTIONAL_TEST_KEY",
        ARBOR_FUNCTIONAL_TEST_KEY: "test-only",
        ARBOR_CONFIG: join(directory, "no-provider-config.json"),
        ...input.daemonEnvironment,
        ...options.daemonEnvironment,
      };
      if (input.admitWorkspaceDirectory === true) {
        daemonEnv.ARBOR_PROJECT_ROOT = workspaceDirectory;
      } else {
        delete daemonEnv.ARBOR_PROJECT_ROOT;
      }
      delete daemonEnv.FORCE_COLOR;
      delete daemonEnv.NO_COLOR;
      const childEntry =
        resolve(options.entry) === DAEMON_ENTRY
          ? NONCE_DAEMON_ENTRY
          : options.entry;
      const child = spawn(process.execPath, [childEntry], {
        cwd: directory,
        env: daemonEnv,
        stdio: ["ignore", "pipe", "pipe"],
      });
      additionalDaemons.push(child);
      let stdoutBuffer = "";
      child.stdout?.on("data", (chunk: Buffer) => {
        stdoutBuffer += chunk.toString("utf8");
        let newline = stdoutBuffer.indexOf("\n");
        while (newline >= 0) {
          const line = stdoutBuffer.slice(0, newline).trim();
          stdoutBuffer = stdoutBuffer.slice(newline + 1);
          if (line.length > 0) options.onStdout?.(line);
          newline = stdoutBuffer.indexOf("\n");
        }
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        const text = chunk.toString("utf8").trim();
        if (text.length > 0 && !text.includes("ExperimentalWarning")) {
          additionalErrors.push(redactDaemonText(text));
          if (additionalErrors.length > 24) {
            additionalErrors.splice(0, additionalErrors.length - 24);
          }
        }
      });
      child.on("error", (error) => {
        additionalErrors.push(`spawn error=${error.message}`);
      });
      try {
        additionalPort = await waitForNonceBoundPort(child, 0);
        additionalBaseUrl = `http://127.0.0.1:${additionalPort}`;
        await waitFor(
          () => fetch(additionalBaseUrl),
          (response) => response.ok && !childHasExited(child),
          60_000,
        );
      } catch (error) {
        await stopChild(child);
        throw new Error(
          `additional daemon failed to start: ${error instanceof Error ? error.message : String(error)}; stderr=${redactDaemonText(additionalErrors.slice(-12).join("\n")) || "<empty>"}`,
        );
      }
      return {
        baseUrl: additionalBaseUrl,
        httpPort: additionalPort,
        daemonErrors: additionalErrors,
        daemonProcessSnapshot: () => {
          let alive = false;
          if (child.pid !== undefined && child.exitCode === null) {
            try {
              process.kill(child.pid, 0);
              alive = true;
            } catch {
              alive = false;
            }
          }
          return {
            pid: child.pid,
            exitCode: child.exitCode,
            signalCode: child.signalCode,
            killed: child.killed,
            alive,
          };
        },
        crash: () => stopChild(child),
      };
    },
    stop: async () => {
      if (stopped) return;
      stopped = true;
      process.removeListener("SIGINT", stopOnSignal);
      process.removeListener("SIGTERM", stopOnSignal);
      try {
        await Promise.all([
          stopChild(daemon),
          ...additionalDaemons.map((child) => stopChild(child)),
        ]);
      } finally {
        await new Promise<void>((resolveClose) =>
          activeProvider.server.close(() => resolveClose()),
        );
        if (input.preserveDirectoryOnStop !== true) {
          removeFunctionalFixtureDirectory(directory);
        }
      }
    },
  };
  const stopOnSignal = () => {
    void fixture.stop().catch(() => undefined);
  };
  process.once("SIGINT", stopOnSignal);
  process.once("SIGTERM", stopOnSignal);
  return fixture;
};
