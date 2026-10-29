import { ContextEpochNumber, parse, SessionId } from "@arbor/domain";
import { describe, expect, it } from "vitest";
import { makeAgentStepContext } from "../src/step-context.js";

const base = {
  logicalStepNo: 2,
  repairAttempt: 0,
  sessionId: parse(SessionId)("ses_018f2b3c-4d5e-7abc-8def-0123456789f1"),
  contextEpoch: parse(ContextEpochNumber)(3),
  controlBasis: {
    projectPolicyRevision: 1,
    workspacePolicyRevision: 2,
    responsibilityRevision: 3,
    resourceBoundaryRevision: 4,
    authorizationDigest: "auth",
    environmentRevision: "env",
  },
  bindingFingerprint: "binding-a",
  inputFrontier: { firstSequence: 10, lastSequence: 20 },
};

describe("SCRC AgentStepContext", () => {
  it("is deterministic for the same sampling snapshot", () => {
    expect(makeAgentStepContext(base)).toEqual(makeAgentStepContext(base));
  });

  it("changes when a control revision changes", () => {
    expect(makeAgentStepContext(base).fingerprint).not.toBe(
      makeAgentStepContext({
        ...base,
        controlBasis: { ...base.controlBasis, responsibilityRevision: 4 },
      }).fingerprint,
    );
  });
});
