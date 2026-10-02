import type { Execution, ExecutionId } from "@arbor/domain";
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
  | "RootConversationRespond"
  | "WorkspaceWork"
  | "WorkspaceCoordination"
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
    : conversation
      ? "RootConversationRespond"
      : execution.binding.focus._tag === "Coordination"
        ? "WorkspaceCoordination"
        : "WorkspaceWork";

const specialistControls = new Set([
  "arbor_send_message",
  "arbor_propose_child_workspace",
  "arbor_spawn_specialist",
]);

const verifierControls = new Set([
  "arbor_record_verification_evidence",
  "arbor_conclude_verification",
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
      if (
        purpose === "WorkspaceWork" ||
        purpose === "WorkspaceCoordination" ||
        purpose === "Verifier"
      ) {
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
        purpose === "RootConversationRespond"
          ? []
          : purpose === "ExecutionBoundSpecialist"
            ? allControls.filter((tool) => specialistControls.has(tool.name))
            : purpose === "Verifier"
              ? allControls.filter((tool) => verifierControls.has(tool.name))
              : allControls.filter((tool) => !verifierControls.has(tool.name));
      const outputContractRef =
        purpose === "RootConversationRespond"
          ? "text-response-v1"
          : "tool-invocation-v1";
      const contextPolicyRef =
        purpose === "RootConversationRespond"
          ? "root-conversation-context-v1"
          : purpose === "WorkspaceWork"
            ? "workspace-work-context-v1"
            : purpose === "WorkspaceCoordination"
              ? "workspace-coordination-context-v1"
              : purpose === "Verifier"
                ? "verifier-context-v1"
                : "specialist-context-v1";
      const identity = {
        purpose,
        profileVersion: "turn-profile-v1" as const,
        outputContractRef,
        executableTools: executableTools.map(({ name, version, hash }) => ({
          name,
          version,
          hash,
        })),
        controlTools: controlTools.map(({ name, version, hash }) => ({
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
