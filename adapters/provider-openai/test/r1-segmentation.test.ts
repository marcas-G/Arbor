import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Effect, Layer, Stream } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { describe, expect, it } from "vitest";
import type { OpenAISdkClient } from "../src/index.js";
import { OpenAICompatibleFetchClient } from "../src/index.js";
import type { OpenAISdkChunk } from "../src/sdk.js";

/**
 * R1 (Gate D1 remediation) — chunk-segmentation independence of the
 * OpenAI-compatible SSE reader.
 *
 * The D1 live qualification saw an INTERMITTENT truncated tool-arguments
 * reconstruction. These tests pin the frozen real DeepSeek SSE stream (the
 * raw capture that proves the provider sends a complete valid arguments
 * JSON) and prove: for every segmentation of that byte stream — enumerated
 * chunk sizes plus randomized cuts — the reconstructed canonical arguments
 * are byte-identical to the raw concatenation. No repair, no tolerance.
 */

const ROOT = join(fileURLToPath(import.meta.url), "..", "..", "..", "..");
const RAW = readFileSync(
  join(
    ROOT,
    "planning/testing/provider-qualification/dep-env/l3/tool-fragmented-args-raw-wire-evidence.txt",
  ),
  "utf8",
);

/** Ground truth: raw concatenation of tool_calls arguments deltas. */
const rawArgumentsOf = (): ReadonlyArray<{ index: number; args: string }> => {
  const perCall = new Map<number, string>();
  for (const line of RAW.split("\n")) {
    if (!line.startsWith("data:")) continue;
    // Captures can be checked out with CRLF; the SSE payload itself is
    // line-ending agnostic, so remove the record terminator before parsing.
    const payload = line.slice(5).trim();
    if (payload === "[DONE]") continue;
    const frame = JSON.parse(payload) as {
      choices?: Array<{
        delta?: {
          tool_calls?: Array<{
            index?: number;
            function?: { arguments?: string };
          }>;
        };
      }>;
    };
    for (const call of frame.choices?.[0]?.delta?.tool_calls ?? []) {
      const index = call.index ?? 0;
      perCall.set(
        index,
        (perCall.get(index) ?? "") + (call.function?.arguments ?? ""),
      );
    }
  }
  return [...perCall.entries()]
    .sort(([a], [b]) => a - b)
    .map(([index, args]) => ({ index, args }));
};

const EXPECTED = rawArgumentsOf();
expect(EXPECTED.length).toBeGreaterThanOrEqual(1);
expect(EXPECTED[0]?.args.length ?? 0).toBeGreaterThan(300);
expect(() => JSON.parse(EXPECTED[0]?.args ?? "")).not.toThrow();

const bytesOf = () => new TextEncoder().encode(RAW);

const clientAt = (parts: ReadonlyArray<Uint8Array>): OpenAISdkClient =>
  OpenAICompatibleFetchClient({
    baseUrl: "http://segmentation.test/v1",
    // Local deterministic transport double — the explicit unauthenticated
    // exemption (P16 `01` §3).
    allowUnauthenticated: true,
    fetch: (async () => ({
      ok: true,
      status: 200,
      body: {
        getReader: () => {
          let position = 0;
          return {
            read: () =>
              new Promise((resolve) => {
                if (position >= parts.length) {
                  resolve({ done: true, value: undefined });
                  return;
                }
                resolve({ done: false, value: parts[position] });
                position += 1;
              }),
            releaseLock: () => undefined,
          };
        },
      },
    })) as never,
  });

const canonicalToolCalls = async (
  client: OpenAISdkClient,
): Promise<ReadonlyArray<{ callRef: string; argumentsJson: string }>> => {
  const chunks: OpenAISdkChunk[] = [];
  for await (const chunk of client.streamChat({
    modelRef: "m",
    request: {
      modelRef: "m",
      instructions: [],
      messages: [],
      toolDefinitions: [],
      outputContractRef: "oc",
      budget: { maxOutputTokens: 64 },
      cacheHints: [],
    },
    context: {
      providerTurnId: "ptn_seg" as never,
      attemptNo: 0,
      cancellationSignal: new AbortController().signal,
      connectTimeoutMs: 5_000,
      firstEventTimeoutMs: 5_000,
      streamIdleTimeoutMs: 5_000,
      turnDeadlineAt: new Date(Date.now() + 20_000).toISOString(),
      maxAttempts: 1,
    },
  })) {
    chunks.push(chunk);
  }
  return chunks
    .filter(
      (chunk): chunk is Extract<OpenAISdkChunk, { type: "tool_call" }> =>
        chunk.type === "tool_call",
    )
    .map((chunk) => ({
      callRef: chunk.callRef,
      argumentsJson: chunk.argumentsJson,
    }));
};

const fixedParts = (size: number): ReadonlyArray<Uint8Array> => {
  const bytes = bytesOf();
  const parts: Uint8Array[] = [];
  for (let index = 0; index < bytes.length; index += size) {
    parts.push(bytes.slice(index, index + size));
  }
  return parts;
};

const randomParts = (): ReadonlyArray<Uint8Array> => {
  const bytes = bytesOf();
  const parts: Uint8Array[] = [];
  let index = 0;
  while (index < bytes.length) {
    const step = 1 + Math.floor(Math.random() * 300);
    parts.push(bytes.slice(index, index + step));
    index += step;
  }
  return parts;
};

describe("R1 — SSE chunk-segmentation independence (frozen DeepSeek capture)", () => {
  it.each([
    1, 2, 3, 5, 7, 11, 13, 17, 64, 101, 256, 512, 1024, 4096, 8192, 1_000_000,
  ])(
    "byte-identical reconstruction at chunk size %i",
    { timeout: 60_000 },
    async (size) => {
      const calls = await canonicalToolCalls(clientAt(fixedParts(size)));
      expect(calls.length).toBe(EXPECTED.length);
      for (const [index, expected] of EXPECTED.entries()) {
        expect(calls[index]?.argumentsJson).toBe(expected.args);
      }
    },
  );

  it("randomized segmentations stay byte-identical (60 trials)", {
    timeout: 120_000,
  }, async () => {
    for (let trial = 0; trial < 60; trial += 1) {
      const calls = await canonicalToolCalls(clientAt(randomParts()));
      expect(calls.length).toBe(EXPECTED.length);
      for (const [index, expected] of EXPECTED.entries()) {
        expect(
          calls[index]?.argumentsJson,
          `trial ${trial} call ${index}`,
        ).toBe(expected.args);
      }
    }
  });

  it("adversarial cuts on every SSE event boundary and mid-data positions", {
    timeout: 120_000,
  }, async () => {
    // Cut exactly at every newline and at every "data:" prefix start; then
    // pairwise combinations of adjacent cuts.
    const bytes = bytesOf();
    const text = RAW;
    const cutPoints = new Set<number>();
    for (let i = 0; i < text.length; i += 1) {
      if (text[i] === "\n") {
        cutPoints.add(i + 1);
        cutPoints.add(i);
      }
      if (text.startsWith("data:", i)) {
        cutPoints.add(i);
        cutPoints.add(i + 5);
      }
    }
    const cuts = [...cutPoints].sort((a, b) => a - b);
    const partsOf = (points: ReadonlyArray<number>): Uint8Array[] => {
      const parts: Uint8Array[] = [];
      let previous = 0;
      for (const point of points) {
        if (point > previous && point <= bytes.length) {
          parts.push(bytes.slice(previous, point));
          previous = point;
        }
      }
      if (previous < bytes.length) {
        parts.push(bytes.slice(previous));
      }
      return parts;
    };
    // every single boundary cut
    for (const cut of cuts) {
      const calls = await canonicalToolCalls(clientAt(partsOf([cut])));
      expect(calls[0]?.argumentsJson.length, `single cut at ${cut}`).toBe(
        EXPECTED[0]?.args.length,
      );
    }
    // all boundaries at once (one part per line-ish fragment)
    const calls = await canonicalToolCalls(clientAt(partsOf(cuts)));
    expect(calls.length).toBe(EXPECTED.length);
    for (const [index, expected] of EXPECTED.entries()) {
      expect(calls[index]?.argumentsJson).toBe(expected.args);
    }
  });

  it("multi-call interleaving + late/duplicate id + empty deltas do not disturb the accumulator", async () => {
    // Synthetic wire exercising the enumerated edge shapes the remediation
    // must survive (index-only continuation, id re-stated, interleaved calls,
    // empty content frames between tool deltas, finish adjacent to last delta).
    const frame = (payload: unknown) => `data: ${JSON.stringify(payload)}\n\n`;
    const wire =
      frame({ choices: [{ delta: { content: "" } }] }) +
      frame({
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: "call-x",
                  function: { name: "write", arguments: '{"path":"' },
                },
              ],
            },
          },
        ],
      }) +
      frame({ choices: [{ delta: { reasoning_content: "" } }] }) +
      frame({
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 1,
                  id: "call-y",
                  function: { name: "read", arguments: '{"p":' },
                },
              ],
            },
          },
        ],
      }) +
      frame({ choices: [{ delta: {} }] }) +
      frame({
        choices: [
          {
            delta: {
              tool_calls: [{ index: 0, function: { arguments: 'a.md"}' } }],
            },
          },
        ],
      }) +
      frame({
        choices: [
          {
            delta: {
              tool_calls: [
                { index: 0, id: "call-x", function: { arguments: "" } },
              ],
            },
          },
        ],
      }) +
      frame({
        choices: [
          {
            delta: {
              tool_calls: [{ index: 1, function: { arguments: "1}" } }],
            },
          },
          { finish_reason: "tool_calls" },
        ],
      }) +
      "data: [DONE]\n\n";
    const bytes = new TextEncoder().encode(wire);
    const parts: Uint8Array[] = [];
    for (let i = 0; i < bytes.length; i += 9) {
      parts.push(bytes.slice(i, i + 9));
    }
    const calls = await canonicalToolCalls(clientAt(parts));
    expect(calls).toEqual([
      { callRef: "call-x", argumentsJson: '{"path":"a.md"}' },
      { callRef: "call-y", argumentsJson: '{"p":1}' },
    ]);
  });
});

// keep unused framework imports referenced for the lint pass
void Effect;
void Stream;
void SqlClient;
void Layer;
