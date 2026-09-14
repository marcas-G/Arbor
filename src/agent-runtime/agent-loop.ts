import { Effect, type Layer } from "effect";
import type { ChatMessage, ModelTurn, ToolCall } from "./provider.js";
import { ModelPort } from "./provider.js";
import type { Tool } from "./tool.js";
import { toolSpecs } from "./tool.js";

export type AgentFinish = "stop" | "loop-guard" | "step-limit";

export interface AgentRunResult {
  readonly finish: AgentFinish;
  readonly steps: number;
  readonly messages: ReadonlyArray<ChatMessage>;
  readonly turns: ReadonlyArray<ModelTurn>;
}

export interface AgentRunInput {
  readonly providerLayer: Layer.Layer<ModelPort>;
  readonly tools: ReadonlyArray<Tool>;
  readonly system: string;
  readonly task: string;
  readonly stepLimit: number;
}

const callsKey = (calls: ReadonlyArray<ToolCall>): string => JSON.stringify(calls);

/** P1_AGENT_RUNTIME_CONTRACT minimum loop with B4 guards:
 * 25-step default cap handled by caller; 3 consecutive identical tool-call
 * rounds terminate with a diagnostic finish reason. Tool errors are fed back
 * as tool results — the run continues. */
export async function runAgent(input: AgentRunInput): Promise<AgentRunResult> {
  const messages: ChatMessage[] = [{ role: "user", content: input.task }];
  const turns: ModelTurn[] = [];
  let repeatCount = 0;
  let lastKey: string | undefined;
  let steps = 0;

  const program = Effect.gen(function* () {
    const model = yield* ModelPort;
    while (true) {
      if (steps >= input.stepLimit) {
        return "step-limit" as const;
      }
      steps += 1;
      const turn = yield* model.complete({
        system: input.system,
        messages: [...messages],
        tools: toolSpecs(input.tools),
      });
      turns.push(turn);
      messages.push({
        role: "assistant",
        ...(turn.content !== undefined ? { content: turn.content } : {}),
        ...(turn.toolCalls.length > 0 ? { toolCalls: turn.toolCalls } : {}),
      });

      if (turn.toolCalls.length === 0) {
        return "stop" as const;
      }

      const key = callsKey(turn.toolCalls);
      repeatCount = key === lastKey ? repeatCount + 1 : 0;
      lastKey = key;
      if (repeatCount >= 2) {
        return "loop-guard" as const;
      }

      for (const call of turn.toolCalls) {
        let args: unknown;
        try {
          args = JSON.parse(call.arguments);
        } catch {
          args = undefined;
        }
        const tool = input.tools.find((t) => t.name === call.name);
        const result = yield* Effect.promise(() =>
          tool === undefined
            ? Promise.resolve({ ok: false as const, error: `unknown tool: ${call.name}` })
            : tool.run(args),
        );
        messages.push({
          role: "tool",
          toolCallId: call.id,
          content: result.ok ? result.output : `ERROR: ${result.error}`,
        });
      }
    }
  });

  const exit = await Effect.runPromiseExit(program.pipe(Effect.provide(input.providerLayer)));
  if (exit._tag === "Success") {
    return { finish: exit.value, steps, messages, turns };
  }
  throw new Error(`model failure: ${String(exit.cause)}`);
}
