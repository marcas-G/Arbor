import type { SandboxPolicyDecisionCommittedViewV1 } from "./sandbox-policy-result.js";
import {
  decodeCanonicalSandboxPolicyDecisionCommittedInternalV2,
  encodeSandboxPolicyDecisionCommittedInternalV2,
  type SandboxPolicyDecisionCommittedInternalV2,
  sandboxPolicyCommittedViewOfV2,
} from "./sandbox-policy-result-v2.js";

/** Exact standing-Workspace provenance; the Linux execution summary retains
 * its independent V2 network/enforcement codec. */
export interface SandboxPolicyDecisionCommittedInternalV3
  extends Omit<SandboxPolicyDecisionCommittedInternalV2, "version"> {
  readonly version: 3;
  readonly workspaceAuthorizationRevision: number;
}

export const encodeSandboxPolicyDecisionCommittedInternalV3 = (
  result: SandboxPolicyDecisionCommittedInternalV3,
): string => {
  const { workspaceAuthorizationRevision, ...fields } = result;
  const v2 = encodeSandboxPolicyDecisionCommittedInternalV2({
    ...fields,
    version: 2,
  });
  return `{"version":3,"workspaceAuthorizationRevision":${workspaceAuthorizationRevision},${v2.slice('{"version":2,'.length)}`;
};

export const decodeCanonicalSandboxPolicyDecisionCommittedInternalV3 = (
  json: string,
  digestOf: (canonicalBytes: string) => string,
): SandboxPolicyDecisionCommittedInternalV3 | undefined => {
  try {
    // Bound before parsing; the established V2 decoder then enforces exact
    // UTF-8 bytes and every inherited identity, snapshot and digest field.
    let byteLength = 0;
    for (const character of json) {
      const code = character.codePointAt(0) ?? 0;
      byteLength +=
        code <= 0x7f ? 1 : code <= 0x7ff ? 2 : code <= 0xffff ? 3 : 4;
      if (byteLength > 65_536) return undefined;
    }
    const value = JSON.parse(json) as Record<string, unknown>;
    if (
      typeof value !== "object" ||
      value === null ||
      Array.isArray(value) ||
      value.version !== 3 ||
      typeof value.workspaceAuthorizationRevision !== "number" ||
      !Number.isSafeInteger(value.workspaceAuthorizationRevision) ||
      value.workspaceAuthorizationRevision < 1
    )
      return undefined;
    const { workspaceAuthorizationRevision, ...fields } = value;
    const legacy = decodeCanonicalSandboxPolicyDecisionCommittedInternalV2(
      JSON.stringify({ ...fields, version: 2 }),
      digestOf,
    );
    if (legacy === undefined) return undefined;
    const result: SandboxPolicyDecisionCommittedInternalV3 = {
      ...legacy,
      version: 3,
      workspaceAuthorizationRevision,
    };
    return encodeSandboxPolicyDecisionCommittedInternalV3(result) === json
      ? result
      : undefined;
  } catch {
    return undefined;
  }
};

export const sandboxPolicyCommittedViewOfV3 = (
  result: SandboxPolicyDecisionCommittedInternalV3,
): SandboxPolicyDecisionCommittedViewV1 =>
  sandboxPolicyCommittedViewOfV2({ ...result, version: 2 });
