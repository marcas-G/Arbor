import type {
  CapturedProviderCall,
  ScriptedProviderResponse,
} from "./production-fixture.js";

const serialized = (call: CapturedProviderCall): string =>
  JSON.stringify(call.messages);

const toolNames = (call: CapturedProviderCall): ReadonlySet<string> =>
  new Set(
    call.tools
      .map((tool) => tool.function?.name)
      .filter((name): name is string => name !== undefined),
  );

export const makeWorkProvider = (input: {
  readonly marker: string;
  readonly verdict: "Pass" | "Fail" | "Unknown";
}): ((call: CapturedProviderCall) => ScriptedProviderResponse) => {
  const requirement = `proof.txt contains FUNCTIONAL_VERIFIED for ${input.marker}`;
  return (call) => {
    const available = toolNames(call);
    const context = serialized(call);
    if (
      available.has("assign_work") &&
      !available.has("claim_completion") &&
      context.includes(input.marker)
    ) {
      if (context.includes("WorkAssigned(")) {
        return { _tag: "Text", text: `Work started for ${input.marker}` };
      }
      return {
        _tag: "ToolCall",
        name: "assign_work",
        arguments: {
          objective: `Complete ${input.marker}.`,
          why: "browser functional release scenario",
          constraints: ["do not perform external side effects"],
          completionExpectation: "independently verified and accepted",
          verificationMission: {
            goal: `Verify ${input.marker}`,
            criteria: [
              {
                criterionId: "functional-criterion",
                requirement,
                required: true,
              },
            ],
            riskRequirements: ["do not perform external side effects"],
          },
          reason: "browser functional goal placement",
        },
      };
    }
    if (available.has("record_verification_evidence")) {
      const hasReadResult = call.messages.some(
        (message) =>
          message.role === "tool" &&
          message.content?.includes("FUNCTIONAL_VERIFIED") === true &&
          !message.content.includes("action/precondition"),
      );
      const evidenceIds = [...context.matchAll(/evd_[0-9a-f-]{36}/gu)].map(
        (match) => match[0],
      );
      if (!hasReadResult) {
        return {
          _tag: "ToolCall",
          name: "read",
          arguments: {
            target: { mount: "workspace", path: "proof.txt" },
            limit: 200,
          },
        };
      }
      if (evidenceIds.length === 0) {
        return {
          _tag: "ToolCall",
          name: "record_verification_evidence",
          arguments: {
            criterionId: "functional-criterion",
            sourceCallRef: "1",
          },
        };
      }
      return {
        _tag: "ToolCall",
        name: "conclude_verification",
        arguments: {
          verdict: input.verdict,
          criteriaResults: [
            {
              criterionId: "functional-criterion",
              requirement,
              required: true,
              verdict: input.verdict,
              evidenceRefs: [evidenceIds.at(-1)],
            },
          ],
          summary: `${input.verdict} from browser functional evidence.`,
        },
      };
    }
    if (available.has("claim_completion")) {
      return {
        _tag: "ToolCall",
        name: "claim_completion",
        arguments: { claim: `${input.marker} complete` },
      };
    }
    return { _tag: "Text", text: `Observed ${input.marker}` };
  };
};
