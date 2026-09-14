import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { runAgent } from "../../src/agent-runtime/agent-loop.js";
import type { ModelTurn } from "../../src/agent-runtime/provider.js";
import { makeWriteFileTool } from "../../src/agent-runtime/tools/write-file.js";
import { FakeProviderLive } from "../../src/infrastructure/fake-provider.js";

const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "arbor-loop-"));
  dirs.push(d);
  return d;
};
afterAll(() => {
  for (const d of dirs) {
    rmSync(d, { recursive: true, force: true });
  }
});

const toolTurn: ModelTurn = {
  content: undefined,
  toolCalls: [
    { id: "c1", name: "write_file", arguments: JSON.stringify({ path: "x.txt", content: "v" }) },
  ],
  finishReason: "tool-calls",
};
const stopTurn: ModelTurn = { content: "done", toolCalls: [], finishReason: "stop" };

describe("runAgent", () => {
  it("executes tools across turns then finishes on stop", async () => {
    const r = await runAgent({
      providerLayer: FakeProviderLive.withScript([toolTurn, toolTurn, stopTurn]),
      tools: [makeWriteFileTool(tmp())],
      system: "s",
      task: "do it",
      stepLimit: 25,
    });
    expect(r.finish).toBe("stop");
    expect(r.steps).toBe(3);
  });

  it("3 consecutive identical tool rounds trigger loop-guard (B4)", async () => {
    const r = await runAgent({
      providerLayer: FakeProviderLive.withScript([
        toolTurn,
        toolTurn,
        toolTurn,
        toolTurn,
        stopTurn,
      ]),
      tools: [makeWriteFileTool(tmp())],
      system: "s",
      task: "t",
      stepLimit: 25,
    });
    expect(r.finish).toBe("loop-guard");
  });

  it("step limit terminates with diagnostic finish", async () => {
    const r = await runAgent({
      providerLayer: FakeProviderLive.withScript(
        Array.from({ length: 30 }, (_, i) => ({
          ...toolTurn,
          toolCalls: [{ ...toolTurn.toolCalls[0]!, id: `c${i}` }],
        })),
      ),
      tools: [makeWriteFileTool(tmp())],
      system: "s",
      task: "t",
      stepLimit: 3,
    });
    expect(r.finish).toBe("step-limit");
    expect(r.steps).toBe(3);
  });

  it("tool errors are reported back as tool results and the run continues", async () => {
    const badTurn: ModelTurn = {
      content: undefined,
      toolCalls: [{ id: "c9", name: "no_such_tool", arguments: "{}" }],
      finishReason: "tool-calls",
    };
    const r = await runAgent({
      providerLayer: FakeProviderLive.withScript([badTurn, stopTurn]),
      tools: [makeWriteFileTool(tmp())],
      system: "s",
      task: "t",
      stepLimit: 25,
    });
    expect(r.finish).toBe("stop");
    expect(r.messages.some((m) => m.role === "tool" && m.content.startsWith("ERROR:"))).toBe(true);
  });

  it("writes real files through the fake script", async () => {
    const root = tmp();
    const write = makeWriteFileTool(root);
    const turn: ModelTurn = {
      content: undefined,
      toolCalls: [
        {
          id: "c1",
          name: "write_file",
          arguments: JSON.stringify({ path: "made/by-agent.txt", content: "agent was here" }),
        },
      ],
      finishReason: "tool-calls",
    };
    const r = await runAgent({
      providerLayer: FakeProviderLive.withScript([turn, stopTurn]),
      tools: [write],
      system: "s",
      task: "t",
      stepLimit: 5,
    });
    expect(r.finish).toBe("stop");
    expect(readFileSync(join(root, "made/by-agent.txt"), "utf8")).toBe("agent was here");
  });
});
