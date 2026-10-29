import type { ExecutionDriverError } from "@arbor/ports";

const tagOf = (cause: unknown): string =>
  typeof cause === "object" &&
  cause !== null &&
  "_tag" in cause &&
  typeof cause._tag === "string"
    ? cause._tag
    : "UntaggedCause";

const invariantStage = (
  tag: string,
):
  | Extract<
      ExecutionDriverError,
      { readonly _tag: "ExecutionDriverInvariantFailure" }
    >["stage"]
  | undefined => {
  if (
    tag === "SessionSourceConflict" ||
    tag === "SessionEpochConflict" ||
    tag.startsWith("SessionContextBlocked")
  ) {
    return "SessionTimeline";
  }
  if (
    tag === "AgentLoopStepInvariantConflict" ||
    tag.startsWith("AgentLoopStepReplay")
  ) {
    return "AgentLoopStep";
  }
  if (tag.startsWith("SettledProvider") || tag.startsWith("LegacyProvider")) {
    return "ProviderReplay";
  }
  if (
    tag === "WorkspaceContextMissing" ||
    tag === "WorkContextMissing" ||
    tag === "SessionContextMissing"
  ) {
    return "ContextAssembly";
  }
  if (tag === "CompactionFenceUnavailable") {
    return "DriverContract";
  }
  return undefined;
};

const operationalStage = (
  tag: string,
  cause: unknown,
): Extract<
  ExecutionDriverError,
  { readonly _tag: "ExecutionDriverOperationalFailure" }
>["stage"] => {
  if (
    (tag === "PersistenceUnavailable" ||
      tag === "PersistenceConstraintViolation" ||
      tag === "PersistenceCorruption") &&
    typeof cause === "object" &&
    cause !== null &&
    "repository" in cause
  ) {
    switch (cause.repository) {
      case "SessionRepository":
        return "SessionStore";
      case "WorkspaceRepository":
        return "WorkspaceStore";
      case "WorkRepository":
        return "WorkStore";
      case "InboxProjectionStore":
        return "InboxProjection";
      case "AgentLoopStepStore":
        return "LoopStepStore";
      case "EnvironmentRevisionStore":
        return "ControlBasis";
      case "VerificationRepository":
        return "TurnProfile";
      case "ConversationJobStore":
      case "HumanMessageStore":
        return "ConversationStore";
      case "ToolInvocationStore":
        return "ActionLedger";
      default:
        return "DriverDependency";
    }
  }
  if (tag === "ModelCapabilityError") return "ModelCapability";
  if (tag.startsWith("InboxProjectionStore")) return "InboxProjection";
  if (tag === "InboxEntryNotFound" || tag === "InputPromotionTargetMismatch") {
    return "InputPromotion";
  }
  if (tag.startsWith("EnvironmentRevisionStore")) return "ControlBasis";
  if (
    tag.startsWith("SessionRepository") ||
    tag === "SessionSourceConflict" ||
    tag === "SessionEpochConflict"
  ) {
    return "SessionStore";
  }
  if (tag.startsWith("WorkspaceRepository")) return "WorkspaceStore";
  if (tag.startsWith("WorkRepository")) return "WorkStore";
  if (
    tag === "ToolNotRegistered" ||
    tag === "ToolCatalogError" ||
    tag.startsWith("VerificationRepository")
  ) {
    return "TurnProfile";
  }
  if (tag === "ModelContextError" || tag === "ContextUnsatisfiable") {
    return "ModelContext";
  }
  if (tag.startsWith("Compaction")) return "Compaction";
  if (tag.startsWith("ProviderTurnStore")) return "ProviderTurnStore";
  if (tag === "ProviderFailure" || tag === "ProviderExecutionTimeout") {
    return "ProviderRuntime";
  }
  if (
    tag === "TransactionOperationalFailure" ||
    tag.endsWith("RepositoryFailure")
  ) {
    return "DriverDependency";
  }
  return "DriverDependency";
};

export const toExecutionDriverError = (
  cause: unknown,
): ExecutionDriverError => {
  if (
    typeof cause === "object" &&
    cause !== null &&
    "_tag" in cause &&
    (cause._tag === "ExecutionDriverOperationalFailure" ||
      cause._tag === "ExecutionDriverOwnershipLost" ||
      cause._tag === "ExecutionDriverInvariantFailure")
  ) {
    return cause as ExecutionDriverError;
  }
  const tag = tagOf(cause);
  if (
    tag === "LeaseFencingRejected" &&
    typeof cause === "object" &&
    cause !== null &&
    "executionId" in cause &&
    "generation" in cause
  ) {
    return {
      _tag: "ExecutionDriverOwnershipLost",
      executionId: cause.executionId as never,
      generation: cause.generation as never,
    };
  }
  const stage = invariantStage(tag);
  if (stage !== undefined) {
    return {
      _tag: "ExecutionDriverInvariantFailure",
      stage,
      reason: tag,
    };
  }
  return {
    _tag: "ExecutionDriverOperationalFailure",
    stage: operationalStage(tag, cause),
    sourceTag: tag,
    cause,
  };
};
