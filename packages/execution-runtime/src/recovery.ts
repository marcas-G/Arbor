import {
  CommandGateway,
  newUuid7,
  semanticRequestFingerprint,
  type VerifiedRuntimeCommandAuthority,
} from "@arbor/application";
import {
  CommandId,
  type DomainEvent,
  type Execution,
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
  ToolInvocationStore,
  TransactionPort,
} from "@arbor/ports";
import { Effect, Layer, Option } from "effect";
import { RECOVERY_WORKER_INCARNATION_ID } from "./process-identity.js";
import {
  fencedTakeover,
  RECOVERY_WORKER_ID,
  type SubmittedDecisionRecoveryQualificationEvent,
  type SubmittedDecisionRecoveryQualificationProbe,
} from "./recovery/common.js";
import { closeSubmittedDecisionForStop } from "./recovery/submitted-decision-stop-close.js";
import { recordSubmittedDecisionBindingFailure } from "./submitted-decision-binding-failure.js";

export type {
  SubmittedDecisionRecoveryQualificationEvent,
  SubmittedDecisionRecoveryQualificationProbe,
} from "./recovery/common.js";
export { makeReconciliationEscalationRecorder } from "./recovery/escalation-recorder.js";

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
 * SettleExecution with RecoveryController authority; never blindly
 * replays an uncertain case.
 */
export const runRecovery = (
  principal: Principal,
  qualificationProbe?: SubmittedDecisionRecoveryQualificationProbe,
) =>
  Effect.gen(function* () {
    const tx = yield* TransactionPort;
    const repository = yield* ExecutionRepository;
    const leases = yield* LeaseService;
    const reconciliation = yield* ReconciliationSource;
    const toolInvocations = yield* Effect.serviceOption(ToolInvocationStore);
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
    const reportP41 = (event: SubmittedDecisionRecoveryQualificationEvent) =>
      Effect.sync(() => {
        try {
          qualificationProbe?.(event);
        } catch {
          // Test diagnostics cannot change recovery control flow.
        }
      });

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
      let pending = yield* tx.transact(
        reconciliation.pending(execution.executionId),
      );
      if (pending.length > 0) {
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
        execution.stopRequestedAt !== null ||
        submittedDecisionBindingFact !== undefined
      ) {
        yield* reportP41({
          boundary: "AH10P41RecoveryCandidate",
          executionId: String(execution.executionId),
          stopRequested: execution.stopRequestedAt !== null,
          factPresent: submittedDecisionBindingFact !== undefined,
          ...(submittedDecisionBindingFact === undefined
            ? {}
            : { failureCode: submittedDecisionBindingFact.failureCode }),
        });
      }
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
      if (
        toolInvocations._tag === "Some" &&
        execution.stopRequestedAt !== null
      ) {
        // A P4 intent can be durable before the owning P3 action projects its
        // result. If the intent is still NotAdmitted, recovery can close it
        // deterministically with no external effect. This must happen before
        // settling the Execution; otherwise the Execution/Step can become
        // terminal while the ToolInvocation remains open forever.
        const unsettledInvocations = yield* tx.transact(
          toolInvocations.value.findUnsettled(execution.executionId),
        );
        const noEffectInvocations = unsettledInvocations.filter(
          (invocation) =>
            invocation.effectAdmissionState === "NotAdmitted" &&
            invocation.settlement === null,
        );
        if (noEffectInvocations.length > 0) {
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
          const interrupted = yield* Effect.match(
            tx.transact(
              Effect.gen(function* () {
                yield* leases.renew(
                  execution.executionId,
                  lease.workerId,
                  lease.workerIncarnationId,
                  lease.generation,
                );
                const fence = {
                  executionId: execution.executionId,
                  workerId: lease.workerId,
                  workerIncarnationId: lease.workerIncarnationId,
                  fencingGeneration: lease.generation,
                };
                for (const invocation of noEffectInvocations) {
                  const recorded =
                    yield* toolInvocations.value.recordNoEffectInterruption(
                      invocation.invocationId,
                      now,
                      fence,
                      now,
                    );
                  if (!recorded) {
                    const current = yield* toolInvocations.value.findById(
                      invocation.invocationId,
                    );
                    if (
                      Option.isNone(current) ||
                      current.value.settlement === null
                    ) {
                      return false;
                    }
                  }
                }
                return true;
              }),
            ),
            {
              onFailure: (error) => ({ ok: false as const, error }),
              onSuccess: (value) => ({ ok: true as const, value }),
            },
          );
          yield* tx.transact(
            leases.release(
              execution.executionId,
              lease.workerId,
              lease.workerIncarnationId,
              lease.generation,
            ),
          );
          if (!interrupted.ok) {
            if (fencedTakeover(interrupted.error)) {
              escalated.push(execution.executionId);
              continue;
            }
            return yield* Effect.fail(interrupted.error);
          }
          if (!interrupted.value) {
            escalated.push(execution.executionId);
            continue;
          }
        }
      }
      pending = yield* tx.transact(
        reconciliation.pending(execution.executionId),
      );
      if (pending.length > 0 && submittedDecisionBindingFact === undefined) {
        escalated.push(execution.executionId);
        continue;
      }
      if (
        execution.stopRequestedAt !== null &&
        submittedDecisionBindingFact === undefined &&
        Option.isSome(loopSteps)
      ) {
        // P4 may have already settled a known in-flight invocation while the
        // owning P3 process was interrupted. Do not settle the Execution
        // underneath an ActionsInProgress/Pending action: the existing Agent
        // Loop must get one fenced pass to project the terminal ToolResult,
        // Action state and cursor. P4 evidence remains owned by its runtime;
        // this gate only prevents P2 from stranding the P3 frontier.
        const steps = yield* tx.transact(
          loopSteps.value.listByExecution(execution.executionId),
        );
        let pendingActionProjection = false;
        for (const step of steps) {
          if (step.state !== "ActionsInProgress") continue;
          const actions = yield* tx.transact(
            loopSteps.value.listActions(step.identity),
          );
          const action = actions.find(
            (candidate) => candidate.actionIndex === step.nextActionIndex,
          );
          // Only executable actions can have an unresolved P4 side effect.
          // Control actions (for example SelectCurrentWork) are settled by
          // the application boundary and must not be mistaken for an
          // in-flight tool invocation during generic Stop recovery.
          if (
            action?.state === "Pending" &&
            action.routeKind === "Executable"
          ) {
            pendingActionProjection = true;
            break;
          }
        }
        if (pendingActionProjection) {
          escalated.push(execution.executionId);
          continue;
        }
      }
      let settlement: ExecutionSettlement = {
        _tag: "Interrupted",
        result: { _tag: "StopRequested" },
      };
      let submittedBindingRecoveryLease: LeaseRecord | undefined;
      if (submittedDecisionBindingFact !== undefined) {
        const closed = yield* closeSubmittedDecisionForStop(
          execution,
          submittedDecisionBindingFact,
          now,
          tx,
          repository,
          leases,
          reconciliation,
          loopSteps,
          providerTurns,
          sessions,
          recoveryAttentionFacts,
          decisionRequests,
          reportP41,
        );
        if (closed._tag === "Blocked") {
          escalated.push(execution.executionId);
          continue;
        }
        submittedBindingRecoveryLease = closed.lease;
        settlement = closed.settlement;
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
      const stopReceipt = yield* gateway.execute(
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
      if (submittedDecisionBindingFact !== undefined) {
        yield* reportP41({
          boundary: "AH10P41StopSettlement",
          executionId: String(execution.executionId),
          resolution: stopReceipt.resolution._tag,
        });
      }
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
