import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const DAEMON_ENTRY = resolve("apps/single-workspace/dist/main.js");
const WEB_DIST = resolve("apps/web/dist");
const TOKEN = "scenario-black-box-token";
const HUMAN = "user:scenario-black-box";

const uuidV7 = () => {
  const chars = randomUUID().replaceAll("-", "").split("");
  chars[12] = "7";
  chars[16] = "8";
  return [
    chars.slice(0, 8).join(""),
    chars.slice(8, 12).join(""),
    chars.slice(12, 16).join(""),
    chars.slice(16, 20).join(""),
    chars.slice(20).join(""),
  ].join("-");
};

const id = (prefix: string) => `${prefix}_${uuidV7()}`;

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

interface ProviderCall {
  readonly messages: ReadonlyArray<{ role?: string; content?: string }>;
  readonly tools: ReadonlyArray<{
    function?: { name?: string };
  }>;
}

const sse = (
  response: import("node:http").ServerResponse,
  delta: Record<string, unknown>,
  finishReason: "stop" | "tool_calls",
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
      choices: [{ index: 0, delta, finish_reason: null }],
      usage: null,
    })}\n\n`,
  );
  response.write(
    `data: ${JSON.stringify({
      id: `chatcmpl-${randomUUID()}`,
      object: "chat.completion.chunk",
      choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
      usage: {
        prompt_tokens: 10,
        completion_tokens: 5,
        total_tokens: 15,
      },
    })}\n\n`,
  );
  response.end("data: [DONE]\n\n");
};

const toolDelta = (name: string, args: unknown) => ({
  role: "assistant",
  tool_calls: [
    {
      index: 0,
      id: `call_${randomUUID().replaceAll("-", "")}`,
      type: "function",
      function: { name, arguments: JSON.stringify(args) },
    },
  ],
});

const startProvider = () =>
  new Promise<{ server: Server; port: number; calls: ProviderCall[] }>(
    (resolveStart) => {
      const calls: ProviderCall[] = [];
      const server = createServer((request, response) => {
        const chunks: Buffer[] = [];
        request.on("data", (chunk: Buffer) => chunks.push(chunk));
        request.on("end", () => {
          const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
            messages?: ProviderCall["messages"];
            tools?: ProviderCall["tools"];
          };
          const call: ProviderCall = {
            messages: body.messages ?? [],
            tools: body.tools ?? [],
          };
          calls.push(call);
          const toolNames = new Set(
            call.tools
              .map((tool) => tool.function?.name)
              .filter((name): name is string => name !== undefined),
          );
          const serialized = JSON.stringify(call.messages);

          if (toolNames.has("arbor_record_verification_evidence")) {
            const evidenceIds = [
              ...serialized.matchAll(/evd_[0-9a-f-]{36}/gu),
            ].map((match) => match[0]);
            if (!serialized.includes("exitCode")) {
              sse(
                response,
                toolDelta("shell", {
                  command: "Write-Output BB_VERIFIED",
                  cwd: { mount: "workspace", path: "." },
                }),
                "tool_calls",
              );
              return;
            }
            if (evidenceIds.length === 0) {
              sse(
                response,
                toolDelta("arbor_record_verification_evidence", {
                  criterionId: "bb-criterion",
                  sourceCallRef: "1",
                }),
                "tool_calls",
              );
              return;
            }
            sse(
              response,
              toolDelta("arbor_conclude_verification", {
                verdict: "Pass",
                criteriaResults: [
                  {
                    criterionId: "bb-criterion",
                    requirement: "shell observation contains BB_VERIFIED",
                    required: true,
                    verdict: "Pass",
                    evidenceRefs: [evidenceIds.at(-1)],
                  },
                ],
                summary: "Black-box verifier observed BB_VERIFIED.",
              }),
              "tool_calls",
            );
            return;
          }

          if (toolNames.has("arbor_claim_completion")) {
            sse(
              response,
              toolDelta("arbor_claim_completion", {
                claim: "black-box work complete",
              }),
              "tool_calls",
            );
            return;
          }

          const memory = serialized.match(/BB-MEMORY-[A-Z0-9-]+/u)?.[0];
          sse(
            response,
            {
              role: "assistant",
              content: memory === undefined ? "BLACKBOX_ACK" : memory,
            },
            "stop",
          );
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
    },
  );

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
      // startup/read races are retried until the public deadline
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 200));
  }
  throw new Error(`black-box timeout; last=${JSON.stringify(last)}`);
};

let directory: string;
let databaseFile: string;
let httpPort: number;
let base: string;
let provider: Awaited<ReturnType<typeof startProvider>>;
let daemon: ChildProcess;
const daemonErrors: string[] = [];

const startDaemon = () => {
  const child = spawn("node", [DAEMON_ENTRY], {
    cwd: directory,
    env: {
      ...process.env,
      ARBOR_DB: databaseFile,
      ARBOR_HTTP_PORT: String(httpPort),
      ARBOR_HTTP_HOST: "127.0.0.1",
      ARBOR_WEB_DIST: WEB_DIST,
      ARBOR_AUTH_TOKENS: `${TOKEN}=${HUMAN}`,
      ARBOR_MODEL_BASE_URL: `http://127.0.0.1:${provider.port}/v1`,
      ARBOR_MODEL_NAME: "scenario-black-box",
      ARBOR_MODEL_API_KEY_VAR: "ARBOR_SCENARIO_TEST_KEY",
      ARBOR_SCENARIO_TEST_KEY: "test-only",
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    const text = chunk.toString("utf8").trim();
    if (text.length > 0 && !text.includes("ExperimentalWarning")) {
      daemonErrors.push(text);
    }
  });
  child.on("error", (error) => {
    daemonErrors.push(`spawn error=${error.message}`);
  });
  return child;
};

const headers = () => ({
  "content-type": "application/json",
  authorization: `Bearer ${TOKEN}`,
});

const post = async (path: string, body: unknown) => {
  const response = await fetch(`${base}${path}`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify(body),
  });
  const text = await response.text();
  if (text.length === 0) {
    throw new Error(`${path} ${response.status}: empty response body`);
  }
  const payload = JSON.parse(text) as Record<string, unknown>;
  if (!response.ok) {
    throw new Error(`${path} ${response.status}: ${JSON.stringify(payload)}`);
  }
  return payload;
};

const command = async (
  projectId: string,
  commandType: string,
  payload: unknown,
) => {
  const response = await post("/commands", {
    commandType,
    commandId: id("cmd"),
    projectId,
    actor: HUMAN,
    issuedAt: new Date().toISOString(),
    payload,
  });
  expect((response.body as { resolution?: string }).resolution).toBe(
    "Committed",
  );
  return response;
};

const view = async <A>(name: string, request: unknown): Promise<A> => {
  const response = await post(`/views/${name}`, request);
  return (response.body as { value: A }).value;
};

const projectId = id("prj");
const rootWorkspaceId = id("ws");
const rootSessionId = id("ses");
const childWorkspaceId = id("ws");
const workId = id("wrk");
const memoryCode = `BB-MEMORY-${randomUUID().slice(0, 8).toUpperCase()}`;

beforeAll(async () => {
  directory = mkdtempSync(join(tmpdir(), "arbor-scenario-black-box-"));
  mkdirSync(join(directory, "workspace"), { recursive: true });
  databaseFile = join(directory, "slice.db");
  httpPort = await freePort();
  base = `http://127.0.0.1:${httpPort}`;
  provider = await startProvider();
  daemon = startDaemon();
  try {
    await waitFor(
      () => fetch(base),
      (response) => response.ok,
      60_000,
    );
  } catch (error) {
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}; pid=${String(daemon.pid)}; exit=${String(daemon.exitCode)}; daemon=${daemonErrors.join(" | ")}; entry=${DAEMON_ENTRY}; cwd=${directory}`,
    );
  }
}, 75_000);

afterAll(async () => {
  if (daemon.exitCode === null) daemon.kill("SIGKILL");
  await new Promise<void>((resolveClose) =>
    provider.server.close(() => resolveClose()),
  );
  rmSync(directory, { recursive: true, force: true, maxRetries: 3 });
});

describe("S1-S4 public-process black-box", () => {
  it("S1/S3 creates a project and a visible first-layer responsibility tree", async () => {
    await command(projectId, "CreateProject", {
      projectId,
      name: "Scenario black-box",
      revision: 0,
      projectPolicy: { delegationCeiling: 1 },
      projectPolicyRevision: 0,
      defaultConfiguration: {},
      environmentRef: "local",
      rootWorkspaceId,
      primarySession: { sessionId: rootSessionId, contextEpoch: 0 },
      rootWorkspace: {
        name: "root",
        responsibilityDefinition: {
          purpose: "black-box root",
          ownedResponsibilities: [],
          obligations: [],
          includes: [],
          excludes: [],
          interfaces: [],
        },
        responsibilityRevision: 0,
        resourceBoundary: {
          basisResponsibilityRevision: 0,
          addresses: [
            { _tag: "FileTree", path: join(directory, "workspace") },
            { _tag: "GitWorktree", path: join(directory, "workspace") },
          ],
        },
        resourceBoundaryRevision: 0,
        agentBinding: {
          _tag: "ResponsibilityBoundAgentBinding",
          workspaceId: rootWorkspaceId,
        },
        workspacePolicy: { delegationCeiling: 1 },
        workspacePolicyRevision: 0,
        revision: 0,
      },
    });

    await command(projectId, "CreateChildWorkspace", {
      parentWorkspaceId: rootWorkspaceId,
      workspaceId: childWorkspaceId,
      primarySession: { sessionId: id("ses"), contextEpoch: 0 },
      name: "child-observer",
      responsibilityDefinition: {
        purpose: "black-box child responsibility",
        ownedResponsibilities: [],
        obligations: [],
        includes: [],
        excludes: [],
        interfaces: [],
      },
      responsibilityRevision: 0,
      resourceBoundary: {
        basisResponsibilityRevision: 0,
        addresses: [],
      },
      resourceBoundaryRevision: 0,
      agentBinding: {
        _tag: "ResponsibilityBoundAgentBinding",
        workspaceId: childWorkspaceId,
      },
      workspacePolicy: {},
      workspacePolicyRevision: 0,
      revision: 0,
    });

    const tree = await view<{
      nodes: Array<{
        workspaceId: string;
        parentWorkspaceId: string | null;
      }>;
    }>("responsibility-tree", { projectId });
    expect(tree.nodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          workspaceId: rootWorkspaceId,
          parentWorkspaceId: null,
        }),
        expect.objectContaining({
          workspaceId: childWorkspaceId,
          parentWorkspaceId: rootWorkspaceId,
        }),
      ]),
    );
  });

  it("S1 keeps high-level conversation, verifies independently and completes only after acceptance", async () => {
    await command(projectId, "SubmitHumanMessage", {
      messageId: id("msg"),
      targetWorkspaceId: rootWorkspaceId,
      bodyRef: `请记住 ${memoryCode} 并确认。`,
    });
    const transcript = await waitFor(
      () =>
        view<{ entries: Array<{ kind: string; body?: string }> }>(
          "transcript",
          { workspaceId: rootWorkspaceId, limit: 20 },
        ),
      (page) =>
        page.entries.some(
          (entry) =>
            entry.kind === "AssistantConversationTurn" &&
            entry.body?.includes(memoryCode) === true,
        ),
    );
    expect(
      transcript.entries.some((entry) => entry.body?.includes(memoryCode)),
    ).toBe(true);

    await command(projectId, "AssignWork", {
      workId,
      workspaceId: rootWorkspaceId,
      expectedWorkspaceRevision: 0,
      objective: "Claim this black-box work complete immediately.",
      why: "exercise S1 delivery",
      constraints: [],
      completionExpectation: "verified and accepted",
      verificationMission: {
        goal: "independently verify the black-box shell observation",
        criteria: [
          {
            criterionId: "bb-criterion",
            requirement: "shell observation contains BB_VERIFIED",
            required: true,
          },
        ],
        riskRequirements: [],
      },
      provenance: { predecessorWorkId: null, reason: "black-box" },
      revision: 0,
    });
    const verification = await waitFor(
      () =>
        view<{
          verificationId?: string;
          targetWorkRevision?: number;
          verdict?: string;
          evidenceRefs: string[];
        }>("verification", { workId }),
      (value) => value.verdict === "Pass" && value.evidenceRefs.length === 1,
      45_000,
    );
    expect(verification.targetWorkRevision).toBe(0);

    await command(projectId, "AcceptWorkOutcome", {
      acceptanceId: id("acc"),
      workId,
      targetWorkRevision: 0,
      verificationId: verification.verificationId,
    });
    await waitFor(
      () => view<unknown>("current-work", { workspaceId: rootWorkspaceId }),
      (value) => value === null,
    );
    const accepted = await view<{ acceptance?: { acceptanceId: string } }>(
      "verification",
      { workId },
    );
    expect(accepted.acceptance?.acceptanceId).toMatch(/^acc_/u);
  }, 60_000);

  it("S4 survives a hard process restart without replaying completed work", async () => {
    const callsBeforeRestart = provider.calls.length;
    daemon.kill("SIGKILL");
    await new Promise<void>((resolveExit) =>
      daemon.once("exit", () => resolveExit()),
    );
    daemon = startDaemon();
    await waitFor(
      () => fetch(base),
      (response) => response.ok,
    );

    const tree = await view<{ nodes: Array<{ workspaceId: string }> }>(
      "responsibility-tree",
      { projectId },
    );
    expect(tree.nodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ workspaceId: rootWorkspaceId }),
      ]),
    );
    const verification = await view<{ verdict?: string; acceptance?: unknown }>(
      "verification",
      { workId },
    );
    expect(verification.verdict).toBe("Pass");
    expect(verification.acceptance).toBeDefined();
    await new Promise((resolveWait) => setTimeout(resolveWait, 1_500));
    expect(provider.calls.length).toBe(callsBeforeRestart);
    expect(daemonErrors).toEqual([]);
  }, 30_000);

  it("S2 applies a local steer through the public command face", async () => {
    const steeredWorkId = id("wrk");
    await command(projectId, "AssignWork", {
      workId: steeredWorkId,
      workspaceId: rootWorkspaceId,
      expectedWorkspaceRevision: 2,
      objective: "Hold for an S2 steer, then claim completion.",
      why: "exercise user correction",
      constraints: [],
      completionExpectation: "steer accepted",
      verificationMission: {
        goal: "verify steer path",
        criteria: [
          {
            criterionId: "bb-criterion",
            requirement: "shell observation contains BB_VERIFIED",
            required: true,
          },
        ],
        riskRequirements: [],
      },
      provenance: { predecessorWorkId: null, reason: "black-box-steer" },
      revision: 0,
    });
    await command(projectId, "SteerWork", {
      workId: steeredWorkId,
      workspaceId: rootWorkspaceId,
      expectedWorkRevision: 0,
      steer: {
        severity: "Normal",
        guidance: `BB-STEER-${randomUUID().slice(0, 8)}`,
      },
      provenance: { source: "HumanInput" },
    });
  });
});
