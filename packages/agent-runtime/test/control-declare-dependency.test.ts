import type { ToolInvocation } from "@arbor/model-context";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { makeControlToolRegistry } from "../src/control.js";

const invocation = (argumentsJson: string): ToolInvocation => ({
  providerTurnId: "ptn_test" as never,
  outputPosition: 0,
  callRef: "call_test",
  toolName: "arbor_declare_dependency",
  argumentsJson,
});

const stubHandler = {
  action: "DeclareDependency" as const,
  handle: () =>
    Effect.succeed({
      _tag: "Observation" as const,
      source: "Runtime" as const,
      observation: { text: "stub", truncated: false },
    }),
};

describe("arbor_declare_dependency codec", () => {
  it("decodes an AnyProducer dependency with roles", async () => {
    const registry = makeControlToolRegistry([stubHandler]);
    const decoded = await Effect.runPromise(
      registry.decode(
        invocation(
          JSON.stringify({
            producerBinding: { _tag: "AnyProducer" },
            expectedDeliverable: {
              kind: "build-report",
              requiredArtifactRoles: ["report"],
            },
          }),
        ),
      ),
    );
    expect(decoded.action).toEqual({
      _tag: "DeclareDependency",
      producerBinding: { _tag: "AnyProducer" },
      expectedDeliverable: {
        kind: "build-report",
        requiredArtifactRoles: ["report"],
      },
    });
  });

  it("decodes a WorkspaceBound producer", async () => {
    const registry = makeControlToolRegistry([stubHandler]);
    const decoded = await Effect.runPromise(
      registry.decode(
        invocation(
          JSON.stringify({
            producerBinding: {
              _tag: "WorkspaceBound",
              workspaceId: "ws_018f2b3c-4d5e-7abc-8def-0123456789ff",
            },
            expectedDeliverable: { kind: "k", requiredArtifactRoles: [] },
          }),
        ),
      ),
    );
    expect(decoded.action._tag).toBe("DeclareDependency");
  });

  it("rejects an unknown producer binding tag", async () => {
    const registry = makeControlToolRegistry([stubHandler]);
    const exit = await Effect.runPromise(
      Effect.exit(
        registry.decode(
          invocation(
            JSON.stringify({
              producerBinding: { _tag: "Anyone" },
              expectedDeliverable: { kind: "k", requiredArtifactRoles: [] },
            }),
          ),
        ),
      ),
    );
    expect(exit._tag).toBe("Failure");
  });

  it("rejects a malformed workspaceId", async () => {
    const registry = makeControlToolRegistry([stubHandler]);
    const exit = await Effect.runPromise(
      Effect.exit(
        registry.decode(
          invocation(
            JSON.stringify({
              producerBinding: { _tag: "WorkspaceBound", workspaceId: "nope" },
              expectedDeliverable: { kind: "k", requiredArtifactRoles: [] },
            }),
          ),
        ),
      ),
    );
    expect(exit._tag).toBe("Failure");
  });

  it("rejects an expectedDeliverable without a kind", async () => {
    const registry = makeControlToolRegistry([stubHandler]);
    const exit = await Effect.runPromise(
      Effect.exit(
        registry.decode(
          invocation(
            JSON.stringify({
              producerBinding: { _tag: "AnyProducer" },
              expectedDeliverable: { requiredArtifactRoles: [] },
            }),
          ),
        ),
      ),
    );
    expect(exit._tag).toBe("Failure");
  });

  it("is not exposed without a registered handler", () => {
    const registry = makeControlToolRegistry();
    expect(registry.classify("arbor_declare_dependency")).toBe("NotControl");
  });
});
