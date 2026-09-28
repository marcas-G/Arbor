import type { ToolInvocation } from "@arbor/model-context";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { makeControlToolRegistry } from "../src/control.js";

const invocation = (argumentsJson: string): ToolInvocation => ({
  providerTurnId: "ptn_test" as never,
  outputPosition: 0,
  callRef: "call_test",
  toolName: "arbor_claim_completion",
  argumentsJson,
});

describe("arbor_claim_completion codec (49 §126-136)", () => {
  it("decodes a well-formed claim", async () => {
    const registry = makeControlToolRegistry([
      {
        action: "ClaimCompletion",
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
      },
    ]);
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

  it("rejects a missing claim", async () => {
    const registry = makeControlToolRegistry();
    const result = await Effect.runPromise(
      Effect.result(registry.decode(invocation(JSON.stringify({})))),
    );
    expect(result._tag).toBe("Failure");
  });

  it("rejects an empty claim", async () => {
    const registry = makeControlToolRegistry();
    const result = await Effect.runPromise(
      Effect.result(registry.decode(invocation(JSON.stringify({ claim: "" })))),
    );
    expect(result._tag).toBe("Failure");
  });

  it("rejects unknown keys (closed object)", async () => {
    const registry = makeControlToolRegistry();
    const result = await Effect.runPromise(
      Effect.result(
        registry.decode(
          invocation(JSON.stringify({ claim: "done", workRevision: 3 })),
        ),
      ),
    );
    expect(result._tag).toBe("Failure");
  });

  it("rejects malformed JSON", async () => {
    const registry = makeControlToolRegistry();
    const result = await Effect.runPromise(
      Effect.result(registry.decode(invocation("not json"))),
    );
    expect(result._tag).toBe("Failure");
  });

  it("is not exposed without a registered handler (no placeholder)", async () => {
    const registry = makeControlToolRegistry();
    expect(registry.classify("arbor_claim_completion")).toBe("NotControl");
    const visible = await Effect.runPromise(registry.visibleDefinitions());
    expect(visible.some((tool) => tool.name === "arbor_claim_completion")).toBe(
      false,
    );
  });

  it("is exposed once a ClaimCompletion handler is registered", async () => {
    const registry = makeControlToolRegistry([
      {
        action: "ClaimCompletion",
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
      },
    ]);
    expect(registry.classify("arbor_claim_completion")).toBe("Control");
    const visible = await Effect.runPromise(registry.visibleDefinitions());
    const tool = visible.find(
      (definition) => definition.name === "arbor_claim_completion",
    );
    expect(tool).toBeDefined();
    expect(JSON.parse(tool?.schemaJson ?? "{}")).toMatchObject({
      required: ["claim"],
    });
  });
});
