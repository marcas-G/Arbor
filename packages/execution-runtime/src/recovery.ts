import {
  planSubmittedDecisionStopClose,
  reconstructSubmittedDecisionStopCloseActions,
} from "@arbor/agent-runtime";
import {
  CommandGateway,
  newUuid7,
  semanticRequestFingerprint,
  type VerifiedRuntimeCommandAuthority,
} from "@arbor/application";
import {
  CommandId,
  type DomainEvent,
  type ExecutionId,
  type ExecutionSettlement,
  executionEpisode,
  type Principal,
  parse,
  type WorkSelectionDecisionRequest,
} from "@arbor/domain";
import {
  type AgentLoopStepActionRecord,
  type AgentLoopStepRecord,
  AgentLoopStepStore,
  Clock,
  DecisionRequestStore,
  DomainEventJournal,
  ExecutionRepository,
  type LeaseRecord,
  LeaseService,
  ProviderTurnStore,
  ReconciliationSource,
  RecoveryAttentionFactStore,
  SessionRepository,
  TransactionPort,
} from "@arbor/ports";
import { Effect, Layer, Option } from "effect";
import { recordSubmittedDecisionBindingFailure } from "./submitted-decision-binding-failure.js";

export interface RecoveryResult {
  readonly invalidated: number;
  readonly settled: ReadonlyArray<string>;
  readonly escalated: ReadonlyArray<string>;
}

/** P9 `01` §2 (B-2): a durable completion fact — an `ExecutionSettled`
 * event whose payload settlement is `Completed(...)` persisted in the
 * settlement trace — settles to the corresponding Completed form, never a
 * guess, never a downgrade. */
const completionFact = (
  events: ReadonlyArray<DomainEvent<unknown>>,
  executionId: ExecutionId,
): ExecutionSettlement | null => {
  for (const event of events) {
    if (
      event.eventType !== "ExecutionSettled" ||
      event.aggregateRef !== executionId
    ) {
      continue;
    }
    const settlement = (
      event.payload as { settlement?: { readonly _tag?: unknown } }
    ).settlement;
    if (
      typeof settlement === "object" &&
      settlement !== null &&
      settlement._tag === "Completed"
    ) {
      return settlement as ExecutionSettlement;
    }
  }
  return null;
};

const recoveryCommandId = (
  executionId: ExecutionId,
  branch: "completion" | "stop",
): CommandId =>
  parse(CommandId)(`cmd_${newUuid7("recovery", `${executionId}:${branch}`)}`);

const RECOVERY_WORKER_ID = "worker:recovery-controller";
const RECOVERY_WORKER_INCARNATION_ID = "wic_recovery_controller";

export const classifySettledDecisionPendingActionAudit = (input: {
  readonly executionId: string;
  readonly executionWorkspaceId: string;
  readonly decisionRequestRevision: number;
  readonly step: AgentLoopStepRecord;
  readonly action: AgentLoopStepActionRecord;
  readonly request: WorkSelectionDecisionRequest | undefined;
  readonly settledProviderManifestId: string | undefined;
}):
  | "DecisionRequestWorkspaceMismatch"
  | "StepManifestMismatch"
  | "SettledExecutionWithPendingDecisionAction"
  | undefined => {
  const { step, action, request } = input;
  if (
    step.identity.executionId !== input.executionId ||
    step.state !== "ActionsInProgress" ||
    action.identity.executionId !== input.executionId ||
    action.identity.logicalStepNo !== step.identity.logicalStepNo ||
    action.identity.repairAttempt !== step.identity.repairAttempt ||
    action.actionIndex !== step.nextActionIndex ||
    action.routeKind !== "Control" ||
    action.actionKind !== "select_current_work" ||
    action.state !== "Pending"
  ) {
    return undefined;
  }
  if (
    request !== undefined &&
    request.state._tag === "Submitted" &&
    request.revision === input.decisionRequestRevision + 1 &&
    request.workspaceId !== input.executionWorkspaceId
  ) {
    return "DecisionRequestWorkspaceMismatch";
  }
  if (
    input.settledProviderManifestId !== undefined &&
    input.settledProviderManifestId !== step.manifestId
  ) {
    return "StepManifestMismatch";
  }
  return "SettledExecutionWithPendingDecisionAction";
};

/**
 * Deterministic Execution-boundary recovery (P2 `06` §2–§6).
 * Invalidates expired leases; settles only deterministic outcomes via
 * `SettleExecution` with `RecoveryController` authority; never blindly
 * replays an uncertain case.
 */
/** Crash-restart edge: the previous daemon died mid-flight holding the
 * lease. A fenced settle means the lease is still live — lazy lease expiry
 * owns the takeover; a fenced execution must never crash the daemon. */
const fencedTakeover = (error: unknown): boolean =>
  typeof error === "object" &&
  error !== null &&
  ((error as { readonly _tag?: unknown })._tag === "LeaseFencingRejected" ||
    JSON.stringify(error).includes("LeaseFencingRejected"));

export const runRecovery = (principal: Principal) =>
  Effect.gen(function* () {
    const tx = yield* TransactionPort;
    const repository = yield* ExecutionRepository;
    const leases = yield* LeaseService;
    const reconciliation = yield* ReconciliationSource;
    const recoveryAttentionFacts = yield* Effect.serviceOption(
      RecoveryAttentionFactStore,
    );
    const loopSteps = yield* Effect.serviceOption(AgentLoopStepStore);
    const providerTurns = yield* Effect.serviceOption(ProviderTurnStore);
    const sessions = yield* Effect.serviceOption(SessionRepository);
    const decisionRequests = yield* Effect.serviceOption(DecisionRequestStore);
    const gateway = yield* CommandGateway;
    const clock = yield* Clock;
    const journal = yield* DomainEventJournal;

    const now = yield* clock.now();
    const invalidated = yield* tx.transact(leases.invalidateExpired(now));
    const submittedDecisionBindingAvailable =
      Option.isSome(recoveryAttentionFacts) &&
      recoveryAttentionFacts.value.isSubmittedDecisionBindingAvailable !==
        undefined
        ? yield* tx.transact(
            recoveryAttentionFacts.value.isSubmittedDecisionBindingAvailable(),
          )
        : false;
    const unsettled = yield* tx.transact(repository.findUnsettledExecutions());

    const settled: string[] = [];
    const escalated: string[] = [];
    for (const execution of unsettled) {
      const events = yield* tx.transact(
        journal.readAfter(execution.projectId, 0, 1_000_000),
      );
      const completion = completionFact(events, execution.executionId);
      if (completion !== null) {
        // B-2 deterministic settle: RecoveryController authority path with
        // the deterministic commandId f("recovery", executionId,
        // "completion"); idempotent replay returns the existing receipt.
        const payload = {
          executionId: execution.executionId,
          settlement: completion,
        };
        const commandId = recoveryCommandId(
          execution.executionId,
          "completion",
        );
        const authority: VerifiedRuntimeCommandAuthority = {
          _tag: "SettleExecutionAuthority",
          submissionOrigin: "RecoveryController",
          principal,
          commandId,
          semanticRequestFingerprint: semanticRequestFingerprint({
            commandType: "SettleExecution",
            projectId: execution.projectId,
            actor: principal as never,
            schemaVersion: "1",
            payload,
          }),
          projectId: execution.projectId,
          commandKind: "SettleExecution",
          executionId: execution.executionId,
        };
        const receipt = yield* Effect.match(
          gateway.execute(
            {
              commandType: "SettleExecution",
              commandId,
              projectId: execution.projectId,
              actor: principal as never,
              issuedAt: now,
              payload,
            },
            { _tag: "RecoveryController", principal, causationRef: "recovery" },
            authority,
          ),
          {
            onFailure: (error) => ({ ok: false as const, error }),
            onSuccess: (value) => ({ ok: true as const, value }),
          },
        );
        if (!receipt.ok) {
          if (fencedTakeover(receipt.error)) {
            continue; // lazy lease expiry owns the takeover; next pass settles
          }
          return yield* Effect.fail(receipt.error);
        }
        settled.push(execution.executionId);
        continue;
      }
      if (execution.stopRequestedAt === null) {
        continue;
      }
      const pending = yield* tx.transact(
        reconciliation.pending(execution.executionId),
      );
      if (pending.length > 0) {
        escalated.push(execution.executionId);
        // P9 `01` §1.2 / `04` §1: durable Attention fact — dedup key
        // executionId + invocationRefs fingerprint; repeated passes are
        // no-ops (INSERT OR IGNORE semantics via journal idempotency key).
        const fingerprint = pending
          .map((ref) =>
            String((ref as { invocationId?: unknown }).invocationId ?? ref),
          )
          .sort()
          .join(",");
        // P9 `01` §1.2 / `04` §1: dedup key executionId + invocationRefs
        // fingerprint — repeated passes mint no new facts.
        const alreadyFact = events.some(
          (event) =>
            event.eventType === "ReconciliationEscalated" &&
            event.aggregateRef === execution.executionId &&
            (event.payload as { invocationRefsFingerprint?: string })
              .invocationRefsFingerprint === fingerprint,
        );
        if (!alreadyFact) {
          yield* tx.transact(
            journal.append([
              {
                projectId: execution.projectId,
                eventType: "ReconciliationEscalated",
                eventVersion: 1,
                occurredAt: now,
                aggregateRef: execution.executionId,
                actor: principal as never,
                payload: {
                  executionId: execution.executionId,
                  invocationRefsFingerprint: fingerprint,
                  refs: pending,
                },
              } as never,
            ]),
          );
        }
      }
      const submittedDecisionBindingFacts =
        Option.isSome(recoveryAttentionFacts) &&
        submittedDecisionBindingAvailable
          ? yield* tx.transact(
              recoveryAttentionFacts.value.listSubmittedDecisionBindingFailures?.(
                execution.projectId,
              ) ?? Effect.succeed([]),
            )
          : [];
      let submittedDecisionBindingFact = submittedDecisionBindingFacts.find(
        (fact) => fact.executionId === execution.executionId,
      );
      if (
        submittedDecisionBindingFact === undefined &&
        execution.stopRequestedAt !== null &&
        loopSteps._tag === "Some" &&
        providerTurns._tag === "Some" &&
        decisionRequests._tag === "Some"
      ) {
        const episode = executionEpisode(execution);
        if (episode?._tag === "DecisionEpisode") {
          const stepOption = yield* tx.transact(
            loopSteps.value.findCurrent(execution.executionId),
          );
          if (Option.isSome(stepOption)) {
            const step = stepOption.value;
            const actions = yield* tx.transact(
              loopSteps.value.listActions(step.identity),
            );
            const cursorAction = actions.find(
              (action) => action.actionIndex === step.nextActionIndex,
            );
            if (
              step.state === "ActionsInProgress" &&
              cursorAction?.routeKind === "Control" &&
              cursorAction.actionKind === "select_current_work" &&
              cursorAction.state === "Pending"
            ) {
              const request = yield* tx.transact(
                decisionRequests.value.findById(episode.decisionId),
              );
              let failureCode:
                | "DecisionRequestWorkspaceMismatch"
                | "StepManifestMismatch"
                | undefined;
              if (
                Option.isSome(request) &&
                request.value.state._tag === "Submitted" &&
                request.value.revision === episode.requestRevision + 1 &&
                request.value.workspaceId !== execution.workspaceId
              ) {
                failureCode = "DecisionRequestWorkspaceMismatch";
              } else {
                const providerResult = yield* tx.transact(
                  providerTurns.value.findSettledResult(step.providerTurnId),
                );
                if (
                  providerResult._tag === "SettledSuccess" &&
                  providerResult.manifestId !== step.manifestId
                ) {
                  failureCode = "StepManifestMismatch";
                }
              }
              if (failureCode !== undefined) {
                // P2's generic Stop settlement is safe only after the P41
                // Submitted DecisionEpisode handoff has closed its exact
                // pending action. Without the immutable P9 fact source, we
                // cannot atomically record that fact and apply the P3 close
                // plan, so leave this execution active for recovery rather
                // than stranding the Step/Action behind a settled Execution.
                if (!submittedDecisionBindingAvailable) {
                  escalated.push(execution.executionId);
                  continue;
                }
                submittedDecisionBindingFact = {
                  attentionFactId: "",
                  eventId: "",
                  projectId: execution.projectId,
                  executionId: execution.executionId,
                  workspaceId: execution.workspaceId,
                  logicalStepNo: step.identity.logicalStepNo,
                  repairAttempt: step.identity.repairAttempt,
                  providerTurnId: step.providerTurnId,
                  logicalActionId: cursorAction.logicalActionId,
                  failureCode,
                  firstDetectedAt: now,
                };
              }
            }
          }
        }
      }
      if (pending.length > 0 && submittedDecisionBindingFact === undefined) {
        escalated.push(execution.executionId);
        continue;
      }
      let settlement: ExecutionSettlement = {
        _tag: "Interrupted",
        result: { _tag: "StopRequested" },
      };
      let submittedBindingRecoveryLease: LeaseRecord | undefined;
      if (submittedDecisionBindingFact !== undefined) {
        if (
          !Option.isSome(loopSteps) ||
          !Option.isSome(providerTurns) ||
          !Option.isSome(sessions) ||
          !Option.isSome(recoveryAttentionFacts) ||
          recoveryAttentionFacts.value.recordSubmittedDecisionBindingFailure ===
            undefined
        ) {
          escalated.push(execution.executionId);
          continue;
        }
        const acquired = yield* Effect.match(
          tx.transact(
            leases.acquire(
              execution.executionId,
              RECOVERY_WORKER_ID,
              RECOVERY_WORKER_INCARNATION_ID,
            ),
          ),
          {
            onFailure: (error) => ({ ok: false as const, error }),
            onSuccess: (lease) => ({ ok: true as const, lease }),
          },
        );
        if (!acquired.ok) {
          if (fencedTakeover(acquired.error)) {
            escalated.push(execution.executionId);
            continue;
          }
          return yield* Effect.fail(acquired.error);
        }
        const lease = acquired.lease;
        submittedBindingRecoveryLease = lease;
        const closed = yield* tx.transact(
          Effect.gen(function* () {
            yield* leases.renew(
              execution.executionId,
              lease.workerId,
              lease.workerIncarnationId,
              lease.generation,
            );
            const current = yield* repository.findById(execution.executionId);
            if (
              Option.isNone(current) ||
              current.value.stopRequestedAt === null ||
              current.value.state.status !== "Active"
            ) {
              return undefined;
            }
            const unresolved = yield* reconciliation.pending(
              execution.executionId,
            );
            const episode = executionEpisode(current.value);
            if (episode?._tag !== "DecisionEpisode") return undefined;
            const decisionStore = Option.getOrUndefined(decisionRequests);
            if (decisionStore === undefined) return undefined;
            const request = yield* decisionStore.findById(episode.decisionId);
            const stepIdentity = {
              executionId: execution.executionId,
              logicalStepNo: submittedDecisionBindingFact.logicalStepNo,
              repairAttempt: submittedDecisionBindingFact.repairAttempt,
            };
            const foundStep = yield* loopSteps.value.find(stepIdentity);
            if (Option.isNone(foundStep)) return undefined;
            const step = foundStep.value;
            if (
              step.providerTurnId !==
              submittedDecisionBindingFact.providerTurnId
            ) {
              return undefined;
            }
            const existingActions = yield* loopSteps.value.listActions(
              step.identity,
            );
            const exactPendingAction = existingActions.find(
              (action) => action.actionIndex === step.nextActionIndex,
            );
            if (step.state === "ActionsInProgress") {
              if (
                exactPendingAction?.logicalActionId !==
                  submittedDecisionBindingFact.logicalActionId ||
                exactPendingAction.routeKind !== "Control" ||
                exactPendingAction.actionKind !== "select_current_work" ||
                exactPendingAction.state !== "Pending"
              ) {
                return undefined;
              }
            } else if (step.state !== "SettlementProposed") {
              return undefined;
            }
            const providerResult = yield* providerTurns.value.findSettledResult(
              step.providerTurnId,
            );
            if (
              step.state === "ActionsInProgress" &&
              submittedDecisionBindingFact.failureCode ===
                "DecisionRequestWorkspaceMismatch" &&
              (Option.isNone(request) ||
                request.value.state._tag !== "Submitted" ||
                request.value.revision !== episode.requestRevision + 1 ||
                request.value.workspaceId === current.value.workspaceId ||
                !request.value.candidateWorkIds.includes(
                  request.value.state.selectedWorkId,
                ))
            ) {
              return undefined;
            }
            if (
              step.state === "ActionsInProgress" &&
              submittedDecisionBindingFact.failureCode ===
                "StepManifestMismatch" &&
              (providerResult._tag !== "SettledSuccess" ||
                providerResult.manifestId === step.manifestId)
            ) {
              return undefined;
            }
            yield* recordSubmittedDecisionBindingFailure(
              recoveryAttentionFacts.value,
              {
                projectId: execution.projectId,
                executionId: execution.executionId,
                workspaceId: current.value.workspaceId,
                logicalStepNo: submittedDecisionBindingFact.logicalStepNo,
                repairAttempt: submittedDecisionBindingFact.repairAttempt,
                providerTurnId: submittedDecisionBindingFact.providerTurnId,
                logicalActionId: submittedDecisionBindingFact.logicalActionId,
                failureCode: submittedDecisionBindingFact.failureCode,
                firstDetectedAt: submittedDecisionBindingFact.firstDetectedAt,
                causedByCommandId: null,
              },
            );
            if (unresolved.length > 0) return undefined;
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
                executionId: String(execution.executionId),
                sessionId: String(current.value.sessionId),
                step,
                providerResult,
                modelOutputEntry: outputEntries[0],
                existingActions,
              });
            if (actionIdentities === undefined) return undefined;
            if (step.state === "SettlementProposed") {
              const currentActionIndex = actionIdentities.findIndex(
                (action) =>
                  action.logicalActionId ===
                  submittedDecisionBindingFact.logicalActionId,
              );
              const settledActions = new Map(
                existingActions.map((action) => [action.actionIndex, action]),
              );
              const currentAction = settledActions.get(currentActionIndex);
              const closeWasPersisted =
                step.nextActionIndex === actionIdentities.length &&
                step.settlement?._tag === "Interrupted" &&
                step.settlement.result._tag === "StopRequested" &&
                currentAction?.state === "TerminalRejected" &&
                typeof currentAction.disposition === "object" &&
                currentAction.disposition !== null &&
                "_tag" in currentAction.disposition &&
                currentAction.disposition._tag ===
                  "StopRequestedAfterSubmittedBindingFailure" &&
                currentAction.observationSourceRef === undefined &&
                actionIdentities.every((action) => {
                  if (action.actionIndex <= currentActionIndex) return true;
                  const settled = settledActions.get(action.actionIndex);
                  return (
                    settled?.state === "SkippedEarlySettlement" &&
                    settled.observationSourceRef === undefined
                  );
                });
              return closeWasPersisted ? step.settlement : undefined;
            }
            if (step.state !== "ActionsInProgress") return undefined;
            const plan = planSubmittedDecisionStopClose({
              step,
              actions: actionIdentities,
              firstDetectedActionId:
                submittedDecisionBindingFact.logicalActionId,
              updatedAt: now,
            });
            if (plan._tag !== "Ready") return undefined;
            const fence = {
              executionId: execution.executionId,
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
            const proposed = yield* loopSteps.value.transition(
              {
                identity: step.identity,
                expectedRevision: step.revision,
                expectedState: "ActionsInProgress",
                next: plan.step,
              },
              fence,
            );
            if (
              proposed.state !== "SettlementProposed" ||
              proposed.settlement === undefined
            ) {
              return undefined;
            }
            return proposed.settlement;
          }),
        );
        if (closed === undefined) {
          yield* tx.transact(
            leases.release(
              execution.executionId,
              lease.workerId,
              lease.workerIncarnationId,
              lease.generation,
            ),
          );
          submittedBindingRecoveryLease = undefined;
          escalated.push(execution.executionId);
          continue;
        }
        settlement = closed;
      }
      const payload = { executionId: execution.executionId, settlement };
      // Crash-restart edge (observed live): the previous daemon died
      // mid-flight holding the lease. A fenced settle means the lease is
      // still live (TTL not expired) — lazy lease expiry is the authority
      // for taking over; the NEXT recovery pass settles this execution. A
      // fenced execution must never crash the whole daemon at startup.
      const commandId = recoveryCommandId(execution.executionId, "stop");
      const authority: VerifiedRuntimeCommandAuthority = {
        _tag: "SettleExecutionAuthority",
        submissionOrigin: "RecoveryController",
        principal,
        commandId,
        semanticRequestFingerprint: semanticRequestFingerprint({
          commandType: "SettleExecution",
          projectId: execution.projectId,
          actor: principal as never,
          schemaVersion: "1",
          payload,
        }),
        projectId: execution.projectId,
        commandKind: "SettleExecution",
        executionId: execution.executionId,
      };
      yield* gateway.execute(
        {
          commandType: "SettleExecution",
          commandId,
          projectId: execution.projectId,
          actor: principal as never,
          issuedAt: now,
          payload,
        },
        { _tag: "RecoveryController", principal, causationRef: "recovery" },
        authority,
      );
      if (submittedBindingRecoveryLease !== undefined) {
        yield* tx.transact(
          leases.release(
            execution.executionId,
            submittedBindingRecoveryLease.workerId,
            submittedBindingRecoveryLease.workerIncarnationId,
            submittedBindingRecoveryLease.generation,
          ),
        );
      }
      settled.push(execution.executionId);
    }
    if (
      submittedDecisionBindingAvailable &&
      recoveryAttentionFacts._tag === "Some" &&
      recoveryAttentionFacts.value.listSubmittedDecisionBindingFailures !==
        undefined &&
      recoveryAttentionFacts.value.recordSubmittedDecisionBindingFailure !==
        undefined &&
      loopSteps._tag === "Some" &&
      providerTurns._tag === "Some" &&
      decisionRequests._tag === "Some" &&
      repository.findSettledExecutions !== undefined
    ) {
      const legacySettled = yield* tx.transact(
        repository.findSettledExecutions(),
      );
      for (const execution of legacySettled) {
        if (
          execution.state.status !== "Settled" ||
          execution.state.settlement?._tag !== "Failed"
        ) {
          continue;
        }
        const episode = executionEpisode(execution);
        if (episode?._tag !== "DecisionEpisode") continue;
        const stepOption = yield* tx.transact(
          loopSteps.value.findCurrent(execution.executionId),
        );
        if (Option.isNone(stepOption)) continue;
        const step = stepOption.value;
        if (step.state !== "ActionsInProgress") continue;
        const actions = yield* tx.transact(
          loopSteps.value.listActions(step.identity),
        );
        const cursorAction = actions.find(
          (action) => action.actionIndex === step.nextActionIndex,
        );
        if (
          cursorAction === undefined ||
          cursorAction.routeKind !== "Control" ||
          cursorAction.actionKind !== "select_current_work" ||
          cursorAction.state !== "Pending"
        ) {
          continue;
        }
        const existingFacts = yield* tx.transact(
          recoveryAttentionFacts.value.listSubmittedDecisionBindingFailures?.(
            execution.projectId,
          ) ?? Effect.succeed([]),
        );
        if (
          existingFacts.some(
            (fact) =>
              fact.executionId === execution.executionId &&
              fact.logicalStepNo === step.identity.logicalStepNo &&
              fact.repairAttempt === step.identity.repairAttempt &&
              fact.logicalActionId === cursorAction.logicalActionId,
          )
        ) {
          continue;
        }
        const request = yield* tx.transact(
          decisionRequests.value.findById(episode.decisionId),
        );
        const providerResult = yield* tx.transact(
          providerTurns.value.findSettledResult(step.providerTurnId),
        );
        const failureCode = classifySettledDecisionPendingActionAudit({
          executionId: execution.executionId,
          executionWorkspaceId: execution.workspaceId,
          decisionRequestRevision: episode.requestRevision,
          step,
          action: cursorAction,
          request: Option.getOrUndefined(request),
          settledProviderManifestId:
            providerResult._tag === "SettledSuccess"
              ? providerResult.manifestId
              : undefined,
        });
        if (failureCode === undefined) continue;
        yield* tx.transact(
          recordSubmittedDecisionBindingFailure(recoveryAttentionFacts.value, {
            projectId: execution.projectId,
            executionId: execution.executionId,
            workspaceId: execution.workspaceId,
            logicalStepNo: step.identity.logicalStepNo,
            repairAttempt: step.identity.repairAttempt,
            providerTurnId: step.providerTurnId,
            logicalActionId: cursorAction.logicalActionId,
            failureCode,
            firstDetectedAt: now,
            causedByCommandId: null,
          }),
        );
      }
    }
    return { invalidated, settled, escalated };
  });

export const ReconciliationSourceStubLive: Layer.Layer<ReconciliationSource> =
  Layer.succeed(ReconciliationSource, {
    pending: () => Effect.succeed([]),
  });
