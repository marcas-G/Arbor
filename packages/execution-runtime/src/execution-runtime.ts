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
  CommandSubmissionContext,
  Execution,
  ExecutionId,
  LeaseGeneration,
  Principal,
  WakeReason,
} from "@arbor/domain";
import { encodeExecutionEpisodeBinding, executionEpisode } from "@arbor/domain";
import {
  AgentExecutionStateStore,
  AgentLoopStepStore,
  AttentionProjectionStore,
  Clock,
  ControlApprovalStore,
  CurrentSandboxAuthoritySnapshotPort,
  DecisionRequestStore,
  ExecutableApprovalStore,
  ExecutionDriverPort,
  ExecutionRepository,
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
  TransactionPort,
  WorkerDispatchPort,
  WorkspaceRepository,
  WorkspaceSandboxAuthorizationStore,
} from "@arbor/ports";
import { Effect, Option } from "effect";
import { claimExecutionLease } from "./execution/claim-lease.js";
import { driveWithLease } from "./execution/drive-with-lease.js";
import {
  type ExecutionLeaseQualificationProbe,
  LEASE_RENEW_INTERVAL_MS,
  renewLeaseOnce,
} from "./execution/lease.js";
import { checkExecutionPolicyBeforeDispatch } from "./execution/pre-dispatch-policy.js";
import { recordSubmittedDecisionBindingFailure } from "./submitted-decision-binding-failure.js";

export {
  type ExecutionLeaseQualificationProbe,
  LEASE_RENEW_INTERVAL_MS,
  LEASE_TTL_MS,
  type LeaseLost,
  leaseRenewalLoop,
  renewLeaseOnce,
  STOP_REQUEST_POLL_INTERVAL_MS,
  stopRequestLoop,
} from "./execution/lease.js";

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
    const workspaceAuthorizations = yield* Effect.serviceOption(
      WorkspaceSandboxAuthorizationStore,
    );
    const policyWorkspaces = yield* Effect.serviceOption(WorkspaceRepository);
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
    const policyBlock = yield* checkExecutionPolicyBeforeDispatch(
      execution.value,
      executionId,
      tx,
      clock,
      sandboxPolicyRequirements,
      currentAuthoritySnapshotPort,
      sandboxPolicyDecisions,
      workspaceAuthorizations,
      policyWorkspaces,
      attentionProjection,
      p39RecoveryEvidence,
      sandboxUnavailableStore,
    );
    if (policyBlock !== undefined) return policyBlock;
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
    const { lease, agentExecutionState } = yield* claimExecutionLease(
      execution.value,
      executionId,
      wakeReason,
      tx,
      leases,
      states,
      clock,
      leaseQualificationProbe,
    );
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
    const outcome = yield* driveWithLease(
      execution.value,
      executionId,
      agentExecutionState,
      wakeReason,
      principal,
      lease,
      driver,
      safety,
      renewIntervalMs,
      leaseQualificationProbe,
    );

    if (outcome._tag === "StopRequestedByControl") {
      // Effect interruption has already run ProviderRuntime's cancellation
      // finalizer. Do not renew or synthesize a settlement here; the recovery
      // controller must still inspect reconciliation evidence before it can
      // commit Interrupted(StopRequested).
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
      const rejection: CommandRejection = receipt.resolution.error;
      return yield* Effect.fail(rejection);
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
