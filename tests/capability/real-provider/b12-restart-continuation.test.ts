import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Readable } from "node:stream";
import { afterEach, describe } from "vitest";
import { defineCapabilityTest, metadataFor } from "../harness.js";
import { runAndCapture } from "../support/capture.js";
import { makePublicProject, newCapabilityId } from "../support/public-chat.js";
import type { HttpProviderRuntime } from "./http-sdk-client.js";

const DAEMON_ENTRY = resolve("apps/single-workspace/dist/main.js");
const TICK_POLL_MS = 250;
const READY_TIMEOUT_MS = 20_000;

const temporaryDirectories: string[] = [];
const spawnedChildren: ChildProcess[] = [];
const startedServers: Server[] = [];

afterEach(() => {
  for (const child of spawnedChildren.splice(0)) {
    if (child.exitCode === null) {
      child.kill("SIGKILL");
    }
  }
  for (const server of startedServers.splice(0)) {
    server.close();
  }
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

interface ProxiedCall {
  readonly at: number;
  readonly path: string;
  readonly body: Record<string, unknown>;
}

/** Test-infrastructure recording proxy: every provider call the daemon makes
 * flows through here, so the sentinel can observe call multiplicity and
 * request composition across a real process restart (the process itself owns
 * no observable side channel). */
const startRecordingProxy = (upstreamBase: string) =>
  new Promise<{ server: Server; port: number; calls: ProxiedCall[] }>(
    (resolveStart) => {
      const calls: ProxiedCall[] = [];
      const upstream = upstreamBase.replace(/\/+$/, "");
      const server = createServer((request, response) => {
        const chunks: Buffer[] = [];
        request.on("data", (chunk: Buffer) => chunks.push(chunk));
        request.on("end", () => {
          const bodyText = Buffer.concat(chunks).toString("utf8");
          let parsed: Record<string, unknown> = {};
          try {
            parsed = JSON.parse(bodyText) as Record<string, unknown>;
          } catch {
            parsed = { unparsed: bodyText };
          }
          calls.push({
            at: Date.now(),
            path: request.url ?? "/",
            body: parsed,
          });
          const headers = { ...request.headers };
          delete headers.host;
          delete headers["content-length"];
          fetch(`${upstream}${request.url}`, {
            method: request.method ?? "GET",
            headers: headers as Record<string, string>,
            ...(request.method === "GET" ? {} : { body: bodyText }),
          })
            .then(async (upstreamResponse) => {
              response.writeHead(
                upstreamResponse.status,
                Object.fromEntries(upstreamResponse.headers.entries()),
              );
              if (upstreamResponse.body === null) {
                response.end();
                return;
              }
              Readable.fromWeb(
                upstreamResponse.body as Parameters<typeof Readable.fromWeb>[0],
              ).pipe(response);
            })
            .catch((error) => {
              response.writeHead(502, { "content-type": "text/plain" });
              response.end(
                `proxy forward failed: ${error instanceof Error ? error.message : String(error)}`,
              );
            });
        });
      });
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        const port =
          typeof address === "object" && address !== null ? address.port : -1;
        startedServers.push(server);
        resolveStart({ server, port, calls });
      });
    },
  );

const freePort = () =>
  new Promise<number>((resolvePort) => {
    const probe = createServer();
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const port =
        typeof address === "object" && address !== null ? address.port : -1;
      probe.close(() => resolvePort(port));
    });
  });

interface DaemonEnv {
  readonly databaseFile: string;
  readonly projectId: string;
  readonly httpPort: number;
  readonly proxyPort: number;
  readonly runtime: HttpProviderRuntime;
}

const spawnDaemon = (input: DaemonEnv): ChildProcess => {
  const child = spawn(process.execPath, [DAEMON_ENTRY], {
    env: {
      ...process.env,
      ARBOR_DB: input.databaseFile,
      ARBOR_PROJECT_ID: input.projectId,
      ARBOR_HTTP_PORT: String(input.httpPort),
      ARBOR_AUTH_TOKENS: "tok_b12=user:capability-test",
      ARBOR_MODEL_BASE_URL: `http://127.0.0.1:${input.proxyPort}`,
      ARBOR_MODEL_NAME: input.runtime.model,
      ARBOR_MODEL_API_KEY_VAR:
        input.runtime.authMode === "env"
          ? "ARBOR_CAPABILITY_API_KEY"
          : "ARBOR_PROXY_UNUSED_KEY",
      ARBOR_PROXY_UNUSED_KEY: "unused",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.on("data", () => undefined);
  child.stderr?.on("data", (chunk: Buffer) => {
    const text = chunk.toString("utf8").trim();
    if (text.length > 0 && !text.includes("ExperimentalWarning")) {
      process.stderr.write(`[b12-daemon] ${text}\n`);
    }
  });
  spawnedChildren.push(child);
  return child;
};

const waitUntilHttpReady = async (base: string) => {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${base}/`);
      response.body?.cancel().catch(() => undefined);
      return;
    } catch {
      await new Promise((sleep) => setTimeout(sleep, TICK_POLL_MS));
    }
  }
  throw new Error(`daemon at ${base} never became ready`);
};

const headers = {
  "content-type": "application/json",
  authorization: "Bearer tok_b12",
};

const submitHumanMessage = async (
  base: string,
  projectId: string,
  workspaceId: string,
  body: string,
) => {
  const response = await fetch(`${base}/commands`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      commandType: "SubmitHumanMessage",
      commandId: newCapabilityId("cmd"),
      projectId,
      actor: "user:capability-test",
      issuedAt: new Date().toISOString(),
      payload: {
        messageId: newCapabilityId("msg"),
        targetWorkspaceId: workspaceId,
        bodyRef: body,
      },
    }),
  });
  const payload = (await response.json()) as {
    body?: { resolution?: string };
  };
  if (response.status !== 200 || payload.body?.resolution !== "Committed") {
    throw new Error(
      `SubmitHumanMessage failed: ${response.status} ${JSON.stringify(payload)}`,
    );
  }
};

interface TranscriptEntry {
  readonly kind: string;
  readonly body: string;
}

const readTranscript = async (
  base: string,
  workspaceId: string,
): Promise<ReadonlyArray<TranscriptEntry>> => {
  const response = await fetch(`${base}/views/transcript`, {
    method: "POST",
    headers,
    body: JSON.stringify({ workspaceId, limit: 50 }),
  });
  if (response.status !== 200) {
    throw new Error(`transcript read failed: ${response.status}`);
  }
  const payload = (await response.json()) as {
    ok: boolean;
    body: { value: { entries: ReadonlyArray<TranscriptEntry> } };
  };
  if (!payload.ok) {
    throw new Error("transcript view returned a problem");
  }
  return payload.body.value.entries;
};

const waitUntilAssistantTurns = async (
  base: string,
  workspaceId: string,
  expected: number,
) => {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const entries = await readTranscript(base, workspaceId);
    const assistants = entries.filter(
      (entry) => entry.kind === "AssistantConversationTurn",
    );
    if (assistants.length >= expected) {
      return entries;
    }
    await new Promise((sleep) => setTimeout(sleep, TICK_POLL_MS * 2));
  }
  throw new Error(
    `assistant turns never reached ${expected} before the deadline`,
  );
};

describe("B12 L3 — daemon process restart continues cognition without replay", () => {
  defineCapabilityTest(
    metadataFor("B12", "L3"),
    "B12: a killed daemon process restarts, completes the pending turn, and never replays the completed one",
    async () => {
      await runAndCapture({
        caseId: "B12-L3-REAL",
        body: async (runtime) => {
          const memoryCode = `B12-CODE-${randomUUID().replaceAll("-", "").slice(0, 8)}`;
          const project = makePublicProject(
            `b12-${randomUUID().replaceAll("-", "").slice(0, 8)}`,
          );
          const directory = join(tmpdir(), `arbor-b12-real-${randomUUID()}`);
          mkdirSync(directory, { recursive: true });
          temporaryDirectories.push(directory);
          const databaseFile = join(directory, "slice.db");

          const proxy = await startRecordingProxy(runtime.endpoint);
          const daemonPort = await freePort();

          const create = async (base: string) => {
            const response = await fetch(`${base}/commands`, {
              method: "POST",
              headers,
              body: JSON.stringify({
                commandType: "CreateProject",
                commandId: newCapabilityId("cmd"),
                projectId: project.projectId,
                actor: "user:capability-test",
                issuedAt: new Date().toISOString(),
                payload: project,
              }),
            });
            const payload = (await response.json()) as {
              body?: { resolution?: string };
            };
            if (
              response.status !== 200 ||
              payload.body?.resolution !== "Committed"
            ) {
              throw new Error(
                `CreateProject failed: ${response.status} ${JSON.stringify(payload)}`,
              );
            }
          };

          // Episode 1: known completed effect (turn 1 answered), then a
          // pending safe step (turn 2 submitted) and a hard process kill.
          const daemon1 = spawnDaemon({
            databaseFile,
            projectId: project.projectId,
            httpPort: daemonPort,
            proxyPort: proxy.port,
            runtime,
          });
          const base1 = `http://127.0.0.1:${daemonPort}`;
          await waitUntilHttpReady(base1);
          await create(base1);
          await submitHumanMessage(
            base1,
            project.projectId,
            project.rootWorkspaceId,
            `记住代码 ${memoryCode}。只需简短确认。`,
          );
          await waitUntilAssistantTurns(base1, project.rootWorkspaceId, 1);
          // The pending safe step crosses the process boundary: submitted,
          // not yet answered, then SIGKILL.
          await submitHumanMessage(
            base1,
            project.projectId,
            project.rootWorkspaceId,
            "我刚才让你记住的代码是什么？",
          );
          daemon1.kill("SIGKILL");
          await new Promise<void>((exited) => {
            if (daemon1.exitCode !== null) {
              exited();
              return;
            }
            daemon1.on("exit", () => exited());
          });

          // Episode 2: same database, same identity — a real process restart
          // that must reconcile and complete the pending step.
          const daemon2 = spawnDaemon({
            databaseFile,
            projectId: project.projectId,
            httpPort: daemonPort,
            proxyPort: proxy.port,
            runtime,
          });
          const base2 = `http://127.0.0.1:${daemonPort}`;
          await waitUntilHttpReady(base2);
          const finalEntries = await waitUntilAssistantTurns(
            base2,
            project.rootWorkspaceId,
            2,
          );
          daemon2.kill("SIGKILL");

          return {
            memoryCode,
            finalEntries: finalEntries.map((entry) => ({
              kind: entry.kind,
              body: entry.body,
            })),
            proxyCalls: proxy.calls.map((call) => call.body),
          };
        },
        verify: (result) => {
          // Requests are attributed by their driving input: a turn-1 request
          // carries the turn-1 text as its CURRENT input (turn-2 requests
          // legitimately replay the turn-1 exchange as conversation history).
          const serializes = (body: Record<string, unknown>) =>
            JSON.stringify(body);
          const turn2Question = "我刚才让你记住的代码";
          const turn1Requests = result.proxyCalls.filter(
            (body) =>
              serializes(body).includes("记住代码") &&
              !serializes(body).includes(turn2Question),
          );
          // Exactly one completed effect: the turn-1 provider request must
          // never be replayed after the restart.
          if (turn1Requests.length !== 1) {
            throw new Error(
              `the completed turn-1 effect was replayed or lost: ${turn1Requests.length} provider requests are driven by the turn-1 input`,
            );
          }
          // The recovered request continues from the correct frontier: it is
          // driven by the pending turn-2 message and carries the prior
          // conversation as context.
          const turn2Requests = result.proxyCalls.filter((body) =>
            serializes(body).includes(turn2Question),
          );
          if (turn2Requests.length === 0) {
            throw new Error(
              "the restarted daemon never issued the recovered turn-2 provider request",
            );
          }
          if (!serializes(turn2Requests[0] ?? {}).includes("记住代码")) {
            throw new Error(
              "the recovered request lost the prior conversation context (turn-1 history absent)",
            );
          }
          // External face: exactly two Human/Assistant pairs, the second one
          // answering from the recovered cognition.
          const humans = result.finalEntries.filter(
            (entry) => entry.kind === "HumanConversationTurn",
          );
          const assistants = result.finalEntries.filter(
            (entry) => entry.kind === "AssistantConversationTurn",
          );
          if (humans.length !== 2 || assistants.length !== 2) {
            throw new Error(
              `expected exactly 2 Human/Assistant pairs after recovery, found human=${humans.length} assistant=${assistants.length}`,
            );
          }
          if (!assistants[1]?.body.includes(result.memoryCode)) {
            throw new Error(
              `the recovered assistant turn does not recall the memory code: ${assistants[1]?.body ?? "none"}`,
            );
          }
        },
      });
    },
  );
});
