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
        complete: () =>
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
};
