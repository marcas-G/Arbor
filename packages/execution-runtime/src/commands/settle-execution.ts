import {
  blockedFailureFingerprint,
  type CommandHandler,
  commandErr,
  commandOk,
  verifyBlockedActionRefs,
  workBlockerIdentity,
} from "@arbor/application";
import type {
  ExecutionId,
  ExecutionSettlement,
  LeaseGeneration,
  WorkBlocker,
  WorkId,
} from "@arbor/domain";
import { settlementMatchesEpisode, workEpisode } from "@arbor/domain";
import type {
  AgentLoopStepStoreService,
  ExecutionRepositoryService,
  InboxProjectionStoreError,
  InboxProjectionStoreService,
  PendingDomainEvent,
  ProviderTurnStoreService,
  TransactionScope,
  WorkBlockerStoreError,
  WorkBlockerStoreService,
  WorkRepositoryError,
  WorkRepositoryService,
  WorkWait,
  WorkWaitStoreError,
  WorkWaitStoreService,
} from "@arbor/ports";
import { Effect, Option } from "effect";

export interface SettleExecutionPayload {
  readonly executionId: ExecutionId;
  readonly settlement: ExecutionSettlement;
  readonly expectedFencingGeneration?: LeaseGeneration;
}

export interface SettleExecutionResult {
  readonly executionId: ExecutionId;
  readonly settlement: ExecutionSettlement;
}

export interface SettleExecutionDependencies {
  readonly executions: ExecutionRepositoryService;
  readonly workWaits: WorkWaitStoreService;
  readonly blockers?: WorkBlockerStoreService;
  readonly works?: Pick<WorkRepositoryService, "findById">;
  readonly inbox?: Pick<InboxProjectionStoreService, "currentSequence">;
  readonly blockedEvidence?: {
    readonly loopSteps: Pick<AgentLoopStepStoreService, "find" | "listActions">;
    readonly providerTurns: Pick<
      ProviderTurnStoreService,
      "findManifestByTurn"
    >;
  };
}

const invalidSettlement = (reason: string) =>
  Effect.die(new Error(`invalid ExecutionSettlement: ${reason}`));

const validateSettlement = (
  settlement: ExecutionSettlement,
): Effect.Effect<void> => {
  switch (settlement._tag) {
    case "Completed": {
      if (settlement.result._tag === "Yielded") {
        return settlement.result.waitSpec.conditions.length > 0
          ? Effect.void
          : invalidSettlement("Yielded requires a non-empty WaitSpec");
      }
      if (settlement.result._tag === "Blocked") {
        const result = settlement.result;
        return result.failedActionRefs.length > 0 &&
          result.request.trim().length > 0 &&
          result.request.length <= 2000 &&
          result.waitFor.mode === "Any" &&
          result.waitFor.conditions.length === 2 &&
          result.waitFor.conditions.some(
            (condition) => condition._tag === "Manual",
          ) &&
          result.waitFor.conditions.some(
            (condition) => condition._tag === "InboxAdvanced",
          )
          ? Effect.void
          : invalidSettlement(
              "Blocked requires bounded request, non-empty evidence and Manual + InboxAdvanced wait",
            );
      }
      return Effect.void;
    }
    case "OutcomeUnknown":
      return settlement.reconciliation.invocationRefs.length > 0
        ? Effect.void
        : invalidSettlement("OutcomeUnknown requires invocationRefs");
    default:
      return Effect.void;
  }
};

const compareBlockedActionRefs = (
  left: WorkBlocker["failedActionRefs"][number],
  right: WorkBlocker["failedActionRefs"][number],
): number =>
  left.logicalStepNo - right.logicalStepNo ||
  left.repairAttempt - right.repairAttempt ||
  left.actionIndex - right.actionIndex;

const registerBlockedWork = (
  execution: import("@arbor/domain").Execution,
  result: Extract<
    Extract<ExecutionSettlement, { readonly _tag: "Completed" }>["result"],
    { readonly _tag: "Blocked" }
  >,
  dependencies: SettleExecutionDependencies,
  occurredAt: string,
): Effect.Effect<
  void,
  | WorkBlockerStoreError
  | WorkRepositoryError
  | InboxProjectionStoreError
  | import("@arbor/ports").AgentLoopStepStoreError
  | import("@arbor/ports").ProviderFailure
  | WorkWaitStoreError,
  TransactionScope
> =>
  Effect.gen(function* () {
    if (
      dependencies.blockers === undefined ||
      dependencies.works === undefined ||
      dependencies.inbox === undefined ||
      dependencies.blockedEvidence === undefined
    ) {
      return yield* invalidSettlement(
        "Blocked settlement requires WorkBlocker, P9 evidence, Work and Inbox sequence stores",
      );
    }
    const episode = workEpisode(execution);
    if (
      episode === null ||
      episode.workId !== result.workId ||
      episode.targetWorkRevision !== result.targetWorkRevision
    ) {
      return yield* invalidSettlement(
        "Blocked does not match exact WorkEpisode",
      );
    }
    const inboxWait = result.waitFor.conditions.find(
      (condition) => condition._tag === "InboxAdvanced",
    );
    if (
      inboxWait === undefined ||
      inboxWait._tag !== "InboxAdvanced" ||
      inboxWait.workspaceId !== execution.workspaceId
    ) {
      return yield* invalidSettlement(
        "Blocked InboxAdvanced must bind the execution Workspace",
      );
    }
    const currentWork = yield* dependencies.works.findById(result.workId);
    if (
      Option.isNone(currentWork) ||
      currentWork.value.workspaceId !== execution.workspaceId
    ) {
      return yield* invalidSettlement(
        "Blocked Work target must belong to the execution Workspace",
      );
    }
    const observedSequence = yield* dependencies.inbox.currentSequence(
      execution.workspaceId,
    );
    if (inboxWait.observedSequence > observedSequence) {
      return yield* invalidSettlement(
        "Blocked InboxAdvanced sequence cannot be from the future",
      );
    }

    const failedActionRefs = [...result.failedActionRefs].sort(
      compareBlockedActionRefs,
    );
    if (
      failedActionRefs.some(
        (action) =>
          action.executionId !== execution.executionId ||
          !Number.isSafeInteger(action.logicalStepNo) ||
          action.logicalStepNo < 0 ||
          !Number.isSafeInteger(action.repairAttempt) ||
          action.repairAttempt < 0 ||
          !Number.isSafeInteger(action.actionIndex) ||
          action.actionIndex < 0,
      )
    ) {
      return yield* invalidSettlement(
        "Blocked evidence must reference this Execution and valid P9 action coordinates",
      );
    }
    const verified = yield* verifyBlockedActionRefs(
      { executionId: execution.executionId, refs: failedActionRefs },
      dependencies.blockedEvidence,
    ).pipe(
      Effect.catchTag("BlockedActionEvidenceInvalid", (error) =>
        invalidSettlement(
          `Blocked refs do not match pinned P9 evidence: ${error.reason}`,
        ),
      ),
    );
    const failureFingerprint = blockedFailureFingerprint(verified);
    const blockerId = workBlockerIdentity({
      projectId: execution.projectId,
      workId: result.workId,
      targetWorkRevision: result.targetWorkRevision,
      failureFingerprint,
    });
    if (result.blockerId !== blockerId) {
      return yield* invalidSettlement(
        "Blocked blockerId does not match exact failure evidence",
      );
    }
    // A canonical Work revision transition may win the race before this
    // settlement transaction. The evidence still validates the stable result,
    // but a stale source revision gets no current blocker row or WorkWait.
    // P6 consumes ExecutionSettled and reevaluates the current Work revision.
    if (
      currentWork.value.lifecycle !== "Open" ||
      currentWork.value.revision !== result.targetWorkRevision
    ) {
      return;
    }
    const blocker: WorkBlocker = {
      blockerId: blockerId as WorkBlocker["blockerId"],
      projectId: execution.projectId,
      workspaceId: execution.workspaceId,
      workId: result.workId,
      targetWorkRevision: result.targetWorkRevision,
      failureFingerprint:
        failureFingerprint as WorkBlocker["failureFingerprint"],
      state: "Open",
      openCycleId: execution.executionId,
      latestRequestRef: result.request,
      failedActionRefs,
      revision: 0,
    };
    yield* dependencies.blockers.openOrUpdate(blocker);
    yield* dependencies.workWaits.upsert({
      workId: result.workId,
      waitSpec: result.waitFor,
      registeredAt: occurredAt,
      updatedAt: occurredAt,
    });

    // Work and Inbox are re-read in the same transaction as the ledger and
    // WorkWait writes. A changed Inbox is delivered by the canonical wake
    // consumer; the Manual condition remains an explicit no-retry barrier.
    // Force current facts to be read after registration in this transaction.
    // The P6 ExecutionSettled consumer compares them again after commit and
    // emits an at-least-once reevaluation wake if either observation is stale.
    yield* dependencies.works.findById(result.workId);
    yield* dependencies.inbox.currentSequence(execution.workspaceId);
  }).pipe(Effect.asVoid);

const yieldedWorkId = (execution: {
  readonly binding: import("@arbor/domain").ExecutionBinding;
}): WorkId | null => {
  const candidate = execution as import("@arbor/domain").Execution;
  return workEpisode(candidate)?.workId ?? null;
};

export const executionSettledEventPayload = (
  execution: {
    readonly executionId: ExecutionId;
    readonly binding: import("@arbor/domain").ExecutionBinding;
  },
  settlement: ExecutionSettlement,
) => {
  const boundWork = workEpisode(execution as import("@arbor/domain").Execution);
  const completionClaimFields =
    boundWork !== null &&
    settlement._tag === "Completed" &&
    settlement.result._tag === "CompletionClaimed"
      ? {
          workId: boundWork.workId,
          workRevision: settlement.result.workRevision,
          claimRef: settlement.result.claimRef,
        }
      : {};
  return {
    executionId: execution.executionId,
    ...completionClaimFields,
    settlement,
  };
};

export const makeSettleExecutionHandler = (
  dependencies: SettleExecutionDependencies,
): CommandHandler<SettleExecutionPayload, SettleExecutionResult> => ({
  commandType: "SettleExecution",
  schemaVersion: "1",
  authority: {
    tag: "SettleExecutionAuthority",
    targetMatches: (authority, payload) =>
      authority._tag === "SettleExecutionAuthority" &&
      authority.executionId === payload.executionId,
  },
  stopAdmission: { _tag: "QuiescenceControlMutation" },
  execute: (envelope) =>
    Effect.gen(function* () {
      const payload = envelope.payload;
      yield* validateSettlement(payload.settlement);
      const execution = yield* dependencies.executions.findById(
        payload.executionId,
      );
      if (Option.isNone(execution)) {
        return commandErr({
          _tag: "ExecutionNotFound",
          executionId: payload.executionId,
        });
      }
      const current = execution.value;
      if (!settlementMatchesEpisode(current, payload.settlement)) {
        return yield* invalidSettlement(
          "completed result does not match exact EpisodeBinding",
        );
      }
      if (current.projectId !== envelope.projectId) {
        return commandErr({
          _tag: "AuthorityDenied",
          reason: "execution belongs to another project",
        });
      }
      if (current.state.status !== "Active") {
        return commandErr({
          _tag: "TerminalLifecycleMutation",
          entity: "Execution",
          lifecycle: "Settled",
        });
      }

      if (
        payload.settlement._tag === "Completed" &&
        payload.settlement.result._tag === "Yielded"
      ) {
        const workId = yieldedWorkId(current);
        if (workId !== null) {
          const wait: WorkWait = {
            workId,
            waitSpec: payload.settlement.result.waitSpec,
            registeredAt: envelope.issuedAt,
            updatedAt: envelope.issuedAt,
          };
          yield* dependencies.workWaits.upsert(wait);
        }
      }
      if (
        payload.settlement._tag === "Completed" &&
        payload.settlement.result._tag === "Blocked"
      ) {
        yield* registerBlockedWork(
          current,
          payload.settlement.result,
          dependencies,
          envelope.issuedAt,
        );
      }

      yield* dependencies.executions.settle(
        payload.executionId,
        payload.settlement,
        envelope.issuedAt,
      );

      const events: PendingDomainEvent[] = [
        {
          projectId: envelope.projectId,
          eventType: "ExecutionSettled",
          eventVersion: 1,
          occurredAt: envelope.issuedAt,
          aggregateRef: payload.executionId,
          actor: envelope.actor,
          causedByCommandId: envelope.commandId,
          payload: executionSettledEventPayload(current, payload.settlement),
        },
      ];

      return commandOk({
        result: {
          executionId: payload.executionId,
          settlement: payload.settlement,
        },
        events,
      });
    }),
});
