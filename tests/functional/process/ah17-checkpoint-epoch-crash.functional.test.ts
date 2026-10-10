import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  type ProductionFixture,
  startProductionFixture,
} from "../support/production-fixture.js";
import {
  admitRootWorkThroughPublicConversation,
  createFunctionalProject,
  makePublicClient,
  waitForPublic,
} from "../support/public-client.js";

interface Ah17Probe {
  readonly tag: "AH17_PROBE";
  readonly boundary: string;
  readonly executionId: string;
  readonly providerTurnId: string;
}

interface ProviderRequest {
  readonly messages: ReadonlyArray<{ role?: string; content?: string }>;
  readonly tools: ReadonlyArray<{ function?: { name?: string } }>;
  readonly kind:
    | "root-work"
    | "seed-wait"
    | "context-overflow"
    | "summary"
    | "wait"
    | "text";
}

interface Ah17Snapshot {
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
    context_epoch: number;
    settled_at: string | null;
    finish_reason: string | null;
  }>;
  readonly providerAttempts: Array<{
    provider_turn_id: string;
    attempt_no: number;
    outcome: string;
    provider_error_kind: string | null;
    canonical_event_prefix_json: string;
    settled_at: string | null;
  }>;
  readonly step:
    | {
        execution_id: string;
        logical_step_no: number;
        repair_attempt: number;
        provider_turn_id: string;
        state: string;
        next_action_index: number;
        decoded_output_hash: string | null;
      }
    | undefined;
  readonly providerLinks: Array<{
    role: string;
    overflow_ordinal: number;
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
  readonly work:
    | {
        work_id: string;
        lifecycle: string;
      }
    | undefined;
}

const fixtures: ProductionFixture[] = [];
const providerServers: Server[] = [];
const ah17Child = resolve(
  "tests/functional/support/ah17-compaction-crash-child.mjs",
);

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
      id: `chatcmpl-ah17-${randomUUID()}`,
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
      id: `chatcmpl-ah17-${randomUUID()}`,
      object: "chat.completion.chunk",
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    })}\n\n`,
  );
  response.end("data: [DONE]\n\n");
};

const sendManualWait = (response: import("node:http").ServerResponse) => {
  response.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  response.write(
    `data: ${JSON.stringify({
      id: `chatcmpl-ah17-${randomUUID()}`,
      object: "chat.completion.chunk",
      choices: [
        {
          index: 0,
          delta: {
            role: "assistant",
            tool_calls: [
              {
                index: 0,
                id: `call_${randomUUID().replaceAll("-", "")}`,
                type: "function",
                function: {
                  name: "wait",
                  arguments: JSON.stringify({
                    reason: "await a manual continuation after compaction",
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
      id: `chatcmpl-ah17-${randomUUID()}`,
      object: "chat.completion.chunk",
      choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    })}\n\n`,
  );
  response.end("data: [DONE]\n\n");
};

const sendFunctionCall = (
  response: import("node:http").ServerResponse,
  name: string,
  args: Readonly<Record<string, unknown>>,
) => {
  response.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  response.write(
    `data: ${JSON.stringify({
      id: `chatcmpl-ah17-${randomUUID()}`,
      object: "chat.completion.chunk",
      choices: [
        {
          index: 0,
          delta: {
            role: "assistant",
            tool_calls: [
              {
                index: 0,
                id: `call_${randomUUID().replaceAll("-", "")}`,
                type: "function",
                function: { name, arguments: JSON.stringify(args) },
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
      id: `chatcmpl-ah17-${randomUUID()}`,
      object: "chat.completion.chunk",
      choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
      usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
    })}\n\n`,
  );
  response.end("data: [DONE]\n\n");
};

const sendContextOverflow = (response: import("node:http").ServerResponse) => {
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

const startCompactionProvider = async (
  marker: string,
  state: { probeArmed: boolean },
) => {
  const requests: ProviderRequest[] = [];
  let contextOverflowSent = false;
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
      const available = new Set(
        tools
          .map((tool) => tool.function?.name)
          .filter((name): name is string => name !== undefined),
      );
      if (messageText.includes("Produce a compact continuation summary")) {
        requests.push({
          messages,
          tools: body.tools ?? [],
          kind: "summary",
        });
        sendText(response, `Compacted continuation for ${marker}.`);
        return;
      }
      if (available.has("assign_work") && !available.has("claim_completion")) {
        requests.push({ messages, tools, kind: "root-work" });
        if (messageText.includes("WorkAssigned(")) {
          sendText(response, `Admitted AH17 Work ${marker}.`);
          return;
        }
        sendFunctionCall(response, "assign_work", {
          objective: `Exercise one compaction checkpoint boundary for ${marker}.`,
          why: "qualify atomic ContextEpoch/checkpoint recovery",
          constraints: [],
          completionExpectation:
            "compaction resumes the same logical Work step",
          verificationMission: {
            goal: `Verify compaction recovery for ${marker}`,
            criteria: [
              {
                criterionId: "ah17-atomic-compaction",
                requirement: "one checkpoint matches the single epoch advance",
                required: true,
              },
            ],
            riskRequirements: [],
          },
          reason: "AH17 process fixture",
        });
        return;
      }
      if (available.has("claim_completion") && !state.probeArmed) {
        requests.push({ messages, tools, kind: "seed-wait" });
        sendManualWait(response);
        return;
      }
      if (!contextOverflowSent) {
        contextOverflowSent = true;
        requests.push({
          messages,
          tools: body.tools ?? [],
          kind: "context-overflow",
        });
        sendContextOverflow(response);
        return;
      }
      if (tools.some((tool) => tool.function?.name === "wait")) {
        requests.push({ messages, tools, kind: "wait" });
        sendManualWait(response);
        return;
      }
      requests.push({ messages, tools, kind: "text" });
      sendText(
        response,
        `Completed the compaction recovery path for ${marker}.`,
      );
    });
  });
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("AH17 local Provider server has no TCP address");
  }
  return {
    server,
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    requests,
  };
};

const readAh17Snapshot = (
  databaseFile: string,
  input: {
    readonly sessionId: string;
    readonly executionId: string;
    readonly workId: string;
  },
): Ah17Snapshot => {
  const db = new DatabaseSync(databaseFile, { readOnly: true });
  try {
    return {
      session: db
        .prepare(
          "SELECT session_id, context_epoch FROM sessions WHERE session_id = ?",
        )
        .get(input.sessionId) as Ah17Snapshot["session"],
      checkpoints: db
        .prepare(
          `SELECT sequence, context_epoch, source_kind, source_ref, payload_json, content_hash
             FROM session_entries
            WHERE session_id = ? AND item_type = 'CompactionCheckpoint'
            ORDER BY sequence`,
        )
        .all(input.sessionId) as Ah17Snapshot["checkpoints"],
      providerTurns: db
        .prepare(
          `SELECT provider_turn_id, execution_id, context_epoch, settled_at, finish_reason
             FROM provider_turns WHERE execution_id = ? ORDER BY provider_turn_id`,
        )
        .all(input.executionId) as Ah17Snapshot["providerTurns"],
      providerAttempts: db
        .prepare(
          `SELECT pa.provider_turn_id, pa.attempt_no, pa.outcome, pa.provider_error_kind,
                  pa.canonical_event_prefix_json, pa.settled_at
             FROM provider_attempts pa
             JOIN provider_turns pt ON pt.provider_turn_id = pa.provider_turn_id
            WHERE pt.execution_id = ? ORDER BY pa.provider_turn_id, pa.attempt_no`,
        )
        .all(input.executionId) as Ah17Snapshot["providerAttempts"],
      step: db
        .prepare(
          `SELECT execution_id, logical_step_no, repair_attempt, provider_turn_id,
                  state, next_action_index, decoded_output_hash
             FROM agent_loop_steps
            WHERE execution_id = ? ORDER BY logical_step_no, repair_attempt LIMIT 1`,
        )
        .get(input.executionId) as Ah17Snapshot["step"],
      providerLinks: db
        .prepare(
          `SELECT role, overflow_ordinal, provider_turn_id,
                  predecessor_provider_turn_id, context_epoch, state
             FROM agent_loop_step_provider_turns WHERE execution_id = ?
            ORDER BY overflow_ordinal, role`,
        )
        .all(input.executionId) as Ah17Snapshot["providerLinks"],
      execution: db
        .prepare(
          "SELECT execution_id, settled_at, settlement_kind FROM executions WHERE execution_id = ?",
        )
        .get(input.executionId) as Ah17Snapshot["execution"],
      leases: db
        .prepare(
          "SELECT execution_id, generation, expires_at FROM execution_leases WHERE execution_id = ?",
        )
        .all(input.executionId) as Ah17Snapshot["leases"],
      workWait: db
        .prepare(
          "SELECT work_id, wait_mode, conditions_json FROM work_waits WHERE work_id = ?",
        )
        .get(input.workId) as Ah17Snapshot["workWait"],
      work: db
        .prepare("SELECT work_id, lifecycle FROM works WHERE work_id = ?")
        .get(input.workId) as Ah17Snapshot["work"],
    };
  } finally {
    db.close();
  }
};

const readExecutionIds = (databaseFile: string): string[] => {
  const db = new DatabaseSync(databaseFile, { readOnly: true });
  try {
    return (
      db
        .prepare("SELECT execution_id FROM executions ORDER BY execution_id")
        .all() as Array<{ execution_id: string }>
    ).map((row) => row.execution_id);
  } finally {
    db.close();
  }
};

const probes: Ah17Probe[] = [];

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

describe("AH17 CompactionCheckpoint and ContextEpoch process crash", () => {
  it.each(["before", "after"] as const)(
    "recovers one atomic checkpoint/epoch boundary after killing the old owner %s commit",
    async (crashSide) => {
      const marker = `AH17-${crypto.randomUUID().slice(0, 8)}`;
      probes.length = 0;
      const providerState = { probeArmed: false };
      const provider = await startCompactionProvider(marker, providerState);
      providerServers.push(provider.server);
      const fixture = await startProductionFixture({
        reply: () => ({ _tag: "HttpError", status: 500 }),
        daemonEnvironment: {
          ARBOR_MODEL_BASE_URL: provider.baseUrl,
        },
        onDaemonStdout: (line) => {
          try {
            const probe = JSON.parse(line) as Ah17Probe;
            if (probe.tag === "AH17_PROBE") probes.push(probe);
          } catch {
            // Keep daemon diagnostics in the fixture on non-probe lines.
          }
        },
      });
      fixtures.push(fixture);
      const client = makePublicClient(fixture.baseUrl);
      const project = await createFunctionalProject(
        client,
        fixture.workspaceDirectory,
        `AH17 atomic compaction ${marker}`,
      );
      const seededWork = await admitRootWorkThroughPublicConversation(
        client,
        project,
        marker,
        `Please exercise one compaction checkpoint boundary for ${marker}.`,
      );
      const workId = seededWork.workId;
      expect(seededWork).toMatchObject({ revision: 0, status: "Open" });
      await waitForPublic(
        async () =>
          provider.requests.filter((request) => request.kind === "seed-wait"),
        (requests) => requests.length === 1,
      );
      const seedWork = await waitForPublic(
        () =>
          client.view<{
            workId?: string;
            revision: number;
            status: string;
            activeExecution?: { executionId: string };
          } | null>("current-work", {
            workspaceId: project.rootWorkspaceId,
          }),
        (work) =>
          work?.workId === workId &&
          work.revision === 0 &&
          work.status === "Open" &&
          work.activeExecution === undefined,
      );
      if (seedWork?.workId !== workId) {
        throw new Error("AH17 public seed Work did not reach Manual wait");
      }
      const seedExecutionIds = new Set(readExecutionIds(fixture.databaseFile));
      expect(providerState.probeArmed).toBe(false);
      await fixture.crash();
      providerState.probeArmed = true;
      await fixture.restart({
        entry: ah17Child,
        daemonEnvironment: {
          ARBOR_AH17_BOUNDARY:
            crashSide === "before"
              ? "AH17BeforeCheckpointEpochCommit"
              : "AH17AfterCheckpointEpochCommit",
          ARBOR_MODEL_BASE_URL: provider.baseUrl,
        },
      });
      await client.command(project.projectId, "SteerWork", {
        workId,
        workspaceId: project.rootWorkspaceId,
        expectedWorkRevision: seedWork.revision,
        steer: {
          severity: "Normal",
          guidance: `Resume compaction checkpoint qualification ${marker}.`,
        },
        provenance: { source: "HumanInput" },
      });

      const boundary = await waitForPublic(
        async () => probes.find((probe) => probe.boundary.startsWith("AH17")),
        (probe) =>
          probe !== undefined &&
          probe.boundary ===
            (crashSide === "before"
              ? "AH17BeforeCheckpointEpochCommit"
              : "AH17AfterCheckpointEpochCommit"),
        60_000,
      ).catch((error: unknown) => {
        throw new Error(
          `AH17 compaction boundary absent: ${error instanceof Error ? error.message : String(error)}; requests=${JSON.stringify(provider.requests.map((request) => request.kind))}; daemon=${fixture.daemonErrors.join(" | ")}`,
        );
      });
      if (boundary === undefined) throw new Error("AH17 boundary probe absent");
      expect(seedExecutionIds.has(boundary.executionId)).toBe(false);
      const ids = {
        sessionId: project.rootSessionId,
        executionId: boundary.executionId,
        workId,
      };
      const compactionProviderTurnId = boundary.providerTurnId;
      expect(compactionProviderTurnId).toMatch(
        new RegExp(`^ptn_${boundary.executionId}_0_compact_0$`, "u"),
      );

      const beforeKill = readAh17Snapshot(fixture.databaseFile, ids);
      expect(beforeKill.session).toBeDefined();
      expect(beforeKill.checkpoints).toHaveLength(
        crashSide === "before" ? 0 : 1,
      );
      expect(beforeKill.session?.context_epoch).toBe(
        crashSide === "before" ? 0 : 1,
      );
      expect(beforeKill.providerLinks).toEqual([
        {
          role: "Inference",
          overflow_ordinal: 0,
          provider_turn_id: `ptn_${boundary.executionId}_0`,
          predecessor_provider_turn_id: null,
          context_epoch: 0,
          state: "SettledFailure",
        },
        {
          role: "OverflowCompaction",
          overflow_ordinal: 0,
          provider_turn_id: compactionProviderTurnId,
          predecessor_provider_turn_id: `ptn_${boundary.executionId}_0`,
          context_epoch: 0,
          state: "Prepared",
        },
      ]);
      if (crashSide === "after") {
        const checkpoint = JSON.parse(
          beforeKill.checkpoints[0]?.payload_json ?? "{}",
        ) as { fromEpoch?: number; toEpoch?: number; summaryText?: string };
        expect(checkpoint).toMatchObject({
          _tag: "CompactionCheckpoint",
          implementation: "Summary",
          fromEpoch: 0,
          toEpoch: 1,
        });
        expect(checkpoint.summaryText).toContain(marker);
      }
      expect(
        beforeKill.providerAttempts.filter(
          (attempt) =>
            attempt.provider_turn_id === compactionProviderTurnId &&
            attempt.outcome === "Success",
        ),
      ).toEqual([
        expect.objectContaining({
          attempt_no: 0,
          settled_at: expect.any(String),
        }),
      ]);
      expect(
        provider.requests.filter((request) => request.kind === "summary"),
      ).toHaveLength(1);

      await fixture.crash();
      const afterOldKill = readAh17Snapshot(fixture.databaseFile, ids);
      expect(afterOldKill.session).toEqual(beforeKill.session);
      expect(afterOldKill.checkpoints).toEqual(beforeKill.checkpoints);
      await waitForPublic(
        async () =>
          readAh17Snapshot(fixture.databaseFile, ids).leases.find(
            (lease) => lease.execution_id === boundary.executionId,
          ),
        (lease) =>
          lease !== undefined && Date.parse(lease.expires_at) <= Date.now(),
        35_000,
      );
      await fixture.restart().catch((error: unknown) => {
        throw new Error(
          `AH17 daemon did not restart after ${crashSide} boundary: ${error instanceof Error ? error.message : String(error)}; daemon=${fixture.daemonErrors.join(" | ")}`,
        );
      });

      const recovered = await waitForPublic(
        async () => readAh17Snapshot(fixture.databaseFile, ids),
        (snapshot) =>
          snapshot.session?.context_epoch === 1 &&
          snapshot.checkpoints.length === 1 &&
          snapshot.execution?.settled_at !== null &&
          snapshot.execution?.settlement_kind === "Completed" &&
          snapshot.workWait !== undefined,
        60_000,
      ).catch((error: unknown) => {
        throw new Error(
          `AH17 did not resume to a settled Manual Wait: ${error instanceof Error ? error.message : String(error)}; snapshot=${JSON.stringify(readAh17Snapshot(fixture.databaseFile, ids))}; requests=${JSON.stringify(provider.requests.map((request) => request.kind))}; daemon=${fixture.daemonErrors.join(" | ")}`,
        );
      });

      expect(recovered.session?.context_epoch).toBe(1);
      const replacementProviderTurnId = `ptn_${boundary.executionId}_0_overflow_0`;
      expect(recovered.checkpoints).toHaveLength(1);
      expect(recovered.checkpoints[0]).toMatchObject({
        context_epoch: 1,
        source_kind: "CompactionTurn",
        source_ref: compactionProviderTurnId,
      });
      expect(
        JSON.parse(recovered.checkpoints[0]?.payload_json ?? "{}"),
      ).toMatchObject({
        fromEpoch: 0,
        toEpoch: 1,
      });
      const checkpointPayload = JSON.parse(
        recovered.checkpoints[0]?.payload_json ?? "{}",
      ) as { summaryText?: string };
      const compactionSuccess = recovered.providerAttempts.find(
        (attempt) =>
          attempt.provider_turn_id === compactionProviderTurnId &&
          attempt.outcome === "Success",
      );
      const compactionCanonicalEvents = JSON.parse(
        compactionSuccess?.canonical_event_prefix_json ?? "[]",
      ) as ReadonlyArray<{ _tag: string; text?: string }>;
      const canonicalSummaryText = compactionCanonicalEvents
        .flatMap((event) =>
          event._tag === "TextDelta" && typeof event.text === "string"
            ? [event.text]
            : [],
        )
        .join("")
        .trim();
      expect(checkpointPayload.summaryText).toBe(canonicalSummaryText);
      expect(canonicalSummaryText).toBe(
        `Compacted continuation for ${marker}.`,
      );
      expect(
        recovered.providerAttempts.filter(
          (attempt) =>
            attempt.provider_turn_id === compactionProviderTurnId &&
            attempt.outcome === "Success",
        ),
      ).toEqual([
        expect.objectContaining({
          attempt_no: 0,
          settled_at: expect.any(String),
        }),
      ]);
      expect(
        recovered.providerTurns.map(
          (providerTurn) => providerTurn.provider_turn_id,
        ),
      ).toEqual([
        `ptn_${boundary.executionId}_0`,
        compactionProviderTurnId,
        replacementProviderTurnId,
      ]);
      expect(
        recovered.providerAttempts.filter(
          (attempt) =>
            attempt.provider_turn_id === replacementProviderTurnId &&
            attempt.outcome === "Success",
        ),
      ).toHaveLength(1);
      expect(recovered.providerLinks).toEqual([
        {
          role: "Inference",
          overflow_ordinal: 0,
          provider_turn_id: `ptn_${boundary.executionId}_0`,
          predecessor_provider_turn_id: null,
          context_epoch: 0,
          state: "SettledFailure",
        },
        {
          role: "OverflowCompaction",
          overflow_ordinal: 0,
          provider_turn_id: compactionProviderTurnId,
          predecessor_provider_turn_id: `ptn_${boundary.executionId}_0`,
          context_epoch: 0,
          state: "Prepared",
        },
        {
          role: "OverflowReplacement",
          overflow_ordinal: 0,
          provider_turn_id: replacementProviderTurnId,
          predecessor_provider_turn_id: compactionProviderTurnId,
          context_epoch: 1,
          state: "Prepared",
        },
      ]);
      expect(recovered.step).toMatchObject({
        logical_step_no: 0,
        repair_attempt: 0,
        provider_turn_id: `ptn_${boundary.executionId}_0`,
      });
      expect(
        provider.requests.filter(
          (request) => request.kind === "context-overflow",
        ),
      ).toHaveLength(1);
      expect(
        provider.requests.filter((request) => request.kind === "summary"),
      ).toHaveLength(1);
      expect(
        provider.requests.filter((request) => request.kind === "seed-wait"),
      ).toHaveLength(1);
      expect(
        provider.requests.some(
          (request) =>
            request.kind === "root-work" &&
            request.tools.some((tool) => tool.function?.name === "assign_work"),
        ),
      ).toBe(true);
      expect(
        provider.requests.filter((request) => request.kind === "wait"),
      ).toHaveLength(1);
      expect(
        provider.requests
          .filter((request) =>
            ["context-overflow", "summary", "wait"].includes(request.kind),
          )
          .map((request) => request.kind),
      ).toEqual(["context-overflow", "summary", "wait"]);
      expect(recovered.workWait).toMatchObject({
        work_id: workId,
        wait_mode: "Any",
      });
      expect(JSON.parse(recovered.workWait?.conditions_json ?? "[]")).toEqual([
        { _tag: "Manual" },
      ]);
      expect(recovered.work?.lifecycle).toBe("Open");
      expect(fixture.daemonErrors).toEqual([]);
      await fixture.crash();
    },
    180_000,
  );
});
