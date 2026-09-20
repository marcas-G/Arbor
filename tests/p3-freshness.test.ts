import { describe, expect, it } from "vitest";
import {
  checkFreshness,
  requirementForDirective,
} from "../packages/agent-runtime/src/index.js";
import type {
  AgentDirective,
  ControlBasis,
} from "../packages/model-context/src/index.js";

const basis: ControlBasis = {
  projectPolicyRevision: 0,
  workspacePolicyRevision: 0,
  responsibilityRevision: 1,
  resourceBoundaryRevision: 0,
  authorizationDigest: "d",
  environmentRevision: "env-1",
};

describe("P3 DecisionStale / freshness", () => {
  it("classifies write/destructive directives as Strong and read-only as Weak", () => {
    expect(
      requirementForDirective({
        _tag: "InvokeTool",
        intent: { callRef: "c", toolName: "t", argumentsJson: "{}" },
      }),
    ).toBe("Strong");
    expect(requirementForDirective({ _tag: "ChangeMode", mode: "m" })).toBe(
      "Weak",
    );
    expect(
      requirementForDirective({ _tag: "Communicate", message: { text: "x" } }),
    ).toBe("Weak");
  });

  it("returns DecisionStale when a Strong field changed", () => {
    const stale = checkFreshness(
      basis,
      { ...basis, responsibilityRevision: 2 },
      "Strong",
    );
    expect(stale?._tag).toBe("DecisionStale");
    expect(stale?.changed).toContain("responsibilityRevision");
  });

  it("ignores a Weak-irrelevant change but catches environment change", () => {
    expect(
      checkFreshness(basis, { ...basis, responsibilityRevision: 2 }, "Weak"),
    ).toBeNull();
    const stale = checkFreshness(
      basis,
      { ...basis, environmentRevision: "env-2" },
      "Weak",
    );
    expect(stale?.changed).toContain("environmentRevision");
  });

  it("never blocks with requirement None", () => {
    expect(
      checkFreshness(basis, { ...basis, environmentRevision: "x" }, "None"),
    ).toBeNull();
  });

  it("keeps the directive set stable for the check", () => {
    const directive: AgentDirective = {
      _tag: "CompletionClaim",
      claim: { claimRef: "c", workRevision: 0 },
    };
    expect(requirementForDirective(directive)).toBe("Strong");
  });
});
