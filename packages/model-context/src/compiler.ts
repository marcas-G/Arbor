import type {
  ContextEpochNumber,
  ExecutionId,
  ProviderTurnId,
  SessionId,
} from "@arbor/domain";
import type {
  ModelCapability,
  ModelFacingControlToolDefinition,
  ModelFacingToolDefinition,
  PortableInputItem,
  PortableLegacyMessage,
  PortableModelRequest,
  PortableModelRequestV2,
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
  readonly controlTools?: ReadonlyArray<ModelFacingControlToolDefinition>;
  readonly turnProfile?: {
    readonly purpose: string;
    readonly version: string;
    readonly fingerprint: string;
    readonly contextPolicyRef: string;
  };
  readonly skills: ReadonlyArray<SkillRef>;
  readonly outputContract: string;
  /** P14 conversation context (user/assistant turns); absent on Work. */
  readonly conversationMessages?: ReadonlyArray<{
    readonly role: "user" | "assistant";
    readonly text: string;
  }>;
  /** Generic provider messages assembled by Agent Runtime (including tool
   * observations). Takes precedence over the P14 compatibility field. */
  readonly messages?: ReadonlyArray<PortableLegacyMessage>;
  readonly inputItems?: ReadonlyArray<PortableInputItem>;
  /** P14 conversation refs (human-input:<messageId>) — carried into the
   * manifest contextRefs so the claimed turn is auditable per turn. */
  readonly conversationContextRefs?: ReadonlyArray<string>;
  readonly messageContextRefs?: ReadonlyArray<string>;
  readonly providerRef?: string;
  /** Optional content table: contentRef -> instruction body text. When
   * present, compiled instructions carry the resolved text instead of the
   * bare reference (P3 `05` compile semantics). */
  readonly instructionContents?: ReadonlyMap<string, string>;
  /** Optional explicit output-contract schema json (overrides the frozen
   * table for exotic deployments). */
  readonly outputContractSchemaJson?: string;
  readonly continuation: string;
  readonly controlBasis: ControlBasis;
}

export interface ModelContextManifest {
  readonly providerRef?: string;
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
  /**
   * Gate C C3: reasoning round-trip attachments preserved for this turn —
   * references only (model/protocol/fingerprint binding + conversation
   * message id). The opaque payloads stay in the conversation history; the
   * Model Context records what it preserved/injected/discarded (INV-C2-1:
   * turn-level opaque reference granularity, never parsed here).
   */
  readonly reasoningAttachmentRefs?: ReadonlyArray<{
    readonly messageId: string;
    readonly modelRef: string;
    readonly protocolFamily: string;
    readonly bindingFingerprint: string;
    readonly decision: "Preserve" | "Inject" | "DiscardForCompaction";
  }>;
  readonly skillRefs: ReadonlyArray<{
    readonly skillId: string;
    readonly revision: number;
  }>;
  readonly toolRefs: ReadonlyArray<string>;
  readonly toolRoutes: ReadonlyArray<{
    readonly name: string;
    readonly route: "Executable" | "Control";
    readonly version?: string;
    readonly hash?: string;
  }>;
  readonly outputContractRef: string;
  readonly budgetDecision: { readonly maxOutputTokens: number };
  readonly compiledRequestHash: string;
  readonly controlBasis: ControlBasis;
  readonly logicalStepNo?: number;
  readonly repairAttempt?: number;
  readonly operationKind?: PortableModelRequestV2["operationKind"];
  readonly inputFrontier?: {
    readonly firstSequence: number | null;
    readonly lastSequence: number | null;
  };
  readonly typedInputItemRefs?: ReadonlyArray<string>;
  readonly callRefs?: ReadonlyArray<string>;
  readonly agentStepContextFingerprint?: string;
  readonly resolvedModelBindingFingerprint?: string;
  readonly turnProfile?: {
    readonly purpose: string;
    readonly version: string;
    readonly fingerprint: string;
    readonly contextPolicyRef: string;
  };
  readonly budgetEvidence?: {
    readonly kind: "CharsPerFourFallback";
    readonly estimatedTokens: number;
    readonly observedTokens: number | null;
    readonly threshold: number;
  };
}

export interface PreparedModelTurn {
  readonly request: PortableModelRequest;
  readonly manifest: ModelContextManifest;
  readonly toolRoutes: ReadonlyArray<{
    readonly name: string;
    readonly route: "Executable" | "Control";
    readonly version?: string;
    readonly hash?: string;
  }>;
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
  contents?: ReadonlyMap<string, string>,
): ReadonlyArray<PortableModelRequest["instructions"][number]> =>
  instructions.map((fragment) => ({
    slotId: fragment.scope,
    authorityRole: fragment.authorityRole,
    text:
      contents?.get(fragment.contentRef) !== undefined
        ? (contents.get(fragment.contentRef) as string)
        : fragment.contentRef,
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
  readonly stepContext?: {
    readonly logicalStepNo: number;
    readonly repairAttempt: number;
    readonly inputFrontier: {
      readonly firstSequence: number | null;
      readonly lastSequence: number | null;
    };
    readonly fingerprint: string;
    readonly bindingFingerprint: string;
  };
  readonly estimatedInputTokens?: number;
}): PreparedModelTurn => {
  const controlTools = [...(input.plan.controlTools ?? [])];
  const names = [
    ...input.plan.tools.map((tool) => tool.name),
    ...controlTools.map((tool) => tool.name),
  ];
  if (new Set(names).size !== names.length) {
    throw new Error("tool identity collision across executable/control routes");
  }
  const toolRoutes = [
    ...input.plan.tools.map((tool) => ({
      name: tool.name,
      route: "Executable" as const,
      version: tool.version,
      hash: tool.hash,
    })),
    ...controlTools.map((tool) => ({
      name: tool.name,
      route: "Control" as const,
      version: tool.version,
      hash: tool.hash,
    })),
  ];
  const request: PortableModelRequestV2 = {
    requestVersion: 2,
    operationKind: "Inference",
    modelRef: input.capability.modelRef,
    instructions: compile(
      input.plan.instructions.effective,
      input.plan.instructionContents,
    ),
    inputItems:
      input.plan.inputItems ??
      (input.plan.messages ?? input.plan.conversationMessages ?? []).map(
        (message) => ({
          _tag: "Message" as const,
          role: message.role,
          text: message.text,
        }),
      ),
    toolDefinitions: [
      ...input.plan.tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        schemaJson: tool.schemaJson,
      })),
      ...controlTools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        schemaJson: tool.schemaJson,
      })),
    ],
    outputContractRef: input.plan.outputContract,
    budget: { maxOutputTokens: input.maxOutputTokens },
    cacheHints: input.plan.context.map((fragment) => ({
      cacheClass: fragment.cacheClass,
    })),
  };

  const manifest: ModelContextManifest = {
    ...(input.plan.providerRef !== undefined
      ? { providerRef: input.plan.providerRef }
      : {}),
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
    contextRefs: [
      ...input.plan.context.map((fragment) => fragment.ref),
      ...(input.plan.conversationContextRefs ?? []),
      ...(input.plan.messageContextRefs ?? []),
    ],
    skillRefs: input.plan.skills.map((skill) => ({
      skillId: skill.skillId,
      revision: skill.revision,
    })),
    toolRefs: [
      ...input.plan.tools.map(
        (tool) => `Executable:${tool.name}@${tool.version}#${tool.hash}`,
      ),
      ...controlTools.map(
        (tool) => `Control:${tool.name}@${tool.version}#${tool.hash}`,
      ),
    ],
    toolRoutes,
    outputContractRef: input.plan.outputContract,
    budgetDecision: { maxOutputTokens: input.maxOutputTokens },
    compiledRequestHash: fnv(JSON.stringify({ request, toolRoutes })),
    controlBasis: input.plan.controlBasis,
    logicalStepNo: input.stepContext?.logicalStepNo ?? 0,
    repairAttempt: input.stepContext?.repairAttempt ?? 0,
    operationKind: request.operationKind,
    inputFrontier: input.stepContext?.inputFrontier ?? {
      firstSequence: null,
      lastSequence: null,
    },
    typedInputItemRefs: [...(input.plan.messageContextRefs ?? [])],
    callRefs: request.inputItems.flatMap((item) =>
      item._tag === "ToolCall" ||
      item._tag === "ToolResult" ||
      item._tag === "ControlResult"
        ? [item.callRef]
        : [],
    ),
    agentStepContextFingerprint:
      input.stepContext?.fingerprint ?? "legacy-step-context",
    resolvedModelBindingFingerprint:
      input.stepContext?.bindingFingerprint ?? "legacy-binding",
    ...(input.plan.turnProfile === undefined
      ? {}
      : { turnProfile: input.plan.turnProfile }),
    budgetEvidence: {
      kind: "CharsPerFourFallback",
      estimatedTokens: input.estimatedInputTokens ?? 0,
      observedTokens: null,
      threshold: input.capability.contextWindow,
    },
  };

  return { request, manifest, toolRoutes };
};
