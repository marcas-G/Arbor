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
  type SkillRef,
  SkillRegistry,
  type SkillRegistryError,
  ToolCatalogPort,
} from "@arbor/ports";
import { Context, Effect, Layer, Option } from "effect";
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
import { type GovernanceIssue, resolveInstructions } from "./resolver.js";
import { progressiveLoad } from "./skills.js";

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
  ModelCapabilityPort | SkillRegistry | ToolCatalogPort
> = Layer.effect(
  ModelContext,
  Effect.gen(function* () {
    const capabilityPort = yield* ModelCapabilityPort;
    const skills = yield* SkillRegistry;
    const toolCatalog = yield* ToolCatalogPort;

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

        const planned = planContext(input.contextFragments, input.budget);
        if (planned.unsatisfiable) {
          const hard = input.contextFragments.filter(
            (fragment) =>
              fragment.retention === "Pinned" ||
              fragment.retention === "Protected",
          );
          return yield* Effect.fail<ContextUnsatisfiable>({
            _tag: "ContextUnsatisfiable",
            requiredTokens: hard.reduce((sum, f) => sum + f.tokens, 0),
            availableTokens: contextBudget(input.budget),
          });
        }
        if (planned.evicted.length > 0) {
          return {
            _tag: "NeedsCompaction",
            reason: "BudgetPressure",
          } as TurnPreparation;
        }

        const capability = yield* capabilityPort.resolve({
          binding: input.binding,
          cognitiveMode: input.cognitiveMode,
          requiredCapabilities: [],
        });
        const tools = yield* toolCatalog.definitions();
        const skillRefs: SkillRef[] = [];
        for (const skillId of input.bodySkillIds) {
          const loaded = yield* skills.load(skillId, "Body");
          skillRefs.push(loaded.skillRef);
        }

        const compiled = compileTurn({
          plan: {
            instructions: resolved,
            context: planned.selected,
            tools,
            skills: skillRefs,
            outputContract:
              input.program.outputContractRefs[0] ?? "agent-directive-v1",
            continuation: "recent-frontier",
            controlBasis: input.controlBasis,
          },
          capability,
          providerTurnId: input.providerTurnId,
          executionId: input.executionId,
          sessionId: input.sessionId,
          contextEpoch: input.contextEpoch,
          maxOutputTokens: input.maxOutputTokens,
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

export type { ModelCapabilityError, SkillRegistryError };
export { Option };
