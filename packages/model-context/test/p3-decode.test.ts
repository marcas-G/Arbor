import type { CanonicalProviderEvent } from "@arbor/ports";
import { describe, expect, it } from "vitest";
import { decodeTurn } from "../src/index.js";

const events = (
  extra: ReadonlyArray<CanonicalProviderEvent>,
): ReadonlyArray<CanonicalProviderEvent> => [
  {
    _tag: "TurnStarted",
    providerTurnId: "ptn_x" as never,
    attemptNo: 0,
    modelRef: "m",
  },
  ...extra,
  { _tag: "TurnCompleted", finishReason: "Stop" },
];

describe("P3 decodeTurn", () => {
  it("decodes text into ModelOutput without constructing an AgentAction", () => {
    const result = decodeTurn(events([{ _tag: "TextDelta", text: "hi" }]));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.output.text).toBe("hi");
      expect(result.output.toolInvocations).toEqual([]);
    }
  });

  it("preserves a provider-neutral typed ToolInvocation", () => {
    const result = decodeTurn(
      events([
        {
          _tag: "ToolCallProposed",
          callRef: "c1",
          toolName: "read",
          argumentsJson: '{"path":"README.md"}',
        },
      ]),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.output.toolInvocations).toEqual([
        {
          providerTurnId: "ptn_x",
          outputPosition: 0,
          callRef: "c1",
          toolName: "read",
          argumentsJson: '{"path":"README.md"}',
        },
      ]);
    }
  });

  it("rejects tool calls without turn identity, arguments, or unique call identity", () => {
    expect(
      decodeTurn([
        {
          _tag: "ToolCallProposed",
          callRef: "c1",
          toolName: "read",
          argumentsJson: "{}",
        },
      ]).ok,
    ).toBe(false);
    expect(
      decodeTurn(
        events([
          {
            _tag: "ToolCallProposed",
            callRef: "",
            toolName: "read",
            argumentsJson: "{}",
          },
        ]),
      ).ok,
    ).toBe(false);
    expect(
      decodeTurn(
        events([
          {
            _tag: "ToolCallProposed",
            callRef: "same",
            toolName: "read",
            argumentsJson: "{}",
          },
          {
            _tag: "ToolCallProposed",
            callRef: "same",
            toolName: "list",
            argumentsJson: "{}",
          },
        ]),
      ).ok,
    ).toBe(false);
  });

  it("rejects an empty turn", () => {
    expect(decodeTurn(events([])).ok).toBe(false);
  });
});
