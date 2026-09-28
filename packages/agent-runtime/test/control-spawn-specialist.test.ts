import type { ToolInvocation } from "@arbor/model-context";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { makeControlToolRegistry } from "../src/control.js";

const invocation = (argumentsJson: string): ToolInvocation => ({
  providerTurnId: "ptn_test" as never,
  outputPosition: 0,
  callRef: "call_test",
  toolName: "arbor_spawn_specialist",
  argumentsJson,
});

const stubHandler = {
  action: "SpawnSpecialist" as const,
  handle: () =>
    Effect.succeed({
      _tag: "Observation" as const,
      source: "Runtime" as const,
      observation: { text: "stub", truncated: false },
    }),
};

describe("arbor_spawn_specialist codec", () => {
  it("decodes a mission with constraints", async () => {
    const registry = makeControlToolRegistry([stubHandler]);
    const decoded = await Effect.runPromise(
      registry.decode(
        invocation(
          JSON.stringify({
            mission: "profile the failing query",
            constraints: ["read-only"],
          }),
        ),
      ),
    );
    expect(decoded.action).toEqual({
      _tag: "SpawnSpecialist",
      mission: "profile the failing query",
      constraints: ["read-only"],
    });
  });

  it("decodes a bare mission", async () => {
    const registry = makeControlToolRegistry([stubHandler]);
    const decoded = await Effect.runPromise(
      registry.decode(invocation(JSON.stringify({ mission: "help" }))),
    );
    expect(decoded.action).toEqual({
      _tag: "SpawnSpecialist",
      mission: "help",
      constraints: [],
    });
  });

  it("rejects a missing or empty mission", async () => {
    const registry = makeControlToolRegistry([stubHandler]);
    for (const args of ["{}", '{"mission": ""}']) {
      const exit = await Effect.runPromise(
        Effect.exit(registry.decode(invocation(args))),
      );
      expect(exit._tag).toBe("Failure");
    }
  });

  it("rejects non-string constraints", async () => {
    const registry = makeControlToolRegistry([stubHandler]);
    const exit = await Effect.runPromise(
      Effect.exit(
        registry.decode(
          invocation(JSON.stringify({ mission: "m", constraints: [1] })),
        ),
      ),
    );
    expect(exit._tag).toBe("Failure");
  });

  it("is not exposed without a registered handler", () => {
    const registry = makeControlToolRegistry();
    expect(registry.classify("arbor_spawn_specialist")).toBe("NotControl");
  });
});
