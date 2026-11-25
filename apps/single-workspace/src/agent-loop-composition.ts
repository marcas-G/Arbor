import type {
  AgentLoopDriverOptions,
  AgentLoopQualificationProbe,
  ModelDecisionServiceOptions,
} from "@arbor/agent-runtime";

interface ModelDecisionCompositionOptions {
  readonly secretRef: ModelDecisionServiceOptions["secretRef"];
  readonly executionPolicyOverrides: ModelDecisionServiceOptions["executionPolicyOverrides"];
  readonly providerRef: ModelDecisionServiceOptions["providerRef"];
  readonly protocolFamily: ModelDecisionServiceOptions["protocolFamily"];
  readonly onProviderProgress: ModelDecisionServiceOptions["onProviderProgress"];
  readonly qualificationProbe: AgentLoopQualificationProbe | undefined;
}

export const makeModelDecisionServiceOptions = (
  input: ModelDecisionCompositionOptions,
): ModelDecisionServiceOptions => ({
  ...(input.secretRef === undefined ? {} : { secretRef: input.secretRef }),
  ...(input.executionPolicyOverrides === undefined
    ? {}
    : { executionPolicyOverrides: input.executionPolicyOverrides }),
  ...(input.providerRef === undefined
    ? {}
    : { providerRef: input.providerRef }),
  ...(input.protocolFamily === undefined
    ? {}
    : { protocolFamily: input.protocolFamily }),
  ...(input.onProviderProgress === undefined
    ? {}
    : { onProviderProgress: input.onProviderProgress }),
  ...(input.qualificationProbe === undefined
    ? {}
    : { qualificationProbe: input.qualificationProbe }),
});

export const makeAgentLoopDriverOptions = (
  input: Omit<AgentLoopDriverOptions, "qualificationProbe">,
  qualificationProbe?: AgentLoopQualificationProbe,
): AgentLoopDriverOptions => ({
  ...input,
  ...(qualificationProbe === undefined ? {} : { qualificationProbe }),
});
