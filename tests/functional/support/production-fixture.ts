import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const DAEMON_ENTRY = resolve("apps/single-workspace/dist/main.js");
const WEB_DIST = resolve("apps/web/dist");

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

export interface ProductionFixture {
  readonly baseUrl: string;
  readonly directory: string;
  readonly databaseFile: string;
  readonly workspaceDirectory: string;
  readonly providerCalls: ReadonlyArray<CapturedProviderCall>;
  readonly daemonErrors: ReadonlyArray<string>;
  readonly crash: () => Promise<void>;
  readonly restart: (options?: {
    readonly entry?: string;
    readonly daemonEnvironment?: Readonly<Record<string, string>>;
  }) => Promise<void>;
  readonly stop: () => Promise<void>;
}

const freePort = () =>
  new Promise<number>((resolvePort) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port =
        typeof address === "object" && address !== null ? address.port : -1;
      server.close(() => resolvePort(port));
    });
  });

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
) =>
  new Promise<{
    readonly server: Server;
    readonly port: number;
    readonly calls: CapturedProviderCall[];
  }>((resolveStart) => {
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
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolveStart({
        server,
        port:
          typeof address === "object" && address !== null ? address.port : -1,
        calls,
      });
    });
  });

const stopChild = async (child: ChildProcess | undefined): Promise<void> => {
  if (child === undefined || child.exitCode !== null) return;
  const exited = new Promise<void>((resolveExit) => {
    child.once("exit", () => resolveExit());
  });
  if (process.platform === "win32" && child.pid !== undefined) {
    await new Promise<void>((resolveKill, rejectKill) => {
      const killer = spawn(
        "taskkill.exe",
        ["/PID", String(child.pid), "/T", "/F"],
        { stdio: "ignore", windowsHide: true },
      );
      killer.once("error", rejectKill);
      killer.once("exit", () => resolveKill());
    });
  } else {
    child.kill("SIGKILL");
  }
  await Promise.race([
    exited,
    new Promise<void>((_, rejectTimeout) =>
      setTimeout(
        () => rejectTimeout(new Error("Arbor process did not exit")),
        5_000,
      ),
    ),
  ]);
};

export const startProductionFixture = async (input: {
  readonly reply: (
    call: CapturedProviderCall,
    index: number,
  ) => ScriptedProviderResponse;
  readonly onResponseSent?: (call: CapturedProviderCall, index: number) => void;
  /** Host-side resource admission for the pending F21 browser contract. */
  readonly admitWorkspaceDirectory?: boolean;
  /** Test-only entrypoint for the first daemon incarnation. Restarts use the
   * ordinary production binary so recovery is never run with a fault hook. */
  readonly firstDaemonEntry?: string;
  readonly daemonEnvironment?: Readonly<Record<string, string>>;
  readonly onDaemonStdout?: (line: string) => void;
}): Promise<ProductionFixture> => {
  const directory = mkdtempSync(join(tmpdir(), "arbor-functional-"));
  const workspaceDirectory = join(directory, "workspace");
  mkdirSync(workspaceDirectory, { recursive: true });
  writeFileSync(join(workspaceDirectory, "proof.txt"), "FUNCTIONAL_VERIFIED");
  const databaseFile = join(directory, "arbor-functional.db");
  const provider = await startProvider(input.reply, input.onResponseSent);
  const httpPort = await freePort();
  const baseUrl = `http://127.0.0.1:${httpPort}`;
  const daemonErrors: string[] = [];
  let daemon: ChildProcess | undefined;
  let stopped = false;
  let daemonStarts = 0;

  const startDaemon = async (override?: {
    readonly entry?: string;
    readonly daemonEnvironment?: Readonly<Record<string, string>>;
  }) => {
    const daemonEnv: NodeJS.ProcessEnv = {
      ...process.env,
      ARBOR_DB: databaseFile,
      ARBOR_HTTP_PORT: String(httpPort),
      ARBOR_HTTP_HOST: "127.0.0.1",
      ARBOR_WEB_DIST: WEB_DIST,
      ARBOR_AUTH_TOKENS: "",
      ARBOR_MODEL_BASE_URL: `http://127.0.0.1:${provider.port}/v1`,
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
    const entry =
      override?.entry ??
      (daemonStarts === 0 && input.firstDaemonEntry !== undefined
        ? input.firstDaemonEntry
        : DAEMON_ENTRY);
    daemonStarts += 1;
    daemon = spawn(process.execPath, [entry], {
      cwd: directory,
      env: daemonEnv,
      stdio: ["ignore", input.onDaemonStdout ? "pipe" : "ignore", "pipe"],
    });
    let stdoutBuffer = "";
    daemon.stdout?.on("data", (chunk: Buffer) => {
      stdoutBuffer += chunk.toString("utf8");
      let newline = stdoutBuffer.indexOf("\n");
      while (newline >= 0) {
        const line = stdoutBuffer.slice(0, newline).trim();
        stdoutBuffer = stdoutBuffer.slice(newline + 1);
        if (line.length > 0) input.onDaemonStdout?.(line);
        newline = stdoutBuffer.indexOf("\n");
      }
    });
    daemon.stderr?.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8").trim();
      if (text.length > 0 && !text.includes("ExperimentalWarning")) {
        daemonErrors.push(text);
      }
    });
    daemon.on("error", (error) => {
      daemonErrors.push(`spawn error=${error.message}`);
    });
    await waitFor(
      () => fetch(baseUrl),
      (response) => response.ok,
      60_000,
    );
  };

  await startDaemon();

  return {
    baseUrl,
    directory,
    databaseFile,
    workspaceDirectory,
    providerCalls: provider.calls,
    daemonErrors,
    crash: () => stopChild(daemon),
    restart: async (override) => {
      await stopChild(daemon);
      await startDaemon(override);
    },
    stop: async () => {
      if (stopped) return;
      stopped = true;
      await stopChild(daemon);
      await new Promise<void>((resolveClose) =>
        provider.server.close(() => resolveClose()),
      );
      rmSync(directory, { recursive: true, force: true, maxRetries: 3 });
    },
  };
};
