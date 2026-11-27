import type { ToolInvocation } from "@arbor/model-context";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { makeControlToolRegistry } from "../src/control.js";
import { fixtureProviderTurnId } from "./fixtures/provider-turn.js";

const invocation = (argumentsJson: string): ToolInvocation => ({
  providerTurnId: fixtureProviderTurnId(),
  outputPosition: 0,
  callRef: "call_test",
  toolName: "claim_completion",
  argumentsJson,
});

const claimCompletionHandler = {
  action: "ClaimCompletion" as const,
  handle: () =>
    Effect.succeed({
      _tag: "Settle" as const,
      settlement: {
        _tag: "Completed" as const,
        result: {
          _tag: "CompletionClaimed" as const,
          workRevision: 0 as never,
          claimRef: "c",
        },
      },
    }),
};

describe("claim_completion codec (49 §126-136)", () => {
  it("decodes a well-formed claim", async () => {
    const registry = makeControlToolRegistry([claimCompletionHandler]);
    const decoded = await Effect.runPromise(
      registry.decode(
        invocation(JSON.stringify({ claim: "feature shipped and verified" })),
      ),
    );
    expect(decoded.action).toEqual({
      _tag: "ClaimCompletion",
      claim: "feature shipped and verified",
    });
  });

  it("rejects a missing, empty, unknown-key or malformed claim through the codec", async () => {
    // Handler registered so decode reaches the claim codec: a handler-less
    // registry fails earlier at the UnknownControlTool name gate, which is
    // covered by i0-control-registry (exact visible-definition list).
    const registry = makeControlToolRegistry([claimCompletionHandler]);
    for (const argumentsJson of [
      JSON.stringify({}),
      JSON.stringify({ claim: "" }),
      JSON.stringify({ claim: "done", workRevision: 3 }),
      "not json",
    ]) {
      const result = await Effect.runPromise(
        Effect.result(registry.decode(invocation(argumentsJson))),
      );
      expect(result._tag, argumentsJson).toBe("Failure");
    }
  });

  it("is not exposed without a registered handler (no placeholder)", async () => {
    const registry = makeControlToolRegistry();
    expect(registry.classify("claim_completion")).toBe("NotControl");
    const visible = await Effect.runPromise(registry.visibleDefinitions());
    expect(visible.some((tool) => tool.name === "claim_completion")).toBe(
      false,
    );
  });

  it("is exposed once a ClaimCompletion handler is registered", async () => {
    const registry = makeControlToolRegistry([claimCompletionHandler]);
    expect(registry.classify("claim_completion")).toBe("Control");
    const visible = await Effect.runPromise(registry.visibleDefinitions());
    const tool = visible.find(
      (definition) => definition.name === "claim_completion",
    );
    expect(tool).toBeDefined();
    expect(tool?.stableId).toBe("core.control.claim-completion");
    expect(JSON.parse(tool?.schemaJson ?? "{}")).toMatchObject({
      required: ["claim"],
    });
  });
});
