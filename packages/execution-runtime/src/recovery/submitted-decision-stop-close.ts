import {
  planSubmittedDecisionStopClose,
  reconstructSubmittedDecisionStopCloseActions,
} from "@arbor/agent-runtime";
import { executionEpisode, type Execution } from "@arbor/domain";
import type {
  AgentLoopStepStoreService,
  DecisionRequestStoreService,
  ExecutionRepositoryService,
  LeaseServiceService,
  ProviderTurnStoreService,
  ReconciliationSourceService,
  RecoveryAttentionFactStoreService,
  SessionRepositoryService,
  TransactionPortService,
} from "@arbor/ports";
import { Effect, Option } from "effect";
import { RECOVERY_WORKER_INCARNATION_ID } from "../process-identity.js";
import { recordSubmittedDecisionBindingFailure, type SubmittedDecisionBindingFailureInput } from "../submitted-decision-binding-failure.js";
import { RECOVERY_WORKER_ID, fencedTakeover, type SubmittedDecisionRecoveryQualificationEvent } from "./common.js";

type StopCloseFact = Pick<
  SubmittedDecisionBindingFailureInput,
  "logicalStepNo" | "repairAttempt" | "providerTurnId" | "logicalActionId" | "failureCode" | "firstDetectedAt"
>;

/** Acquire a recovery lease and close an exact P41 action ledger under its original transaction. */
export const closeSubmittedDecisionForStop = (
  execution: Execution,
  submittedDecisionBindingFact: StopCloseFact,
  now: string,
  tx: TransactionPortService,
  repository: ExecutionRepositoryService,
  leases: LeaseServiceService,
  reconciliation: ReconciliationSourceService,
  loopSteps: Option.Option<AgentLoopStepStoreService>,
  providerTurns: Option.Option<ProviderTurnStoreService>,
  sessions: Option.Option<SessionRepositoryService>,
  recoveryAttentionFacts: Option.Option<RecoveryAttentionFactStoreService>,
  decisionRequests: Option.Option<DecisionRequestStoreService>,
  reportP41: (event: SubmittedDecisionRecoveryQualificationEvent) => Effect.Effect<void>,
) =>
  Effect.gen(function* () {
    if (
      !Option.isSome(loopSteps) ||
      !Option.isSome(providerTurns) ||
      !Option.isSome(sessions) ||
      !Option.isSome(recoveryAttentionFacts) ||
      recoveryAttentionFacts.value.recordSubmittedDecisionBindingFailure ===
        undefined
    ) {
      return { _tag: "Blocked" as const };
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
      yield* reportP41({
        boundary: "AH10P41RecoveryLease",
        executionId: String(execution.executionId),
        acquired: false,
        errorTag:
          typeof acquired.error === "object" &&
          acquired.error !== null &&
          "_tag" in acquired.error
            ? String(acquired.error._tag)
            : "unknown",
      });
      if (fencedTakeover(acquired.error)) {
        return { _tag: "Blocked" as const };
      }
      return yield* Effect.fail(acquired.error);
    }
    const lease = acquired.lease;
    yield* reportP41({
      boundary: "AH10P41RecoveryLease",
      executionId: String(execution.executionId),
      acquired: true,
      fencingGeneration: Number(lease.generation),
    });
    let submittedBindingCloseStage = "lease-revalidation";
    let submittedBindingCloseReason = "close-guard-not-reached";
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
          submittedBindingCloseReason =
            "execution-not-active-or-stop-request-missing";
          return undefined;
        }
        const unresolved = yield* reconciliation.pending(
          execution.executionId,
        );
        yield* reportP41({
          boundary: "AH10P41StopCloseStage",
          executionId: String(execution.executionId),
          stage: "p4-gate",
          outcome: unresolved.length === 0 ? "pass" : "blocked",
          unresolvedP4Effects: unresolved.length,
          ...(unresolved.length === 0
            ? {}
            : { reason: "unresolved-p4-side-effects" }),
        });
        const episode = executionEpisode(current.value);
        submittedBindingCloseStage = "episode-and-decision-store";
        if (episode?._tag !== "DecisionEpisode") {
          submittedBindingCloseReason = "episode-not-decision";
          return undefined;
        }
        const decisionStore = Option.getOrUndefined(decisionRequests);
        if (decisionStore === undefined) {
          submittedBindingCloseReason = "decision-store-unavailable";
          return undefined;
        }
        const request = yield* decisionStore.findById(episode.decisionId);
        const stepIdentity = {
          executionId: execution.executionId,
          logicalStepNo: submittedDecisionBindingFact.logicalStepNo,
          repairAttempt: submittedDecisionBindingFact.repairAttempt,
        };
        const foundStep = yield* loopSteps.value.find(stepIdentity);
        submittedBindingCloseStage = "step-and-action-binding";
        if (Option.isNone(foundStep)) {
          submittedBindingCloseReason = "step-not-found";
          return undefined;
        }
        const step = foundStep.value;
        if (
          step.providerTurnId !==
          submittedDecisionBindingFact.providerTurnId
        ) {
          submittedBindingCloseReason = "provider-turn-mismatch";
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
            submittedBindingCloseReason = "pending-action-mismatch";
            return undefined;
          }
        } else if (step.state !== "SettlementProposed") {
          submittedBindingCloseReason = "step-not-closeable";
          return undefined;
        }
        const providerResult = yield* providerTurns.value.findSettledResult(
          step.providerTurnId,
        );
        submittedBindingCloseStage =
          "submitted-request-and-provider-result";
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
          submittedBindingCloseReason = "decision-request-mismatch";
          return undefined;
        }
        if (
          step.state === "ActionsInProgress" &&
          submittedDecisionBindingFact.failureCode ===
            "StepManifestMismatch" &&
          (providerResult._tag !== "SettledSuccess" ||
            providerResult.manifestId === step.manifestId)
        ) {
          submittedBindingCloseReason = "provider-result-mismatch";
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
        submittedBindingCloseStage = "reconstruction-inputs";
        if (unresolved.length > 0) {
          submittedBindingCloseReason = "unresolved-p4-side-effects";
          return undefined;
        }
        const outputEntries =
          step.modelOutputSessionSequence === undefined
            ? []
            : yield* sessions.value.listEntries(
                current.value.sessionId,
                step.modelOutputSessionSequence - 1,
                1,
              );
        const outputEntry = outputEntries[0];
        yield* reportP41({
          boundary: "AH10P41StopCloseStage",
          executionId: String(execution.executionId),
          stage: "action-reconstruction-input",
          outcome: "pass",
          reason: JSON.stringify({
            providerResultTag: providerResult._tag,
            providerTurnMatches:
              providerResult._tag === "SettledSuccess" &&
              providerResult.turn.providerTurnId === step.providerTurnId,
            modelOutputSequence: step.modelOutputSessionSequence ?? null,
            modelOutputEntryKind: outputEntry?.entryKind ?? null,
            modelOutputEntrySequence: outputEntry?.sequence ?? null,
            decodedOutputHashPresent: step.decodedOutputHash !== undefined,
            manifestMatchesStep:
              providerResult._tag === "SettledSuccess" &&
              providerResult.manifestId === step.manifestId,
            existingActionCount: existingActions.length,
            nextActionIndex: step.nextActionIndex,
          }),
        });
        const actionIdentities =
          reconstructSubmittedDecisionStopCloseActions({
            executionId: String(execution.executionId),
            sessionId: String(current.value.sessionId),
            step,
            providerResult,
            modelOutputEntry: outputEntry,
            existingActions,
          });
        submittedBindingCloseStage = "action-ledger-reconstruction";
        if (actionIdentities === undefined) {
          submittedBindingCloseReason =
            "action-ledger-reconstruction-insufficient";
          return undefined;
        }
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
        submittedBindingCloseStage = `stop-close-plan:${plan._tag}`;
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
        submittedBindingCloseStage = `step-transition:${proposed.state}`;
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
      yield* reportP41({
        boundary: "AH10P41StopCloseStage",
        executionId: String(execution.executionId),
        stage: submittedBindingCloseStage,
        outcome: "blocked",
        reason: submittedBindingCloseReason,
      });
      yield* tx.transact(
        leases.release(
          execution.executionId,
          lease.workerId,
          lease.workerIncarnationId,
          lease.generation,
        ),
      );
      return { _tag: "Blocked" as const };
    }
    yield* reportP41({
      boundary: "AH10P41StopCloseStage",
      executionId: String(execution.executionId),
      stage: submittedBindingCloseStage,
      outcome: "pass",
    });
    return { _tag: "Ready" as const, lease, settlement: closed };
  });
