import {
  ContextEpochNumber,
  ExecutionId,
  ProviderTurnId,
  parse,
  SessionId,
} from "@arbor/domain";
import { describe, expect, it } from "vitest";
import { compileTurn, type ModelContextPlan } from "../src/index.js";

const plan: ModelContextPlan = {
  instructions: {
    effective: [
      {
        identity: "runtime-safety",
        revision: 1,
        hash: "h1",
        semanticKind: "RuntimeSafety",
        source: "Canonical",
        scope: "runtime-safety",
        authorityRole: "A0",
        strength: "Hard",
        compositionMode: "Constrain",
        activationCondition: "always",
        lifetime: "Pinned",
        cacheClass: "Stable",
        budgetClass: "b",
        modelCompatibility: [],
        contentRef: "runtime safety text",
      },
    ],
    suppressed: [],
    conflicts: [],
    governanceIssues: [],
  },
  context: [],
  tools: [],
  skills: [],
  outputContract: "agent-directive-v1",
  continuation: "recent-frontier",
  controlBasis: {
    projectPolicyRevision: 0,
    workspacePolicyRevision: 0,
    responsibilityRevision: 0,
    resourceBoundaryRevision: 0,
    authorizationDigest: "digest",
    environmentRevision: "env-1",
  },
};

const capability = {
  modelRef: "model-a",
  family: "family-a",
  contextWindow: 1000,
  outputCeiling: 200,
  toolProtocol: "json",
};

describe("P3 model-family compiler", () => {
  it("produces a stable manifest hash and carries A0 instructions", () => {
    const input = {
      plan,
      capability,
      providerTurnId: parse(ProviderTurnId)(
        "ptn_018f2b3c-4d5e-7abc-8def-0123456789a1",
      ),
      executionId: parse(ExecutionId)(
        "exe_018f2b3c-4d5e-7abc-8def-0123456789a1",
      ),
      sessionId: parse(SessionId)("ses_018f2b3c-4d5e-7abc-8def-0123456789a1"),
      contextEpoch: parse(ContextEpochNumber)(0),
      maxOutputTokens: 128,
    };
    const first = compileTurn(input);
    const second = compileTurn(input);
    expect(first.manifest.compiledRequestHash).toBe(
      second.manifest.compiledRequestHash,
    );
    expect(first.manifest.instructionFragments.map((f) => f.identity)).toEqual([
      "runtime-safety",
    ]);
    expect(first.request.instructions[0]?.authorityRole).toBe("A0");
    expect(first.manifest.controlBasis.environmentRevision).toBe("env-1");
  });
});
