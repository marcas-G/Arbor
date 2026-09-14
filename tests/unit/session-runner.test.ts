import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { runAgent } from "../../src/agent-runtime/agent-loop.js";
import type { ModelTurn } from "../../src/agent-runtime/provider.js";
import { isResumable, replayMessages } from "../../src/agent-runtime/session-runner.js";
import { makeWriteFileTool } from "../../src/agent-runtime/tools/write-file.js";
import type { TranscriptEnvelope } from "../../src/domain/transcript-events.js";
import { FakeProviderLive } from "../../src/infrastructure/fake-provider.js";

const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "arbor-sr-"));
  dirs.push(d);
  return d;
};
afterAll(() => {
  for (const d of dirs) {
    rmSync(d, { recursive: true, force: true });
  }
});

const env = (type: string, payload: unknown, sequence: number): TranscriptEnvelope => ({
  schemaVersion: 1,
  eventId: `e${sequence}`,
  agentId: "a1",
  sequence,
  timestamp: "2026-09-14T00:00:00Z",
  type,
  payload,
});

describe("replayMessages (E5)", () => {
  it("rebuilds user/assistant/tool messages from durable events", () => {
    const events = [
      env("user_input", { text: "task" }, 1),
      env(
        "model_turn_committed",
        {
          step: 1,
          toolCalls: [{ id: "c1", name: "write_file", arguments: '{"path":"x","content":"v"}' }],
          finishReason: "tool-calls",
        },
        2,
      ),
      env("tool_result", { callId: "c1", ok: true, output: "wrote x", state: "succeeded" }, 3),
      env(
        "model_turn_committed",
        { step: 2, content: "done", toolCalls: [], finishReason: "stop" },
        4,
      ),
    ];
    const msgs = replayMessages(events);
    expect(msgs).toEqual([
      { role: "user", content: "task" },
      {
        role: "assistant",
        toolCalls: [{ id: "c1", name: "write_file", arguments: '{"path":"x","content":"v"}' }],
      },
      { role: "tool", toolCallId: "c1", content: "wrote x" },
      { role: "assistant", content: "done" },
    ]);
  });

  it("isResumable: paused yes, crashed (no marker) yes, finished no, empty no", () => {
    expect(
      isResumable([
        env("user_input", { text: "t" }, 1),
        env("pause_marker", { finish: "paused", steps: 2 }, 2),
      ]),
    ).toBe(true);
    // crash: user_input + tool events with NO terminal marker at all
    expect(
      isResumable([
        env("user_input", { text: "t" }, 1),
        env("tool_result", { callId: "c", ok: true, output: "o", state: "succeeded" }, 2),
      ]),
    ).toBe(true);
    expect(
      isResumable([
        env("user_input", { text: "t" }, 1),
        env("run_finished", { finish: "stop", steps: 3 }, 2),
      ]),
    ).toBe(false);
    expect(isResumable([env("run_finished", { finish: "stop", steps: 3 }, 3)])).toBe(false);
    expect(isResumable([])).toBe(false);
  });
});

describe("persistent runAgent hooks (E1/E4)", () => {
  const toolTurn: ModelTurn = {
    content: undefined,
    toolCalls: [
      { id: "c1", name: "write_file", arguments: JSON.stringify({ path: "x.txt", content: "v" }) },
    ],
    finishReason: "tool-calls",
  };
  const stopTurn: ModelTurn = { content: "done", toolCalls: [], finishReason: "stop" };

  it("records the durable boundary sequence", async () => {
    const events: Array<[string, unknown]> = [];
    const r = await runAgent({
      providerLayer: FakeProviderLive.withScript([toolTurn, stopTurn]),
      tools: [makeWriteFileTool(tmp())],
      system: "s",
      task: "t",
      stepLimit: 5,
      hooks: {
        onEvent: async (type, payload) => {
          events.push([type, payload]);
        },
      },
    });
    expect(r.finish).toBe("stop");
    const types = events.map(([t]) => t);
    expect(types).toEqual([
      "user_input",
      "model_turn_started",
      "model_turn_committed",
      "tool_call_requested",
      "tool_execution_started",
      "tool_result",
      "model_turn_started",
      "model_turn_committed",
      "run_finished",
    ]);
  });

  it("pause lands between steps: the in-flight tool result is fully recorded first", async () => {
    // SIGINT mid-tool must not tear the durable record: the loop records
    // tool_result before honoring the pause (write path has no interrupt point)
    const events: Array<[string, unknown]> = [];
    const r = await runAgent({
      providerLayer: FakeProviderLive.withScript([toolTurn, stopTurn, stopTurn]),
      tools: [makeWriteFileTool(tmp())],
      system: "s",
      task: "t",
      stepLimit: 5,
      hooks: {
        onEvent: async (type, payload) => {
          events.push([type, payload]);
        },
        shouldPause: () => events.some(([t]) => t === "tool_result"), // pause as soon as a result lands
      },
    });
    expect(r.finish).toBe("paused");
    const types = events.map(([t]) => t);
    const firstToolResult = types.indexOf("tool_result");
    const pauseIdx = types.indexOf("pause_marker");
    expect(firstToolResult).toBeGreaterThanOrEqual(0);
    expect(pauseIdx).toBeGreaterThan(firstToolResult); // marker strictly after the durable result
    // the recorded tool_result is complete (all four payload fields)
    const [, payload] = events[firstToolResult] as [string, unknown];
    expect(payload).toMatchObject({ callId: "c1", ok: true, state: "succeeded" });
  });

  it("shouldPause between steps yields paused + pause_marker", async () => {
    const events: Array<string> = [];
    let calls = 0;
    const r = await runAgent({
      providerLayer: FakeProviderLive.withScript([toolTurn, stopTurn, stopTurn]),
      tools: [makeWriteFileTool(tmp())],
      system: "s",
      task: "t",
      stepLimit: 5,
      hooks: {
        onEvent: async (type) => {
          events.push(type);
        },
        shouldPause: () => {
          calls += 1;
          return calls > 1; // allow first step, pause before second
        },
      },
    });
    expect(r.finish).toBe("paused");
    expect(events.includes("pause_marker")).toBe(true);
    expect(events.includes("run_finished")).toBe(false);
  });

  it("resume: replayed messages precede the new task input", async () => {
    const events: Array<string> = [];
    const r = await runAgent({
      providerLayer: FakeProviderLive.withScript([stopTurn]),
      tools: [],
      system: "s",
      task: "continue please",
      stepLimit: 5,
      resumeMessages: [
        { role: "user", content: "original task" },
        {
          role: "assistant",
          toolCalls: [{ id: "c1", name: "write_file", arguments: '{"path":"x","content":"v"}' }],
        },
        { role: "tool", toolCallId: "c1", content: "wrote x" },
      ],
      hooks: {
        onEvent: async (type) => {
          events.push(type);
        },
      },
    });
    expect(r.finish).toBe("stop");
    expect(r.messages[0]).toEqual({ role: "user", content: "original task" });
    expect(r.messages[3]).toEqual({ role: "user", content: "continue please" });
  });
});
