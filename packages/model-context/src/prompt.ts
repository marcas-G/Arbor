/** DID v1.7 §8.4–§8.6; P3 `05` §1–§4. Prompt Programs are versioned
 * phase-scoped contract artifacts (C5); only wording iteration that does not
 * change the contract is empirical. */

export type PromptProgramFamily =
  | "BaseAgentProtocol"
  | "ResponsibilityBoundProtocol"
  | "ExecutionBoundProtocol"
  | "WorkExecutionProgram"
  | "ResponsibilityFormationProgram"
  | "CommunicationProgram"
  | "CognitiveModeProgram"
  | "SkillProgram"
  | "VerificationProgram"
  | "BootstrapHandoffProgram"
  | "ContinuationProgram"
  | "CompactionProgram"
  | "HumanInteractionProgram"
  | "QueryProgram";

export type AuthorityRole = "A0" | "A1" | "A2" | "A3" | "A4" | "A5" | "A6";

export type CompositionMode =
  | "Extend"
  | "Specialize"
  | "Constrain"
  | "ReplaceScope"
  | "Advisory";

export type RetentionClass =
  | "Pinned"
  | "Protected"
  | "Compressible"
  | "Evictable";

export type CacheClass = "Stable" | "SemiStable" | "TurnDynamic";

export type InstructionSource = "Canonical" | "DynamicSurface";

export interface PromptSlot {
  readonly slotId: string;
  readonly semanticKind: string;
  readonly authorityRole: AuthorityRole;
  readonly strength: "Hard" | "Soft";
  readonly compositionMode: CompositionMode;
  readonly replaceable: boolean;
  readonly required: boolean;
  readonly source: InstructionSource;
  readonly retention: RetentionClass;
  readonly cacheClass: CacheClass;
}

export interface PromptProgram {
  readonly programId: string;
  readonly revision: number;
  readonly hash: string;
  readonly family: PromptProgramFamily;
  readonly slots: ReadonlyArray<PromptSlot>;
  readonly outputContractRefs: ReadonlyArray<string>;
  readonly evalSetRef: string;
}

export interface InstructionFragment {
  readonly identity: string;
  readonly revision: number;
  readonly hash: string;
  readonly semanticKind: string;
  readonly source: InstructionSource;
  readonly scope: string;
  readonly authorityRole: AuthorityRole;
  readonly strength: "Hard" | "Soft";
  readonly compositionMode: CompositionMode;
  readonly activationCondition: string;
  readonly lifetime: RetentionClass;
  readonly cacheClass: CacheClass;
  readonly budgetClass: string;
  readonly modelCompatibility: ReadonlyArray<string>;
  readonly contentRef: string;
}

const fnv = (input: string): string => {
  let value = 0x811c9dc5;
  for (let index = 0; index < input.length; index += 1) {
    value ^= input.charCodeAt(index);
    value = Math.imul(value, 0x01000193) >>> 0;
  }
  return value.toString(16).padStart(8, "0");
};

/** Deterministic hash over the slot contract (not the wording). */
export const hashProgram = (program: Omit<PromptProgram, "hash">): string =>
  fnv(
    JSON.stringify({
      programId: program.programId,
      revision: program.revision,
      family: program.family,
      slots: program.slots,
      outputContractRefs: program.outputContractRefs,
      evalSetRef: program.evalSetRef,
    }),
  );

const slot = (
  slotId: string,
  semanticKind: string,
  authorityRole: AuthorityRole,
  options: Partial<PromptSlot> = {},
): PromptSlot => ({
  slotId,
  semanticKind,
  authorityRole,
  strength: authorityRole <= "A3" ? "Hard" : "Soft",
  compositionMode: authorityRole <= "A3" ? "Constrain" : "Advisory",
  replaceable: authorityRole >= "A4",
  required: authorityRole <= "A1",
  source: "Canonical",
  retention: authorityRole <= "A1" ? "Pinned" : "Protected",
  cacheClass: authorityRole <= "A1" ? "Stable" : "SemiStable",
  ...options,
});

const program = (input: Omit<PromptProgram, "hash">): PromptProgram => ({
  ...input,
  hash: hashProgram(input),
});

export const BASE_AGENT_PROTOCOL: PromptProgram = program({
  programId: "base-agent-protocol",
  revision: 1,
  family: "BaseAgentProtocol",
  slots: [
    slot("runtime-safety", "RuntimeSafety", "A0"),
    slot("output-contract", "OutputContract", "A0"),
    slot("base-loop", "BaseLoop", "A4", { compositionMode: "Extend" }),
  ],
  outputContractRefs: ["agent-directive-v1"],
  evalSetRef: "eval/base-agent-protocol",
});

export const RESPONSIBILITY_BOUND_PROTOCOL: PromptProgram = program({
  programId: "responsibility-bound-protocol",
  revision: 1,
  family: "ResponsibilityBoundProtocol",
  slots: [
    slot("responsibility-definition", "ResponsibilityDefinition", "A2"),
    slot("resource-boundary", "ResourceBoundary", "A2"),
    slot("permission-ceiling", "PermissionCeiling", "A2"),
    slot("responsibility-guidance", "ResponsibilityGuidance", "A5", {
      compositionMode: "Specialize",
    }),
  ],
  outputContractRefs: ["agent-directive-v1"],
  evalSetRef: "eval/responsibility-bound-protocol",
});

export const WORK_EXECUTION_PROGRAM: PromptProgram = program({
  programId: "work-execution-program",
  revision: 1,
  family: "WorkExecutionProgram",
  slots: [
    slot("work-objective", "WorkObjective", "A3"),
    slot("work-constraints", "WorkConstraints", "A3"),
    slot("completion-expectation", "CompletionExpectation", "A3"),
    slot("verification-mission-summary", "VerificationMissionSummary", "A3"),
    slot("outcome-gap", "OutcomeGap", "A4", { compositionMode: "Extend" }),
  ],
  outputContractRefs: ["agent-directive-v1", "completion-claim-v1"],
  evalSetRef: "eval/work-execution-program",
});

export const COMPACTION_PROGRAM: PromptProgram = program({
  programId: "compaction-program",
  revision: 1,
  family: "CompactionProgram",
  slots: [
    slot("compaction-mandate", "CompactionMandate", "A0"),
    slot("checkpoint-schema", "CheckpointSchema", "A0"),
    slot("compaction-strategy", "CompactionStrategy", "A4", {
      compositionMode: "Extend",
    }),
  ],
  outputContractRefs: ["compaction-result-v1"],
  evalSetRef: "eval/compaction-program",
});

export const P3_PROGRAMS: ReadonlyArray<PromptProgram> = [
  BASE_AGENT_PROTOCOL,
  RESPONSIBILITY_BOUND_PROTOCOL,
  WORK_EXECUTION_PROGRAM,
  COMPACTION_PROGRAM,
];

export const OVERRIDABLE_AUTHORITY_FLOOR: AuthorityRole = "A3";
