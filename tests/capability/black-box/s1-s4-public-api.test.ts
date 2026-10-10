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
const LOCAL_READ_TOKEN = "scenario-local-read-token";
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

const macRootGoalMarker = "MAC-P1-BLACKBOX-GOAL";
const childFormationMarker = `MAC-P2-BLACKBOX-${randomUUID().slice(0, 8)}`;
const childFormationName = `black-box-child-${randomUUID().slice(0, 8)}`;
const s2SteerGoalMarker = `MAC-S2-BLACKBOX-${randomUUID().slice(0, 8)}`;
const s2SteerGuidanceMarker = `MAC-S2-STEER-${randomUUID().slice(0, 8)}`;

const startProvider = () =>
  new Promise<{ server: Server; port: number; calls: ProviderCall[] }>(
    (resolveStart) => {
      const calls: ProviderCall[] = [];
      let childFormationProposalSent = false;
      let childFormationFollowupResponded = false;
      const rootAssignmentsProposed = new Set<string>();
      const rootAssignmentFollowupsResponded = new Set<string>();
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
          const latestUserContent = [...call.messages]
            .reverse()
            .find((message) => message.role === "user")?.content;
          const rootGoalMarker = [macRootGoalMarker, s2SteerGoalMarker].find(
            (marker) => latestUserContent?.includes(marker) === true,
          );

          if (
            toolNames.has("propose_workspace") &&
            serialized.includes(childFormationMarker)
          ) {
            if (!childFormationProposalSent) {
              childFormationProposalSent = true;
              sse(
                response,
                toolDelta("propose_workspace", {
                  name: childFormationName,
                  rationale:
                    "A durable child responsibility is needed for this independent area.",
                  responsibilityDraft: {
                    purpose: `Own the ${childFormationMarker} responsibility.`,
                    ownedResponsibilities: [childFormationMarker],
                    obligations: [],
                    includes: [],
                    excludes: [],
                    interfaces: [],
                  },
                  resourceBoundaryDraft: {
                    addresses: [
                      {
                        _tag: "FileTree",
                        path: join(directory, "workspace"),
                      },
                    ],
                  },
                  initialWork: {
                    objective: `Establish the ${childFormationMarker} responsibility.`,
                    why: "Start the newly approved responsibility with bounded work.",
                    constraints: [],
                    completionExpectation:
                      "The child responsibility is initialized.",
                    verificationMission: {
                      goal: "Verify the child responsibility is initialized.",
                      criteria: [
                        {
                          criterionId: "child-initialized",
                          requirement:
                            "The child Workspace has its initial Work.",
                          required: true,
                        },
                      ],
                      riskRequirements: [],
                    },
                  },
                }),
                "tool_calls",
              );
              return;
            }
            if (
              serialized.includes("ProposalRecorded(") &&
              !childFormationFollowupResponded
            ) {
              childFormationFollowupResponded = true;
              sse(
                response,
                { role: "assistant", content: "方案已提交给用户审批。" },
                "stop",
              );
              return;
            }
          }

          if (
            toolNames.has("claim_completion") &&
            serialized.includes(childFormationMarker) &&
            !serialized.includes(macRootGoalMarker) &&
            !serialized.includes(s2SteerGoalMarker)
          ) {
            sse(
              response,
              toolDelta("wait", {
                reason: `Hold initial Work for ${childFormationMarker}.`,
                waitSpec: { mode: "Any", conditions: [{ _tag: "Manual" }] },
              }),
              "tool_calls",
            );
            return;
          }

          if (
            toolNames.has("claim_completion") &&
            serialized.includes(s2SteerGoalMarker)
          ) {
            sse(
              response,
              toolDelta("wait", {
                reason: serialized.includes(s2SteerGuidanceMarker)
                  ? `Await follow-up after ${s2SteerGuidanceMarker}.`
                  : `Hold ${s2SteerGoalMarker} for the user's correction.`,
                waitSpec: { mode: "Any", conditions: [{ _tag: "Manual" }] },
              }),
              "tool_calls",
            );
            return;
          }

          if (
            toolNames.has("assign_work") &&
            !toolNames.has("claim_completion") &&
            rootGoalMarker !== undefined
          ) {
            if (!rootAssignmentsProposed.has(rootGoalMarker)) {
              rootAssignmentsProposed.add(rootGoalMarker);
              sse(
                response,
                toolDelta("assign_work", {
                  objective:
                    rootGoalMarker === macRootGoalMarker
                      ? `Claim ${rootGoalMarker} complete immediately.`
                      : `Hold ${rootGoalMarker} for the user's correction.`,
                  why:
                    rootGoalMarker === macRootGoalMarker
                      ? "exercise the complete MAC-P1 user path"
                      : "exercise the public S2 correction path",
                  constraints:
                    rootGoalMarker === macRootGoalMarker
                      ? ["do not place real orders"]
                      : [],
                  completionExpectation:
                    rootGoalMarker === macRootGoalMarker
                      ? "verified and accepted"
                      : "the Agent incorporates the public steer",
                  verificationMission: {
                    goal: "independently verify the black-box shell observation",
                    criteria: [
                      {
                        criterionId: "bb-criterion",
                        requirement: "shell observation contains BB_VERIFIED",
                        required: true,
                      },
                    ],
                    riskRequirements:
                      rootGoalMarker === macRootGoalMarker
                        ? ["do not place real orders"]
                        : [],
                  },
                  reason:
                    rootGoalMarker === macRootGoalMarker
                      ? "start the bounded goal from the root conversation"
                      : "start Work so the human can steer it",
                }),
                "tool_calls",
              );
              return;
            }
            if (!rootAssignmentFollowupsResponded.has(rootGoalMarker)) {
              rootAssignmentFollowupsResponded.add(rootGoalMarker);
              sse(
                response,
                {
                  role: "assistant",
                  content: "工作已提交，并可在审批后开始。",
                },
                "stop",
              );
              return;
            }
          }

          if (toolNames.has("record_verification_evidence")) {
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
                toolDelta("record_verification_evidence", {
                  criterionId: "bb-criterion",
                  sourceCallRef: "1",
                }),
                "tool_calls",
              );
              return;
            }
            sse(
              response,
              toolDelta("conclude_verification", {
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

          if (toolNames.has("claim_completion")) {
            sse(
              response,
              toolDelta("claim_completion", {
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
      ARBOR_AUTH_TOKENS: `${TOKEN}=${HUMAN},${LOCAL_READ_TOKEN}=user:local`,
      ARBOR_PROJECT_ROOT: join(directory, "workspace"),
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

const localViewHeaders = () => ({
  "content-type": "application/json",
  authorization: `Bearer ${LOCAL_READ_TOKEN}`,
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

const readProjectProfileSelection = async () => {
  const response = await fetch(`${base}/project-resources`, {
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${LOCAL_READ_TOKEN}`,
    },
  });
  const result = (await response.json()) as {
    readonly ok: boolean;
    readonly body?: {
      readonly profiles?: ReadonlyArray<{
        readonly resourceProfileRef: string;
        readonly version: string;
        readonly available: boolean;
      }>;
    };
  };
  if (!response.ok || !result.ok) {
    throw new Error(`project profile catalog unavailable: ${response.status}`);
  }
  const available = result.body?.profiles?.filter(
    (profile) => profile.available,
  );
  if (available?.length !== 1 || available[0] === undefined) {
    throw new Error("expected one available host Project Profile");
  }
  return {
    _tag: "Profile" as const,
    resourceProfileRef: available[0].resourceProfileRef,
    version: available[0].version,
  };
};

const commandEnvelope = (
  projectId: string,
  commandType: string,
  payload: unknown,
) => ({
  commandType,
  commandId: id("cmd"),
  projectId,
  actor: HUMAN,
  issuedAt: new Date().toISOString(),
  payload,
});

const command = async (
  projectId: string,
  commandType: string,
  payload: unknown,
) => {
  const envelope = commandEnvelope(projectId, commandType, payload);
  const response = await post("/commands", envelope);
  expect((response.body as { resolution?: string }).resolution).toBe(
    "Committed",
  );
  return response;
};

const expectExternalOriginDenied = async (
  projectId: string,
  commandType: string,
  payload: unknown,
) => {
  const response = await fetch(`${base}/commands`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify(commandEnvelope(projectId, commandType, payload)),
  });
  const result = (await response.json()) as {
    readonly ok: boolean;
    readonly problem?: {
      readonly code?: string;
      readonly safeDetails?: { readonly reason?: string };
    };
  };
  expect(response.status).toBe(403);
  expect(result).toMatchObject({
    ok: false,
    problem: {
      code: "authority/denied",
      safeDetails: { reason: `UnsupportedOrigin:${commandType}` },
    },
  });
};

const view = async <A>(name: string, request: unknown): Promise<A> => {
  const response = await fetch(`${base}/views/${name}`, {
    method: "POST",
    headers: localViewHeaders(),
    body: JSON.stringify(request),
  });
  const text = await response.text();
  if (text.length === 0) {
    throw new Error(`/views/${name} ${response.status}: empty response body`);
  }
  const payload = JSON.parse(text) as Record<string, unknown>;
  if (!response.ok) {
    throw new Error(
      `/views/${name} ${response.status}: ${JSON.stringify(payload)}`,
    );
  }
  return (payload.body as { value: A }).value;
};

interface DaemonReadinessProbe {
  readonly status: number | null;
  readonly problemCode: string | null;
  readonly transportError: "fetch-failed" | null;
}

const readDaemonReadiness = async (): Promise<DaemonReadinessProbe> => {
  try {
    const response = await fetch(`${base}/views/readiness-probe`, {
      method: "POST",
      headers: localViewHeaders(),
      body: "{}",
    });
    let problemCode: string | null = null;
    try {
      const payload = (await response.json()) as {
        readonly problem?: { readonly code?: unknown };
      };
      const candidate = payload.problem?.code;
      if (
        typeof candidate === "string" &&
        /^transport\/[a-z-]+$/u.test(candidate)
      ) {
        problemCode = candidate;
      }
    } catch {
      // Readiness diagnostics deliberately retain no response body.
    }
    return { status: response.status, problemCode, transportError: null };
  } catch {
    return {
      status: null,
      problemCode: null,
      transportError: "fetch-failed",
    };
  }
};

const waitForDaemonReady = (timeoutMs = 30_000) =>
  waitFor(
    readDaemonReadiness,
    (probe) =>
      probe.status === 404 && probe.problemCode === "transport/unknown-view",
    timeoutMs,
  );

const projectId = id("prj");
const rootWorkspaceId = id("ws");
const rootSessionId = id("ses");
const childWorkspaceId = id("ws");
let workId = id("wrk");
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
    await waitForDaemonReady(60_000);
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
    const resourceSelection = await readProjectProfileSelection();
    await command(projectId, "CreateProject", {
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
        resourceSelection,
        agentBinding: {
          _tag: "ResponsibilityBoundAgentBinding",
          workspaceId: rootWorkspaceId,
        },
        workspacePolicy: { delegationCeiling: 1 },
        workspacePolicyRevision: 0,
        revision: 0,
      },
    });

    await expectExternalOriginDenied(projectId, "CreateChildWorkspace", {
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

    const beforeFormation = await view<{
      nodes: Array<{
        workspaceId: string;
        parentWorkspaceId: string | null;
      }>;
    }>("responsibility-tree", { projectId });
    expect(beforeFormation.nodes).toHaveLength(1);
    expect(beforeFormation.nodes[0]).toMatchObject({
      workspaceId: rootWorkspaceId,
      parentWorkspaceId: null,
    });

    await command(projectId, "SubmitHumanMessage", {
      messageId: id("msg"),
      targetWorkspaceId: rootWorkspaceId,
      bodyRef:
        `请为长期独立责任 ${childFormationMarker} 提议一个子工作区，` +
        "并为该责任给出具体的初始 Work。",
    });
    const formationInbox = await waitFor(
      () =>
        view<{
          unconsumed: Array<{
            entryKey: string;
            kind: string;
            summary: string;
          }>;
        }>("inbox-view", { workspaceId: rootWorkspaceId }),
      (value) =>
        value.unconsumed.some(
          (entry) =>
            entry.kind === "Governance" &&
            /^gov:fpr_[^:]+:\d+$/u.test(entry.entryKey) &&
            entry.summary.includes(childFormationName),
        ),
    );
    const pendingFormation = formationInbox.unconsumed.find(
      (entry) =>
        entry.kind === "Governance" &&
        /^gov:fpr_[^:]+:\d+$/u.test(entry.entryKey) &&
        entry.summary.includes(childFormationName),
    );
    if (pendingFormation === undefined) {
      throw new Error(
        "public Inbox exposed no pending child formation proposal",
      );
    }
    const formationMatch = /^gov:(fpr_[^:]+):(\d+)$/u.exec(
      pendingFormation.entryKey,
    );
    if (formationMatch === null) {
      throw new Error(
        `invalid public formation ref ${pendingFormation.entryKey}`,
      );
    }
    const treeBeforeDecision = await view<{
      nodes: Array<{
        workspaceId: string;
        parentWorkspaceId: string | null;
      }>;
    }>("responsibility-tree", { projectId });
    expect(treeBeforeDecision.nodes).toHaveLength(1);
    expect(treeBeforeDecision.nodes[0]).toMatchObject({
      workspaceId: rootWorkspaceId,
      parentWorkspaceId: null,
    });

    await command(projectId, "RecordDecision", {
      proposalId: formationMatch[1],
      expectedProposalRevision: Number(formationMatch[2]),
      outcome: { _tag: "Approve" },
    });

    const tree = await waitFor(
      () =>
        view<{
          nodes: Array<{
            workspaceId: string;
            parentWorkspaceId: string | null;
            name: string;
            currentWork?: { workId?: string; objective: string };
          }>;
        }>("responsibility-tree", { projectId }),
      (value) =>
        value.nodes.some(
          (node) =>
            node.parentWorkspaceId === rootWorkspaceId &&
            node.name === childFormationName &&
            node.currentWork?.workId !== undefined,
        ),
    );
    const formedChild = tree.nodes.find(
      (node) => node.parentWorkspaceId === rootWorkspaceId,
    );
    expect(formedChild).toMatchObject({
      name: childFormationName,
      currentWork: {
        objective: expect.stringContaining(childFormationMarker),
      },
    });
    expect(tree.nodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          workspaceId: rootWorkspaceId,
          parentWorkspaceId: null,
        }),
        expect.objectContaining({
          parentWorkspaceId: rootWorkspaceId,
        }),
      ]),
    );
  });

  it("S1 keeps high-level conversation, verifies independently and clears current Work after acceptance", async () => {
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
    expect(transcript.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "HumanConversationTurn",
          body: `请记住 ${memoryCode} 并确认。`,
        }),
        expect.objectContaining({
          kind: "AssistantConversationTurn",
          body: expect.stringContaining(memoryCode),
        }),
      ]),
    );

    await command(projectId, "SubmitHumanMessage", {
      messageId: id("msg"),
      targetWorkspaceId: rootWorkspaceId,
      bodyRef:
        `请创建并执行正式目标 ${macRootGoalMarker}。` +
        "约束：不要真实下单。完成标准：经过独立验证并被接受。信息充分，请直接调用 assign_work。",
    });
    const approvalEntry = await waitFor(
      () =>
        view<{
          unconsumed: Array<{
            entryKey: string;
            kind: string;
            summary: string;
          }>;
        }>("inbox-view", { workspaceId: rootWorkspaceId }),
      (value) =>
        value.unconsumed.some(
          (entry) =>
            entry.kind === "Governance" &&
            /^cap:cap_[^:]+:\d+$/u.test(entry.entryKey) &&
            entry.summary.includes(macRootGoalMarker),
        ),
    );
    const pendingApproval = approvalEntry.unconsumed.find(
      (entry) =>
        entry.kind === "Governance" &&
        /^cap:cap_[^:]+:\d+$/u.test(entry.entryKey) &&
        entry.summary.includes(macRootGoalMarker),
    );
    if (pendingApproval === undefined) {
      throw new Error("public Inbox exposed no exact pending approval");
    }
    const approvalMatch = /^cap:(cap_[^:]+):(\d+)$/u.exec(
      pendingApproval.entryKey,
    );
    if (approvalMatch === null) {
      throw new Error(
        `invalid public approval ref ${pendingApproval.entryKey}`,
      );
    }
    const beforeApproval = await view<unknown>("current-work", {
      workspaceId: rootWorkspaceId,
    });
    expect(beforeApproval).toBeNull();
    await command(projectId, "ResolveControlApproval", {
      approvalId: approvalMatch[1],
      expectedRevision: Number(approvalMatch[2]),
      decision: "Approve",
      reason: "approve exact MAC-P1 black-box Work",
    });
    const createdWork = await waitFor(
      () =>
        view<{
          workId?: string;
          objective: string;
          status: string;
          revision: number;
        } | null>("current-work", { workspaceId: rootWorkspaceId }),
      (value) =>
        value?.workId !== undefined &&
        value.objective.includes(macRootGoalMarker) &&
        value.status === "Open",
      45_000,
    );
    if (createdWork?.workId === undefined) {
      throw new Error("approved root goal produced no Work");
    }
    workId = createdWork.workId;
    await waitFor(
      async () => provider.calls,
      (calls) =>
        calls.some((call) => {
          const context = JSON.stringify(call.messages);
          return (
            context.includes(macRootGoalMarker) &&
            context.includes("do not place real orders")
          );
        }),
    );
    let verification: {
      verificationId?: string;
      targetWorkRevision?: number;
      verdict?: string;
      evidenceRefs: string[];
    };
    try {
      verification = await waitFor(
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
    } catch (error) {
      throw new Error(
        `${error instanceof Error ? error.message : String(error)}; daemon=${daemonErrors.join(" | ")}; providerTail=${JSON.stringify(provider.calls.slice(-6))}`,
      );
    }
    expect(verification.targetWorkRevision).toBe(0);
    expect(
      await view<{ workId?: string; status: string } | null>("current-work", {
        workspaceId: rootWorkspaceId,
      }),
    ).toMatchObject({ workId, status: "Open" });
    expect(
      await view<{ acceptance?: unknown }>("verification", { workId }),
    ).not.toHaveProperty("acceptance");

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

  it("S4 preserves accepted evidence after hard restart without provider replay", async () => {
    const callsBeforeRestart = provider.calls.length;
    daemon.kill("SIGKILL");
    await new Promise<void>((resolveExit) =>
      daemon.once("exit", () => resolveExit()),
    );
    daemon = startDaemon();
    await waitForDaemonReady();

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
    const rejectedWorkId = id("wrk");
    await expectExternalOriginDenied(projectId, "AssignWork", {
      workId: rejectedWorkId,
      workspaceId: rootWorkspaceId,
      expectedWorkspaceRevision: 2,
      objective: "External callers cannot create Agent-originated Work.",
      why: "the Root Agent owns AssignWork control",
      constraints: [],
      completionExpectation: "an Agent-created Work",
      verificationMission: {
        goal: "verify Work assignment ownership",
        criteria: [
          {
            criterionId: "agent-assignment",
            requirement: "the Root Agent creates Work through its control path",
            required: true,
          },
        ],
        riskRequirements: [],
      },
      provenance: {
        predecessorWorkId: null,
        reason: "external callers cannot author control provenance",
      },
      revision: 0,
    });

    expect(
      await view<unknown>("current-work", { workspaceId: rootWorkspaceId }),
    ).toBeNull();
    await command(projectId, "SubmitHumanMessage", {
      messageId: id("msg"),
      targetWorkspaceId: rootWorkspaceId,
      bodyRef:
        `请创建并执行目标 ${s2SteerGoalMarker}，然后暂停等待我的局部纠偏。` +
        "请直接调用 assign_work，并保留后续纠偏所需的目标。",
    });
    const approvalInbox = await waitFor(
      () =>
        view<{
          unconsumed: Array<{
            entryKey: string;
            kind: string;
            summary: string;
          }>;
        }>("inbox-view", { workspaceId: rootWorkspaceId }),
      (value) =>
        value.unconsumed.some(
          (entry) =>
            entry.kind === "Governance" &&
            /^cap:cap_[^:]+:\d+$/u.test(entry.entryKey) &&
            entry.summary.includes(s2SteerGoalMarker),
        ),
    );
    const pendingApproval = approvalInbox.unconsumed.find(
      (entry) =>
        entry.kind === "Governance" &&
        /^cap:cap_[^:]+:\d+$/u.test(entry.entryKey) &&
        entry.summary.includes(s2SteerGoalMarker),
    );
    if (pendingApproval === undefined) {
      throw new Error("public Inbox exposed no exact S2 Work approval");
    }
    const approvalMatch = /^cap:(cap_[^:]+):(\d+)$/u.exec(
      pendingApproval.entryKey,
    );
    if (approvalMatch === null) {
      throw new Error(
        `invalid public approval ref ${pendingApproval.entryKey}`,
      );
    }
    expect(
      await view<unknown>("current-work", { workspaceId: rootWorkspaceId }),
    ).toBeNull();
    await command(projectId, "ResolveControlApproval", {
      approvalId: approvalMatch[1],
      expectedRevision: Number(approvalMatch[2]),
      decision: "Approve",
      reason: "approve exact S2 Root Agent Work before user steer",
    });
    const assignedWork = await waitFor(
      () =>
        view<{
          workId?: string;
          objective: string;
          revision: number;
          status: string;
        } | null>("current-work", { workspaceId: rootWorkspaceId }),
      (value) =>
        value?.workId !== undefined &&
        value.objective.includes(s2SteerGoalMarker) &&
        value.status === "Open",
    );
    if (assignedWork?.workId === undefined) {
      throw new Error("approved S2 goal produced no Open Work");
    }
    await waitFor(
      async () => provider.calls,
      (calls) =>
        calls.some(
          (call) =>
            call.tools.some(
              (tool) => tool.function?.name === "claim_completion",
            ) && JSON.stringify(call.messages).includes(s2SteerGoalMarker),
        ),
    );
    expect(
      provider.calls.some((call) =>
        JSON.stringify(call.messages).includes(s2SteerGuidanceMarker),
      ),
    ).toBe(false);

    await command(projectId, "SteerWork", {
      workId: assignedWork.workId,
      workspaceId: rootWorkspaceId,
      expectedWorkRevision: assignedWork.revision,
      steer: {
        severity: "Normal",
        guidance: s2SteerGuidanceMarker,
      },
      provenance: { source: "HumanInput" },
    });
    const revisedWork = await waitFor(
      () =>
        view<{
          workId?: string;
          revision: number;
          status: string;
        } | null>("current-work", { workspaceId: rootWorkspaceId }),
      (value) =>
        value !== null &&
        value.workId === assignedWork.workId &&
        value.revision === assignedWork.revision + 1,
    );
    expect(revisedWork?.status).toBe("Open");
    await waitFor(
      async () => provider.calls,
      (calls) =>
        calls.some(
          (call) =>
            call.tools.some(
              (tool) => tool.function?.name === "claim_completion",
            ) && JSON.stringify(call.messages).includes(s2SteerGuidanceMarker),
        ),
    );
    expect(daemonErrors).toEqual([]);
  });
});
