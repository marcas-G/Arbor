import { Effect, type Layer } from "effect";
import type { ChatMessage, ModelTurn, ToolCall } from "./provider.js";
import { ModelPort } from "./provider.js";
import type { Tool } from "./tool.js";
import { toolSpecs } from "./tool.js";

export type AgentFinish = "stop" | "loop-guard" | "step-limit" | "paused";

export interface AgentRunResult {
  readonly finish: AgentFinish;
  readonly steps: number;
  readonly messages: ReadonlyArray<ChatMessage>;
  readonly turns: ReadonlyArray<ModelTurn>;
}

/** Persistence hooks (P1-05A D-035): every durable boundary is recorded here. */
export interface RunHooks {
  readonly onEvent?: (type: string, payload: unknown) => Promise<void>;
  readonly shouldPause?: () => boolean;
  readonly abort?: AbortSignal;
}

export interface AgentRunInput {
  readonly providerLayer: Layer.Layer<ModelPort>;
  readonly tools: ReadonlyArray<Tool>;
  readonly system: string;
  readonly task: string;
  readonly stepLimit: number;
  /** resume: replayed message history (E5); the task is appended as user_input */
  readonly resumeMessages?: ReadonlyArray<ChatMessage>;
  readonly hooks?: RunHooks;
}

const callsKey = (calls: ReadonlyArray<ToolCall>): string => JSON.stringify(calls);

/** P1_AGENT_RUNTIME_CONTRACT minimum loop with B4 guards and P1-05 durable
 * boundaries. Tool errors are fed back as tool results — the run continues.
 * Pause: between steps (shouldPause) or mid-model-call (abort) → "paused". */
export async function runAgent(input: AgentRunInput): Promise<AgentRunResult> {
  const messages: ChatMessage[] = [...(input.resumeMessages ?? [])];
  const turns: ModelTurn[] = [];
  const hooks = input.hooks;
  const record = async (type: string, payload: unknown): Promise<void> => {
    if (hooks?.onEvent !== undefined) {
      await hooks.onEvent(type, payload);
    }
  };
  let repeatCount = 0;
  let lastKey: string | undefined;
  let steps = 0;
  let paused = false;

  messages.push({ role: "user", content: input.task });
  await record("user_input", { text: input.task });

  const program = Effect.gen(function* () {
    const model = yield* ModelPort;
    while (true) {
      if (steps >= input.stepLimit) {
        return "step-limit" as const;
      }
      if (hooks?.shouldPause?.() === true) {
        paused = true;
        return "paused" as const;
      }
      steps += 1;
      yield* Effect.promise(() => record("model_turn_started", { step: steps }));
      const turn = yield* model
        .complete(
          { system: input.system, messages: [...messages], tools: toolSpecs(input.tools) },
          hooks?.abort,
        )
        .pipe(
          Effect.catchTag("ModelError", (e) => {
            if (hooks?.abort?.aborted === true) {
              paused = true;
              return Effect.succeed(undefined as unknown as ModelTurn);
            }
            return Effect.fail(e);
          }),
        );
      if (paused) {
        return "paused" as const; // incomplete model turn is not committed
      }
      turns.push(turn);
      yield* Effect.promise(() =>
        record("model_turn_committed", {
          step: steps,
          ...(turn.content !== undefined ? { content: turn.content } : {}),
          toolCalls: turn.toolCalls,
          finishReason: turn.finishReason,
        }),
      );
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
        yield* Effect.promise(() =>
          record("tool_call_requested", {
            callId: call.id,
            name: call.name,
            argumentsJson: call.arguments,
          }),
        );
        yield* Effect.promise(() => record("tool_execution_started", { callId: call.id }));
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
        yield* Effect.promise(() =>
          record("tool_result", {
            callId: call.id,
            ok: result.ok,
            output: result.ok ? result.output : result.error,
            state: result.ok ? "succeeded" : "failed",
          }),
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
    const finish = exit.value;
    // E4: pause writes a marker, not a terminal run_finished
    await record(finish === "paused" ? "pause_marker" : "run_finished", { finish, steps });
    return { finish, steps, messages, turns };
  }
  throw new Error(`model failure: ${String(exit.cause)}`);
}
