import {
  Actor,
  type CommandId,
  type EventId,
  type ExecutionId,
  type ProjectId,
  type ProviderTurnId,
  parse,
  type WorkspaceId,
} from "@arbor/domain";
import {
  DomainEventJournal,
  IdGenerator,
  type RecoveryAttentionFactStoreService,
  sha256Hex,
} from "@arbor/ports";
import { Effect } from "effect";

export interface SubmittedDecisionBindingFailureInput {
  readonly projectId: ProjectId;
  readonly executionId: ExecutionId;
  readonly workspaceId: WorkspaceId;
  readonly logicalStepNo: number;
  readonly repairAttempt: number;
  readonly providerTurnId: ProviderTurnId;
  readonly logicalActionId: string;
  readonly failureCode:
    | "DecisionRequestWorkspaceMismatch"
    | "StepManifestMismatch"
    | "SettledExecutionWithPendingDecisionAction";
  readonly firstDetectedAt: string;
  readonly causedByCommandId: CommandId | null;
}

/**
 * Write the immutable P9 witness and its exact journal event in the caller's
 * transaction. The fact identity is stable across retries; journal identity
 * is returned by the journal and stored in the same transaction.
 */
export const recordSubmittedDecisionBindingFailure = (
  facts: RecoveryAttentionFactStoreService,
  input: SubmittedDecisionBindingFailureInput,
) =>
  Effect.gen(function* () {
    const journal = yield* DomainEventJournal;
    const record = facts.recordSubmittedDecisionBindingFailure;
    const find = facts.findSubmittedDecisionBindingFailure;
    if (record === undefined || find === undefined) {
      return yield* Effect.fail({
        _tag: "RecoveryAttentionFactInvariantConflict" as const,
        reason: "Submitted DecisionEpisode binding fact storage is unavailable",
      });
    }

    const tuple = {
      executionId: input.executionId,
      logicalStepNo: input.logicalStepNo,
      repairAttempt: input.repairAttempt,
      logicalActionId: input.logicalActionId,
    };
    const attentionFactId = `att_${sha256Hex(
      JSON.stringify({ version: 1, ...tuple }),
    )}`;
    const existing = yield* find(attentionFactId);
    if (existing._tag === "Some") {
      const fact = existing.value;
      if (
        fact.projectId !== input.projectId ||
        fact.executionId !== input.executionId ||
        fact.workspaceId !== input.workspaceId ||
        fact.logicalStepNo !== input.logicalStepNo ||
        fact.repairAttempt !== input.repairAttempt ||
        fact.providerTurnId !== input.providerTurnId ||
        fact.logicalActionId !== input.logicalActionId ||
        fact.failureCode !== input.failureCode
      ) {
        return yield* Effect.fail({
          _tag: "RecoveryAttentionFactInvariantConflict" as const,
          reason:
            "existing Submitted DecisionEpisode binding fact conflicts with its immutable tuple",
        });
      }
      return fact;
    }

    const eventIds = yield* journal
      .appendReturningIds([
        {
          projectId: input.projectId,
          eventType: "SubmittedDecisionBindingEscalated",
          eventVersion: 1,
          occurredAt: input.firstDetectedAt,
          aggregateRef: input.workspaceId,
          actor: parse(Actor)("system:recovery"),
          ...(input.causedByCommandId === null
            ? {}
            : { causedByCommandId: input.causedByCommandId }),
          correlationRef: input.logicalActionId,
          payload: {
            attentionFactId,
            executionId: input.executionId,
            workspaceId: input.workspaceId,
            logicalStepNo: input.logicalStepNo,
            repairAttempt: input.repairAttempt,
            providerTurnId: input.providerTurnId,
            logicalActionId: input.logicalActionId,
            failureCode: input.failureCode,
          },
        },
      ])
      .pipe(Effect.provideService(IdGenerator, yield* IdGenerator));
    const eventId: EventId | undefined = eventIds[0];
    if (eventId === undefined) {
      return yield* Effect.fail({
        _tag: "RecoveryAttentionFactInvariantConflict" as const,
        reason:
          "event journal did not return the Submitted DecisionEpisode binding event id",
      });
    }
    return yield* record({
      attentionFactId,
      eventId,
      projectId: input.projectId,
      executionId: input.executionId,
      workspaceId: input.workspaceId,
      logicalStepNo: input.logicalStepNo,
      repairAttempt: input.repairAttempt,
      providerTurnId: input.providerTurnId,
      logicalActionId: input.logicalActionId,
      failureCode: input.failureCode,
      firstDetectedAt: input.firstDetectedAt,
    });
  });
