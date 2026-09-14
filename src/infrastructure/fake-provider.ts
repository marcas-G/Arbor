import { readFileSync } from "node:fs";
import { Effect, Layer } from "effect";
import { ModelError, ModelPort, type ModelTurn } from "../agent-runtime/provider.js";

/** Scripted fake: each `complete` consumes the next scripted turn.
 * An exhausted script is a typed ModelError. */
export const FakeProviderLive = {
  withScript: (scriptInput: ReadonlyArray<ModelTurn>) => {
    const script = [...scriptInput];
    return Layer.succeed(
      ModelPort,
      ModelPort.of({
        complete: (_req, _signal) =>
          Effect.gen(function* () {
            const next = script.shift();
            if (next === undefined) {
              return yield* new ModelError({ message: "fake provider script exhausted" });
            }
            return next;
          }),
      }),
    );
  },

  /** CLI channel: OPENAI_API_STYLE=fake with ARBOR_FAKE_SCRIPT=<file> holding a
   * JSON array of ModelTurn. Enables process-level acceptance without a key. */
  fromEnvFile: (env: Record<string, string | undefined>) => {
    const file = env.ARBOR_FAKE_SCRIPT;
    if (file === undefined || file === "") {
      throw new Error("OPENAI_API_STYLE=fake requires ARBOR_FAKE_SCRIPT=<json file>");
    }
    const script = JSON.parse(readFileSync(file, "utf8")) as ModelTurn[];
    return FakeProviderLive.withScript(script);
  },
};
