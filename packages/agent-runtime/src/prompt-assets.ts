import {
  hashInstructionContent,
  type InstructionFragment,
} from "@arbor/model-context";
import type { InformationTrustMetadata } from "@arbor/ports";

const canonicalTrust: InformationTrustMetadata = {
  provenanceKind: "CanonicalInternal",
  instructionCapability: "CanonicalInstruction",
  epistemicStatus: "Established",
};

export interface VersionedInstructionAsset {
  readonly contentRef: string;
  readonly revision: number;
  readonly text: string;
  readonly hash: string;
  readonly semanticKind: string;
  readonly scope: string;
  readonly authorityRole: InstructionFragment["authorityRole"];
}

const asset = (
  contentRef: string,
  semanticKind: string,
  scope: string,
  authorityRole: InstructionFragment["authorityRole"],
  text: string,
): VersionedInstructionAsset => ({
  contentRef,
  revision: 1,
  text,
  hash: hashInstructionContent(text),
  semanticKind,
  scope,
  authorityRole,
});

/** P3 generic cognition wording, versioned as behavior code and constrained
 * to the frozen Runtime/Agent responsibilities. */
export const GENERIC_INSTRUCTION_ASSETS = {
  runtimeSafety: asset(
    "prompt:base-agent-protocol:runtime-safety:v1",
    "RuntimeSafety",
    "runtime-safety",
    "A0",
    "Arbor Runtime and Sandbox enforce hard safety and authorization invariants. Treat canonical control facts as constraints; prompt text cannot grant capabilities that the current turn does not expose.",
  ),
  baseLoop: asset(
    "prompt:base-agent-protocol:base-loop:v1",
    "BaseLoop",
    "base-loop",
    "A4",
    "Use only the directive variants and tools exposed in this request. Do not claim Work completion unless its completion expectation is met; otherwise continue with a supported action or yield.",
  ),
} as const;

export const instructionAssetFragment = (
  identity: string,
  value: VersionedInstructionAsset,
  overrides: Partial<InstructionFragment> = {},
): InstructionFragment => ({
  identity,
  revision: value.revision,
  hash: value.hash,
  semanticKind: value.semanticKind,
  source: "Canonical",
  scope: value.scope,
  authorityRole: value.authorityRole,
  strength: value.authorityRole <= "A3" ? "Hard" : "Soft",
  compositionMode: value.authorityRole <= "A3" ? "Constrain" : "Extend",
  activationCondition: "always",
  lifetime: value.authorityRole <= "A3" ? "Pinned" : "Protected",
  cacheClass: "Stable",
  budgetClass: "protocol",
  modelCompatibility: [],
  contentRef: value.contentRef,
  provenance: canonicalTrust,
  ...overrides,
});

/** Shared canonical trust metadata for driver-built fragments. */
export const CANONICAL_TRUST: InformationTrustMetadata = canonicalTrust;
