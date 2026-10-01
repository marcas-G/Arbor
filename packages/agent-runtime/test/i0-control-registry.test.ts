import type { ToolInvocation } from "@arbor/model-context";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import {
  type AgentActionHandler,
  classifyToolRoute,
  makeControlToolRegistry,
} from "../src/control.js";

const invocation = (toolName: string, value: unknown): ToolInvocation => ({
  providerTurnId: "ptn_018f2b3c-4d5e-7abc-8def-0123456789a1" as never,
  outputPosition: 0,
  callRef: "call-1",
  toolName,
  argumentsJson: JSON.stringify(value),
});

const sendHandler: AgentActionHandler = {
  action: "SendMessage",
  handle: () =>
    Effect.succeed({
      _tag: "Observation",
      source: "Runtime",
      observation: { text: "accepted", truncated: false },
    }),
};

describe("I0 ControlToolRegistry", () => {
  it("exposes only registered control identities and classifies by registry identity", () => {
    const registry = makeControlToolRegistry([sendHandler]);
    expect(registry.definitions().map((tool) => tool.name)).toEqual([
      "arbor_wait",
      "arbor_send_message",
    ]);
    expect(registry.classify("arbor_wait")).toBe("Control");
    expect(registry.classify("read")).toBe("NotControl");
    expect(registry.classify("arbor_unregistered")).toBe("NotControl");
    expect(
      classifyToolRoute(
        [
          { name: "read", route: "Executable" },
          { name: "arbor_wait", route: "Control" },
        ],
        registry,
        "read",
      ),
    ).toEqual({ _tag: "Executable" });
    expect(
      classifyToolRoute(
        [{ name: "arbor_wait", route: "Control" }],
        registry,
        "arbor_wait",
      ),
    ).toEqual({ _tag: "Control" });
    expect(
      classifyToolRoute(
        [
          {
            name: "arbor_wait",
            route: "Control",
            version: "1",
            hash: "stale-hash",
          },
        ],
        registry,
        "arbor_wait",
      ),
    ).toEqual({ _tag: "Stale", route: "Control" });
    expect(
      classifyToolRoute(
        [{ name: "arbor_missing", route: "Control" }],
        registry,
        "arbor_missing",
      ),
    ).toEqual({ _tag: "Invalid", reason: "RouteRegistryMismatch" });
    expect(classifyToolRoute([], registry, "shell")).toEqual({
      _tag: "Invalid",
      reason: "UnknownTool",
    });
  });

  it("decodes a bounded Wait action and rejects malformed or extra fields", () => {
    const registry = makeControlToolRegistry();
    const valid = Effect.runSync(
      registry.decode(
        invocation("arbor_wait", {
          reason: "await response",
          waitSpec: { mode: "Any", conditions: [{ _tag: "Manual" }] },
        }),
      ),
    );
    expect(valid.action).toEqual({
      _tag: "Wait",
      reason: "await response",
      waitSpec: { mode: "Any", conditions: [{ _tag: "Manual" }] },
    });

    expect(() =>
      Effect.runSync(
        registry.decode(
          invocation("arbor_wait", {
            reason: "wait",
            waitSpec: { mode: "Any", conditions: [] },
          }),
        ),
      ),
    ).toThrow();
    expect(() =>
      Effect.runSync(
        registry.decode(
          invocation("arbor_wait", {
            reason: "wait",
            waitSpec: { mode: "Any", conditions: [{ _tag: "Manual" }] },
            authority: "invented",
          }),
        ),
      ),
    ).toThrow();
  });

  it("decodes SendMessage semantic fields without requiring Runtime bindings", () => {
    const registry = makeControlToolRegistry([sendHandler]);
    const query = Effect.runSync(
      registry.decode(
        invocation("arbor_send_message", {
          kind: "Query",
          body: "What is the current status?",
          recipientWorkspaceId: "ws_018f2b3c-4d5e-7abc-8def-0123456789a1",
        }),
      ),
    );
    expect(query.action._tag).toBe("SendMessage");
    if (query.action._tag === "SendMessage") {
      expect(query.action.kind).toBe("Query");
      expect(query.action.recipientWorkspaceId).toBe(
        "ws_018f2b3c-4d5e-7abc-8def-0123456789a1",
      );
      expect(query.action).not.toHaveProperty("bodyRef");
    }

    const reply = Effect.runSync(
      registry.decode(
        invocation("arbor_send_message", {
          kind: "Reply",
          body: "The status is ready.",
        }),
      ),
    );
    expect(reply.action._tag).toBe("SendMessage");
  });

  it("fails closed for unknown tools, malformed JSON, and invalid SendMessage arguments", () => {
    const registry = makeControlToolRegistry([sendHandler]);
    expect(() =>
      Effect.runSync(registry.decode(invocation("arbor_unknown", {}))),
    ).toThrow();
    expect(() =>
      Effect.runSync(
        registry.decode({
          ...invocation("arbor_wait", {}),
          argumentsJson: "{",
        }),
      ),
    ).toThrow();
    expect(() =>
      Effect.runSync(
        registry.decode(
          invocation("arbor_send_message", {
            kind: "Deliver",
            body: "not in SendMessage",
          }),
        ),
      ),
    ).toThrow();
  });
});
