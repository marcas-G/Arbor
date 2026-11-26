// Shared AH18 local overflow Provider server — moved verbatim from
// ah18-overflow-linked-compaction-resume.functional.test.ts (B5 split).
import { createServer } from "node:http";
import type { ProviderRequest, SeedProviderRequest } from "./snapshot.js";

export const sendText = (
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

export const sendContextLimit = (
  response: import("node:http").ServerResponse,
) => {
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

export const sendManualWait = (
  response: import("node:http").ServerResponse,
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

export const sendRootAssignWork = (
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

export const ah18WorkObjective = (marker: string) =>
  `Recover one AH18 overflow chain for ${marker}.`;

export const ah18SteerGuidance = (marker: string) =>
  `AH18 target overflow provider turn ${marker}`;

export const startOverflowProvider = async (
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
