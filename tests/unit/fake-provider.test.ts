import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { ModelPort } from "../../src/agent-runtime/provider.js";
import { FakeProviderLive } from "../../src/infrastructure/fake-provider.js";

describe("FakeProvider (scripted)", () => {
  it("returns scripted turns in order", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const p = yield* ModelPort;
        const r1 = yield* p.complete({ system: "s", messages: [] });
        const r2 = yield* p.complete({ system: "s", messages: [] });
        expect(r1.finishReason).toBe("tool-calls");
        expect(r1.toolCalls[0]?.name).toBe("read_file");
        expect(r2.finishReason).toBe("stop");
        expect(r2.content).toBe("done");
      }).pipe(
        Effect.provide(
          FakeProviderLive.withScript([
            {
              content: undefined,
              toolCalls: [{ id: "c1", name: "read_file", arguments: '{"path":"a.txt"}' }],
              finishReason: "tool-calls",
            },
            { content: "done", toolCalls: [], finishReason: "stop" },
          ]),
        ),
      ),
    );
  });

  it("exhausted script fails with ModelError", async () => {
    const exit = await Effect.runPromiseExit(
      Effect.gen(function* () {
        const p = yield* ModelPort;
        yield* p.complete({ system: "s", messages: [] });
        return yield* p.complete({ system: "s", messages: [] });
      }).pipe(
        Effect.provide(
          FakeProviderLive.withScript([{ content: "x", toolCalls: [], finishReason: "stop" }]),
        ),
      ),
    );
    expect(exit._tag).toBe("Failure");
  });
});
