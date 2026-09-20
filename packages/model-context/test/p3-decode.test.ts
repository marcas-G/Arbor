import type { CanonicalProviderEvent } from "@arbor/ports";
import { describe, expect, it } from "vitest";
import {
  AGENT_DIRECTIVE_CONTRACT,
  COMPLETION_CLAIM_CONTRACT,
  decodeTurn,
} from "../src/index.js";

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
  it("decodes text into a ModelOutput", () => {
    const result = decodeTurn(
      events([{ _tag: "TextDelta", text: "hi" }]),
      AGENT_DIRECTIVE_CONTRACT,
      "man-1",
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.output.text).toBe("hi");
      expect(result.output.directives).toHaveLength(0);
    }
  });

  it("decodes a ToolCallProposed into an InvokeTool directive, not the raw event", () => {
    const result = decodeTurn(
      events([
        {
          _tag: "ToolCallProposed",
          callRef: "c1",
          toolName: "read",
          argumentsJson: "{}",
        },
      ]),
      AGENT_DIRECTIVE_CONTRACT,
      "man-1",
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.output.directives[0]?.directive._tag).toBe("InvokeTool");
      expect(result.output.directives[0]?.decisionBasisManifestId).toBe(
        "man-1",
      );
    }
  });

  it("rejects a directive not admitted by the Output Contract", () => {
    const result = decodeTurn(
      events([
        {
          _tag: "ToolCallProposed",
          callRef: "c1",
          toolName: "read",
          argumentsJson: "{}",
        },
      ]),
      COMPLETION_CLAIM_CONTRACT,
      "man-1",
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.violation).toBe("ModelOutputContractViolation");
    }
  });

  it("rejects an empty turn and an unknown contract", () => {
    expect(decodeTurn(events([]), AGENT_DIRECTIVE_CONTRACT, "m").ok).toBe(
      false,
    );
    expect(
      decodeTurn(events([{ _tag: "TextDelta", text: "x" }]), "nope", "m").ok,
    ).toBe(false);
  });
});
