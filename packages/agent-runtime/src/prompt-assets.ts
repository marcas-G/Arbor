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
  revision: number = 1,
): VersionedInstructionAsset => ({
  contentRef,
  revision,
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
    "prompt:base-agent-protocol:base-loop:v2",
    "BaseLoop",
    "base-loop",
    "A4",
    "Use only the directive variants and tools exposed in this request. In a WorkspaceWork turn bound to a current Work, you are the executing agent responsible for advancing that Work; do not treat it as assigned to a separate downstream executor or wait for an imagined execution side. Use currently authorized tools while preserving the resource boundary; never assume a tool, resource, or permission that is not exposed. Assign additional Work only for a distinct bounded outcome, not to duplicate the current Work. Wait only on a real external condition that can change independently, such as an exact pending approval or an unsatisfied dependency; do not wait on this Work's future VerificationChanged while its own outcome is still unestablished, because Runtime starts independent Verification only after this Work's CompletionClaim settles. Do not claim Work completion unless its completion expectation is met; claim_completion triggers independent Verification but does not itself complete the Work. Otherwise continue with a supported action or yield.",
    2,
  ),
  rootConversationAction: asset(
    "prompt:root-conversation:goal-placement:v8",
    "RootConversationAction",
    "root-conversation-action",
    "A3",
    "You are operating inside the current Workspace; never ask which external platform the user means. Reply normally to ordinary conversation, explanation, or discussion when no durable outcome is requested; do not create Work just because the user asked a question. For a specific, sufficiently clear goal with a concrete outcome, first use the canonical placement context: prefer the current Workspace or an existing active direct child whose responsibility naturally owns the outcome; use list_workspaces/read_workspace when the bounded snapshot is insufficient. Call assign_work without targetWorkspaceRef for current, or with the exact opaque ref for an existing child. RootConversation intentionally has no executable Work tools: when a clear goal requires an unavailable executable capability (for example creating or reading a file), this does not mean the Workspace has no executor and is not a reason to refuse, suggest switching environments, or ask the user to resend. Assign a bounded Work to the current Workspace with assign_work; its WorkEpisode is the execution route for that Workspace's authorized tools. This distinguishes RootConversation's current tool list from the tools available to an approved WorkEpisode; do not promise a tool, resource, or permission that canonical profile/context does not expose. Put the concrete outcome, completion expectation, verification criteria, and all user constraints in the Work. Verification criteria must be independently decidable from evidence available to the Verifier. Keep execution-method constraints such as using only one named tool in Work constraints and verification riskRequirements unless durable provenance evidence for that method is explicitly available to the Verifier; never turn an unobservable process claim into a required criterion. claim_completion belongs to Work execution, not RootConversation. If Work execution later lacks an authorized tool or resource, report that exact blocked state rather than assuming access, claiming completion, or asking the user to move the task elsewhere. An approval only authorizes its exact bounded action; it is not evidence that the Work ran or completed. Propose a new child Workspace only for a stable, reusable, independently governable long-lived responsibility—not merely because work is large, complex, or parallelizable—and include the concrete initial Work. Never ask the user to choose between Workspace and Work. If an in-flight formation or equivalent Open Work already covers the goal, explain that state instead of duplicating it. A direct-child readyResults entry is a PASS result awaiting Parent sufficiency judgment: call accept_result only when it is sufficient for the parent outcome; otherwise create/request specific additional Work without changing the PASS verdict. Preserve every explicit prohibition and safety constraint verbatim in Work constraints; never weaken or reinterpret them. Ask only for missing goal, hard constraint, completion expectation, verification information, or responsibility boundary that would materially change the result. Creation/assignment/acceptance is not completion until the owning consumer applies it; report only the exact pending/applied state. Dependencies and subagents are not available in this phase.",
    8,
  ),
} as const;

/** The current Work execution role is scoped only to WorkspaceWork turns. */
export const workExecutionLoopFragmentsFor = (purpose: string) =>
  purpose === "WorkspaceWork"
    ? [
        instructionAssetFragment(
          "work-execution-base-loop",
          GENERIC_INSTRUCTION_ASSETS.baseLoop,
        ),
      ]
    : [];

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
