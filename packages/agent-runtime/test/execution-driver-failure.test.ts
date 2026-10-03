import { describe, expect, it } from "vitest";
import { toExecutionDriverError } from "../src/execution-driver-failure.js";

describe("ExecutionDriver failure translation", () => {
  it("turns lease fencing into ownership loss without retaining a generic cause", () => {
    expect(
      toExecutionDriverError({
        _tag: "LeaseFencingRejected",
        executionId: "exe_fenced",
        generation: 7,
      }),
    ).toEqual({
      _tag: "ExecutionDriverOwnershipLost",
      executionId: "exe_fenced",
      generation: 7,
    });
  });

  it.each([
    ["ModelCapabilityError", "ModelCapability"],
    ["ToolCatalogError", "TurnProfile"],
    ["ModelContextError", "ModelContext"],
    ["ProviderTurnStoreError", "ProviderTurnStore"],
  ] as const)("maps %s to the %s operational stage", (sourceTag, stage) => {
    expect(
      toExecutionDriverError({ _tag: sourceTag, cause: "native" }),
    ).toMatchObject({
      _tag: "ExecutionDriverOperationalFailure",
      stage,
      sourceTag,
    });
  });

  it.each([
    ["InboxProjectionStore", "InboxProjection"],
    ["AgentLoopStepStore", "LoopStepStore"],
    ["SessionRepository", "SessionStore"],
    ["WorkspaceRepository", "WorkspaceStore"],
    ["WorkRepository", "WorkStore"],
    ["EnvironmentRevisionStore", "ControlBasis"],
    ["VerificationRepository", "TurnProfile"],
    ["HumanMessageStore", "ConversationStore"],
    ["ConversationJobStore", "ConversationStore"],
    ["ToolInvocationStore", "ActionLedger"],
  ] as const)(
    "maps %s persistence failure to the %s driver stage",
    (repository, stage) => {
      expect(
        toExecutionDriverError({
          _tag: "PersistenceUnavailable",
          repository,
          operation: "test",
          retryDisposition: "retryable",
          sourceTag: "InjectedFailure",
          cause: "native",
        }),
      ).toMatchObject({
        _tag: "ExecutionDriverOperationalFailure",
        stage,
        sourceTag: "PersistenceUnavailable",
      });
    },
  );

  it.each([
    ["SessionSourceConflict", "SessionTimeline"],
    ["AgentLoopStepInvariantConflict", "AgentLoopStep"],
    ["AgentLoopStepReplayBindingMismatch", "AgentLoopStep"],
    ["SettledProviderEvidenceInvalid", "ProviderReplay"],
    ["WorkspaceContextMissing", "ContextAssembly"],
    ["CompactionFenceUnavailable", "DriverContract"],
  ] as const)("maps %s to the %s invariant stage", (reason, stage) => {
    expect(toExecutionDriverError({ _tag: reason })).toEqual({
      _tag: "ExecutionDriverInvariantFailure",
      stage,
      reason,
    });
  });
});
