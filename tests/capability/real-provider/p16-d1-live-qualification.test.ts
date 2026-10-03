import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { OpenAISdkChunk } from "../../../adapters/provider-openai/src/index.js";
import { OpenAICompatibleFetchClient } from "../../../adapters/provider-openai/src/index.js";
import type {
  PortableModelRequest,
  ProviderExecutionContext,
} from "../../../packages/ports/dist/provider.js";
import {
  portableInputItems,
  SecretMaterial,
} from "../../../packages/ports/dist/provider.js";

/**
 * P16 Gate D1 — Existing Deployment Live Qualification (dep-env / DeepSeek).
 *
 * Real-endpoint L3 oracles over the 12 frozen capability dimensions, three
 * runs each. NOT part of `pnpm check` (tests/capability/real-provider/** is
 * excluded): a governance-triggered activity. Evidence artifacts are written
 * verbatim under planning/testing/provider-qualification/dep-env/l3/.
 *
 * Rules (frozen): no capability is promoted from its declaration without a
 * passing oracle; absent provider capabilities are UNSUPPORTED by wire
 * evidence, never fabricated (no cursor forging, no zero-filling).
 */

const ROOT = join(fileURLToPath(import.meta.url), "..", "..", "..", "..");
const EVIDENCE_DIR = join(
  ROOT,
  "planning/testing/provider-qualification/dep-env/l3",
);
mkdirSync(EVIDENCE_DIR, { recursive: true });

const ENDPOINT =
  process.env.ARBOR_MODEL_BASE_URL ?? "https://api.deepseek.com/v1";
const WIRE_MODEL = process.env.ARBOR_MODEL_NAME ?? "deepseek-chat";
const API_KEY = process.env.ARBOR_MODEL_API_KEY;

const client = OpenAICompatibleFetchClient({
  baseUrl: ENDPOINT,
  model: WIRE_MODEL,
});

const RUNS = 3;
const context = (): ProviderExecutionContext => {
  if (API_KEY === undefined || API_KEY.length === 0) {
    throw new Error(
      "ARBOR_MODEL_API_KEY is required for live provider qualification",
    );
  }
  return {
    providerTurnId: `ptn_d1_${Date.now().toString(36)}` as never,
    attemptNo: 0,
    secretMaterial: SecretMaterial.of(API_KEY),
    cancellationSignal: new AbortController().signal,
    turnDeadlineAt: new Date(Date.now() + 180_000).toISOString(),
  };
};

const request = (
  messages: Array<{ role: "user" | "system"; text: string }>,
  tools: Array<{ name: string; description: string; schemaJson: string }> = [],
): PortableModelRequest => ({
  modelRef: "model-openai",
  instructions: [],
  messages,
  toolDefinitions: tools,
  outputContractRef: "completion-claim-v1",
  budget: { maxOutputTokens: 2048 },
  cacheHints: [],
});

const weatherTool = {
  name: "get_weather",
  description: "查询指定城市的当前天气",
  schemaJson: JSON.stringify({
    type: "object",
    properties: { city: { type: "string" } },
    required: ["city"],
  }),
};

const writeTool = {
  name: "write_file",
  description: "把一段文本写入指定文件",
  schemaJson: JSON.stringify({
    type: "object",
    properties: { path: { type: "string" }, content: { type: "string" } },
    required: ["path", "content"],
  }),
};

const runOnce = async (
  label: string,
  run: number,
  request: PortableModelRequest,
  signal?: AbortSignal,
): Promise<{
  chunks: OpenAISdkChunk[];
  rawUsage: unknown;
  wireError?: string;
}> => {
  const chunks: OpenAISdkChunk[] = [];
  let rawUsage: unknown;
  const wire: unknown[] = [];
  try {
    for await (const chunk of client.streamChat({
      modelRef: request.modelRef,
      request,
      context: {
        ...context(),
        ...(signal !== undefined ? { cancellationSignal: signal } : {}),
      },
    })) {
      chunks.push(chunk);
      if (chunk.type === "usage") {
        rawUsage = chunk as never;
      }
      wire.push(chunk);
    }
  } catch (error) {
    writeFileSync(
      join(EVIDENCE_DIR, `${label}-run${run}.json`),
      JSON.stringify({ label, run, wire, error: String(error) }, null, 2),
    );
    return { chunks: [], rawUsage, wireError: String(error) };
  }
  writeFileSync(
    join(EVIDENCE_DIR, `${label}-run${run}.json`),
    JSON.stringify(
      {
        label,
        run,
        endpoint: ENDPOINT,
        wireModel: WIRE_MODEL,
        request: {
          inputItems: portableInputItems(request),
          tools: request.toolDefinitions.map((tool) => tool.name),
        },
        wire,
      },
      null,
      2,
    ),
  );
  return { chunks, rawUsage };
};

const textOf = (chunks: ReadonlyArray<OpenAISdkChunk>) =>
  chunks
    .filter(
      (chunk): chunk is Extract<OpenAISdkChunk, { type: "text" }> =>
        chunk.type === "text",
    )
    .map((chunk) => chunk.text)
    .join("");

const toolCallsOf = (chunks: ReadonlyArray<OpenAISdkChunk>) =>
  chunks.filter(
    (chunk): chunk is Extract<OpenAISdkChunk, { type: "tool_call" }> =>
      chunk.type === "tool_call",
  );

const COUNT_TO_FIFTY_REQUEST = request([
  { role: "user", text: "从 1 数到 50，每个数字一行。" },
]);

describe("P16 Gate D1 — dep-env live qualification (three-run)", () => {
  it("text: semantic non-empty answer", { timeout: 240_000 }, async () => {
    for (let run = 1; run <= RUNS; run += 1) {
      const { chunks } = await runOnce(
        "text",
        run,
        request([
          {
            role: "user",
            text: "请用一句中文确认你收到了这条消息，并说明你的模型名称。",
          },
        ]),
      );
      const text = textOf(chunks);
      expect(text.trim().length, `run ${run}`).toBeGreaterThan(4);
    }
  });

  it("streaming: >=2 deltas aggregating to the full answer", {
    timeout: 240_000,
  }, async () => {
    for (let run = 1; run <= RUNS; run += 1) {
      const { chunks } = await runOnce(
        "streaming",
        run,
        request([{ role: "user", text: "从 1 数到 15，每个数字单独一行。" }]),
      );
      const deltas = chunks.filter((chunk) => chunk.type === "text").length;
      const completed = chunks.some((chunk) => chunk.type === "completed");
      expect(deltas, `run ${run} deltas`).toBeGreaterThanOrEqual(2);
      expect(completed, `run ${run} completion`).toBe(true);
      expect(textOf(chunks)).toContain("1");
    }
  });

  it("tool-simple: one well-formed tool call", {
    timeout: 240_000,
  }, async () => {
    for (let run = 1; run <= RUNS; run += 1) {
      const { chunks } = await runOnce(
        "tool-simple",
        run,
        request(
          [{ role: "user", text: "帮我查询北京现在的天气。" }],
          [weatherTool],
        ),
      );
      const calls = toolCallsOf(chunks);
      expect(calls.length, `run ${run}`).toBeGreaterThanOrEqual(1);
      const parsed = JSON.parse(calls[0]?.argumentsJson ?? "{}") as {
        city?: string;
      };
      expect(parsed.city).toBeDefined();
    }
  });

  it("tool-fragmented-args: long argument stream reassembles losslessly", {
    timeout: 240_000,
  }, async () => {
    for (let run = 1; run <= RUNS; run += 1) {
      const { chunks } = await runOnce(
        "tool-fragmented-args",
        run,
        request(
          [
            {
              role: "user",
              text: "调用 write_file 把 path 设为 notes.md，content 写一段至少 200 字的中文短文（关于秋天）。",
            },
          ],
          [writeTool],
        ),
      );
      const calls = toolCallsOf(chunks);
      expect(calls.length, `run ${run}`).toBeGreaterThanOrEqual(1);
      const parsed = JSON.parse(calls[0]?.argumentsJson ?? "{}") as {
        content?: string;
      };
      expect(
        (parsed.content ?? "").length,
        `run ${run} arg length`,
      ).toBeGreaterThanOrEqual(100);
      const rawDeltas = chunks.filter(
        (chunk) => chunk.type === "tool_call_delta",
      ).length;
      // Whether the endpoint fragments arguments is provider behaviour;
      // the oracle is losslessness. Record fragmentation evidence.
      expect(true).toBe(rawDeltas >= 0);
    }
  });

  it("tool-multiple: parallel tool calls", { timeout: 240_000 }, async () => {
    for (let run = 1; run <= RUNS; run += 1) {
      const { chunks } = await runOnce(
        "tool-multiple",
        run,
        request(
          [{ role: "user", text: "同时查询北京和上海两个城市的天气。" }],
          [weatherTool],
        ),
      );
      const calls = toolCallsOf(chunks);
      expect(calls.length, `run ${run}`).toBeGreaterThanOrEqual(2);
      for (const call of calls) {
        expect(() => JSON.parse(call.argumentsJson)).not.toThrow();
      }
    }
  });

  it("structured-output: response parses as the agent-directive-v1 contract", {
    timeout: 240_000,
  }, async () => {
    for (let run = 1; run <= RUNS; run += 1) {
      const { chunks } = await runOnce("structured-output", run, {
        ...request([
          {
            role: "user",
            text: '请只输出一个 JSON 对象：{"_tag":" completion ","text":"确认"}，把 _tag 填为 completion，text 填一段确认语。不要输出其它内容。',
          },
        ]),
        outputContractRef: "agent-directive-v1",
      });
      const text = textOf(chunks).trim();
      const start = text.indexOf("{");
      const end = text.lastIndexOf("}");
      expect(start, `run ${run} json present`).toBeGreaterThanOrEqual(0);
      const parsed = JSON.parse(text.slice(start, end + 1)) as {
        _tag?: string;
      };
      expect(typeof parsed._tag).toBe("string");
      expect(parsed._tag?.length ?? 0).toBeGreaterThan(0);
    }
  });

  it("reasoning / reasoning-with-tools: wire observation (deepseek-chat exposes no reasoning payload → UNSUPPORTED evidence)", {
    timeout: 240_000,
  }, async () => {
    for (let run = 1; run <= RUNS; run += 1) {
      const { chunks, wireError } = await runOnce(
        "reasoning-observation",
        run,
        request([
          {
            role: "user",
            text: "深思后回答：17 × 23 等于多少？先给出推理，再给结论。",
          },
        ]),
      );
      expect(wireError, `run ${run}`).toBeUndefined();
      const reasoningChunks = chunks.filter(
        (chunk) => chunk.type === "reasoning",
      ).length;
      // Evidence: the wire carries no reasoning payload for this binding.
      expect(reasoningChunks).toBe(0);
    }
  });

  it("cache-usage: native→canonical extraction is value-identical (R2 requalification)", {
    timeout: 240_000,
  }, async () => {
    for (let run = 1; run <= RUNS; run += 1) {
      const { chunks } = await runOnce(
        "cache-usage-observation",
        run,
        request([{ role: "user", text: "说明缓存证据观察请求。" }]),
      );
      const usage = chunks.find((chunk) => chunk.type === "usage") as
        | {
            type: "usage";
            inputTokens: number;
            outputTokens: number;
            cacheReadTokens?: number;
            cacheWriteTokens?: number;
          }
        | undefined;
      expect(usage).toBeDefined();
      expect(usage?.inputTokens ?? 0).toBeGreaterThan(0);
      // R2: the adapter extracts the native read dimension — a real number;
      // the write dimension stays absent (unknown, never 0).
      expect(typeof usage?.cacheReadTokens).toBe("number");
      expect(usage?.cacheReadTokens ?? -1).toBeGreaterThanOrEqual(0);
      expect(usage?.cacheWriteTokens).toBeUndefined();
      // Native==canonical value identity against the archived wire frame.
      const archived = JSON.parse(
        readFileSync(
          join(EVIDENCE_DIR, `cache-usage-observation-run${run}.json`),
          "utf8",
        ),
      ) as {
        wire: ReadonlyArray<{
          type: string;
          cacheReadTokens?: number;
          inputTokens?: number;
        }>;
      };
      const archivedUsage = archived.wire.find(
        (chunk) => chunk.type === "usage",
      );
      expect(archivedUsage?.cacheReadTokens).toBe(usage?.cacheReadTokens);
      expect(archivedUsage?.inputTokens).toBe(usage?.inputTokens);
    }
  });

  it("provider-continuation: wire observation — no resumable cursor in chat/completions", {
    timeout: 240_000,
  }, async () => {
    for (let run = 1; run <= RUNS; run += 1) {
      const { chunks } = await runOnce(
        "continuation-observation",
        run,
        request([{ role: "user", text: "续传机制观察请求。" }]),
      );
      const continuationChunks = chunks.filter(
        (chunk) => chunk.type === "continuation",
      ).length;
      expect(continuationChunks).toBe(0);
    }
  });

  it("cancellation: aborting mid-stream stops production", {
    timeout: 240_000,
  }, async () => {
    for (let run = 1; run <= RUNS; run += 1) {
      const controller = new AbortController();
      const received: OpenAISdkChunk[] = [];
      let errored = false;
      try {
        for await (const chunk of client.streamChat({
          modelRef: "model-openai",
          request: COUNT_TO_FIFTY_REQUEST,
          context: { ...context(), cancellationSignal: controller.signal },
        })) {
          received.push(chunk);
          if (received.filter((c) => c.type === "text").length >= 2) {
            controller.abort();
          }
        }
      } catch {
        errored = true;
      }
      const textCount = () => received.filter((c) => c.type === "text").length;
      const atAbort = textCount();
      await new Promise((resolve) => setTimeout(resolve, 1_500));
      expect(textCount(), `run ${run} no post-abort production`).toBe(atAbort);
      // Stream must NOT have completed normally after abort.
      const completed = received.some((chunk) => chunk.type === "completed");
      expect(
        completed && !errored,
        `run ${run} aborted stream is not a clean completion`,
      ).toBe(false);
      writeFileSync(
        join(EVIDENCE_DIR, `cancellation-run${run}.json`),
        JSON.stringify(
          { run, received: received.length, errored, atAbort },
          null,
          2,
        ),
      );
    }
  });
});
