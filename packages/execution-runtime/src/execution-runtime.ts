import {
  planSubmittedDecisionStopClose,
  reconstructSubmittedDecisionStopCloseActions,
} from "@arbor/agent-runtime";
import {
  CommandGateway,
  type CommandRejection,
  semanticRequestFingerprint,
  type VerifiedRuntimeCommandAuthority,
} from "@arbor/application";
import type {
  AgentEpisodeIdentity,
  AgentExecutionState,
  CommandSubmissionContext,
  Execution,
  ExecutionId,
  LeaseGeneration,
  Principal,
  SandboxAuthorityBundleSnapshotV2,
  SandboxPolicyDecisionCommittedInternalV1,
  WakeReason,
} from "@arbor/domain";
import { encodeExecutionEpisodeBinding, executionEpisode } from "@arbor/domain";
import {
  AgentExecutionStateStore,
  AgentLoopStepStore,
  AttentionProjectionStore,
  Clock,
  type CommittedSandboxPolicyDecisionV1,
  ControlApprovalStore,
  CurrentSandboxAuthoritySnapshotPort,
  DecisionRequestStore,
  ExecutableApprovalStore,
  type ExecutionDriverOwnershipLost,
  ExecutionDriverPort,
  ExecutionRepository,
  type ExecutionRepositoryError,
  type LeaseFencingRejected,
  type LeaseRecord,
  LeaseService,
  P39RecoveryEvidenceStore,
  ProviderTurnStore,
  ReconciliationSource,
  RecoveryAttentionFactStore,
  RuntimeSafetyGate,
  SandboxPolicyDecisionStore,
  SandboxPolicyRequirementReadPort,
  SandboxProviderUnavailableStore,
  SessionRepository,
  type TransactionOperationalFailure,
  TransactionPort,
  WorkerDispatchPort,
} from "@arbor/ports";
import { Effect, Option } from "effect";
import { LOCAL_WORKER_INCARNATION_ID } from "./process-identity.js";
import { recordSubmittedDecisionBindingFailure } from "./submitted-decision-binding-failure.js";

/** Empirical TTL value (P2 `03` §8 keeps lease duration non-contract); only
 * the TTL/3 renewal-cadence convention is contract (P9 `03` §1). */
export const LEASE_TTL_MS = 30_000;
export const LEASE_RENEW_INTERVAL_MS = LEASE_TTL_MS / 3;

/** Test-only process-local seam. Production composition leaves it absent. */
export type ExecutionSettlementQualificationProbe = (
  event:
    | {
        readonly boundary:
          | "AH12BeforeSettleGatewaySubmission"
          | "AH12AfterSettleCommandCommit";
        readonly executionId: ExecutionId;
        readonly fencingGeneration: LeaseGeneration;
        readonly commandId: string;
      }
    | {
        readonly boundary:
          | "AH10BeforeSubmittedDecisionBindingFactCommit"
          | "AH10AfterSubmittedDecisionBindingFactCommit";
        readonly executionId: ExecutionId;
        readonly fencingGeneration: LeaseGeneration;
        readonly providerTurnId: string;
        readonly logicalActionId: string;
        readonly failureCode: string;
      },
) => Promise<void>;

/** Test-child-only seam for proving real lease takeover without editing the
 * durable lease. Production Composition leaves this probe absent. */
export type ExecutionLeaseQualificationProbe = (
  event:
    | {
        readonly boundary: "AH10BeforeLeaseRenewal" | "AH10AfterLeaseAcquired";
        readonly executionId: ExecutionId;
        readonly workerId?: string;
        readonly workerIncarnationId?: string;
        readonly fencingGeneration: LeaseGeneration;
      }
    | {
        readonly boundary: "AH10BeforeLeaseAcquired";
        readonly executionId: ExecutionId;
      }
    | {
        /** Scheduler observed a live lease and skipped before runExecution. */
        readonly boundary: "AH10PreDispatchSkippedLiveLease";
        readonly executionId: ExecutionId;
      }
    | {
        /** Emitted only after this process's real LeaseService.acquire call rejects. */
        readonly boundary: "AH10LeaseAcquisitionRejected";
        readonly executionId: ExecutionId;
        readonly workerId: string;
        readonly workerIncarnationId: string;
        readonly fencingGeneration: LeaseGeneration;
      },
) => Promise<void>;

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

/** P2 pre-dispatch check. P4 still performs the final currentness check at
 * effect admission; this earlier guard prevents a known-stale policy from
 * acquiring a lease or dispatching a Worker. */
const sandboxPolicyDecisionIsCurrentForRequirement = (input: {
  readonly execution: Execution;
  readonly requirement: import("@arbor/ports").SandboxPolicyRequirementV1;
  readonly committed: CommittedSandboxPolicyDecisionV1;
  readonly authority: SandboxAuthorityBundleSnapshotV2;
  readonly now: string;
}): boolean => {
  const { execution, requirement, committed, authority } = input;
  const decision = committed.decision;
  const result: SandboxPolicyDecisionCommittedInternalV1 = committed.result;
  const snapshot = result.effectivePolicySnapshot;
  const currentEpisode = executionEpisode(execution);
  if (currentEpisode === undefined) return false;
  const episodeJson = encodeExecutionEpisodeBinding(currentEpisode);
  const bundle = authority.bundle;
  const commonCurrent =
    execution.projectId === requirement.projectId &&
    execution.workspaceId === requirement.workspaceId &&
    execution.executionId === requirement.executionId &&
    encodeExecutionEpisodeBinding(requirement.episodeBinding) === episodeJson &&
    decision.projectId === requirement.projectId &&
    decision.workspaceId === requirement.workspaceId &&
    decision.executionId === requirement.executionId &&
    encodeExecutionEpisodeBinding(decision.episodeBinding) === episodeJson &&
    decision.expectedExecutionRevision ===
      requirement.expectedEpisodeRevision &&
    result.commandId === decision.decisionCommandId &&
    result.projectId === decision.projectId &&
    result.workspaceId === decision.workspaceId &&
    result.executionId === decision.executionId &&
    encodeExecutionEpisodeBinding(result.episodeBinding) === episodeJson &&
    result.policyRevision === decision.policyRevision &&
    result.policyDigest === decision.policyDigest &&
    snapshot.projectId === decision.projectId &&
    snapshot.workspaceId === decision.workspaceId &&
    snapshot.executionId === decision.executionId &&
    encodeExecutionEpisodeBinding(snapshot.episodeBinding) === episodeJson &&
    snapshot.policyRevision === decision.policyRevision &&
    snapshot.expiresAt === decision.expiresAt &&
    Date.parse(decision.expiresAt) > Date.parse(input.now) &&
    snapshot.authorityBundleRevision === bundle.bundleRevision &&
    snapshot.authorityBundleDigest === authority.bundleDigest;
  if (!commonCurrent) return false;

  if (snapshot.kind === "TrustedLocalUnconfinedV1") {
    const trustedMatches =
      snapshot.trustedRuntimeIdentity === "TrustedLocal" &&
      snapshot.trustedRuntimeVersion === "builtin-v1" &&
      snapshot.profile === "FullAccess" &&
      snapshot.networkBoundary === "Unconfined" &&
      decision.providerId === "TrustedLocal" &&
      decision.profile === "FullAccess" &&
      decision.networkPolicy.kind === "TrustedLocalUnconfinedV1" &&
      decision.networkPolicy.version === 1;
    return trustedMatches;
  }

  return (
    decision.providerId === snapshot.providerId &&
    decision.profile === snapshot.profile &&
    decision.networkPolicy.kind === "OsEnforced" &&
    JSON.stringify(decision.networkPolicy.policy) ===
      JSON.stringify(snapshot.networkPolicy) &&
    snapshot.providerRegistryRevision === bundle.providerRegistryRevision &&
    snapshot.providerRegistryDigest === bundle.providerRegistryDigest
  );
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

/** P2 `03` §7 / P9 `03` §1: the renewal CAS failed (stale generation / no
 * live lease) — the worker lost ownership, must stop durable mutation and
 * must not ordinary-retry. */
export interface LeaseLost {
  readonly _tag: "LeaseLost";
  readonly executionId: ExecutionId;
  readonly generation: LeaseGeneration;
}

/** One renewal CAS on (worker_id, generation) extending `expires_at`;
 * generation UNCHANGED, no new lease row identity (P2 `03` §2). A fencing
 * rejection maps to the local `LeaseLost`. */
export const renewLeaseOnce = (
  executionId: ExecutionId,
  workerId: string,
  workerIncarnationId: string,
  generation: LeaseGeneration,
): Effect.Effect<
  LeaseRecord,
  LeaseLost | ExecutionRepositoryError | TransactionOperationalFailure,
  TransactionPort | LeaseService
> =>
  Effect.gen(function* () {
    const tx = yield* TransactionPort;
    const leases = yield* LeaseService;
    return yield* tx
      .transact(
        leases.renew(executionId, workerId, workerIncarnationId, generation),
      )
      .pipe(
        Effect.mapError(
          (
            error,
          ):
            | LeaseLost
            | ExecutionRepositoryError
            | TransactionOperationalFailure =>
            error._tag === "LeaseFencingRejected"
              ? { _tag: "LeaseLost", executionId, generation }
              : error,
        ),
      );
  });

/** P9 `03` §1: the renewal loop — every TTL/3 during a drive; bounded by
 * the drive lifetime (raced against it), never an independent daemon
 * thread. A drive shorter than one interval needs no renewal. */
export const leaseRenewalLoop = (
  executionId: ExecutionId,
  workerId: string,
  workerIncarnationId: string,
  generation: LeaseGeneration,
  intervalMs: number = LEASE_RENEW_INTERVAL_MS,
  qualificationProbe?: ExecutionLeaseQualificationProbe,
): Effect.Effect<
  never,
  LeaseLost | ExecutionRepositoryError | TransactionOperationalFailure,
  TransactionPort | LeaseService
> =>
  Effect.forever(
    Effect.gen(function* () {
      yield* Effect.sleep(intervalMs);
      if (qualificationProbe !== undefined) {
        yield* Effect.promise(() =>
          qualificationProbe({
            boundary: "AH10BeforeLeaseRenewal",
            executionId,
            fencingGeneration: generation,
          }),
        );
      }
      yield* renewLeaseOnce(
        executionId,
        workerId,
        workerIncarnationId,
        generation,
      );
    }),
  );

/**
 * Orchestration: durable admission already exists; dispatch, acquire a lease,
 * drive, and persist the driver's settlement proposal through the command
 * pipeline (ExecutionOrigin, fenced).
 */
export const runExecution = (
  executionId: ExecutionId,
  wakeReason: WakeReason,
  principal: Principal,
  renewIntervalMs: number = LEASE_RENEW_INTERVAL_MS,
  qualificationProbe?: ExecutionSettlementQualificationProbe,
  leaseQualificationProbe?: ExecutionLeaseQualificationProbe,
) =>
  Effect.gen(function* () {
    const tx = yield* TransactionPort;
    const repository = yield* ExecutionRepository;
    const states = yield* AgentExecutionStateStore;
    const leases = yield* LeaseService;
    const dispatch = yield* WorkerDispatchPort;
    const driver = yield* ExecutionDriverPort;
    const safety = yield* RuntimeSafetyGate;
    const recoveryAttentionFacts = yield* RecoveryAttentionFactStore;
    const sandboxUnavailableStore = yield* Effect.serviceOption(
      SandboxProviderUnavailableStore,
    );
    const sandboxPolicyDecisions = yield* Effect.serviceOption(
      SandboxPolicyDecisionStore,
    );
    const sandboxPolicyRequirements = yield* Effect.serviceOption(
      SandboxPolicyRequirementReadPort,
    );
    const currentAuthoritySnapshotPort = yield* Effect.serviceOption(
      CurrentSandboxAuthoritySnapshotPort,
    );
    const loopSteps = yield* Effect.serviceOption(AgentLoopStepStore);
    const attentionProjection = yield* Effect.serviceOption(
      AttentionProjectionStore,
    );
    const p39RecoveryEvidence = yield* Effect.serviceOption(
      P39RecoveryEvidenceStore,
    );
    const providerTurns = yield* Effect.serviceOption(ProviderTurnStore);
    const sessions = yield* Effect.serviceOption(SessionRepository);
    const decisions = yield* Effect.serviceOption(DecisionRequestStore);
    const reconciliation = yield* Effect.serviceOption(ReconciliationSource);
    const gateway = yield* CommandGateway;
    const clock = yield* Clock;
    const controlApprovals = yield* ControlApprovalStore;
    const executableApprovals = yield* ExecutableApprovalStore;

    const { execution, pendingApproval, pendingControlApproval } =
      yield* tx.transact(
        Effect.gen(function* () {
          const execution = yield* repository.findById(executionId);
          const pendingControlApproval =
            yield* controlApprovals.findPendingForExecution(executionId);
          const pendingApproval =
            yield* executableApprovals.findPendingForExecution(executionId);
          return { execution, pendingApproval, pendingControlApproval };
        }),
      );
    if (Option.isNone(execution)) {
      return yield* Effect.fail({ _tag: "ExecutionNotFound" as const });
    }
    if (Option.isSome(sandboxPolicyRequirements)) {
      const pendingRequirement = yield* tx.transact(
        sandboxPolicyRequirements.value.findPendingByExecution({
          projectId: execution.value.projectId,
          workspaceId: execution.value.workspaceId,
          executionId,
        }),
      );
      let policyMustWaitForHuman = false;
      if (Option.isSome(pendingRequirement)) {
        const currentAuthority = Option.isSome(currentAuthoritySnapshotPort)
          ? yield* currentAuthoritySnapshotPort.value.loadCurrentVerifiedV2()
          : { _tag: "Unavailable" as const, failure: "SourceMissing" as const };
        const now = yield* clock.now();
        policyMustWaitForHuman = yield* tx.transact(
          Effect.gen(function* () {
            // Re-read the exact proof after the effectful P5 source/high-water
            // load. This closes a requirement change during that read window.
            const requirement =
              yield* sandboxPolicyRequirements.value.findPendingByExecution({
                projectId: execution.value.projectId,
                workspaceId: execution.value.workspaceId,
                executionId,
              });
            if (Option.isNone(requirement)) return false;
            if (
              currentAuthority._tag !== "Available" ||
              Option.isNone(sandboxPolicyDecisions)
            ) {
              return true;
            }
            const current =
              yield* sandboxPolicyDecisions.value.findCurrentForExecution(
                execution.value.projectId,
                execution.value.workspaceId,
                executionId,
              );
            if (Option.isNone(current)) return true;
            return !sandboxPolicyDecisionIsCurrentForRequirement({
              execution: execution.value,
              requirement: requirement.value,
              committed: current.value,
              authority: currentAuthority.snapshot,
              now,
            });
          }),
        );
      }
      if (policyMustWaitForHuman) {
        return { _tag: "RecoveryBlocked" as const };
      }
    }
    if (
      Option.isSome(attentionProjection) &&
      Option.isSome(p39RecoveryEvidence) &&
      attentionProjection.value.listSandboxPolicyDecisionRequired !== undefined
    ) {
      const now = yield* clock.now();
      const required = yield* tx.transact(
        attentionProjection.value.listSandboxPolicyDecisionRequired(
          execution.value.projectId,
          now,
        ),
      );
      if (required.some((item) => item.executionId === executionId)) {
        return { _tag: "RecoveryBlocked" as const };
      }
    }
    if (
      Option.isSome(sandboxUnavailableStore) &&
      Option.isSome(sandboxPolicyDecisions)
    ) {
      const currentPolicy = yield* tx.transact(
        sandboxPolicyDecisions.value.findCurrentForExecution(
          execution.value.projectId,
          execution.value.workspaceId,
          executionId,
        ),
      );
      if (Option.isSome(currentPolicy)) {
        const decision = currentPolicy.value.decision;
        const snapshot = currentPolicy.value.result.effectivePolicySnapshot;
        const fact = yield* tx.transact(
          sandboxUnavailableStore.value.findByExecutionAndRevision(
            executionId,
            decision.policyRevision,
          ),
        );
        if (fact !== undefined) {
          if (
            snapshot.kind !== "OsEnforced" ||
            fact.projectId !== decision.projectId ||
            fact.workspaceId !== decision.workspaceId ||
            encodeExecutionEpisodeBinding(fact.episodeBinding) !==
              encodeExecutionEpisodeBinding(decision.episodeBinding) ||
            fact.policyDigest !== decision.policyDigest ||
            fact.profileId !== snapshot.profile ||
            fact.providerId !== snapshot.providerId ||
            fact.providerVersion !== snapshot.providerVersion
          ) {
            return yield* Effect.fail({
              _tag: "SandboxProviderUnavailableFactInvariantConflict" as const,
              reason:
                "current policy head conflicts with its immutable unavailable fact",
            });
          }
          return { _tag: "RecoveryBlocked" as const };
        }
      }
    }
    // P2 `06` §10: Pending approval is a durable nonterminal pause. Every
    // execution entry point shares this trusted gate before dispatch or lease
    // acquisition; only a committed resolution can re-enter the same Step.
    if (
      Option.isSome(pendingControlApproval) ||
      Option.isSome(pendingApproval)
    ) {
      const pending = Option.isSome(pendingControlApproval)
        ? pendingControlApproval.value
        : Option.getOrThrow(pendingApproval);
      return {
        _tag: "ApprovalRequired" as const,
        approvalId: pending.approvalId,
        revision: pending.revision,
      };
    }
    yield* dispatch.dispatch({
      executionId,
      workspaceId: execution.value.workspaceId,
      workerKind: "Agent",
    });
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
        const episode = executionEpisodeIdentity(execution.value);
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
    const submittedDecisionEpisode = executionEpisode(execution.value);
    const submittedDecisionStopRecovery =
      execution.value.stopRequestedAt !== null &&
      submittedDecisionEpisode?._tag === "DecisionEpisode";
    const submittedDecisionBindingAvailable =
      submittedDecisionStopRecovery &&
      recoveryAttentionFacts.isSubmittedDecisionBindingAvailable !== undefined
        ? yield* tx.transact(
            recoveryAttentionFacts.isSubmittedDecisionBindingAvailable(),
          )
        : false;
    const submittedDecisionBindingFacts =
      submittedDecisionBindingAvailable &&
      recoveryAttentionFacts.listSubmittedDecisionBindingFailures !== undefined
        ? yield* tx.transact(
            recoveryAttentionFacts.listSubmittedDecisionBindingFailures(
              execution.value.projectId,
            ),
          )
        : [];
    if (
      submittedDecisionBindingFacts.some(
        (fact) => fact.executionId === executionId,
      )
    ) {
      yield* tx
        .transact(
          leases.release(
            executionId,
            lease.workerId,
            lease.workerIncarnationId,
            lease.generation,
          ),
        )
        .pipe(Effect.ignore);
      return { _tag: "RecoveryBlocked" as const };
    }
    // P9 `03` §1: race the drive against the renewal loop — the first to
    // complete wins; a lost renewal (LeaseLost) interrupts the drive so no
    // durable mutation is attempted, and no ordinary retry occurs.
    const outcome = yield* Effect.raceFirst(
      driver.drive({
        execution: execution.value,
        agentExecutionState,
        wakeReason,
        context: {
          _tag: "ExecutionOrigin",
          principal,
          executionId,
          fencingGeneration: lease.generation,
          workerId: lease.workerId,
          workerIncarnationId: lease.workerIncarnationId,
        },
        safetyGate: safety,
      }),
      leaseRenewalLoop(
        executionId,
        lease.workerId,
        lease.workerIncarnationId,
        lease.generation,
        renewIntervalMs,
        leaseQualificationProbe,
      ),
    ).pipe(
      Effect.catchTag(
        "ExecutionDriverOwnershipLost",
        (lost: ExecutionDriverOwnershipLost) =>
          Effect.fail<LeaseFencingRejected>({
            _tag: "LeaseFencingRejected",
            executionId: lost.executionId,
            generation: lost.generation,
          }),
      ),
    );

    // The background loop keeps a long drive live. Renew once more at the
    // durability boundary so a scheduler delay around the final tick cannot
    // turn an otherwise owned, completed drive into a stale fenced write.
    // This is still the same owner/generation CAS: a takeover is reported as
    // LeaseLost and prevents the settlement command below.
    yield* renewLeaseOnce(
      executionId,
      lease.workerId,
      lease.workerIncarnationId,
      lease.generation,
    );
    if (outcome._tag === "SubmittedDecisionBindingMismatch") {
      const detectedAt = yield* clock.now();
      const recordBindingFailure =
        recoveryAttentionFacts.recordSubmittedDecisionBindingFailure;
      const submittedDecisionBindingAvailable =
        recoveryAttentionFacts.isSubmittedDecisionBindingAvailable === undefined
          ? false
          : yield* tx.transact(
              recoveryAttentionFacts.isSubmittedDecisionBindingAvailable(),
            );
      if (
        recordBindingFailure !== undefined &&
        submittedDecisionBindingAvailable
      ) {
        yield* tx.transact(
          Effect.gen(function* () {
            // Revalidate the complete lease tuple in the same transaction as
            // the immutable P9 fact and event write.
            yield* leases.renew(
              executionId,
              lease.workerId,
              lease.workerIncarnationId,
              lease.generation,
            );
            const current = yield* repository.findById(executionId);
            if (
              Option.isNone(current) ||
              current.value.projectId !== execution.value.projectId ||
              current.value.workspaceId !== execution.value.workspaceId
            ) {
              return;
            }
            yield* recordSubmittedDecisionBindingFailure(
              recoveryAttentionFacts,
              {
                projectId: execution.value.projectId,
                executionId,
                workspaceId: current.value.workspaceId,
                logicalStepNo: outcome.logicalStepNo,
                repairAttempt: outcome.repairAttempt,
                providerTurnId: outcome.providerTurnId,
                logicalActionId: outcome.logicalActionId,
                failureCode: outcome.failureCode,
                firstDetectedAt: detectedAt,
                causedByCommandId: null,
              },
            );
            if (qualificationProbe !== undefined) {
              yield* Effect.promise(() =>
                qualificationProbe({
                  boundary: "AH10BeforeSubmittedDecisionBindingFactCommit",
                  executionId,
                  fencingGeneration: lease.generation,
                  providerTurnId: outcome.providerTurnId,
                  logicalActionId: outcome.logicalActionId,
                  failureCode: outcome.failureCode,
                }),
              );
            }
            if (
              Option.isNone(current) ||
              current.value.stopRequestedAt === null ||
              current.value.state.status !== "Active" ||
              !Option.isSome(loopSteps) ||
              !Option.isSome(providerTurns) ||
              !Option.isSome(sessions) ||
              !Option.isSome(decisions) ||
              !Option.isSome(reconciliation)
            ) {
              return;
            }
            const unresolved = yield* reconciliation.value.pending(executionId);
            if (unresolved.length > 0) return;
            const currentEpisode = executionEpisode(current.value);
            if (currentEpisode?._tag !== "DecisionEpisode") return;
            const request = yield* decisions.value.findById(
              currentEpisode.decisionId,
            );
            const identity = {
              executionId,
              logicalStepNo: outcome.logicalStepNo,
              repairAttempt: outcome.repairAttempt,
            };
            const foundStep = yield* loopSteps.value.find(identity);
            if (Option.isNone(foundStep)) return;
            const step = foundStep.value;
            if (
              step.providerTurnId !== outcome.providerTurnId ||
              step.state !== "ActionsInProgress"
            ) {
              return;
            }
            const existingActions = yield* loopSteps.value.listActions(
              step.identity,
            );
            const currentAction = existingActions.find(
              (action) => action.actionIndex === step.nextActionIndex,
            );
            if (
              currentAction?.logicalActionId !== outcome.logicalActionId ||
              currentAction.state !== "Pending"
            ) {
              return;
            }
            const providerResult = yield* providerTurns.value.findSettledResult(
              step.providerTurnId,
            );
            if (
              outcome.failureCode === "DecisionRequestWorkspaceMismatch" &&
              (Option.isNone(request) ||
                request.value.state._tag !== "Submitted" ||
                request.value.workspaceId === current.value.workspaceId ||
                request.value.revision !== currentEpisode.requestRevision + 1 ||
                !request.value.candidateWorkIds.includes(
                  request.value.state.selectedWorkId,
                ))
            ) {
              return;
            }
            if (
              outcome.failureCode === "StepManifestMismatch" &&
              (providerResult._tag !== "SettledSuccess" ||
                providerResult.manifestId === step.manifestId)
            ) {
              return;
            }
            const outputEntries =
              step.modelOutputSessionSequence === undefined
                ? []
                : yield* sessions.value.listEntries(
                    current.value.sessionId,
                    step.modelOutputSessionSequence - 1,
                    1,
                  );
            const actionIdentities =
              reconstructSubmittedDecisionStopCloseActions({
                executionId: String(executionId),
                sessionId: String(current.value.sessionId),
                step,
                providerResult,
                modelOutputEntry: outputEntries[0],
                existingActions,
              });
            if (actionIdentities === undefined) return;
            const plan = planSubmittedDecisionStopClose({
              step,
              actions: actionIdentities,
              firstDetectedActionId: outcome.logicalActionId,
              updatedAt: detectedAt,
            });
            if (plan._tag !== "Ready") return;
            const fence = {
              executionId,
              workerId: lease.workerId,
              workerIncarnationId: lease.workerIncarnationId,
              fencingGeneration: lease.generation,
            };
            for (const nextAction of plan.actions) {
              const existing = existingActions.find(
                (action) => action.actionIndex === nextAction.actionIndex,
              );
              if (existing === undefined) {
                yield* loopSteps.value.createAction(nextAction, fence);
              } else {
                yield* loopSteps.value.transitionAction(
                  {
                    identity: existing.identity,
                    actionIndex: existing.actionIndex,
                    expectedRevision: existing.revision,
                    expectedState: "Pending",
                    next: nextAction,
                  },
                  fence,
                );
              }
            }
            yield* loopSteps.value.transition(
              {
                identity: step.identity,
                expectedRevision: step.revision,
                expectedState: "ActionsInProgress",
                next: plan.step,
              },
              fence,
            );
          }),
        );
        if (qualificationProbe !== undefined) {
          yield* Effect.promise(() =>
            qualificationProbe({
              boundary: "AH10AfterSubmittedDecisionBindingFactCommit",
              executionId,
              fencingGeneration: lease.generation,
              providerTurnId: outcome.providerTurnId,
              logicalActionId: outcome.logicalActionId,
              failureCode: outcome.failureCode,
            }),
          );
        }
      }
      yield* tx
        .transact(
          leases.release(
            executionId,
            lease.workerId,
            lease.workerIncarnationId,
            lease.generation,
          ),
        )
        .pipe(Effect.ignore);
      return { _tag: "RecoveryBlocked" as const };
    }
    if (
      outcome._tag === "ApprovalRequired" ||
      outcome._tag === "RecoveryBlocked" ||
      outcome._tag === "SandboxPolicyRequiredInterruption"
    ) {
      yield* tx
        .transact(
          leases.release(
            executionId,
            lease.workerId,
            lease.workerIncarnationId,
            lease.generation,
          ),
        )
        .pipe(Effect.ignore);
      return outcome;
    }
    if (outcome._tag === "SandboxProviderUnavailable") {
      if (
        Option.isNone(sandboxUnavailableStore) ||
        Option.isNone(sandboxPolicyDecisions)
      ) {
        return yield* Effect.fail({
          _tag: "PersistenceUnavailable" as const,
          repository: "SandboxProviderUnavailableStore" as const,
          operation: "provider-unavailable-outcome",
          retryDisposition: "non-retryable" as const,
          sourceTag: "P50StoreUnavailable",
          cause: { _tag: "P50StoreUnavailable" },
        });
      }
      const detectedAt = yield* clock.now();
      yield* tx.transact(
        Effect.gen(function* () {
          yield* leases.renew(
            executionId,
            lease.workerId,
            lease.workerIncarnationId,
            lease.generation,
          );
          const current = yield* repository.findById(executionId);
          if (
            Option.isNone(current) ||
            current.value.projectId !== outcome.outcome.projectId ||
            current.value.workspaceId !== outcome.outcome.workspaceId ||
            current.value.state.status !== "Active" ||
            current.value.stopRequestedAt !== null
          ) {
            return yield* Effect.fail({
              _tag: "SandboxProviderUnavailableFactInvariantConflict" as const,
              reason:
                "provider unavailable outcome no longer binds the active Execution",
            });
          }
          const sourceAction = outcome.outcome.actionBinding;
          if (
            Option.isNone(loopSteps) ||
            sourceAction.identity.executionId !== executionId ||
            sourceAction.invocationId.length === 0 ||
            sourceAction.logicalActionId.length === 0 ||
            sourceAction.callRef.length === 0 ||
            sourceAction.actionIndex < 0 ||
            !Number.isSafeInteger(sourceAction.actionIndex)
          ) {
            return yield* Effect.fail({
              _tag: "SandboxProviderUnavailableFactInvariantConflict" as const,
              reason:
                "provider-unavailable outcome is missing exact P3 action identity",
            });
          }
          const policy =
            yield* sandboxPolicyDecisions.value.findCurrentForExecution(
              outcome.outcome.projectId,
              outcome.outcome.workspaceId,
              outcome.outcome.executionId,
            );
          const decision = Option.isSome(policy)
            ? policy.value.decision
            : undefined;
          const snapshot = Option.isSome(policy)
            ? policy.value.result.effectivePolicySnapshot
            : undefined;
          if (
            decision === undefined ||
            snapshot?.kind !== "OsEnforced" ||
            decision.executionId !== outcome.outcome.executionId ||
            decision.policyRevision !== outcome.outcome.policyRevision ||
            decision.policyDigest !== outcome.outcome.policyDigest ||
            snapshot.profile !== outcome.outcome.profileId ||
            snapshot.providerId !== outcome.outcome.providerId ||
            snapshot.providerVersion !== outcome.outcome.providerVersion ||
            String(snapshot.capabilityRevision) !==
              outcome.outcome.capabilityRevision ||
            encodeExecutionEpisodeBinding(decision.episodeBinding) !==
              encodeExecutionEpisodeBinding(outcome.outcome.episodeBinding) ||
            decision.expiresAt <= detectedAt
          ) {
            return yield* Effect.fail({
              _tag: "SandboxProviderUnavailableFactInvariantConflict" as const,
              reason:
                "provider unavailable outcome does not match the exact current policy head",
            });
          }
          const fence = {
            executionId,
            workerId: lease.workerId,
            workerIncarnationId: lease.workerIncarnationId,
            fencingGeneration: lease.generation,
          };
          const step = yield* loopSteps.value.find(sourceAction.identity);
          if (
            Option.isNone(step) ||
            step.value.state !== "ActionsInProgress" ||
            step.value.nextActionIndex !== sourceAction.actionIndex ||
            step.value.providerTurnId !== sourceAction.providerTurnId
          ) {
            return yield* Effect.fail({
              _tag: "SandboxProviderUnavailableFactInvariantConflict" as const,
              reason:
                "provider-unavailable outcome does not match the active P3 step",
            });
          }
          const actions = yield* loopSteps.value.listActions(
            sourceAction.identity,
          );
          const action = actions.find(
            (candidate) => candidate.actionIndex === sourceAction.actionIndex,
          );
          if (
            action === undefined ||
            action.state !== "Pending" ||
            action.routeKind !== "Executable" ||
            action.logicalActionId !== sourceAction.logicalActionId ||
            action.callRef !== sourceAction.callRef
          ) {
            return yield* Effect.fail({
              _tag: "SandboxProviderUnavailableFactInvariantConflict" as const,
              reason:
                "provider-unavailable outcome does not match the exact pending P3 action",
            });
          }
          const fact = yield* sandboxUnavailableStore.value.record({
            outcome: outcome.outcome,
            fence,
            firstDetectedAt: detectedAt,
          });
          yield* loopSteps.value.transitionAction(
            {
              identity: sourceAction.identity,
              actionIndex: sourceAction.actionIndex,
              expectedRevision: action.revision,
              expectedState: "Pending",
              next: {
                ...action,
                state: "TerminalRejected",
                resultRef: fact.attentionFactId,
                disposition: {
                  _tag: "SandboxUnavailableV1",
                  attentionFactId: fact.attentionFactId,
                  invocationId: sourceAction.invocationId,
                  policyRevision: outcome.outcome.policyRevision,
                  policyDigest: outcome.outcome.policyDigest,
                  profile: outcome.outcome.profileId,
                  providerId: outcome.outcome.providerId,
                  providerVersion: outcome.outcome.providerVersion,
                  capabilityRevision: outcome.outcome.capabilityRevision,
                  probeEvidenceRef: outcome.outcome.probeEvidenceRef,
                  failureCode: outcome.outcome.failureCode,
                },
                revision: action.revision + 1,
                updatedAt: detectedAt,
              },
            },
            fence,
          );
          yield* loopSteps.value.transition(
            {
              identity: sourceAction.identity,
              expectedRevision: step.value.revision,
              expectedState: "ActionsInProgress",
              next: {
                ...step.value,
                state: "StepEffectsCommitted",
                nextActionIndex: sourceAction.actionIndex + 1,
                revision: step.value.revision + 1,
                updatedAt: detectedAt,
              },
            },
            fence,
          );
        }),
      );
      yield* tx
        .transact(
          leases.release(
            executionId,
            lease.workerId,
            lease.workerIncarnationId,
            lease.generation,
          ),
        )
        .pipe(Effect.ignore);
      return { _tag: "RecoveryBlocked" as const };
    }
    const settlement = outcome;
    const settledAt = yield* clock.now();

    const payload = {
      executionId,
      settlement,
      expectedFencingGeneration: lease.generation as LeaseGeneration,
    };
    const commandId = `cmd_settle_${executionId}_${lease.generation}` as never;
    const authority: VerifiedRuntimeCommandAuthority = {
      _tag: "SettleExecutionAuthority",
      submissionOrigin: "ExecutionOrigin",
      principal,
      commandId,
      semanticRequestFingerprint: semanticRequestFingerprint({
        commandType: "SettleExecution",
        projectId: execution.value.projectId,
        actor: principal as never,
        schemaVersion: "1",
        payload,
      }),
      projectId: execution.value.projectId,
      commandKind: "SettleExecution",
      executionId,
      fencingGeneration: lease.generation,
    };
    const context: CommandSubmissionContext = {
      _tag: "ExecutionOrigin",
      principal,
      executionId,
      fencingGeneration: lease.generation,
      workerId: lease.workerId,
      workerIncarnationId: lease.workerIncarnationId,
    };
    if (qualificationProbe !== undefined) {
      yield* Effect.promise(() =>
        qualificationProbe({
          boundary: "AH12BeforeSettleGatewaySubmission",
          executionId,
          fencingGeneration: lease.generation,
          commandId,
        }),
      );
    }
    const receipt = yield* gateway.execute(
      {
        commandType: "SettleExecution",
        commandId,
        projectId: execution.value.projectId,
        actor: principal as never,
        issuedAt: settledAt,
        payload,
      },
      context,
      authority,
    );
    if (qualificationProbe !== undefined) {
      yield* Effect.promise(() =>
        qualificationProbe({
          boundary: "AH12AfterSettleCommandCommit",
          executionId,
          fencingGeneration: lease.generation,
          commandId,
        }),
      );
    }
    if (receipt.resolution._tag === "TerminalRejected") {
      return yield* Effect.fail(
        receipt.resolution.error as unknown as CommandRejection,
      );
    }
    // P9 `03` §1 soft release: worker-initiated CAS deleting the live lease
    // row's liveness. Release never settles the Execution and never changes
    // Work lifecycle (DID §6A.6); lazy invalidation remains the only
    // lease-expiry authority — a failed release is a lost optimization, not
    // a correctness failure.
    yield* tx
      .transact(
        leases.release(
          executionId,
          lease.workerId,
          lease.workerIncarnationId,
          lease.generation,
        ),
      )
      .pipe(Effect.ignore);
    return settlement;
  });
