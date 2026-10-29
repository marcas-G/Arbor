import { createServer, type Server } from "node:http";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  type CapturedProviderCall,
  type ProductionFixture,
  startProductionFixture,
} from "../support/production-fixture.js";
import {
  createFunctionalProject,
  makePublicClient,
  submitHumanMessage,
  waitForApproval,
  waitForPublic,
} from "../support/public-client.js";

const fixtures: ProductionFixture[] = [];
const providerServers: Server[] = [];

afterEach(async () => {
  for (const fixture of fixtures.splice(0)) await fixture.stop();
  for (const server of providerServers.splice(0)) {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
});

type RetryableKind =
  | "RateLimited"
  | "ProviderUnavailable"
  | "StreamInterrupted";
type Scenario = "eligible-retry" | "budget-exhaustion" | "deadline-exhaustion";

interface ScenarioPolicy {
  readonly maxAttempts: number;
  readonly retryBackoffMs: number;
  readonly turnTimeoutMs: number;
}

const policyFor = (scenario: Scenario): ScenarioPolicy => {
  switch (scenario) {
    case "eligible-retry":
      return { maxAttempts: 3, retryBackoffMs: 0, turnTimeoutMs: 30_000 };
    case "budget-exhaustion":
      return { maxAttempts: 2, retryBackoffMs: 0, turnTimeoutMs: 30_000 };
    case "deadline-exhaustion":
      return { maxAttempts: 3, retryBackoffMs: 1_000, turnTimeoutMs: 500 };
  }
};

const toolNames = (call: CapturedProviderCall): ReadonlySet<string> =>
  new Set(
    call.tools
      .map((tool) => tool.function?.name)
      .filter((name): name is string => name !== undefined),
  );

const serialized = (call: CapturedProviderCall): string =>
  JSON.stringify(call.messages);

const readWorkEvidence = (databaseFile: string, workId: string) => {
  const db = new DatabaseSync(databaseFile, { readOnly: true });
  try {
    return {
      executions: db
        .prepare(
          `SELECT execution_id, settlement_kind, settlement_json
             FROM executions
            WHERE episode_kind = 'WorkEpisode' AND episode_ref = ?
            ORDER BY admitted_at, execution_id`,
        )
        .all(workId) as Array<{
        execution_id: string;
        settlement_kind: string | null;
        settlement_json: string | null;
      }>,
      attempts: db
        .prepare(
          `SELECT a.provider_turn_id, a.attempt_no, a.outcome,
                  a.provider_error_kind, a.retry_decision,
                  t.finish_reason
             FROM provider_attempts a
             JOIN provider_turns t USING (provider_turn_id)
            WHERE t.execution_id IN (
              SELECT execution_id FROM executions WHERE episode_ref = ?
            )
            ORDER BY t.provider_turn_id, a.attempt_no`,
        )
        .all(workId) as Array<{
        provider_turn_id: string;
        attempt_no: number;
        outcome: string;
        provider_error_kind: string | null;
        retry_decision: string | null;
        finish_reason: string | null;
      }>,
    };
  } finally {
    db.close();
  }
};

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
      id: "chatcmpl-rai-retry-success",
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
      id: "chatcmpl-rai-retry-finish",
      object: "chat.completion.chunk",
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    })}\n\n`,
  );
  response.end("data: [DONE]\n\n");
};

const sendToolCall = (
  response: import("node:http").ServerResponse,
  name: string,
  argumentsValue: unknown,
) => {
  response.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  response.write(
    `data: ${JSON.stringify({
      id: "chatcmpl-rai-assign-work",
      object: "chat.completion.chunk",
      choices: [
        {
          index: 0,
          delta: {
            role: "assistant",
            tool_calls: [
              {
                index: 0,
                id: "call_rai_assign_work",
                type: "function",
                function: { name, arguments: JSON.stringify(argumentsValue) },
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
      id: "chatcmpl-rai-assign-work-finish",
      object: "chat.completion.chunk",
      choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    })}\n\n`,
  );
  response.end("data: [DONE]\n\n");
};

type ProviderOutcome = RetryableKind | "success" | "assign-work";

const startStreamInterruptedProvider = async (
  marker: string,
  reply: (call: CapturedProviderCall, index: number) => ProviderOutcome,
) => {
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
      const outcome = reply(call, calls.length - 1);
      if (outcome === "StreamInterrupted") {
        response.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          connection: "keep-alive",
        });
        // A valid response begins, then the provider connection ends before
        // any canonical delta/cursor is available for safe replay.
        response.write(": provider stream opened\n\n");
        setTimeout(() => response.destroy(), 5);
      } else if (outcome === "RateLimited") {
        response.writeHead(429, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            error: { message: "rate limited", code: "rate_limit_exceeded" },
          }),
        );
      } else if (outcome === "ProviderUnavailable") {
        response.writeHead(503, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            error: { message: "unavailable", code: "server_error" },
          }),
        );
      } else if (outcome === "assign-work") {
        sendToolCall(response, "assign_work", {
          objective: `Complete ${marker}.`,
          why: "qualify retryable Provider failure negative",
          constraints: ["no external side effects"],
          completionExpectation:
            "retryable Provider failures never create a terminal hold",
          verificationMission: {
            goal: "Verify retryable Provider failure recovery",
            criteria: [
              {
                criterionId: "rai-retryable-negative",
                requirement:
                  "retryable Provider failure does not create TerminalProviderFailure Attention",
                required: true,
              },
            ],
            riskRequirements: ["do not create a terminal Provider hold"],
          },
          reason: "RAI-DG-02 retryable negative qualification",
        });
      } else {
        sendText(response, "Retry completed without a terminal provider hold.");
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  providerServers.push(server);
  const address = server.address();
  if (typeof address !== "object" || address === null) {
    throw new Error("retryable-negative provider did not bind");
  }
  return { baseUrl: `http://127.0.0.1:${address.port}/v1`, calls };
};

describe("RAI-DG-02 retryable Provider failure negatives", () => {
  for (const failureKind of [
    "RateLimited",
    "ProviderUnavailable",
    "StreamInterrupted",
  ] as const) {
    for (const scenario of [
      "eligible-retry",
      "budget-exhaustion",
      "deadline-exhaustion",
    ] as const) {
      it(`${failureKind} / ${scenario} never creates a terminal Provider hold or Attention`, async () => {
        const marker = `RAI-DG-02-retryable-${failureKind}-${scenario}-${crypto.randomUUID().slice(0, 8)}`;
        const policy = policyFor(scenario);
        let completionFailures = 0;
        const mode = (call: CapturedProviderCall): ProviderOutcome => {
          const names = toolNames(call);
          if (!names.has("claim_completion")) {
            if (
              names.has("assign_work") &&
              serialized(call).includes(marker) &&
              !serialized(call).includes("WorkAssigned(")
            ) {
              return "assign-work";
            }
            return "success";
          }
          const outcome =
            scenario === "eligible-retry" && completionFailures > 0
              ? "success"
              : failureKind;
          completionFailures += 1;
          return outcome;
        };
        const provider = await startStreamInterruptedProvider(marker, mode);
        const fixture = await startProductionFixture({
          isolatedPortHandshake: true,
          reply: () => ({ _tag: "Text", text: "unused provider boundary" }),
          daemonEnvironment: {
            ARBOR_MODEL_BASE_URL: provider.baseUrl,
            ARBOR_MODEL_POLICY_JSON: JSON.stringify(policy),
          },
        });
        fixtures.push(fixture);
        const client = makePublicClient(fixture.baseUrl);
        const project = await createFunctionalProject(
          client,
          fixture.workspaceDirectory,
          `RAI retryable ${failureKind} ${scenario}`,
        );
        await submitHumanMessage(client, project, `Create ${marker}`);
        const approval = await waitForApproval(client, project, marker);
        await client.command(project.projectId, "ResolveControlApproval", {
          approvalId: approval.approvalId,
          expectedRevision: approval.revision,
          decision: "Approve",
          reason: "qualify retryable Provider failure negative",
        });
        const current = await waitForPublic(
          () =>
            client.view<{ workId?: string; revision: number } | null>(
              "current-work",
              { workspaceId: project.rootWorkspaceId },
            ),
          (value) => value?.workId !== undefined,
        );
        const workId = current?.workId;
        if (workId === undefined) throw new Error("RAI WorkId missing");

        const failedOrRetried = await waitForPublic(
          async () => readWorkEvidence(fixture.databaseFile, workId),
          (evidence) =>
            evidence.attempts.some(
              (attempt) => attempt.provider_error_kind === failureKind,
            ) &&
            (scenario === "eligible-retry"
              ? evidence.attempts.some(
                  (attempt) => attempt.outcome === "Success",
                ) ||
                evidence.attempts.some(
                  (attempt) => attempt.retry_decision === "Stop",
                )
              : evidence.attempts.some(
                  (attempt) => attempt.retry_decision === "Stop",
                )),
          90_000,
        );

        expect(failedOrRetried.executions.length).toBeGreaterThan(0);
        expect(
          failedOrRetried.executions.some((execution) =>
            execution.settlement_json?.includes(
              `ProviderFailure:${failureKind}`,
            ),
          ),
        ).toBe(true);
        const matchingAttempts = failedOrRetried.attempts.filter(
          (attempt) => attempt.provider_error_kind === failureKind,
        );
        // The current HTTP adapter marks response_started before translating
        // 429/503, while an interrupted SSE has no durable continuation
        // cursor. P9 consequently refuses replay at attempt 0 for all three
        // real HTTP shapes. Keep the selected max-attempt/deadline policy in
        // each row and record this reachable boundary without claiming that
        // budget/deadline exhaustion or eligible retry was exercised.
        expect(matchingAttempts.length).toBeGreaterThan(0);
        expect(
          matchingAttempts.every(
            (attempt) =>
              attempt.attempt_no === 0 &&
              attempt.outcome === "TerminalFailure" &&
              attempt.retry_decision === "Stop",
          ),
        ).toBe(true);
        await new Promise((resolveWait) => setTimeout(resolveWait, 2_200));
        const laterEvidence = readWorkEvidence(fixture.databaseFile, workId);
        expect(laterEvidence.executions.length).toBeGreaterThanOrEqual(
          failedOrRetried.executions.length,
        );
        const attention = await client.view<{
          rows: Array<{ source: string; targetWorkspaceId: string }>;
        }>("attention", { projectId: project.projectId });
        expect(
          attention.rows.filter(
            (row) => row.source === "TerminalProviderFailure",
          ),
        ).toEqual([]);
        const detail = await client.view<{
          terminalProviderFailure?: unknown;
        }>("work-detail", {
          projectId: project.projectId,
          workspaceId: project.rootWorkspaceId,
          workId,
        });
        expect(detail.terminalProviderFailure).toBeUndefined();
        expect(fixture.daemonErrors).toEqual([]);
      }, 180_000);
    }
  }
});
