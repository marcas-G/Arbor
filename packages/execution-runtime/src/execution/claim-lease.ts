import type {
  AgentEpisodeIdentity,
  AgentExecutionState,
  Execution,
  ExecutionId,
  WakeReason,
} from "@arbor/domain";
import type { AgentExecutionStateStoreService, ClockService, LeaseServiceService, TransactionPortService } from "@arbor/ports";
import { Effect, Option } from "effect";
import { LOCAL_WORKER_INCARNATION_ID } from "../process-identity.js";
import type { ExecutionLeaseQualificationProbe } from "./lease.js";

const WORKER_ID = "worker:local";

const episodeIdentityMatches = (
  stored: AgentEpisodeIdentity,
  expected: AgentEpisodeIdentity,
): boolean => {
  if (stored._tag !== expected._tag) return false;
  switch (expected._tag) {
    case "WorkEpisode":
      return (
        stored._tag === "WorkEpisode" &&
        stored.workId === expected.workId &&
        stored.targetWorkRevision === expected.targetWorkRevision
      );
    case "ConversationResponseEpisode":
      return (
        stored._tag === "ConversationResponseEpisode" &&
        stored.messageId === expected.messageId &&
        stored.responseJobRevision === expected.responseJobRevision
      );
    case "InboxEpisode":
      return (
        stored._tag === "InboxEpisode" &&
        stored.entryKey === expected.entryKey &&
        stored.inputKind === expected.inputKind
      );
    case "DecisionEpisode":
      return (
        stored._tag === "DecisionEpisode" &&
        stored.decisionId === expected.decisionId &&
        stored.decisionKind === expected.decisionKind &&
        stored.requestRevision === expected.requestRevision
      );
    case "ExecutionBoundEpisode":
      return (
        stored._tag === "ExecutionBoundEpisode" &&
        stored.executionId === expected.executionId
      );
    case "LegacyAmbiguousEpisode":
      return (
        stored._tag === "LegacyAmbiguousEpisode" &&
        stored.executionId === expected.executionId
      );
  }
};

const executionEpisodeIdentity = (
  execution: import("@arbor/domain").Execution,
): AgentEpisodeIdentity =>
  execution.binding._tag === "ExecutionBoundAgentBinding"
    ? { _tag: "ExecutionBoundEpisode", executionId: execution.executionId }
    : (execution.binding.episode ?? {
        _tag: "LegacyAmbiguousEpisode",
        executionId: execution.executionId,
      });

const initialAgentExecutionState = (
  executionId: ExecutionId,
  episode: AgentEpisodeIdentity,
  wakeReason: WakeReason,
  updatedAt: string,
): AgentExecutionState => ({
  executionId,
  episode,
  wakeReason,
  currentMode: null,
  activeSkillRefs: [],
  turnNo: 0,
  recentDirectiveRefs: [],
  recentActionFingerprints: [],
  updatedAt,
});

const agentStateBindingFailure = {
  _tag: "PersistenceCorruption" as const,
  repository: "ExecutionRepository" as const,
  operation: "agent-state-episode-binding",
  reason:
    "stored AgentExecutionState does not match canonical Execution Episode",
};

/** Lease acquisition and canonical AgentExecutionState initialization are one transaction. */
export const claimExecutionLease = (
  execution: Execution,
  executionId: ExecutionId,
  wakeReason: WakeReason,
  tx: TransactionPortService,
  leases: LeaseServiceService,
  states: AgentExecutionStateStoreService,
  clock: ClockService,
  leaseQualificationProbe?: ExecutionLeaseQualificationProbe,
) =>
  Effect.gen(function* () {
    if (leaseQualificationProbe !== undefined) {
      yield* Effect.promise(() =>
        leaseQualificationProbe({
          boundary: "AH10BeforeLeaseAcquired",
          executionId,
        }),
      );
    }
    const { lease, agentExecutionState } = yield* tx.transact(
      Effect.gen(function* () {
        const lease = yield* leases
          .acquire(executionId, WORKER_ID, LOCAL_WORKER_INCARNATION_ID)
          .pipe(
            Effect.tapError((error) =>
              error._tag === "LeaseFencingRejected" &&
              leaseQualificationProbe !== undefined
                ? Effect.promise(() =>
                    leaseQualificationProbe({
                      boundary: "AH10LeaseAcquisitionRejected",
                      executionId,
                      workerId: WORKER_ID,
                      workerIncarnationId: LOCAL_WORKER_INCARNATION_ID,
                      fencingGeneration: error.generation,
                    }),
                  )
                : Effect.void,
            ),
          );
        const existingState = yield* states.find(executionId);
        const episode = executionEpisodeIdentity(execution);
        if (Option.isSome(existingState)) {
          const state = existingState.value;
          if (
            state.executionId !== executionId ||
            state.episode === undefined ||
            !episodeIdentityMatches(state.episode, episode)
          ) {
            return yield* Effect.fail(agentStateBindingFailure);
          }
          return { lease, agentExecutionState: state };
        }
        const state = initialAgentExecutionState(
          executionId,
          episode,
          wakeReason,
          yield* clock.now(),
        );
        yield* states.upsert(state);
        return { lease, agentExecutionState: state };
      }),
    );
    if (leaseQualificationProbe !== undefined) {
      yield* Effect.promise(() =>
        leaseQualificationProbe({
          boundary: "AH10AfterLeaseAcquired",
          executionId,
          workerId: WORKER_ID,
          workerIncarnationId: LOCAL_WORKER_INCARNATION_ID,
          fencingGeneration: lease.generation,
        }),
      );
    }
    return { lease, agentExecutionState };
  });
