import type {
  ContextEpochNumber,
  ExecutionId,
  ProviderTurnId,
  SessionId,
} from "@arbor/domain";
import type {
  ModelCapability,
  ModelFacingToolDefinition,
  PortableModelRequest,
  SkillRef,
} from "@arbor/ports";
import type { ContextFragment } from "./context.js";
import type { InstructionFragment } from "./prompt.js";
import type { ResolvedInstructionSet } from "./resolver.js";

/** DID v1.7 §8.19/§7.5; P3 `02` §6, `05` §5. */

export interface ControlBasis {
  readonly projectPolicyRevision: number;
  readonly workspacePolicyRevision: number;
  readonly responsibilityRevision: number;
  readonly resourceBoundaryRevision: number;
  readonly workId?: string;
  readonly workRevision?: number;
  readonly authorizationDigest: string;
  readonly environmentRevision: string;
}

export interface ModelContextPlan {
  readonly instructions: ResolvedInstructionSet;
  readonly context: ReadonlyArray<ContextFragment>;
  readonly tools: ReadonlyArray<ModelFacingToolDefinition>;
  readonly skills: ReadonlyArray<SkillRef>;
  readonly outputContract: string;
  readonly continuation: string;
  readonly controlBasis: ControlBasis;
}

export interface ModelContextManifest {
  readonly providerTurnId: ProviderTurnId;
  readonly executionId: ExecutionId;
  readonly sessionId: SessionId;
  readonly contextEpoch: ContextEpochNumber;
  readonly modelRef: string;
  readonly instructionFragments: ReadonlyArray<{
    readonly identity: string;
    readonly revision: number;
    readonly hash: string;
    readonly source: string;
    readonly scope: string;
  }>;
  readonly contextRefs: ReadonlyArray<string>;
  readonly skillRefs: ReadonlyArray<{
    readonly skillId: string;
    readonly revision: number;
  }>;
  readonly toolRefs: ReadonlyArray<string>;
  readonly outputContractRef: string;
  readonly budgetDecision: { readonly maxOutputTokens: number };
  readonly compiledRequestHash: string;
  readonly controlBasis: ControlBasis;
}

export interface PreparedModelTurn {
  readonly request: PortableModelRequest;
  readonly manifest: ModelContextManifest;
}

const fnv = (input: string): string => {
  let value = 0x811c9dc5;
  for (let index = 0; index < input.length; index += 1) {
    value ^= input.charCodeAt(index);
    value = Math.imul(value, 0x01000193) >>> 0;
  }
  return value.toString(16).padStart(8, "0");
};

const compile = (
  instructions: ReadonlyArray<InstructionFragment>,
): ReadonlyArray<PortableModelRequest["instructions"][number]> =>
  instructions.map((fragment) => ({
    slotId: fragment.scope,
    authorityRole: fragment.authorityRole,
    text: fragment.contentRef,
  }));

/**
 * Compile a plan into a portable request + manifest. The compiler may reorder/
 * format for a model family but cannot suppress an `A0`–`A3` instruction
 * (P3 `05` §5).
 */
export const compileTurn = (input: {
  readonly plan: ModelContextPlan;
  readonly capability: ModelCapability;
  readonly providerTurnId: ProviderTurnId;
  readonly executionId: ExecutionId;
  readonly sessionId: SessionId;
  readonly contextEpoch: ContextEpochNumber;
  readonly maxOutputTokens: number;
}): PreparedModelTurn => {
  const request: PortableModelRequest = {
    modelRef: input.capability.modelRef,
    instructions: compile(input.plan.instructions.effective),
    messages: [],
    toolDefinitions: input.plan.tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      schemaJson: tool.schemaJson,
    })),
    outputContractRef: input.plan.outputContract,
    budget: { maxOutputTokens: input.maxOutputTokens },
    cacheHints: input.plan.context.map((fragment) => ({
      cacheClass: fragment.cacheClass,
    })),
  };

  const manifest: ModelContextManifest = {
    providerTurnId: input.providerTurnId,
    executionId: input.executionId,
    sessionId: input.sessionId,
    contextEpoch: input.contextEpoch,
    modelRef: input.capability.modelRef,
    instructionFragments: input.plan.instructions.effective.map((fragment) => ({
      identity: fragment.identity,
      revision: fragment.revision,
      hash: fragment.hash,
      source: fragment.source,
      scope: fragment.scope,
    })),
    contextRefs: input.plan.context.map((fragment) => fragment.ref),
    skillRefs: input.plan.skills.map((skill) => ({
      skillId: skill.skillId,
      revision: skill.revision,
    })),
    toolRefs: input.plan.tools.map((tool) => `${tool.name}@${tool.version}`),
    outputContractRef: input.plan.outputContract,
    budgetDecision: { maxOutputTokens: input.maxOutputTokens },
    compiledRequestHash: fnv(JSON.stringify(request)),
    controlBasis: input.plan.controlBasis,
  };

  return { request, manifest };
};
