import type { AgentActionHandler } from "@arbor/agent-runtime";
import { reviseLocalPlan } from "@arbor/agent-runtime";
import {
  type AcceptWorkOutcomePayload,
  type AcceptWorkOutcomeResult,
  type CommandGatewayService,
  type CommandHandlerRegistryService,
  newUuid7,
  semanticRequestFingerprint,
  type VerifiedCommandAuthority,
} from "@arbor/application";
import {
  AcceptanceId,
  executionEpisode,
  parse,
  Revision,
  VerificationId,
  WorkId,
  WorkRevision,
  workEpisode,
} from "@arbor/domain";
import {
  type AcceptanceRepositoryService,
  type AgentLoopStepStoreService,
  type ClockService,
  type CommandStoreService,
  type DecisionRequestStoreService,
  type LocalPlanStoreService,
  type ProviderTurnStoreService,
  type SessionRepositoryService,
  sha256Hex,
  type TransactionPortService,
  type WorkRepositoryService,
  type WorkspacePlacementPortService,
  type WorkspaceRepositoryService,
  type WorkWaitStoreService,
} from "@arbor/ports";
import { Effect, Option } from "effect";
import { commitDurableControlActionEffect } from "../durable-control-action-effect.js";
import {
  actionError,
  actionOperationalFailure,
  findPriorCommandReceipt,
  generationScopedCommandId,
  legacySelectCurrentWorkCommandId,
  selectCurrentWorkCommandId,
} from "./command-receipts.js";

export interface ClaimCompletionDependencies {
  readonly works: WorkRepositoryService;
  readonly tx: TransactionPortService;
  readonly waits?: Pick<
    WorkWaitStoreService,
    "upsert" | "findByWork" | "clear"
  >;
  readonly clock: ClockService;
}

export interface AcceptResultDependencies {
  readonly gateway: CommandGatewayService;
  readonly commandHandlerRegistry?: CommandHandlerRegistryService;
  readonly commandReceipts?: Pick<CommandStoreService, "findResolution">;
  readonly acceptances?: Pick<
    AcceptanceRepositoryService,
    "findByWorkRevision"
  >;
  readonly works: WorkRepositoryService;
  readonly tx: TransactionPortService;
  readonly placement: WorkspacePlacementPortService;
  readonly clock: ClockService;
}

export interface UpdatePlanDependencies {
  readonly works: WorkRepositoryService;
  readonly plans: LocalPlanStoreService;
  readonly tx: TransactionPortService;
  readonly clock: ClockService;
  readonly loopSteps?: AgentLoopStepStoreService;
  readonly providerTurns?: Pick<
    ProviderTurnStoreService,
    "findManifestByTurn" | "findSettledResult"
  >;
  readonly sessions?: Pick<SessionRepositoryService, "appendItemIdempotent">;
}

export interface SelectCurrentWorkDependencies {
  readonly gateway: CommandGatewayService;
  readonly commandHandlerRegistry?: CommandHandlerRegistryService;
  readonly commandReceipts?: Pick<CommandStoreService, "findResolution">;
  readonly decisions: DecisionRequestStoreService;
  readonly workspaces: WorkspaceRepositoryService;
  readonly tx: TransactionPortService;
  readonly clock: ClockService;
}

export const acceptResultHandler = (
  dependencies: AcceptResultDependencies,
): AgentActionHandler => ({
  action: "AcceptResult",
  handle: ({ action, invocation, execution, context }) =>
    Effect.gen(function* () {
      if (action._tag !== "AcceptResult") {
        return yield* Effect.fail(
          actionOperationalFailure("AcceptResult.dispatch")(
            "AcceptResult handler received a different AgentAction",
          ),
        );
      }
      const occurrence = `${invocation.providerTurnId}:${invocation.outputPosition}`;
      const acceptanceId = parse(AcceptanceId)(
        `acc_${newUuid7("accept-child-result", occurrence)}`,
      );
      if (context._tag === "ExecutionOrigin" && context.fencingGeneration > 0) {
        const prior = yield* findPriorCommandReceipt({
          context,
          namespace: "accept-child-result-command",
          occurrence,
          commandReceipts: dependencies.commandReceipts,
          commandType: "AcceptWorkOutcome",
          commandHandlerRegistry: dependencies.commandHandlerRegistry,
          tx: dependencies.tx,
          projectId: execution.projectId,
          operation: "AcceptResult.priorReceipt",
          errorOperation: "AcceptResult",
          lookupOperation: "AcceptResult.receiptLookup",
        });
        if (prior._tag === "Committed") {
          const result = prior.receipt.resolution.result;
          if (
            typeof result !== "object" ||
            result === null ||
            !("acceptanceId" in result) ||
            result.acceptanceId !== acceptanceId ||
            !("workId" in result) ||
            typeof result.workId !== "string" ||
            !("targetWorkRevision" in result) ||
            typeof result.targetWorkRevision !== "number" ||
            !Number.isInteger(result.targetWorkRevision) ||
            result.targetWorkRevision < 0 ||
            !("verificationId" in result) ||
            typeof result.verificationId !== "string"
          ) {
            return yield* Effect.fail(
              actionOperationalFailure("AcceptResult.priorReceipt")(
                "prior Committed result does not match the pinned action",
              ),
            );
          }
          let receiptWorkId: WorkId;
          let receiptVerificationId: VerificationId;
          let targetWorkRevision: WorkRevision;
          try {
            receiptWorkId = parse(WorkId)(result.workId);
            receiptVerificationId = parse(VerificationId)(
              result.verificationId,
            );
            targetWorkRevision = parse(WorkRevision)(result.targetWorkRevision);
          } catch {
            return yield* Effect.fail(
              actionOperationalFailure("AcceptResult.priorReceipt")(
                "prior Committed result contains malformed identity",
              ),
            );
          }
          const work = yield* dependencies.tx.transact(
            dependencies.works.findById(receiptWorkId),
          );
          if (
            Option.isNone(work) ||
            work.value.projectId !== execution.projectId
          ) {
            return yield* Effect.fail(
              actionOperationalFailure("AcceptResult.priorReceipt")(
                "prior accepted Work is missing or belongs to another Project",
              ),
            );
          }
          const expectedResultRef = `rref_${sha256Hex(
            JSON.stringify({
              parentWorkspaceId: execution.workspaceId,
              childWorkspaceId: work.value.workspaceId,
              workId: receiptWorkId,
              workRevision: Number(targetWorkRevision),
              verificationId: receiptVerificationId,
            }),
          )}`;
          if (action.resultRef !== expectedResultRef) {
            return yield* Effect.fail(
              actionOperationalFailure("AcceptResult.priorReceipt")(
                "prior Committed result does not match the pinned resultRef",
              ),
            );
          }
          const acceptances = dependencies.acceptances;
          if (acceptances === undefined) {
            return yield* Effect.fail(
              actionOperationalFailure("AcceptResult.priorReceipt")(
                "Acceptance repository lookup is required to converge a Committed receipt",
              ),
            );
          }
          const accepted = yield* dependencies.tx.transact(
            acceptances.findByWorkRevision(
              receiptWorkId,
              Number(targetWorkRevision),
            ),
          );
          if (
            Option.isNone(accepted) ||
            accepted.value.acceptanceId !== acceptanceId ||
            accepted.value.workId !== receiptWorkId ||
            accepted.value.targetWorkRevision !== targetWorkRevision ||
            accepted.value.verificationId !== receiptVerificationId
          ) {
            return yield* Effect.fail(
              actionOperationalFailure("AcceptResult.priorReceipt")(
                "Committed receipt has no exact matching canonical Acceptance row",
              ),
            );
          }
          return {
            _tag: "Observation" as const,
            source: "Runtime" as const,
            observation: {
              text: `WorkOutcomeAccepted(${receiptWorkId}, ${receiptVerificationId})`,
              truncated: false,
            },
          };
        }
        if (prior._tag === "TerminalRejected") {
          return yield* Effect.fail(
            actionError(
              "earlier command was terminally rejected",
              "action/canonical-rejected",
              "WaitForStateChange",
            ),
          );
        }
      }
      const resolved = yield* dependencies.placement.resolveResultRef(
        execution.workspaceId,
        action.resultRef,
      );
      if (Option.isNone(resolved)) {
        return yield* Effect.fail(
          actionError(
            "resultRef is stale, already accepted, non-PASS, foreign, or not from an active direct child",
            "action/target-unavailable",
            "RetryWithChangedInput",
          ),
        );
      }
      const payload: AcceptWorkOutcomePayload = {
        acceptanceId,
        workId: resolved.value.workId,
        targetWorkRevision: resolved.value.workRevision,
        verificationId: resolved.value.verificationId,
      };
      const commandId = generationScopedCommandId(
        "accept-child-result-command",
        occurrence,
        context,
      );
      const actor = context.principal as never;
      const receipt = yield* dependencies.gateway.execute<
        AcceptWorkOutcomePayload,
        AcceptWorkOutcomeResult
      >(
        {
          commandType: "AcceptWorkOutcome",
          commandId,
          projectId: execution.projectId,
          actor,
          issuedAt: yield* dependencies.clock.now(),
          payload,
        },
        context,
        {
          _tag: "AcceptanceAuthority",
          principal: context.principal,
          commandId,
          semanticRequestFingerprint: semanticRequestFingerprint({
            commandType: "AcceptWorkOutcome",
            projectId: execution.projectId,
            actor,
            schemaVersion: "1",
            payload,
          }),
          projectId: execution.projectId,
          targetWorkspaceId: execution.workspaceId,
          workId: resolved.value.workId,
          verificationId: resolved.value.verificationId,
        },
      );
      if (receipt.resolution._tag !== "Committed") {
        return yield* Effect.fail(
          actionError(
            receipt.resolution._tag === "TerminalRejected"
              ? JSON.stringify(receipt.resolution.error)
              : "AcceptWorkOutcome failed operationally",
            "action/canonical-rejected",
            "WaitForStateChange",
          ),
        );
      }
      return {
        _tag: "Observation" as const,
        source: "Runtime" as const,
        observation: {
          text: `WorkOutcomeAccepted(${resolved.value.workId}, ${resolved.value.verificationId})`,
          truncated: false,
        },
      };
    }).pipe(Effect.mapError(actionOperationalFailure("AcceptResult"))),
});

export const updatePlanHandler = (
  dependencies: UpdatePlanDependencies,
): AgentActionHandler => ({
  action: "UpdatePlan",
  handle: (input) =>
    Effect.gen(function* () {
      const { action, execution } = input;
      if (action._tag !== "UpdatePlan") {
        return yield* Effect.fail(
          actionError("UpdatePlan received a different AgentAction"),
        );
      }
      const boundWork = workEpisode(execution);
      if (boundWork === null) {
        return yield* Effect.fail(
          actionError(
            "update_plan is available only inside an exact Work episode",
            "action/not-applicable",
          ),
        );
      }
      const revise = () =>
        Effect.gen(function* () {
          const updatedAt = yield* dependencies.clock.now();
          const work = yield* dependencies.works.findById(boundWork.workId);
          if (Option.isNone(work) || work.value.lifecycle !== "Open") {
            return yield* Effect.fail(
              actionError("planned Work is missing or no longer Open"),
            );
          }
          if (work.value.revision !== boundWork.targetWorkRevision) {
            return yield* Effect.fail(
              actionError(
                "Work revision changed; refresh context before updating its plan",
                "action/precondition",
                "WaitForStateChange",
              ),
            );
          }
          const current = yield* dependencies.plans.findByWork(
            boundWork.workId,
          );
          const expectedPlanRevision = Option.isSome(current)
            ? current.value.revision
            : 0;
          const revised = reviseLocalPlan({
            current: Option.getOrNull(current),
            workId: boundWork.workId,
            targetWorkRevision: boundWork.targetWorkRevision,
            expectedRevision: expectedPlanRevision,
            items: action.items,
            updatedAt,
          });
          if (!revised.ok) {
            return yield* Effect.fail(
              actionError(
                revised.error._tag === "LocalPlanInvalid"
                  ? revised.error.reason
                  : "plan revision changed",
                "action/precondition",
                "RetryWithChangedInput",
              ),
            );
          }
          yield* dependencies.plans.save(revised.value, expectedPlanRevision);
          return revised.value;
        });
      if (
        dependencies.loopSteps !== undefined &&
        dependencies.sessions !== undefined &&
        dependencies.providerTurns !== undefined
      ) {
        const committed = yield* commitDurableControlActionEffect({
          handlerInput: input,
          expectedToolName: "update_plan",
          tx: dependencies.tx,
          loopSteps: dependencies.loopSteps,
          providerTurns: dependencies.providerTurns,
          sessions: dependencies.sessions,
          clock: dependencies.clock,
          effect: () =>
            revise().pipe(
              Effect.map((plan) => ({
                value: plan,
                result: {
                  observation: {
                    text: JSON.stringify({
                      planRevision: plan.revision,
                      items: plan.items,
                      authority: "progress-only",
                    }),
                    truncated: false as const,
                  },
                },
              })),
            ),
        });
        return committed.outcome;
      }
      if (
        dependencies.loopSteps !== undefined ||
        dependencies.sessions !== undefined
      ) {
        return yield* Effect.fail(
          actionOperationalFailure("UpdatePlan.commit")(
            "P9 Control commit requires the exact ProviderTurn manifest store",
          ),
        );
      }
      const plan = yield* dependencies.tx.transact(revise());
      return {
        _tag: "Observation" as const,
        source: "Runtime" as const,
        observation: {
          text: JSON.stringify({
            planRevision: plan.revision,
            items: plan.items,
            authority: "progress-only",
          }),
          truncated: false,
        },
      };
    }).pipe(Effect.mapError(actionOperationalFailure("UpdatePlan"))),
});

export const selectCurrentWorkHandler = (
  dependencies: SelectCurrentWorkDependencies,
): AgentActionHandler => ({
  action: "SelectCurrentWork",
  handle: ({ action, invocation, execution, context }) =>
    Effect.gen(function* () {
      if (action._tag !== "SelectCurrentWork") {
        return yield* Effect.fail(
          actionError("SelectCurrentWork received a different AgentAction"),
        );
      }
      const episode = executionEpisode(execution);
      if (episode?._tag !== "DecisionEpisode") {
        return yield* Effect.fail(
          actionError(
            "select_current_work requires an exact DecisionEpisode",
            "action/not-applicable",
          ),
        );
      }
      const occurrence = `${invocation.providerTurnId}:${invocation.outputPosition}`;
      if (context._tag === "ExecutionOrigin" && context.fencingGeneration > 0) {
        const prior = yield* findPriorCommandReceipt({
          context,
          namespace: "select-current-work-command",
          occurrence,
          legacyCommandId: legacySelectCurrentWorkCommandId(episode.decisionId),
          commandReceipts: dependencies.commandReceipts,
          commandType: "SelectCurrentWork",
          commandHandlerRegistry: dependencies.commandHandlerRegistry,
          tx: dependencies.tx,
          projectId: execution.projectId,
          operation: "SelectCurrentWork.priorReceipt",
          lookupOperation: "SelectCurrentWork.receiptLookup",
          errorOperation: "SelectCurrentWork",
        });
        if (prior._tag === "Committed") {
          const result = prior.receipt.resolution.result;
          if (
            typeof result !== "object" ||
            result === null ||
            !("workspaceId" in result) ||
            result.workspaceId !== execution.workspaceId ||
            !("workId" in result) ||
            result.workId !== action.workId ||
            !("revision" in result) ||
            typeof result.revision !== "number" ||
            !Number.isInteger(result.revision)
          ) {
            return yield* Effect.fail(
              actionOperationalFailure("SelectCurrentWork.priorReceipt")(
                "prior Committed result does not match the pinned DecisionRequest selection",
              ),
            );
          }
          const request = yield* dependencies.tx.transact(
            dependencies.decisions.findById(episode.decisionId),
          );
          if (
            Option.isNone(request) ||
            request.value.workspaceId !== execution.workspaceId ||
            !request.value.candidateWorkIds.includes(action.workId) ||
            request.value.workspaceRevision + 1 !== result.revision
          ) {
            return yield* Effect.fail(
              actionOperationalFailure("SelectCurrentWork.priorReceipt")(
                "Committed receipt has no matching durable DecisionRequest",
              ),
            );
          }
          if (request.value.state._tag === "Pending") {
            if (request.value.revision !== episode.requestRevision) {
              return yield* Effect.fail(
                actionOperationalFailure("SelectCurrentWork.priorReceipt")(
                  "Pending DecisionRequest revision conflicts with the pinned episode",
                ),
              );
            }
            const workspace = yield* dependencies.tx.transact(
              dependencies.workspaces.findById(execution.workspaceId),
            );
            if (
              Option.isNone(workspace) ||
              workspace.value.projectId !== execution.projectId ||
              workspace.value.currentWorkId !== action.workId ||
              Number(workspace.value.revision) !== result.revision
            ) {
              return yield* Effect.fail(
                actionOperationalFailure("SelectCurrentWork.priorReceipt")(
                  "Committed selection conflicts with the current Workspace row while DecisionRequest is Pending",
                ),
              );
            }
            yield* dependencies.tx.transact(
              dependencies.decisions.submit({
                decisionId: episode.decisionId,
                expectedRevision: request.value.revision,
                selectedWorkId: action.workId,
                updatedAt: yield* dependencies.clock.now(),
              }),
            );
          } else if (
            request.value.state.selectedWorkId !== action.workId ||
            request.value.revision !== episode.requestRevision + 1
          ) {
            return yield* Effect.fail(
              actionOperationalFailure("SelectCurrentWork.priorReceipt")(
                "Submitted DecisionRequest conflicts with the Committed selection",
              ),
            );
          }
          return {
            _tag: "Settle" as const,
            settlement: {
              _tag: "Completed" as const,
              result: {
                _tag: "DecisionSubmitted" as const,
                decisionId: episode.decisionId,
              },
            },
          };
        }
        if (prior._tag === "TerminalRejected") {
          return yield* Effect.fail(
            actionError(
              "canonical Work selection was rejected",
              "action/canonical-rejected",
              "WaitForStateChange",
            ),
          );
        }
      }
      const request = yield* dependencies.tx.transact(
        dependencies.decisions.findById(episode.decisionId),
      );
      if (
        Option.isNone(request) ||
        request.value.state._tag !== "Pending" ||
        request.value.revision !== episode.requestRevision ||
        !request.value.candidateWorkIds.includes(action.workId)
      ) {
        return yield* Effect.fail(
          actionError(
            "selected Work is not an eligible candidate for this DecisionRequest",
            "action/precondition",
            "RetryWithChangedInput",
          ),
        );
      }
      const commandId = selectCurrentWorkCommandId(
        episode.decisionId,
        occurrence,
        context,
      );
      const payload = {
        workspaceId: execution.workspaceId,
        workId: action.workId,
        expectedWorkspaceRevision: request.value.workspaceRevision,
      };
      const authority: VerifiedCommandAuthority = {
        _tag: "SelectCurrentWorkAuthority",
        principal: context.principal,
        commandId,
        semanticRequestFingerprint: semanticRequestFingerprint({
          commandType: "SelectCurrentWork",
          projectId: execution.projectId,
          actor: context.principal as never,
          schemaVersion: "1",
          payload,
        }),
        projectId: execution.projectId,
        targetWorkspaceId: execution.workspaceId,
      };
      const receipt = yield* dependencies.gateway.execute(
        {
          commandType: "SelectCurrentWork",
          commandId,
          projectId: execution.projectId,
          actor: context.principal as never,
          issuedAt: yield* dependencies.clock.now(),
          payload,
        },
        context,
        authority,
      );
      if (receipt.resolution._tag !== "Committed") {
        return yield* Effect.fail(
          actionError(
            "canonical Work selection was rejected",
            "action/canonical-rejected",
            "WaitForStateChange",
          ),
        );
      }
      yield* dependencies.tx.transact(
        dependencies.decisions.submit({
          decisionId: episode.decisionId,
          expectedRevision: episode.requestRevision,
          selectedWorkId: action.workId,
          updatedAt: yield* dependencies.clock.now(),
        }),
      );
      return {
        _tag: "Settle" as const,
        settlement: {
          _tag: "Completed" as const,
          result: {
            _tag: "DecisionSubmitted" as const,
            decisionId: episode.decisionId,
          },
        },
      };
    }).pipe(Effect.mapError(actionOperationalFailure("SelectCurrentWork"))),
});

/** ACR-8 (DID v1.19): the producer claims its Work complete. The
 * workRevision is a trusted Runtime fact read from the store (never
 * model-supplied); the claimRef is deterministic per provider-turn
 * occurrence so replays converge; the downstream StartVerification is
 * driven by the existing verification consumer — this handler never
 * completes the Work itself. */
export const claimCompletionHandler = (
  dependencies: ClaimCompletionDependencies,
): AgentActionHandler => ({
  action: "ClaimCompletion",
  handle: (input) =>
    Effect.gen(function* () {
      const { action, invocation, execution } = input;
      if (action._tag !== "ClaimCompletion") {
        return yield* Effect.fail(
          actionOperationalFailure("ClaimCompletion.dispatch")(
            "ClaimCompletion handler received a different AgentAction",
          ),
        );
      }
      const boundWork = workEpisode(execution);
      if (boundWork === null) {
        return yield* Effect.fail(
          actionError(
            "ClaimCompletion requires an active Work binding to claim against",
          ),
        );
      }
      const workId = boundWork.workId;
      const work = yield* dependencies.tx.transact(
        dependencies.works.findById(workId),
      );
      if (Option.isNone(work)) {
        return yield* Effect.fail(actionError("claimed Work is missing"));
      }
      if (work.value.lifecycle !== "Open") {
        return yield* Effect.fail(
          actionError(
            `ClaimCompletion requires an Open Work, found ${work.value.lifecycle}`,
          ),
        );
      }
      const occurrence = `${invocation.providerTurnId}:${invocation.outputPosition}`;
      let durableSettlementEffect:
        | Effect.Effect<void, unknown, import("@arbor/ports").TransactionScope>
        | undefined;
      if (dependencies.waits !== undefined) {
        const now = yield* dependencies.clock.now();
        const wait = {
          workId,
          waitSpec: {
            mode: "Any" as const,
            conditions: [
              {
                _tag: "VerificationChanged" as const,
                workId,
                targetWorkRevision: parse(Revision)(
                  Number(work.value.revision),
                ),
              },
            ],
          },
          registeredAt: now,
          updatedAt: now,
        };
        if (
          input.actionContext !== undefined &&
          input.loopStepFence !== undefined &&
          input.logicalActionId !== undefined
        ) {
          durableSettlementEffect = dependencies.waits.upsert(wait);
        } else {
          yield* dependencies.tx.transact(dependencies.waits.upsert(wait));
        }
      }
      return {
        _tag: "Settle" as const,
        settlement: {
          _tag: "Completed" as const,
          result: {
            _tag: "CompletionClaimed" as const,
            workRevision: work.value.revision,
            claimRef: `clm_${newUuid7("completion-claim", occurrence)}`,
          },
        },
        ...(durableSettlementEffect === undefined
          ? {}
          : { durableSettlementEffect }),
      };
    }).pipe(Effect.mapError(actionOperationalFailure("ClaimCompletion"))),
});
