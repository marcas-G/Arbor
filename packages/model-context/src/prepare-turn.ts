import type {
  AgentBinding,
  ContextEpochNumber,
  ExecutionId,
  ProviderTurnId,
  SessionId,
  WorkspaceId,
} from "@arbor/domain";
import {
  type ModelCapabilityError,
  ModelCapabilityPort,
  type ModelContextError,
  type PortableInputItem,
  type PortableLegacyMessage,
  type SkillRef,
  SkillRegistry,
  type SkillRegistryError,
} from "@arbor/ports";
import { Context, Effect, Layer, type Option } from "effect";
import {
  type ControlBasis,
  compileTurn,
  type PreparedModelTurn,
} from "./compiler.js";
import {
  type ContextBudget,
  type ContextFragment,
  type ContextUnsatisfiable,
  contextBudget,
  planContext,
} from "./context.js";
import type { InstructionFragment, PromptProgram } from "./prompt.js";
import { estimateFixedRequestTokens } from "./request-budget.js";
import { type GovernanceIssue, resolveInstructions } from "./resolver.js";
import type { ResolvedTurnProfile } from "./turn-profile.js";

/** DID v1.7 §6A.10/§8.2; P3 `02` §1. */
export type TurnPreparation =
  | { readonly _tag: "Ready"; readonly turn: PreparedModelTurn }
  | {
      readonly _tag: "NeedsCompaction";
      readonly reason: "ContextUnsatisfiable" | "BudgetPressure";
    }
  | { readonly _tag: "GovernanceBlocked"; readonly issue: GovernanceIssue };

export interface PrepareTurnInput {
  readonly executionId: ExecutionId;
  readonly sessionId: SessionId;
  readonly contextEpoch: ContextEpochNumber;
  readonly providerTurnId: ProviderTurnId;
  readonly binding: AgentBinding;
  readonly workspaceId: WorkspaceId;
  readonly cognitiveMode: string;
  readonly program: PromptProgram;
  readonly fragments: ReadonlyArray<InstructionFragment>;
  readonly contextFragments: ReadonlyArray<ContextFragment>;
  readonly budget: ContextBudget;
  readonly controlBasis: ControlBasis;
  readonly maxOutputTokens: number;
  readonly bodySkillIds: ReadonlyArray<string>;
  readonly turnProfile: ResolvedTurnProfile;
  /** P14 conversation context: the current claimed human message (user) plus
   * recent answered turns (user/assistant). Absent on Work executions. */
  readonly conversationMessages?: ReadonlyArray<{
    readonly role: "user" | "assistant";
    readonly text: string;
  }>;
  /** Provider-neutral messages assembled by the runtime. Supports tool
   * observations without treating their text as instructions. */
  readonly messages?: ReadonlyArray<PortableLegacyMessage>;
  readonly inputItems?: ReadonlyArray<PortableInputItem>;
  /** Manifest refs for the conversation context (human-input:<messageId>). */
  readonly conversationContextRefs?: ReadonlyArray<string>;
  readonly messageContextRefs?: ReadonlyArray<string>;
  /** Adapter identity recorded on the manifest (composition-provided). */
  readonly providerRef?: string;
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
  /** Content table (contentRef -> instruction body). When present,
   * compiled instructions carry the resolved text instead of the bare
   * reference (P3 `05` compile semantics). */
  readonly instructionContents?: ReadonlyMap<string, string>;
}

export interface ModelContextService {
  readonly prepareTurn: (
    input: PrepareTurnInput,
  ) => Effect.Effect<TurnPreparation, ContextUnsatisfiable | ModelContextError>;
}

export class ModelContext extends Context.Service<
  ModelContext,
  ModelContextService
>()("arbor/ModelContext") {}

const toModelContextError = (cause: unknown): ModelContextError => ({
  _tag: "ModelContextError",
  cause,
});

export const ModelContextLive: Layer.Layer<
  ModelContext,
  never,
  ModelCapabilityPort | SkillRegistry
> = Layer.effect(
  ModelContext,
  Effect.gen(function* () {
    const capabilityPort = yield* ModelCapabilityPort;
    const skills = yield* SkillRegistry;

    const prepareTurn = (input: PrepareTurnInput) =>
      Effect.gen(function* () {
        const resolved = resolveInstructions({
          fragments: input.fragments,
          slots: input.program.slots,
        });
        if (resolved.governanceIssues.length > 0) {
          return {
            _tag: "GovernanceBlocked",
            issue: resolved.governanceIssues[0] as GovernanceIssue,
          } as TurnPreparation;
        }

        const capability = yield* capabilityPort.resolve({
          binding: input.binding,
          cognitiveMode: input.cognitiveMode,
          requiredCapabilities: [],
        });
        const tools = input.turnProfile.executableTools;
        const controlTools = input.turnProfile.controlTools;
        const skillRefs: SkillRef[] = [];
        for (const skillId of input.bodySkillIds) {
          const loaded = yield* skills.load(skillId, "Body");
          skillRefs.push(loaded.skillRef);
        }
        const messages = input.messages ?? input.conversationMessages ?? [];
        const inputItems = input.inputItems ?? [];
        const availableTokens = contextBudget(input.budget);
        const fixedTokens = estimateFixedRequestTokens({
          instructions: resolved.effective,
          ...(input.instructionContents === undefined
            ? {}
            : { instructionContents: input.instructionContents }),
          messages,
          inputItems,
          tools,
          controlTools,
        });
        const planned = planContext(input.contextFragments, {
          modelWindow: availableTokens - fixedTokens,
          outputReserve: 0,
          protocolReserve: 0,
          toolReserve: 0,
        });
        if (planned.unsatisfiable) {
          const hard = input.contextFragments.filter(
            (fragment) =>
              fragment.retention === "Pinned" ||
              fragment.retention === "Protected",
          );
          return yield* Effect.fail<ContextUnsatisfiable>({
            _tag: "ContextUnsatisfiable",
            requiredTokens:
              fixedTokens +
              hard.reduce((sum, fragment) => sum + fragment.tokens, 0),
            availableTokens,
          });
        }
        if (planned.evicted.length > 0) {
          return {
            _tag: "NeedsCompaction",
            reason: "BudgetPressure",
          } as TurnPreparation;
        }

        const compiled = compileTurn({
          plan: {
            instructions: resolved,
            context: planned.selected,
            tools,
            controlTools,
            skills: skillRefs,
            outputContract: input.turnProfile.outputContractRef,
            turnProfile: {
              purpose: input.turnProfile.purpose,
              version: input.turnProfile.profileVersion,
              fingerprint: input.turnProfile.fingerprint,
              contextPolicyRef: input.turnProfile.contextPolicyRef,
            },
            continuation: "recent-frontier",
            controlBasis: input.controlBasis,
            ...(input.conversationMessages !== undefined &&
            input.conversationMessages.length > 0
              ? { conversationMessages: input.conversationMessages }
              : {}),
            ...(input.messages !== undefined && input.messages.length > 0
              ? { messages: input.messages }
              : {}),
            ...(input.inputItems !== undefined && input.inputItems.length > 0
              ? { inputItems: input.inputItems }
              : {}),
            ...(input.conversationContextRefs !== undefined &&
            input.conversationContextRefs.length > 0
              ? { conversationContextRefs: input.conversationContextRefs }
              : {}),
            ...(input.messageContextRefs !== undefined &&
            input.messageContextRefs.length > 0
              ? { messageContextRefs: input.messageContextRefs }
              : {}),
            ...(input.providerRef !== undefined
              ? { providerRef: input.providerRef }
              : {}),
            ...(input.instructionContents !== undefined &&
            input.instructionContents.size > 0
              ? { instructionContents: input.instructionContents }
              : {}),
          },
          capability,
          providerTurnId: input.providerTurnId,
          executionId: input.executionId,
          sessionId: input.sessionId,
          contextEpoch: input.contextEpoch,
          maxOutputTokens: input.maxOutputTokens,
          ...(input.stepContext === undefined
            ? {}
            : { stepContext: input.stepContext }),
          estimatedInputTokens: fixedTokens,
        });
        return { _tag: "Ready", turn: compiled } as TurnPreparation;
      }).pipe(
        Effect.catchIf(
          (cause): cause is ContextUnsatisfiable =>
            typeof cause === "object" &&
            cause !== null &&
            "_tag" in cause &&
            cause._tag === "ContextUnsatisfiable",
          (cause) => Effect.fail(cause),
        ),
        Effect.mapError(toModelContextError),
      );

    return ModelContext.of({ prepareTurn });
  }),
);

export type { ModelCapabilityError, Option, SkillRegistryError };
