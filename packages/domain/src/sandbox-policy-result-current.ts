import {
  decodeCanonicalSandboxPolicyDecisionCommittedInternalV1,
  encodeSandboxPolicyDecisionCommittedInternalV1,
  type SandboxPolicyDecisionCommittedInternalV1,
  sandboxPolicyCommittedViewOf,
} from "./sandbox-policy-result.js";
import {
  decodeCanonicalSandboxPolicyDecisionCommittedInternalV2,
  encodeSandboxPolicyDecisionCommittedInternalV2,
  type SandboxPolicyDecisionCommittedInternalV2,
  sandboxPolicyCommittedViewOfV2,
} from "./sandbox-policy-result-v2.js";
import {
  decodeCanonicalSandboxPolicyDecisionCommittedInternalV3,
  encodeSandboxPolicyDecisionCommittedInternalV3,
  type SandboxPolicyDecisionCommittedInternalV3,
  sandboxPolicyCommittedViewOfV3,
} from "./sandbox-policy-result-v3.js";

export type SandboxPolicyDecisionCommittedInternal =
  | SandboxPolicyDecisionCommittedInternalV1
  | SandboxPolicyDecisionCommittedInternalV2
  | SandboxPolicyDecisionCommittedInternalV3;

/** Each frozen codec retains its exact historical bytes and meaning. */
export const decodeCanonicalSandboxPolicyDecisionCommittedInternal = (
  json: string,
  digestOf: (canonicalBytes: string) => string,
): SandboxPolicyDecisionCommittedInternal | undefined =>
  decodeCanonicalSandboxPolicyDecisionCommittedInternalV1(json, digestOf) ??
  decodeCanonicalSandboxPolicyDecisionCommittedInternalV2(json, digestOf) ??
  decodeCanonicalSandboxPolicyDecisionCommittedInternalV3(json, digestOf);

export const encodeSandboxPolicyDecisionCommittedInternal = (
  result: SandboxPolicyDecisionCommittedInternal,
): string =>
  result.version === 3
    ? encodeSandboxPolicyDecisionCommittedInternalV3(result)
    : result.version === 2
      ? encodeSandboxPolicyDecisionCommittedInternalV2(result)
      : encodeSandboxPolicyDecisionCommittedInternalV1(result);

export const sandboxPolicyCommittedViewOfCurrent = (
  result: SandboxPolicyDecisionCommittedInternal,
) =>
  result.version === 3
    ? sandboxPolicyCommittedViewOfV3(result)
    : result.version === 2
      ? sandboxPolicyCommittedViewOfV2(result)
      : sandboxPolicyCommittedViewOf(result);
