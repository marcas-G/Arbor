import type { Execution, ExecutionId } from "@arbor/domain";
import { executionEpisode } from "@arbor/domain";
import {
  ControlToolCatalogPort,
  type ControlToolCatalogPortService,
  type ModelFacingControlToolDefinition,
  type ModelFacingToolDefinition,
  sha256Hex,
  ToolCatalogPort,
  type ToolCatalogPortService,
  type TransactionOperationalFailure,
  TransactionPort,
  VerificationRepository,
  type VerificationRepositoryError,
} from "@arbor/ports";
import { Context, Effect, Layer, Option } from "effect";

export type ExecutionPurpose =
  | "RootConversation"
  | "WorkspaceWork"
  | "WorkspaceInput"
  | "WorkspaceDecision"
  | "LegacyAmbiguous"
  | "ExecutionBoundSpecialist"
  | "Verifier";

export interface ResolvedTurnProfile {
  readonly purpose: ExecutionPurpose;
  readonly profileVersion: "turn-profile-v1";
  readonly outputContractRef: string;
  readonly executableTools: ReadonlyArray<ModelFacingToolDefinition>;
  readonly controlTools: ReadonlyArray<ModelFacingControlToolDefinition>;
  readonly contextPolicyRef: string;
  readonly fingerprint: string;
}

export interface TurnProfileResolverService {
  readonly resolve: (input: {
    readonly execution: Execution;
    readonly conversation: boolean;
  }) => Effect.Effect<
    ResolvedTurnProfile,
    | import("@arbor/ports").ToolCatalogError
    | VerificationRepositoryError
    | TransactionOperationalFailure
  >;
}

export class TurnProfileResolver extends Context.Service<
  TurnProfileResolver,
  TurnProfileResolverService
>()("arbor/TurnProfileResolver") {}

const purposeOf = (
  execution: Execution,
  conversation: boolean,
): ExecutionPurpose =>
  execution.binding._tag === "ExecutionBoundAgentBinding"
    ? "ExecutionBoundSpecialist"
    : executionEpisode(execution)?._tag === "ConversationResponseEpisode" ||
        conversation
      ? "RootConversation"
      : executionEpisode(execution)?._tag === "InboxEpisode"
        ? "WorkspaceInput"
        : executionEpisode(execution)?._tag === "DecisionEpisode"
          ? "WorkspaceDecision"
          : executionEpisode(execution)?._tag === "WorkEpisode"
            ? "WorkspaceWork"
            : "LegacyAmbiguous";

/** MAC-P4 owns any future runtime subagent surface. Historical
 * ExecutionBound specialists fail closed until that phase is authorized. */
const specialistControls = new Set<string>();

const verifierControls = new Set([
  "core.control.record-verification-evidence",
  "core.control.conclude-verification",
]);

const decisionControls = new Set(["core.control.select-current-work"]);

const workControls = new Set([
  "core.control.assign-work",
  "core.control.accept-result",
  "core.control.list-workspaces",
  "core.control.read-workspace",
  "core.control.send-message",
  "core.control.wait",
  "core.control.update-plan",
  "core.control.claim-completion",
  "core.control.propose-workspace",
  "core.control.declare-dependency",
  "core.control.produce-deliverable",
  "core.control.deliver",
]);

/** Cross-Workspace Inbox cognition reopens only with the complete MAC-P3
 * declare/produce/deliver/satisfy/wake path. */
const inputControls = new Set([
  "core.control.accept-result",
  "core.control.send-message",
  "core.control.list-workspaces",
  "core.control.read-workspace",
]);

/** MAC-P1: RootConversation can turn one bounded human goal into Work in the
 * current root Workspace. Formation and cross-Workspace placement reopen in
 * MAC-P2; executable tools remain WorkEpisode-only. */
const conversationControls = new Set([
  "core.control.assign-work",
  "core.control.accept-result",
  "core.control.list-workspaces",
  "core.control.read-workspace",
  "core.control.propose-workspace",
]);

export const makeTurnProfileResolver = (dependencies: {
  readonly toolCatalog: ToolCatalogPortService;
  readonly controlCatalog?: ControlToolCatalogPortService;
  readonly verificationForExecution?: (
    executionId: ExecutionId,
  ) => Effect.Effect<
    Option.Option<import("@arbor/domain").Verification>,
    VerificationRepositoryError | TransactionOperationalFailure
  >;
}): TurnProfileResolverService => ({
  resolve: ({ execution, conversation }) =>
    Effect.gen(function* () {
      const verifier =
        execution.binding._tag === "ExecutionBoundAgentBinding" &&
        dependencies.verificationForExecution !== undefined
          ? yield* dependencies.verificationForExecution(execution.executionId)
          : Option.none();
      const purpose = Option.isSome(verifier)
        ? "Verifier"
        : purposeOf(execution, conversation);
      const executableTools: ModelFacingToolDefinition[] = [];
      if (purpose === "WorkspaceWork" || purpose === "Verifier") {
        for (const ref of yield* dependencies.toolCatalog.visibleRefs()) {
          executableTools.push(
            yield* dependencies.toolCatalog.resolveForModel(ref),
          );
        }
      }
      const allControls =
        dependencies.controlCatalog === undefined
          ? []
          : yield* dependencies.controlCatalog.visibleDefinitions();
      const controlTools =
        purpose === "RootConversation"
          ? allControls.filter((tool) =>
              conversationControls.has(tool.stableId),
            )
          : purpose === "WorkspaceDecision"
            ? allControls.filter((tool) => decisionControls.has(tool.stableId))
            : purpose === "WorkspaceWork"
              ? allControls.filter((tool) => workControls.has(tool.stableId))
              : purpose === "WorkspaceInput"
                ? allControls.filter((tool) => inputControls.has(tool.stableId))
                : purpose === "ExecutionBoundSpecialist"
                  ? allControls.filter((tool) =>
                      specialistControls.has(tool.stableId),
                    )
                  : purpose === "Verifier"
                    ? allControls.filter((tool) =>
                        verifierControls.has(tool.stableId),
                      )
                    : [];
      const outputContractRef = "tool-invocation-v1";
      const contextPolicyRef =
        purpose === "RootConversation"
          ? "root-conversation-context-v1"
          : purpose === "WorkspaceWork"
            ? "workspace-work-context-v1"
            : purpose === "WorkspaceInput"
              ? "workspace-input-context-v1"
              : purpose === "WorkspaceDecision"
                ? "workspace-decision-context-v1"
                : purpose === "Verifier"
                  ? "verifier-context-v1"
                  : purpose === "LegacyAmbiguous"
                    ? "legacy-ambiguous-fail-closed-v1"
                    : "legacy-specialist-fail-closed-v1";
      const identity = {
        purpose,
        profileVersion: "turn-profile-v1" as const,
        outputContractRef,
        executableTools: executableTools.map(({ name, version, hash }) => ({
          name,
          version,
          hash,
        })),
        controlTools: controlTools.map(({ stableId, name, version, hash }) => ({
          stableId,
          name,
          version,
          hash,
        })),
        contextPolicyRef,
      };
      return {
        ...identity,
        executableTools,
        controlTools,
        fingerprint: `tpf_${sha256Hex(JSON.stringify(identity))}`,
      };
    }),
});

export const TurnProfileResolverLive: Layer.Layer<
  TurnProfileResolver,
  never,
  ToolCatalogPort | VerificationRepository | TransactionPort
> = Layer.effect(
  TurnProfileResolver,
  Effect.gen(function* () {
    const toolCatalog = yield* ToolCatalogPort;
    const controlCatalog = yield* Effect.serviceOption(ControlToolCatalogPort);
    const verifications = yield* VerificationRepository;
    const tx = yield* TransactionPort;
    return makeTurnProfileResolver({
      toolCatalog,
      verificationForExecution: (executionId) =>
        tx.transact(verifications.findByExecutionId(executionId)),
      ...(Option.isSome(controlCatalog)
        ? { controlCatalog: controlCatalog.value }
        : {}),
    });
  }),
);
