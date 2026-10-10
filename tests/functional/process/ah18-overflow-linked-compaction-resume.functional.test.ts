import { createHash, randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  type ProductionFixture,
  startProductionFixture,
} from "../support/production-fixture.js";
import {
  createFunctionalProject,
  type FunctionalProject,
  functionalId,
  makePublicClient,
  submitHumanMessage,
  waitForApproval,
  waitForPublic,
} from "../support/public-client.js";

interface Ah18Probe {
  readonly tag: "AH18_PROBE";
  readonly boundary: string;
  readonly executionId: string;
  readonly providerTurnId: string;
  readonly attemptNo?: number;
  readonly failureKind?: string;
}

interface Ah4Probe {
  readonly tag: "AH_PROBE";
  readonly boundary: string;
  readonly providerTurnId?: string;
}

interface ProviderRequest {
  readonly kind: "initial-inference" | "summary" | "replacement-inference";
  readonly messages: ReadonlyArray<{ role?: string; content?: string }>;
  readonly tools: ReadonlyArray<{ function?: { name?: string } }>;
}

interface SeedProviderRequest {
  readonly kind: "root" | "work";
  readonly messages: ProviderRequest["messages"];
  readonly tools: ProviderRequest["tools"];
}

interface Ah18Snapshot {
  readonly session: { session_id: string; context_epoch: number } | undefined;
  readonly checkpoints: Array<{
    sequence: number;
    context_epoch: number;
    source_kind: string;
    source_ref: string;
    payload_json: string;
    content_hash: string;
  }>;
  readonly providerTurns: Array<{
    provider_turn_id: string;
    execution_id: string;
    session_id: string;
    context_epoch: number;
    manifest_id: string;
    settled_at: string | null;
    finish_reason: string | null;
    manifest_json: string | null;
    portable_request_json: string | null;
  }>;
  readonly manifests: Array<{
    provider_turn_id: string;
    manifest_id: string;
    execution_id: string;
    context_epoch: number;
    manifest_json: string;
    portable_request_json: string | null;
  }>;
  readonly providerAttempts: Array<{
    provider_turn_id: string;
    attempt_no: number;
    outcome: string;
    provider_error_kind: string | null;
    failure_taxonomy_version: string | null;
    retry_safety: string | null;
    retry_decision: string | null;
    retry_strategy: string | null;
    retry_reason: string | null;
    canonical_event_prefix_json: string;
    delivered_position: number | null;
    settled_at: string | null;
  }>;
  readonly step:
    | {
        execution_id: string;
        logical_step_no: number;
        repair_attempt: number;
        provider_turn_id: string;
        state: string;
        settlement_json: string | null;
      }
    | undefined;
  readonly steps: Array<{
    logical_step_no: number;
    repair_attempt: number;
    state: string;
    settlement_json: string | null;
  }>;
  readonly links: Array<{
    logical_step_no: number;
    repair_attempt: number;
    overflow_ordinal: number;
    role: string;
    provider_turn_id: string;
    predecessor_provider_turn_id: string | null;
    context_epoch: number;
    state: string;
  }>;
  readonly execution:
    | {
        execution_id: string;
        settled_at: string | null;
        settlement_kind: string | null;
      }
    | undefined;
  readonly leases: Array<{
    execution_id: string;
    generation: number;
    expires_at: string;
  }>;
  readonly workWait:
    | {
        work_id: string;
        wait_mode: string;
        conditions_json: string;
      }
    | undefined;
  readonly actions: Array<{
    action_index: number;
    action_kind: string;
    state: string;
  }>;
  readonly durableOutputs: Array<{
    item_type: string;
    source_ref: string | null;
  }>;
  readonly work: { work_id: string; lifecycle: string } | undefined;
}

const fixtures: ProductionFixture[] = [];
const providerServers: Server[] = [];
const ah18Child = resolve(
  "tests/functional/support/ah18-overflow-crash-child.mjs",
);
const ahCrashChild = resolve("tests/functional/support/ah-crash-child.mjs");
const boundaries = [
  "AH18BeforeOverflowLinksCommit",
  "AH18AfterOverflowLinksCommit",
  "AH18BeforeSummaryTurnCommit",
  "AH18AfterSummaryTurnCommit",
] as const;
type Ah18Boundary = (typeof boundaries)[number];
type Ah18CrashBoundary = Ah18Boundary | "AH18BeforeInferenceFailTurnCommit";

const sendText = (
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
      id: `chatcmpl-ah18-${crypto.randomUUID()}`,
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
      id: `chatcmpl-ah18-${crypto.randomUUID()}`,
      object: "chat.completion.chunk",
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    })}\n\n`,
  );
  response.end("data: [DONE]\n\n");
};

const sendContextLimit = (response: import("node:http").ServerResponse) => {
  response.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  response.end(
    `data: ${JSON.stringify({
      error: {
        message: "context length exceeded",
        type: "invalid_request_error",
        code: "context_length_exceeded",
      },
    })}\n\n`,
  );
};

const sendManualWait = (response: import("node:http").ServerResponse) => {
  response.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  response.write(
    `data: ${JSON.stringify({
      id: `chatcmpl-ah18-${crypto.randomUUID()}`,
      object: "chat.completion.chunk",
      choices: [
        {
          index: 0,
          delta: {
            role: "assistant",
            tool_calls: [
              {
                index: 0,
                id: `call_${crypto.randomUUID().replaceAll("-", "")}`,
                type: "function",
                function: {
                  name: "wait",
                  arguments: JSON.stringify({
                    reason: "finish the recovered overflow replacement once",
                    waitSpec: {
                      mode: "Any",
                      conditions: [{ _tag: "Manual" }],
                    },
                  }),
                },
              },
            ],
          },
          finish_reason: null,
        },
      ],
      usage: null,
    })}\n\n`,
  );
  response.write(
    `data: ${JSON.stringify({
      id: `chatcmpl-ah18-${crypto.randomUUID()}`,
      object: "chat.completion.chunk",
      choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    })}\n\n`,
  );
  response.end("data: [DONE]\n\n");
};

const sendRootAssignWork = (
  response: import("node:http").ServerResponse,
  marker: string,
  objective: string,
) => {
  response.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  response.write(
    `data: ${JSON.stringify({
      id: `chatcmpl-ah18-${crypto.randomUUID()}`,
      object: "chat.completion.chunk",
      choices: [
        {
          index: 0,
          delta: {
            role: "assistant",
            tool_calls: [
              {
                index: 0,
                id: `call_${crypto.randomUUID().replaceAll("-", "")}`,
                type: "function",
                function: {
                  name: "assign_work",
                  arguments: JSON.stringify({
                    objective,
                    why: `create the publicly approved AH18 Work for ${marker}`,
                    constraints: [],
                    completionExpectation:
                      "the overflow recovery completes the same logical step",
                    verificationMission: {
                      goal: `Verify the AH18 overflow journey for ${marker}`,
                      criteria: [
                        {
                          criterionId: "ah18-public-work",
                          requirement:
                            "the approved Work reaches the requested AH18 journey",
                          required: true,
                        },
                      ],
                      riskRequirements: [],
                    },
                    reason: "AH18 public functional seed",
                  }),
                },
              },
            ],
          },
          finish_reason: null,
        },
      ],
      usage: null,
    })}\n\n`,
  );
  response.write(
    `data: ${JSON.stringify({
      id: `chatcmpl-ah18-${crypto.randomUUID()}`,
      object: "chat.completion.chunk",
      choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    })}\n\n`,
  );
  response.end("data: [DONE]\n\n");
};

const ah18WorkObjective = (marker: string) =>
  `Recover one AH18 overflow chain for ${marker}.`;

const ah18SteerGuidance = (marker: string) =>
  `AH18 target overflow provider turn ${marker}`;

const startOverflowProvider = async (
  marker: string,
  replacementOutcome: "manual-wait" | "context-limit" = "manual-wait",
  summaryFirstAttempt: "hold" | "transport-failure" | undefined = undefined,
) => {
  const requests: ProviderRequest[] = [];
  const seedRequests: SeedProviderRequest[] = [];
  let inferenceCalls = 0;
  let summaryCalls = 0;
  let overflowArmed = false;
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
        messages?: ProviderRequest["messages"];
        tools?: ProviderRequest["tools"];
      };
      const messages = body.messages ?? [];
      const messageText = messages
        .map((message) => message.content ?? "")
        .join("\n");
      const tools = body.tools ?? [];
      const toolNames = new Set(
        tools
          .map((tool) => tool.function?.name)
          .filter((name): name is string => name !== undefined),
      );
      if (
        !messageText.includes(marker) &&
        !messageText.includes("Produce a compact continuation summary")
      ) {
        response.writeHead(422, { "content-type": "application/json" });
        response.end(
          JSON.stringify({ error: { message: "unrelated AH18 request" } }),
        );
        return;
      }
      if (messageText.includes(ah18SteerGuidance(marker))) {
        overflowArmed = true;
      }
      if (!overflowArmed && messageText.includes(marker)) {
        if (
          toolNames.has("assign_work") &&
          !toolNames.has("claim_completion")
        ) {
          seedRequests.push({ kind: "root", messages, tools });
          if (messageText.includes("WorkAssigned(")) {
            sendText(response, `AH18 Work admitted for ${marker}.`);
          } else {
            sendRootAssignWork(response, marker, ah18WorkObjective(marker));
          }
          return;
        }
        if (toolNames.has("wait")) {
          seedRequests.push({ kind: "work", messages, tools });
          sendManualWait(response);
          return;
        }
        response.writeHead(422, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            error: { message: "AH18 public seed stage gated" },
          }),
        );
        return;
      }
      if (messageText.includes("Produce a compact continuation summary")) {
        requests.push({ kind: "summary", messages, tools });
        const summaryAttemptNo = summaryCalls;
        summaryCalls += 1;
        if (summaryAttemptNo === 0 && summaryFirstAttempt === "hold") {
          // The durable Attempt is already InProgress when the request reaches
          // this server. The process test kills the daemon while this response
          // is held open, then the restarted server request succeeds.
          return;
        }
        if (
          summaryAttemptNo === 0 &&
          summaryFirstAttempt === "transport-failure"
        ) {
          // A pre-response transport failure is replay-safe under P9; the
          // fixture's long persisted backoff leaves a deterministic kill seam.
          response.destroy();
          return;
        }
        sendText(response, `Compacted continuation for ${marker}.`);
        return;
      }
      inferenceCalls += 1;
      if (inferenceCalls === 1) {
        requests.push({ kind: "initial-inference", messages, tools });
        sendContextLimit(response);
        return;
      }
      if (inferenceCalls === 2) {
        requests.push({ kind: "replacement-inference", messages, tools });
        if (replacementOutcome === "context-limit") {
          sendContextLimit(response);
        } else {
          sendManualWait(response);
        }
        return;
      }
      requests.push({ kind: "replacement-inference", messages, tools });
      sendManualWait(response);
    });
  });
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("AH18 local Provider server has no TCP address");
  }
  return {
    server,
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    requests,
    seedRequests,
  };
};

const readSnapshot = (
  databaseFile: string,
  input: {
    readonly sessionId: string;
    readonly executionId: string;
    readonly workId: string;
  },
): Ah18Snapshot => {
  const db = new DatabaseSync(databaseFile, { readOnly: true });
  try {
    db.exec("BEGIN DEFERRED");
    const snapshot: Ah18Snapshot = {
      session: db
        .prepare(
          "SELECT session_id, context_epoch FROM sessions WHERE session_id = ?",
        )
        .get(input.sessionId) as Ah18Snapshot["session"],
      checkpoints: db
        .prepare(
          `SELECT sequence, context_epoch, source_kind, source_ref, payload_json, content_hash
             FROM session_entries
            WHERE session_id = ? AND item_type = 'CompactionCheckpoint'
            ORDER BY sequence`,
        )
        .all(input.sessionId) as Ah18Snapshot["checkpoints"],
      providerTurns: db
        .prepare(
          `SELECT pt.provider_turn_id, pt.execution_id, pt.session_id,
                  pt.context_epoch, pt.manifest_id, pt.settled_at,
                  pt.finish_reason, m.manifest_json, m.portable_request_json
             FROM provider_turns pt
             LEFT JOIN model_context_manifests m
               ON m.provider_turn_id = pt.provider_turn_id
              AND m.manifest_id = pt.manifest_id
            WHERE pt.execution_id = ? ORDER BY pt.provider_turn_id`,
        )
        .all(input.executionId) as Ah18Snapshot["providerTurns"],
      manifests: db
        .prepare(
          `SELECT provider_turn_id, manifest_id, execution_id, context_epoch,
                  manifest_json, portable_request_json
             FROM model_context_manifests WHERE execution_id = ?
            ORDER BY provider_turn_id, manifest_id`,
        )
        .all(input.executionId) as Ah18Snapshot["manifests"],
      providerAttempts: db
        .prepare(
          `SELECT pa.provider_turn_id, pa.attempt_no, pa.outcome,
                  pa.provider_error_kind, pa.failure_taxonomy_version,
                  pa.retry_safety, pa.retry_decision, pa.retry_strategy,
                  pa.retry_reason, pa.canonical_event_prefix_json,
                  pa.delivered_position, pa.settled_at
             FROM provider_attempts pa
             JOIN provider_turns pt
               ON pt.provider_turn_id = pa.provider_turn_id
            WHERE pt.execution_id = ?
            ORDER BY pa.provider_turn_id, pa.attempt_no`,
        )
        .all(input.executionId) as Ah18Snapshot["providerAttempts"],
      step: db
        .prepare(
          `SELECT execution_id, logical_step_no, repair_attempt, provider_turn_id,
                  state, settlement_json
             FROM agent_loop_steps WHERE execution_id = ?
            ORDER BY logical_step_no, repair_attempt LIMIT 1`,
        )
        .get(input.executionId) as Ah18Snapshot["step"],
      steps: db
        .prepare(
          `SELECT logical_step_no, repair_attempt, state, settlement_json
             FROM agent_loop_steps WHERE execution_id = ?
            ORDER BY logical_step_no, repair_attempt`,
        )
        .all(input.executionId) as Ah18Snapshot["steps"],
      links: db
        .prepare(
          `SELECT logical_step_no, repair_attempt, overflow_ordinal, role, provider_turn_id,
                  predecessor_provider_turn_id, context_epoch, state
             FROM agent_loop_step_provider_turns WHERE execution_id = ?
            ORDER BY overflow_ordinal, role`,
        )
        .all(input.executionId) as Ah18Snapshot["links"],
      execution: db
        .prepare(
          `SELECT execution_id, settled_at, settlement_kind
             FROM executions WHERE execution_id = ?`,
        )
        .get(input.executionId) as Ah18Snapshot["execution"],
      leases: db
        .prepare(
          "SELECT execution_id, generation, expires_at FROM execution_leases WHERE execution_id = ?",
        )
        .all(input.executionId) as Ah18Snapshot["leases"],
      workWait: db
        .prepare(
          "SELECT work_id, wait_mode, conditions_json FROM work_waits WHERE work_id = ?",
        )
        .get(input.workId) as Ah18Snapshot["workWait"],
      actions: db
        .prepare(
          `SELECT action_index, action_kind, state
             FROM agent_loop_step_actions WHERE execution_id = ?
            ORDER BY logical_step_no, repair_attempt, action_index`,
        )
        .all(input.executionId) as Ah18Snapshot["actions"],
      durableOutputs: db
        .prepare(
          `SELECT item_type, source_ref FROM session_entries
            WHERE session_id = ? AND item_type IN
              ('AssistantMessage','ModelOutput','ToolCall','ToolResult','ControlResult','Observation')
            ORDER BY sequence`,
        )
        .all(input.sessionId) as Ah18Snapshot["durableOutputs"],
      work: db
        .prepare("SELECT work_id, lifecycle FROM works WHERE work_id = ?")
        .get(input.workId) as Ah18Snapshot["work"],
    };
    db.exec("ROLLBACK");
    return snapshot;
  } finally {
    db.close();
  }
};

const readWorkExecutionId = (databaseFile: string, workId: string) => {
  const db = new DatabaseSync(databaseFile, { readOnly: true });
  try {
    return db
      .prepare(
        `SELECT execution_id FROM executions
          WHERE episode_kind = 'WorkEpisode' AND episode_ref = ?
          ORDER BY admitted_at DESC LIMIT 1`,
      )
      .get(workId)?.execution_id as string | undefined;
  } finally {
    db.close();
  }
};

const admitAh18PublicWork = async (
  client: ReturnType<typeof makePublicClient>,
  project: FunctionalProject,
  marker: string,
) => {
  const objective = ah18WorkObjective(marker);
  await submitHumanMessage(
    client,
    project,
    `Please create an AH18 overflow-recovery Work ${marker}: ${objective}`,
  );
  const approval = await waitForApproval(client, project, marker);
  expect(
    await client.view("current-work", {
      workspaceId: project.rootWorkspaceId,
    }),
  ).toBeNull();
  await client.command(project.projectId, "ResolveControlApproval", {
    approvalId: approval.approvalId,
    expectedRevision: approval.revision,
    decision: "Approve",
    reason: "AH18 public Work admission",
  });
  const currentWork = await waitForPublic(
    () =>
      client.view<{
        workId?: string;
        objective?: string;
        revision: number;
        status: string;
      } | null>("current-work", {
        workspaceId: project.rootWorkspaceId,
      }),
    (work) => work?.workId !== undefined && work.objective === objective,
  );
  const workId = currentWork?.workId;
  if (currentWork === null || workId === undefined) {
    throw new Error("AH18 public Root approval did not expose the Open Work");
  }
  expect(currentWork).toMatchObject({ objective, revision: 0, status: "Open" });
  return { workId, revision: currentWork.revision };
};

const waitForAh18ManualSeed = async (input: {
  readonly client: ReturnType<typeof makePublicClient>;
  readonly fixture: ProductionFixture;
  readonly project: FunctionalProject;
  readonly provider: Awaited<ReturnType<typeof startOverflowProvider>>;
  readonly workId: string;
}) => {
  await waitForPublic(
    async () =>
      input.provider.seedRequests.filter((request) => request.kind === "work")
        .length,
    (count) => count === 1,
  );
  await waitForPublic(
    () =>
      input.client.view<{
        workId?: string;
        revision: number;
        status: string;
        activeExecution?: { executionId: string };
      } | null>("current-work", {
        workspaceId: input.project.rootWorkspaceId,
      }),
    (work) =>
      work?.workId === input.workId &&
      work.revision === 0 &&
      work.status === "Open" &&
      work.activeExecution === undefined,
  );
  const seedExecutionId = await waitForPublic(
    async () => readWorkExecutionId(input.fixture.databaseFile, input.workId),
    (id) => id !== undefined,
  );
  if (seedExecutionId === undefined) {
    throw new Error("AH18 Manual-wait seed WorkEpisode was not admitted");
  }
  const seedSnapshot = readSnapshot(input.fixture.databaseFile, {
    sessionId: input.project.rootSessionId,
    executionId: seedExecutionId,
    workId: input.workId,
  });
  expect(seedSnapshot.session).toEqual({
    session_id: input.project.rootSessionId,
    context_epoch: 0,
  });
  expect(seedSnapshot.checkpoints).toEqual([]);
  expect(seedSnapshot.providerTurns).toHaveLength(1);
  expect(seedSnapshot.providerAttempts).toHaveLength(1);
  expect(seedSnapshot.providerAttempts[0]).toMatchObject({
    outcome: "Success",
    provider_error_kind: null,
  });
  expect(seedSnapshot.execution?.settlement_kind).not.toBe("Failed");
  expect(seedSnapshot.workWait).toMatchObject({
    work_id: input.workId,
    wait_mode: "Any",
  });
  expect(JSON.parse(seedSnapshot.workWait?.conditions_json ?? "[]")).toEqual([
    { _tag: "Manual" },
  ]);
  expect(
    input.provider.seedRequests.some((request) => request.kind === "root"),
  ).toBe(true);
  expect(input.provider.requests).toEqual([]);
  return { seedExecutionId, seedSnapshot };
};

const startAh18MeasuredWork = async (input: {
  readonly client: ReturnType<typeof makePublicClient>;
  readonly fixture: ProductionFixture;
  readonly project: FunctionalProject;
  readonly provider: Awaited<ReturnType<typeof startOverflowProvider>>;
  readonly marker: string;
  readonly restartOptions?: Parameters<ProductionFixture["restart"]>[0];
}) => {
  const sourceWork = await admitAh18PublicWork(
    input.client,
    input.project,
    input.marker,
  );
  const seed = await waitForAh18ManualSeed({
    client: input.client,
    fixture: input.fixture,
    project: input.project,
    provider: input.provider,
    workId: sourceWork.workId,
  });
  await input.fixture.crash();
  await input.fixture.restart(input.restartOptions);
  await input.client.command(input.project.projectId, "SteerWork", {
    workId: sourceWork.workId,
    workspaceId: input.project.rootWorkspaceId,
    expectedWorkRevision: sourceWork.revision,
    steer: {
      severity: "Normal",
      guidance: ah18SteerGuidance(input.marker),
    },
    provenance: { source: "HumanInput" },
  });
  const executionId = await waitForPublic(
    async () =>
      readWorkExecutionId(input.fixture.databaseFile, sourceWork.workId),
    (id) => id !== undefined && id !== seed.seedExecutionId,
  );
  if (executionId === undefined) {
    throw new Error("AH18 measured WorkEpisode did not follow its Manual seed");
  }
  expect(executionId).not.toBe(seed.seedExecutionId);
  expect(
    input.provider.seedRequests.filter((request) => request.kind === "work"),
  ).toHaveLength(1);
  return {
    workId: sourceWork.workId,
    seedExecutionId: seed.seedExecutionId,
    executionId,
  };
};

const startAtBoundary = async (boundary: Ah18CrashBoundary) => {
  const marker = `AH18-${randomUUID().slice(0, 8)}`;
  probes.length = 0;
  const provider = await startOverflowProvider(marker);
  providerServers.push(provider.server);
  const fixture = await startProductionFixture({
    reply: () => ({ _tag: "HttpError", status: 500 }),
    daemonEnvironment: {
      ARBOR_MODEL_BASE_URL: provider.baseUrl,
    },
    onDaemonStdout: (line) => {
      try {
        const probe = JSON.parse(line) as Ah18Probe;
        if (probe.tag === "AH18_PROBE") probes.push(probe);
      } catch {
        // Keep non-probe daemon output in the fixture for diagnostics.
      }
    },
  });
  fixtures.push(fixture);
  const client = makePublicClient(fixture.baseUrl);
  const project = await createFunctionalProject(
    client,
    fixture.workspaceDirectory,
    `AH18 linked overflow recovery ${marker}`,
  );
  const measured = await startAh18MeasuredWork({
    client,
    fixture,
    project,
    provider,
    marker,
    restartOptions: {
      entry: ah18Child,
      daemonEnvironment: {
        ARBOR_AH18_BOUNDARY: boundary,
        ARBOR_MODEL_BASE_URL: provider.baseUrl,
      },
    },
  });
  const { workId, seedExecutionId, executionId } = measured;
  expect(executionId).not.toBe(seedExecutionId);
  const boundaryProbe = await waitForPublic(
    async () => probes.find((probe) => probe.boundary === boundary),
    (probe) => probe !== undefined,
    45_000,
  ).catch((error: unknown) => {
    throw new Error(
      `AH18 boundary absent at ${boundary}: ${error instanceof Error ? error.message : String(error)}; requests=${JSON.stringify(provider.requests.map((request) => request.kind))}; daemon=${fixture.daemonErrors.join(" | ")}`,
    );
  });
  if (boundaryProbe === undefined) {
    throw new Error(`AH18 probe missing at ${boundary}`);
  }
  expect(boundaryProbe.executionId).toBe(executionId);
  expect(provider.requests.map((request) => request.kind)).toEqual([
    "initial-inference",
  ]);
  return {
    marker,
    provider,
    fixture,
    project,
    workId,
    seedExecutionId,
    boundaryProbe,
  };
};

const waitForExpiredLease = async (
  fixture: ProductionFixture,
  project: { readonly rootSessionId: string },
  executionId: string,
  workId: string,
) =>
  waitForPublic(
    async () =>
      readSnapshot(fixture.databaseFile, {
        sessionId: project.rootSessionId,
        executionId,
        workId,
      }).leases.find((lease) => lease.execution_id === executionId),
    (lease) =>
      lease !== undefined && Date.parse(lease.expires_at) <= Date.now(),
    35_000,
  );

const insertOrphanCompactionManifest = (
  databaseFile: string,
  input: {
    readonly providerTurnId: string;
    readonly executionId: string;
    readonly sessionId: string;
    readonly manifestId: string;
  },
) => {
  const request = JSON.stringify({
    requestVersion: 2,
    operationKind: "CompactionSummary",
    modelRef: "model-openai",
    instructions: [],
    inputItems: [],
    toolDefinitions: [],
    outputContractRef: "compaction-result-v1",
    budget: { maxOutputTokens: 2048 },
    cacheHints: [],
  });
  const manifest = JSON.stringify({
    providerTurnId: input.providerTurnId,
    executionId: input.executionId,
    sessionId: input.sessionId,
    contextEpoch: 0,
    modelRef: "model-openai",
    outputContractRef: "compaction-result-v1",
    compiledRequestHash: createHash("sha256").update(request).digest("hex"),
    operationKind: "CompactionSummary",
    logicalStepNo: 0,
    resolvedModelBindingFingerprint: "legacy:provider-openai:model-openai",
  });
  const compiledRequestHash = createHash("sha256")
    .update(request)
    .digest("hex");
  const db = new DatabaseSync(databaseFile);
  try {
    db.exec("PRAGMA foreign_keys = OFF");
    db.exec("BEGIN IMMEDIATE");
    db.prepare(
      `INSERT INTO model_context_manifests
         (manifest_id, provider_turn_id, execution_id, session_id,
          context_epoch, model_ref, compiled_request_hash, manifest_json,
          created_at, portable_request_json)
       VALUES (?, ?, ?, ?, 0, 'model-openai', ?, ?, ?, ?)`,
    ).run(
      input.manifestId,
      input.providerTurnId,
      input.executionId,
      input.sessionId,
      compiledRequestHash,
      manifest,
      new Date().toISOString(),
      request,
    );
    db.exec("COMMIT");
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // Preserve the original SQL setup error.
    }
    throw error;
  } finally {
    db.close();
  }
};

const corruptSummaryBinding = (
  databaseFile: string,
  input: {
    readonly providerTurnId: string;
    readonly manifestId: string;
    readonly corruption: "manifest-context-epoch" | "turn-context-epoch";
  },
) => {
  const db = new DatabaseSync(databaseFile);
  try {
    db.exec("BEGIN IMMEDIATE");
    let changedRows: number;
    if (input.corruption === "manifest-context-epoch") {
      const row = db
        .prepare(
          `SELECT manifest_json FROM model_context_manifests
            WHERE provider_turn_id = ? AND manifest_id = ?`,
        )
        .get(input.providerTurnId, input.manifestId) as
        | { manifest_json: string }
        | undefined;
      if (row === undefined) {
        throw new Error("AH18 Summary manifest is absent before corruption");
      }
      const manifest = JSON.parse(row.manifest_json) as {
        contextEpoch?: number;
      };
      manifest.contextEpoch = 1;
      const result = db
        .prepare(
          `UPDATE model_context_manifests SET manifest_json = ?
            WHERE provider_turn_id = ? AND manifest_id = ?`,
        )
        .run(JSON.stringify(manifest), input.providerTurnId, input.manifestId);
      changedRows = Number(result.changes);
    } else {
      const result = db
        .prepare(
          "UPDATE provider_turns SET context_epoch = 1 WHERE provider_turn_id = ? AND manifest_id = ?",
        )
        .run(input.providerTurnId, input.manifestId);
      changedRows = Number(result.changes);
    }
    if (changedRows !== 1) {
      throw new Error(
        `AH18 expected exactly one row for ${input.corruption}; changes=${String(changedRows)}`,
      );
    }
    db.exec("COMMIT");
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // Preserve the original SQL setup error.
    }
    throw error;
  } finally {
    db.close();
  }
};

const probes: Ah18Probe[] = [];

afterEach(async () => {
  for (const fixture of fixtures.splice(0)) await fixture.stop();
  for (const server of providerServers.splice(0)) {
    if (!server.listening) continue;
    await new Promise<void>((resolveClose, rejectClose) => {
      server.close((error) => {
        if (error !== undefined) rejectClose(error);
        else resolveClose();
      });
    });
  }
});

describe("AH18 linked overflow compaction recovery", () => {
  it.each(boundaries)(
    "resumes one ordinal-0 Summary Turn after process crash at %s",
    async (boundary) => {
      const { marker, provider, fixture, project, workId, boundaryProbe } =
        await startAtBoundary(boundary);
      const executionId = boundaryProbe.executionId;
      const initialInferenceId = `ptn_${executionId}_0`;
      const compactionId = `ptn_${executionId}_0_compact_0`;
      const replacementId = `ptn_${executionId}_0_overflow_0`;
      expect(boundaryProbe.providerTurnId).toBe(compactionId);

      const beforeKill = readSnapshot(fixture.databaseFile, {
        sessionId: project.rootSessionId,
        executionId,
        workId,
      });
      expect(beforeKill.session).toEqual({
        session_id: project.rootSessionId,
        context_epoch: 0,
      });
      expect(beforeKill.checkpoints).toEqual([]);
      expect(beforeKill.step).toMatchObject({
        execution_id: executionId,
        logical_step_no: 0,
        repair_attempt: 0,
        provider_turn_id: initialInferenceId,
        state: "Prepared",
      });
      expect(beforeKill.providerTurns).toHaveLength(
        boundary === "AH18AfterSummaryTurnCommit" ? 2 : 1,
      );
      expect(
        beforeKill.providerTurns.find(
          (turn) => turn.provider_turn_id === initialInferenceId,
        ),
      ).toMatchObject({
        provider_turn_id: initialInferenceId,
        execution_id: executionId,
        session_id: project.rootSessionId,
        context_epoch: 0,
        settled_at: expect.any(String),
        finish_reason: "Failed",
      });
      expect(beforeKill.providerAttempts).toEqual([
        expect.objectContaining({
          provider_turn_id: initialInferenceId,
          attempt_no: 0,
          outcome: "TerminalFailure",
          provider_error_kind: "ContextLimitExceeded",
          failure_taxonomy_version: "phase1-v2",
          settled_at: expect.any(String),
        }),
      ]);
      expect(beforeKill.links.map((link) => link.role)).toEqual(
        boundary === "AH18BeforeOverflowLinksCommit"
          ? []
          : ["Inference", "OverflowCompaction"],
      );
      const beforeSummaryTurn = beforeKill.providerTurns.find(
        (turn) => turn.provider_turn_id === compactionId,
      );
      const beforeSummaryManifest = beforeKill.manifests.find(
        (manifest) => manifest.provider_turn_id === compactionId,
      );
      if (boundary === "AH18AfterSummaryTurnCommit") {
        expect(beforeSummaryTurn).toMatchObject({
          provider_turn_id: compactionId,
          context_epoch: 0,
          settled_at: null,
          finish_reason: null,
          manifest_json: expect.any(String),
          portable_request_json: expect.any(String),
        });
        expect(beforeSummaryManifest).toMatchObject({
          provider_turn_id: compactionId,
          manifest_id: beforeSummaryTurn?.manifest_id,
          manifest_json: beforeSummaryTurn?.manifest_json,
          portable_request_json: beforeSummaryTurn?.portable_request_json,
        });
        expect(
          beforeKill.providerAttempts.some(
            (attempt) => attempt.provider_turn_id === compactionId,
          ),
        ).toBe(false);
        expect(
          beforeKill.manifests.filter(
            (manifest) => manifest.provider_turn_id === compactionId,
          ),
        ).toHaveLength(1);
      } else {
        expect(beforeSummaryTurn).toBeUndefined();
        expect(
          beforeKill.manifests.filter(
            (manifest) => manifest.provider_turn_id === compactionId,
          ),
        ).toHaveLength(0);
      }
      expect(provider.requests).toEqual([
        expect.objectContaining({ kind: "initial-inference" }),
      ]);

      await fixture.crash();
      const afterOldKill = readSnapshot(fixture.databaseFile, {
        sessionId: project.rootSessionId,
        executionId,
        workId,
      });
      expect(afterOldKill.session).toEqual(beforeKill.session);
      expect(afterOldKill.checkpoints).toEqual([]);
      expect(afterOldKill.providerTurns).toEqual(beforeKill.providerTurns);
      expect(afterOldKill.providerAttempts).toEqual(
        beforeKill.providerAttempts,
      );
      if (
        boundary === "AH18BeforeOverflowLinksCommit" ||
        boundary === "AH18AfterOverflowLinksCommit"
      ) {
        expect(afterOldKill.links).toEqual(beforeKill.links);
      }
      if (boundary === "AH18AfterSummaryTurnCommit") {
        expect(
          afterOldKill.manifests.find(
            (manifest) => manifest.provider_turn_id === compactionId,
          ),
        ).toEqual(beforeSummaryManifest);
      }
      if (
        boundary === "AH18BeforeSummaryTurnCommit" ||
        boundary === "AH18AfterSummaryTurnCommit"
      ) {
        expect(afterOldKill.links).toEqual(beforeKill.links);
      }

      await waitForPublic(
        async () =>
          readSnapshot(fixture.databaseFile, {
            sessionId: project.rootSessionId,
            executionId,
            workId,
          }).leases.find((lease) => lease.execution_id === executionId),
        (lease) =>
          lease !== undefined && Date.parse(lease.expires_at) <= Date.now(),
        35_000,
      );
      await fixture.restart().catch((error: unknown) => {
        throw new Error(
          `AH18 ordinary daemon restart failed: ${error instanceof Error ? error.message : String(error)}; snapshot=${JSON.stringify(readSnapshot(fixture.databaseFile, { sessionId: project.rootSessionId, executionId, workId }))}; providerRequests=${JSON.stringify(provider.requests.map((request) => request.kind))}; daemon=${fixture.daemonErrors.join(" | ")}`,
        );
      });

      const recovered = await waitForPublic(
        async () =>
          readSnapshot(fixture.databaseFile, {
            sessionId: project.rootSessionId,
            executionId,
            workId,
          }),
        (snapshot) =>
          snapshot.session?.context_epoch === 1 &&
          snapshot.checkpoints.length === 1 &&
          snapshot.execution?.settlement_kind === "Completed" &&
          snapshot.workWait !== undefined,
        90_000,
      ).catch((error: unknown) => {
        throw new Error(
          `AH18 linked compaction did not resume: ${error instanceof Error ? error.message : String(error)}; snapshot=${JSON.stringify(readSnapshot(fixture.databaseFile, { sessionId: project.rootSessionId, executionId, workId }))}; requests=${JSON.stringify(provider.requests.map((request) => request.kind))}; daemon=${fixture.daemonErrors.join(" | ")}`,
        );
      });

      expect(recovered.session).toEqual({
        session_id: project.rootSessionId,
        context_epoch: 1,
      });
      expect(recovered.checkpoints).toHaveLength(1);
      expect(recovered.checkpoints[0]).toMatchObject({
        context_epoch: 1,
        source_kind: "CompactionTurn",
        source_ref: compactionId,
      });
      expect(
        JSON.parse(recovered.checkpoints[0]?.payload_json ?? "{}"),
      ).toMatchObject({
        _tag: "CompactionCheckpoint",
        implementation: "Summary",
        fromEpoch: 0,
        toEpoch: 1,
        summaryText: `Compacted continuation for ${marker}.`,
      });
      expect(recovered.providerTurns).toHaveLength(3);
      expect(recovered.manifests).toHaveLength(3);
      const initialInference = recovered.providerTurns.find(
        (turn) => turn.provider_turn_id === initialInferenceId,
      );
      const summaryTurn = recovered.providerTurns.find(
        (turn) => turn.provider_turn_id === compactionId,
      );
      const replacementTurn = recovered.providerTurns.find(
        (turn) => turn.provider_turn_id === replacementId,
      );
      const recoveredSummaryManifest = recovered.manifests.find(
        (manifest) => manifest.provider_turn_id === compactionId,
      );
      expect(initialInference?.manifest_json).toBe(
        beforeKill.providerTurns[0]?.manifest_json,
      );
      if (boundary === "AH18AfterSummaryTurnCommit") {
        expect(summaryTurn).toMatchObject({
          manifest_id: beforeSummaryManifest?.manifest_id,
          manifest_json: beforeSummaryManifest?.manifest_json,
          portable_request_json: beforeSummaryManifest?.portable_request_json,
        });
        expect(recoveredSummaryManifest).toEqual(beforeSummaryManifest);
      }
      expect(summaryTurn).toMatchObject({
        provider_turn_id: compactionId,
        execution_id: executionId,
        context_epoch: 0,
        finish_reason: "Stop",
        settled_at: expect.any(String),
      });
      expect(replacementTurn).toMatchObject({
        provider_turn_id: replacementId,
        execution_id: executionId,
        context_epoch: 1,
        settled_at: expect.any(String),
      });
      expect(recovered.providerAttempts).toHaveLength(3);
      expect(recovered.providerAttempts).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            provider_turn_id: initialInferenceId,
            attempt_no: 0,
            outcome: "TerminalFailure",
            provider_error_kind: "ContextLimitExceeded",
          }),
          expect.objectContaining({
            provider_turn_id: compactionId,
            attempt_no: 0,
            outcome: "Success",
          }),
          expect.objectContaining({
            provider_turn_id: replacementId,
            attempt_no: 0,
            outcome: "Success",
          }),
        ]),
      );
      expect(recovered.links).toEqual([
        expect.objectContaining({
          overflow_ordinal: 0,
          role: "Inference",
          provider_turn_id: initialInferenceId,
          context_epoch: 0,
          state: "SettledFailure",
        }),
        expect.objectContaining({
          overflow_ordinal: 0,
          role: "OverflowCompaction",
          provider_turn_id: compactionId,
          predecessor_provider_turn_id: initialInferenceId,
          context_epoch: 0,
          state: "Prepared",
        }),
        expect.objectContaining({
          overflow_ordinal: 0,
          role: "OverflowReplacement",
          provider_turn_id: replacementId,
          predecessor_provider_turn_id: compactionId,
          context_epoch: 1,
          state: "Prepared",
        }),
      ]);
      expect(recovered.step).toMatchObject({
        execution_id: executionId,
        logical_step_no: 0,
        repair_attempt: 0,
        provider_turn_id: initialInferenceId,
      });
      expect(provider.requests.map((request) => request.kind)).toEqual([
        "initial-inference",
        "summary",
        "replacement-inference",
      ]);
      expect(recovered.workWait).toBeDefined();
      expect(fixture.daemonErrors).toEqual([]);
    },
    150_000,
  );

  it("recovers from terminal Attempt evidence when the original failTurn transaction is killed before commit", async () => {
    const boundary = "AH18BeforeInferenceFailTurnCommit";
    const scenario = await startAtBoundary(boundary);
    const { fixture, provider, project, workId, boundaryProbe } = scenario;
    const executionId = boundaryProbe.executionId;
    const initialInferenceId = `ptn_${executionId}_0`;
    const compactionId = `ptn_${executionId}_0_compact_0`;
    const replacementId = `ptn_${executionId}_0_overflow_0`;
    expect(boundaryProbe.providerTurnId).toBe(initialInferenceId);

    const ids = {
      sessionId: project.rootSessionId,
      executionId,
      workId,
    };
    const beforeKill = readSnapshot(fixture.databaseFile, ids);
    const beforeTurn = beforeKill.providerTurns.find(
      (turn) => turn.provider_turn_id === initialInferenceId,
    );
    const beforeAttempt = beforeKill.providerAttempts.find(
      (attempt) => attempt.provider_turn_id === initialInferenceId,
    );
    expect(beforeKill.session).toEqual({
      session_id: project.rootSessionId,
      context_epoch: 0,
    });
    expect(beforeKill.checkpoints).toEqual([]);
    expect(beforeKill.step).toMatchObject({
      execution_id: executionId,
      logical_step_no: 0,
      repair_attempt: 0,
      provider_turn_id: initialInferenceId,
      state: "Prepared",
    });
    expect(beforeTurn).toMatchObject({
      provider_turn_id: initialInferenceId,
      execution_id: executionId,
      session_id: project.rootSessionId,
      context_epoch: 0,
      settled_at: null,
      finish_reason: null,
      manifest_id: expect.any(String),
      manifest_json: expect.any(String),
      portable_request_json: expect.any(String),
    });
    expect(beforeAttempt).toMatchObject({
      provider_turn_id: initialInferenceId,
      attempt_no: 0,
      outcome: "TerminalFailure",
      provider_error_kind: "ContextLimitExceeded",
      failure_taxonomy_version: "phase1-v2",
      retry_safety: expect.any(String),
      retry_decision: expect.any(String),
      retry_reason: expect.any(String),
      canonical_event_prefix_json: expect.any(String),
      delivered_position: 0,
      settled_at: expect.any(String),
    });
    expect(
      JSON.parse(beforeAttempt?.canonical_event_prefix_json ?? "null"),
    ).toEqual(expect.any(Array));
    expect(beforeKill.links).toEqual([]);
    expect(beforeKill.providerTurns).toHaveLength(1);
    expect(beforeKill.providerAttempts).toHaveLength(1);
    expect(provider.requests.map((request) => request.kind)).toEqual([
      "initial-inference",
    ]);

    await fixture.crash();
    const afterOldKill = readSnapshot(fixture.databaseFile, ids);
    expect(afterOldKill.session).toEqual(beforeKill.session);
    expect(afterOldKill.checkpoints).toEqual([]);
    expect(afterOldKill.step).toEqual(beforeKill.step);
    expect(afterOldKill.providerTurns).toEqual(beforeKill.providerTurns);
    expect(afterOldKill.providerAttempts).toEqual(beforeKill.providerAttempts);
    expect(afterOldKill.links).toEqual([]);
    expect(provider.requests.map((request) => request.kind)).toEqual([
      "initial-inference",
    ]);

    await waitForExpiredLease(fixture, project, executionId, workId);
    await fixture.restart().catch((error: unknown) => {
      throw new Error(
        `AH18 restart after failTurn rollback failed: ${error instanceof Error ? error.message : String(error)}; snapshot=${JSON.stringify(readSnapshot(fixture.databaseFile, ids))}; requests=${JSON.stringify(provider.requests.map((request) => request.kind))}; daemon=${fixture.daemonErrors.join(" | ")}`,
      );
    });
    const recovered = await waitForPublic(
      async () => readSnapshot(fixture.databaseFile, ids),
      (snapshot) =>
        snapshot.session?.context_epoch === 1 &&
        snapshot.checkpoints.length === 1 &&
        snapshot.execution?.settlement_kind === "Completed" &&
        snapshot.workWait !== undefined,
      90_000,
    ).catch((error: unknown) => {
      throw new Error(
        `AH18 did not recover from terminal Attempt evidence: ${error instanceof Error ? error.message : String(error)}; snapshot=${JSON.stringify(readSnapshot(fixture.databaseFile, ids))}; requests=${JSON.stringify(provider.requests.map((request) => request.kind))}; daemon=${fixture.daemonErrors.join(" | ")}`,
      );
    });

    const recoveredTurn = recovered.providerTurns.find(
      (turn) => turn.provider_turn_id === initialInferenceId,
    );
    expect(recovered.providerTurns).toHaveLength(3);
    expect(recovered.providerAttempts).toHaveLength(3);
    expect(recoveredTurn).toMatchObject({
      settled_at: expect.any(String),
      finish_reason: "Failed",
      manifest_id: beforeTurn?.manifest_id,
      manifest_json: beforeTurn?.manifest_json,
      portable_request_json: beforeTurn?.portable_request_json,
    });
    expect(
      recovered.providerAttempts.find(
        (attempt) => attempt.provider_turn_id === initialInferenceId,
      ),
    ).toEqual(beforeAttempt);
    expect(recovered.links).toEqual([
      expect.objectContaining({
        overflow_ordinal: 0,
        role: "Inference",
        provider_turn_id: initialInferenceId,
        context_epoch: 0,
        state: "SettledFailure",
      }),
      expect.objectContaining({
        overflow_ordinal: 0,
        role: "OverflowCompaction",
        provider_turn_id: compactionId,
        predecessor_provider_turn_id: initialInferenceId,
        context_epoch: 0,
      }),
      expect.objectContaining({
        overflow_ordinal: 0,
        role: "OverflowReplacement",
        provider_turn_id: replacementId,
        predecessor_provider_turn_id: compactionId,
        context_epoch: 1,
      }),
    ]);
    expect(recovered.steps).toEqual([
      expect.objectContaining({ logical_step_no: 0, repair_attempt: 0 }),
    ]);
    expect(provider.requests.map((request) => request.kind)).toEqual([
      "initial-inference",
      "summary",
      "replacement-inference",
    ]);
    expect(fixture.daemonErrors).toEqual([]);
  }, 150_000);

  it.each(["in-progress", "retryable-failure"] as const)(
    "resumes the link-pinned Summary ProviderTurn after a hard crash with Attempt 0 %s",
    async (summaryAttemptState) => {
      const marker = `AH18-summary-attempt-${randomUUID().slice(0, 8)}`;
      const provider = await startOverflowProvider(
        marker,
        "manual-wait",
        summaryAttemptState === "in-progress" ? "hold" : "transport-failure",
      );
      providerServers.push(provider.server);
      const summaryFailureProbes: Ah18Probe[] = [];
      const fixture = await startProductionFixture({
        reply: () => ({ _tag: "HttpError", status: 500 }),
        daemonEnvironment: {
          ARBOR_MODEL_BASE_URL: provider.baseUrl,
        },
        onDaemonStdout: (line: string) => {
          try {
            const probe = JSON.parse(line) as Ah18Probe;
            if (
              probe.tag === "AH18_PROBE" &&
              probe.boundary === "AH18AfterSummaryRetryableFailureCommit"
            ) {
              summaryFailureProbes.push(probe);
            }
          } catch {
            // Preserve non-probe diagnostics from the real daemon.
          }
        },
      });
      fixtures.push(fixture);
      const client = makePublicClient(fixture.baseUrl);
      const project = await createFunctionalProject(
        client,
        fixture.workspaceDirectory,
        `AH18 Summary Attempt recovery ${marker}`,
      );
      const measured = await startAh18MeasuredWork({
        client,
        fixture,
        project,
        provider,
        marker,
        ...(summaryAttemptState === "retryable-failure"
          ? {
              restartOptions: {
                entry: ah18Child,
                daemonEnvironment: {
                  ARBOR_AH18_BOUNDARY: "AH18AfterSummaryRetryableFailureCommit",
                  ARBOR_MODEL_BASE_URL: provider.baseUrl,
                },
              },
            }
          : {}),
      });
      const { workId, executionId } = measured;
      const inferenceId = `ptn_${executionId}_0`;
      const compactionId = `ptn_${executionId}_0_compact_0`;
      const replacementId = `ptn_${executionId}_0_overflow_0`;
      expect(compactionId).toBe(`ptn_${executionId}_0_compact_0`);

      if (summaryAttemptState === "in-progress") {
        await waitForPublic(
          async () =>
            provider.requests.filter((request) => request.kind === "summary")
              .length,
          (count) => count === 1,
          45_000,
        );
      } else {
        const retryProbe = await waitForPublic(
          async () => summaryFailureProbes[0],
          (probe) => probe !== undefined,
          30_000,
        );
        expect(retryProbe).toMatchObject({
          boundary: "AH18AfterSummaryRetryableFailureCommit",
          providerTurnId: compactionId,
          attemptNo: 0,
          failureKind: "TransportFailed",
        });
      }

      const ids = { sessionId: project.rootSessionId, executionId, workId };
      const beforeKill = readSnapshot(fixture.databaseFile, ids);
      const summaryTurnBefore = beforeKill.providerTurns.find(
        (turn) => turn.provider_turn_id === compactionId,
      );
      const summaryManifestBefore = beforeKill.manifests.find(
        (manifest) => manifest.provider_turn_id === compactionId,
      );
      expect(beforeKill.session).toEqual({
        session_id: project.rootSessionId,
        context_epoch: 0,
      });
      expect(beforeKill.checkpoints).toEqual([]);
      expect(beforeKill.step).toMatchObject({
        execution_id: executionId,
        logical_step_no: 0,
        repair_attempt: 0,
        provider_turn_id: inferenceId,
        state: "Prepared",
      });
      expect(beforeKill.links.map((link) => link.role)).toEqual([
        "Inference",
        "OverflowCompaction",
      ]);
      expect(summaryTurnBefore).toMatchObject({
        provider_turn_id: compactionId,
        execution_id: executionId,
        context_epoch: 0,
        settled_at: null,
        finish_reason: null,
      });
      expect(summaryManifestBefore).toMatchObject({
        provider_turn_id: compactionId,
        manifest_id: summaryTurnBefore?.manifest_id,
        manifest_json: summaryTurnBefore?.manifest_json,
        portable_request_json: summaryTurnBefore?.portable_request_json,
      });
      const summaryAttemptsBefore = beforeKill.providerAttempts.filter(
        (attempt) => attempt.provider_turn_id === compactionId,
      );
      expect(summaryAttemptsBefore).toHaveLength(1);
      if (summaryAttemptState === "in-progress") {
        expect(summaryAttemptsBefore[0]).toMatchObject({
          attempt_no: 0,
          outcome: "InProgress",
          settled_at: null,
        });
      } else {
        expect(summaryAttemptsBefore[0]).toMatchObject({
          attempt_no: 0,
          outcome: "RetryableFailure",
          provider_error_kind: "TransportFailed",
          retry_safety: "SafeReplay",
          retry_decision: "Retry",
          retry_strategy: "Replay",
          settled_at: expect.any(String),
        });
      }
      expect(
        beforeKill.providerAttempts.filter(
          (attempt) => attempt.provider_turn_id === inferenceId,
        ),
      ).toHaveLength(1);
      expect(
        beforeKill.providerAttempts.some(
          (attempt) => attempt.provider_turn_id === replacementId,
        ),
      ).toBe(false);
      expect(
        provider.requests.filter(
          (request) => request.kind === "initial-inference",
        ),
      ).toHaveLength(1);

      await fixture.crash();
      const afterOldKill = readSnapshot(fixture.databaseFile, ids);
      expect(afterOldKill.session).toEqual(beforeKill.session);
      expect(afterOldKill.checkpoints).toEqual([]);
      expect(afterOldKill.providerTurns).toEqual(beforeKill.providerTurns);
      expect(afterOldKill.manifests).toEqual(beforeKill.manifests);
      expect(afterOldKill.providerAttempts).toEqual(
        beforeKill.providerAttempts,
      );
      expect(afterOldKill.links).toEqual(beforeKill.links);
      expect(afterOldKill.step).toEqual(beforeKill.step);
      await waitForExpiredLease(fixture, project, executionId, workId);
      await fixture.restart();

      const recovered = await waitForPublic(
        async () => readSnapshot(fixture.databaseFile, ids),
        (snapshot) =>
          snapshot.session?.context_epoch === 1 &&
          snapshot.checkpoints.length === 1 &&
          snapshot.execution?.settlement_kind === "Completed" &&
          snapshot.workWait !== undefined,
        90_000,
      );
      expect(recovered.checkpoints).toHaveLength(1);
      expect(recovered.checkpoints[0]).toMatchObject({
        context_epoch: 1,
        source_kind: "CompactionTurn",
        source_ref: compactionId,
      });
      expect(recovered.providerTurns).toHaveLength(3);
      expect(recovered.manifests).toHaveLength(3);
      expect(
        recovered.providerTurns.find(
          (turn) => turn.provider_turn_id === compactionId,
        ),
      ).toMatchObject({
        manifest_id: summaryTurnBefore?.manifest_id,
        manifest_json: summaryTurnBefore?.manifest_json,
        portable_request_json: summaryTurnBefore?.portable_request_json,
        context_epoch: 0,
        finish_reason: "Stop",
        settled_at: expect.any(String),
      });
      expect(
        recovered.manifests.find(
          (manifest) => manifest.provider_turn_id === compactionId,
        ),
      ).toEqual(summaryManifestBefore);
      const recoveredSummaryAttempts = recovered.providerAttempts.filter(
        (attempt) => attempt.provider_turn_id === compactionId,
      );
      expect(recoveredSummaryAttempts).toHaveLength(2);
      expect(recoveredSummaryAttempts[0]).toMatchObject({
        attempt_no: 0,
        outcome: "RetryableFailure",
        retry_decision: "Retry",
      });
      expect(recoveredSummaryAttempts[1]).toMatchObject({
        attempt_no: 1,
        outcome: "Success",
      });
      if (summaryAttemptState === "in-progress") {
        expect(recoveredSummaryAttempts[0]).toMatchObject({
          provider_error_kind: null,
          retry_strategy: "Replay",
          retry_reason: expect.stringContaining("ProcessLost retry"),
        });
      } else {
        expect(recoveredSummaryAttempts[0]).toMatchObject({
          provider_error_kind: "TransportFailed",
          retry_safety: "SafeReplay",
          retry_strategy: "Replay",
        });
      }
      expect(recovered.providerAttempts).toHaveLength(4);
      expect(recovered.providerAttempts).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            provider_turn_id: inferenceId,
            attempt_no: 0,
            outcome: "TerminalFailure",
            provider_error_kind: "ContextLimitExceeded",
          }),
          expect.objectContaining({
            provider_turn_id: replacementId,
            attempt_no: 0,
            outcome: "Success",
          }),
        ]),
      );
      expect(recovered.links).toEqual([
        expect.objectContaining({
          logical_step_no: 0,
          repair_attempt: 0,
          overflow_ordinal: 0,
          role: "Inference",
          provider_turn_id: inferenceId,
          state: "SettledFailure",
        }),
        expect.objectContaining({
          logical_step_no: 0,
          repair_attempt: 0,
          overflow_ordinal: 0,
          role: "OverflowCompaction",
          provider_turn_id: compactionId,
          predecessor_provider_turn_id: inferenceId,
          context_epoch: 0,
          state: "Prepared",
        }),
        expect.objectContaining({
          logical_step_no: 0,
          repair_attempt: 0,
          overflow_ordinal: 0,
          role: "OverflowReplacement",
          provider_turn_id: replacementId,
          predecessor_provider_turn_id: compactionId,
          context_epoch: 1,
          state: "Prepared",
        }),
      ]);
      expect(recovered.step).toMatchObject({
        logical_step_no: 0,
        repair_attempt: 0,
        provider_turn_id: inferenceId,
      });
      expect(provider.requests.map((request) => request.kind)).toEqual([
        "initial-inference",
        "summary",
        "summary",
        "replacement-inference",
      ]);
      expect(recovered.workWait).toBeDefined();
      expect(fixture.daemonErrors).toEqual([]);
    },
    150_000,
  );

  it("fails closed when a NotFound Summary Turn has an orphan manifest", async () => {
    const boundary = "AH18AfterOverflowLinksCommit";
    const scenario = await startAtBoundary(boundary);
    const { fixture, provider, project, workId, boundaryProbe } = scenario;
    const executionId = boundaryProbe.executionId;
    const compactionId = boundaryProbe.providerTurnId;
    const initial = readSnapshot(fixture.databaseFile, {
      sessionId: project.rootSessionId,
      executionId,
      workId,
    });
    expect(initial.links.map((link) => link.role)).toEqual([
      "Inference",
      "OverflowCompaction",
    ]);
    expect(
      initial.providerTurns.some(
        (turn) => turn.provider_turn_id === compactionId,
      ),
    ).toBe(false);
    expect(
      initial.manifests.some(
        (manifest) => manifest.provider_turn_id === compactionId,
      ),
    ).toBe(false);

    await fixture.crash();
    await waitForExpiredLease(fixture, project, executionId, workId);
    insertOrphanCompactionManifest(fixture.databaseFile, {
      providerTurnId: compactionId,
      executionId,
      sessionId: project.rootSessionId,
      manifestId: functionalId("mft"),
    });
    const corrupted = readSnapshot(fixture.databaseFile, {
      sessionId: project.rootSessionId,
      executionId,
      workId,
    });
    expect(corrupted.links).toEqual(initial.links);
    expect(
      corrupted.manifests.filter(
        (manifest) => manifest.provider_turn_id === compactionId,
      ),
    ).toHaveLength(1);
    expect(
      corrupted.providerTurns.some(
        (turn) => turn.provider_turn_id === compactionId,
      ),
    ).toBe(false);

    let restartError: unknown;
    try {
      await fixture.restart();
    } catch (error) {
      restartError = error;
    }
    await waitForPublic(
      async () => ({
        errors: fixture.daemonErrors,
        providerRequests: provider.requests.length,
      }),
      (state) => state.errors.length > 0 || state.providerRequests > 1,
      15_000,
    );

    const failedClosed = readSnapshot(fixture.databaseFile, {
      sessionId: project.rootSessionId,
      executionId,
      workId,
    });
    expect(fixture.daemonErrors.length > 0 || restartError !== undefined).toBe(
      true,
    );
    expect(provider.requests.map((request) => request.kind)).toEqual([
      "initial-inference",
    ]);
    expect(failedClosed.session?.context_epoch).toBe(0);
    expect(failedClosed.checkpoints).toEqual([]);
    expect(failedClosed.links).toEqual(initial.links);
    expect(failedClosed.step).toMatchObject({
      logical_step_no: 0,
      repair_attempt: 0,
      state: "Prepared",
    });
    expect(
      failedClosed.providerTurns.some(
        (turn) => turn.provider_turn_id === compactionId,
      ),
    ).toBe(false);
    expect(fixture.daemonErrors.join(" | ")).toMatch(
      /ProtocolViolation|manifest-orphaned|ProviderRuntime|AgentLoopStep/u,
    );
  }, 150_000);

  it.each(["manifest-context-epoch", "turn-context-epoch"] as const)(
    "fails closed when an Unsettled Summary binding is corrupted: %s",
    async (corruption) => {
      const scenario = await startAtBoundary("AH18AfterSummaryTurnCommit");
      const { fixture, provider, project, workId, boundaryProbe } = scenario;
      const executionId = boundaryProbe.executionId;
      const compactionId = boundaryProbe.providerTurnId;
      const initial = readSnapshot(fixture.databaseFile, {
        sessionId: project.rootSessionId,
        executionId,
        workId,
      });
      const summaryTurn = initial.providerTurns.find(
        (turn) => turn.provider_turn_id === compactionId,
      );
      if (summaryTurn === undefined) {
        throw new Error("AH18 Unsettled Summary Turn is missing at probe");
      }
      expect(summaryTurn).toMatchObject({
        context_epoch: 0,
        settled_at: null,
        manifest_json: expect.any(String),
      });
      expect(
        initial.providerAttempts.some(
          (attempt) => attempt.provider_turn_id === compactionId,
        ),
      ).toBe(false);

      await fixture.crash();
      await waitForExpiredLease(fixture, project, executionId, workId);
      corruptSummaryBinding(fixture.databaseFile, {
        providerTurnId: compactionId,
        manifestId: summaryTurn.manifest_id,
        corruption,
      });
      const corrupted = readSnapshot(fixture.databaseFile, {
        sessionId: project.rootSessionId,
        executionId,
        workId,
      });
      expect(corrupted.links).toEqual(initial.links);
      const corruptedSummary = corrupted.providerTurns.find(
        (turn) => turn.provider_turn_id === compactionId,
      );
      expect(corruptedSummary).toBeDefined();
      if (corruption === "manifest-context-epoch") {
        expect(
          JSON.parse(corruptedSummary?.manifest_json ?? "{}").contextEpoch,
        ).toBe(1);
        expect(corruptedSummary?.context_epoch).toBe(0);
      } else {
        expect(corruptedSummary?.context_epoch).toBe(1);
        expect(
          JSON.parse(corruptedSummary?.manifest_json ?? "{}").contextEpoch,
        ).toBe(0);
      }

      let restartError: unknown;
      try {
        await fixture.restart();
      } catch (error) {
        restartError = error;
      }
      await waitForPublic(
        async () => ({
          errors: fixture.daemonErrors,
          providerRequests: provider.requests.length,
        }),
        (state) => state.errors.length > 0 || state.providerRequests > 1,
        15_000,
      );

      const failedClosed = readSnapshot(fixture.databaseFile, {
        sessionId: project.rootSessionId,
        executionId,
        workId,
      });
      expect(
        fixture.daemonErrors.length > 0 || restartError !== undefined,
      ).toBe(true);
      expect(provider.requests.map((request) => request.kind)).toEqual([
        "initial-inference",
      ]);
      expect(failedClosed.session?.context_epoch).toBe(0);
      expect(failedClosed.checkpoints).toEqual([]);
      expect(failedClosed.links).toEqual(initial.links);
      expect(failedClosed.step).toMatchObject({
        logical_step_no: 0,
        repair_attempt: 0,
        state: "Prepared",
      });
      expect(
        failedClosed.links.some((link) => link.role === "OverflowReplacement"),
      ).toBe(false);
      expect(failedClosed.execution?.settled_at).toBeNull();
    },
    150_000,
  );

  it.each([
    "AH4BeforeSettlementProposal",
    "AH4AfterSettlementProposal",
  ] as const)(
    "terminalizes a second ContextLimit without another ordinal at %s",
    async (boundary) => {
      const marker = `AH18-terminal-${randomUUID().slice(0, 8)}`;
      const provider = await startOverflowProvider(marker, "context-limit");
      providerServers.push(provider.server);
      const probes: Ah4Probe[] = [];
      const fixture = await startProductionFixture({
        reply: () => ({ _tag: "HttpError", status: 500 }),
        daemonEnvironment: {
          ARBOR_MODEL_BASE_URL: provider.baseUrl,
        },
        onDaemonStdout: (line) => {
          try {
            const probe = JSON.parse(line) as Ah4Probe;
            if (probe.tag === "AH_PROBE") probes.push(probe);
          } catch {
            // Preserve the real daemon diagnostics on the fixture.
          }
        },
      });
      fixtures.push(fixture);
      const client = makePublicClient(fixture.baseUrl);
      const project = await createFunctionalProject(
        client,
        fixture.workspaceDirectory,
        `AH18 terminal replacement ${marker}`,
      );
      const measured = await startAh18MeasuredWork({
        client,
        fixture,
        project,
        provider,
        marker,
        restartOptions: {
          entry: ahCrashChild,
          daemonEnvironment: {
            ARBOR_AH_BOUNDARY: boundary,
            ARBOR_MODEL_BASE_URL: provider.baseUrl,
          },
        },
      });
      const { workId, executionId } = measured;

      const terminalProbe = await waitForPublic(
        async () => probes.find((probe) => probe.boundary === boundary),
        (probe) => probe !== undefined,
        60_000,
      ).catch((error: unknown) => {
        throw new Error(
          `AH18 terminal proposal probe absent: ${error instanceof Error ? error.message : String(error)}; requests=${JSON.stringify(provider.requests.map((request) => request.kind))}; daemon=${fixture.daemonErrors.join(" | ")}`,
        );
      });
      if (terminalProbe?.providerTurnId === undefined) {
        throw new Error("AH18 terminal overflow probe omitted ProviderTurnId");
      }
      const initialInferenceId = `ptn_${executionId}_0`;
      const compactionId = `ptn_${executionId}_0_compact_0`;
      const replacementId = `ptn_${executionId}_0_overflow_0`;
      expect(terminalProbe.providerTurnId).toBe(replacementId);
      expect(provider.requests.map((request) => request.kind)).toEqual([
        "initial-inference",
        "summary",
        "replacement-inference",
      ]);

      const ids = {
        sessionId: project.rootSessionId,
        executionId,
        workId,
      };
      const beforeKill = readSnapshot(fixture.databaseFile, ids);
      expect(beforeKill.session?.context_epoch).toBe(1);
      expect(beforeKill.checkpoints).toHaveLength(1);
      expect(beforeKill.checkpoints[0]).toMatchObject({
        context_epoch: 1,
        source_kind: "CompactionTurn",
        source_ref: compactionId,
      });
      expect(beforeKill.links).toEqual([
        expect.objectContaining({
          logical_step_no: 0,
          repair_attempt: 0,
          overflow_ordinal: 0,
          role: "Inference",
          provider_turn_id: initialInferenceId,
        }),
        expect.objectContaining({
          logical_step_no: 0,
          repair_attempt: 0,
          overflow_ordinal: 0,
          role: "OverflowCompaction",
          provider_turn_id: compactionId,
        }),
        expect.objectContaining({
          logical_step_no: 0,
          repair_attempt: 0,
          overflow_ordinal: 0,
          role: "OverflowReplacement",
          provider_turn_id: replacementId,
        }),
      ]);
      expect(beforeKill.providerAttempts).toHaveLength(3);
      expect(beforeKill.providerAttempts).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            provider_turn_id: initialInferenceId,
            outcome: "TerminalFailure",
            provider_error_kind: "ContextLimitExceeded",
          }),
          expect.objectContaining({
            provider_turn_id: compactionId,
            outcome: "Success",
          }),
          expect.objectContaining({
            provider_turn_id: replacementId,
            outcome: "TerminalFailure",
            provider_error_kind: "ContextLimitExceeded",
          }),
        ]),
      );
      expect(beforeKill.steps).toEqual([
        expect.objectContaining({
          logical_step_no: 0,
          repair_attempt: 0,
          state:
            boundary === "AH4BeforeSettlementProposal"
              ? "Prepared"
              : "SettlementProposed",
          ...(boundary === "AH4AfterSettlementProposal"
            ? {
                settlement_json: expect.stringContaining(
                  "ContextLimitExceeded",
                ),
              }
            : { settlement_json: null }),
        }),
      ]);
      expect(beforeKill.execution?.settled_at).toBeNull();
      expect(beforeKill.actions).toEqual([]);
      expect(
        beforeKill.durableOutputs.filter(
          (item) =>
            item.source_ref?.startsWith(`ptn_${executionId}_`) === true ||
            item.source_ref?.startsWith(`observation_${executionId}_`) === true,
        ),
      ).toEqual([]);

      await fixture.crash();
      const afterOldKill = readSnapshot(fixture.databaseFile, ids);
      expect(afterOldKill.session).toEqual(beforeKill.session);
      expect(afterOldKill.checkpoints).toEqual(beforeKill.checkpoints);
      expect(afterOldKill.links).toEqual(beforeKill.links);
      await waitForExpiredLease(fixture, project, executionId, workId);
      await fixture.restart();

      const terminal = await waitForPublic(
        async () => readSnapshot(fixture.databaseFile, ids),
        (snapshot) =>
          snapshot.execution?.settled_at !== null &&
          snapshot.execution?.settlement_kind === "Failed" &&
          snapshot.steps[0]?.state === "SettlementProposed",
        60_000,
      ).catch((error: unknown) => {
        throw new Error(
          `AH18 second overflow did not terminalize: ${error instanceof Error ? error.message : String(error)}; snapshot=${JSON.stringify(readSnapshot(fixture.databaseFile, ids))}; requests=${JSON.stringify(provider.requests.map((request) => request.kind))}; daemon=${fixture.daemonErrors.join(" | ")}`,
        );
      });

      expect(terminal.steps).toEqual([
        expect.objectContaining({
          logical_step_no: 0,
          repair_attempt: 0,
          state: "SettlementProposed",
          settlement_json: expect.stringContaining(
            "ProviderFailure:ContextLimitExceeded",
          ),
        }),
      ]);
      expect(terminal.session?.context_epoch).toBe(1);
      expect(terminal.checkpoints).toHaveLength(1);
      expect(terminal.links).toEqual(beforeKill.links);
      expect(terminal.providerTurns).toHaveLength(3);
      expect(terminal.providerAttempts).toHaveLength(3);
      expect(terminal.actions).toEqual([]);
      expect(
        terminal.durableOutputs.filter(
          (item) =>
            item.source_ref?.startsWith(`ptn_${executionId}_`) === true ||
            item.source_ref?.startsWith(`observation_${executionId}_`) === true,
        ),
      ).toEqual([]);
      expect(provider.requests.map((request) => request.kind)).toEqual([
        "initial-inference",
        "summary",
        "replacement-inference",
      ]);
      expect(fixture.daemonErrors).toEqual([]);
    },
    180_000,
  );
});
