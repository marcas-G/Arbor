import type {
  AgentBinding,
  AgentExecutionState,
  Execution,
  ExecutionSettlement,
  LeaseGeneration,
} from "@arbor/domain";
import {
  conversationResponseEpisode,
  executionEpisode,
  workEpisode,
} from "@arbor/domain";
import {
  type ControlBasis,
  decideSessionProjection,
  decodeTurn,
  GENERIC_COGNITION_PROGRAM,
  type InstructionFragment,
  type ModelContextService,
  projectSessionTimeline,
  SESSION_TIMELINE_ENTRY_LIMIT,
  type SessionTimelineProjection,
  type TurnProfileResolverService,
} from "@arbor/model-context";
import type {
  AgentLoopStepActionRecord,
  AgentLoopStepFence,
  AgentLoopStepRecord,
  AgentLoopStepStoreService,
  ConversationResponseJobStoreService,
  DecisionRequestStoreService,
  ExecutionActivity,
  ExecutionDriverError,
  HumanMessageStoreService,
  LocalPlanStoreService,
  ModelCapability,
  ProviderExecutionPolicyOverrides,
  ProviderRunInput,
  ProviderRuntimeProgress,
  ProviderRuntimeService,
  ProviderTurnStoreService,
  RuntimeSafetyObservation,
  SecretRef,
  SessionEntryRecord,
  SessionRepositoryService,
  TransactionPortService,
  WorkRepositoryService,
  WorkspaceKnowledgePortService,
  WorkspacePlacementPortService,
  WorkspaceRepositoryService,
} from "@arbor/ports";
import { sha256Hex } from "@arbor/ports";
import { Effect, Option } from "effect";
import {
  isProviderExecutionTimeout,
  isProviderFailure,
  isProviderTurnBindingChanged,
  type ModelDecisionOutcome,
  providerExecutionTimeoutSettlement,
  providerFailureSettlement,
  providerTurnBindingChangedSettlement,
  REPAIR_POLICY,
  runtimeSafetyFragment,
  safetyStop,
} from "./agent-loop-policy.js";
import { runCompaction } from "./compaction-coordinator.js";
import {
  GENERIC_INSTRUCTION_ASSETS,
  instructionAssetFragment,
} from "./prompt-assets.js";
import type { AgentLoopQualificationProbe } from "./qualification-probe.js";
import { decideRepair } from "./repair.js";
import { makeAgentStepContext } from "./step-context.js";
import { assembleWorkContext } from "./work-context.js";

export interface ModelDecisionOptions {
  readonly secretRef?: SecretRef;
  readonly executionPolicyOverrides?: ProviderExecutionPolicyOverrides;
  readonly providerRef?: string;
  readonly onProviderProgress?:
    | ((executionId: string, event: ProviderRuntimeProgress) => void)
    | undefined;
  readonly qualificationProbe?: AgentLoopQualificationProbe;
}

export interface ModelDecisionDependencies {
  readonly input: {
    readonly execution: Execution;
    readonly agentExecutionState: AgentExecutionState;
  };
  readonly agentBinding: AgentBinding;
  readonly capability: ModelCapability;
  readonly currentControlBasis: () => Effect.Effect<
    ControlBasis,
    ExecutionDriverError
  >;
  readonly modelContext: ModelContextService;
  readonly providerRuntime: ProviderRuntimeService;
  readonly tx: TransactionPortService;
  readonly loopSteps?: AgentLoopStepStoreService;
  readonly loopStepFence?: AgentLoopStepFence;
  readonly providerTurns?: ProviderTurnStoreService;
  readonly sessions: SessionRepositoryService;
  readonly humanMessages: HumanMessageStoreService;
  readonly turnProfileResolver: TurnProfileResolverService;
  readonly responseJobs?: Pick<
    ConversationResponseJobStoreService,
    "findByExecution" | "listForWorkspace"
  >;
  readonly works: WorkRepositoryService;
  readonly localPlans?: Pick<LocalPlanStoreService, "findByWork">;
  readonly decisionRequests?: Pick<DecisionRequestStoreService, "findById">;
  readonly workspaces: WorkspaceRepositoryService;
  readonly workspaceKnowledge?: WorkspaceKnowledgePortService;
  readonly workspacePlacement?: WorkspacePlacementPortService;
  readonly options: ModelDecisionOptions;
  readonly admit: (
    activity: ExecutionActivity,
    observation: RuntimeSafetyObservation,
  ) => Effect.Effect<"Continue" | "Stop">;
  readonly failure: (cause: unknown) => ExecutionDriverError;
  readonly now: () => Effect.Effect<string>;
  readonly leaseGeneration?: LeaseGeneration;
}

interface SubmittedDecisionReplayInput {
  readonly executionWorkspaceId: string;
  readonly episode: {
    readonly decisionId: string;
    readonly requestRevision: number;
  };
  readonly request: {
    readonly workspaceId: string;
    readonly candidateWorkIds: ReadonlyArray<string>;
    readonly workspaceRevision: number;
    readonly revision: number;
    readonly state:
      | { readonly _tag: "Pending" }
      | { readonly _tag: "Submitted"; readonly selectedWorkId: string };
  };
  readonly workspace:
    | {
        readonly currentWorkId: string | null;
        readonly revision: number;
      }
    | undefined;
  readonly step:
    | (Omit<
        Pick<
          AgentLoopStepRecord,
          | "providerTurnId"
          | "state"
          | "nextActionIndex"
          | "manifestId"
          | "decodedOutputHash"
          | "modelOutputSessionSequence"
        >,
        "providerTurnId"
      > & { readonly providerTurnId: string })
    | undefined;
  readonly pendingAction:
    | Pick<
        AgentLoopStepActionRecord,
        "actionIndex" | "routeKind" | "actionKind" | "state"
      >
    | undefined;
  readonly providerTurnId: string;
  readonly providerResult:
    | { readonly _tag: "SettledSuccess"; readonly manifestId: string }
    | undefined;
}

/** A terminal DecisionRequest may be reused only to recover this exact
 * already-pinned SelectCurrentWork action. All new or otherwise ambiguous
 * DecisionEpisodes remain Pending-only. */
export const isPinnedSubmittedDecisionReplay = (
  input: SubmittedDecisionReplayInput,
): boolean => {
  const { request, episode, workspace, step, pendingAction, providerResult } =
    input;
  const selectedWorkId =
    request.state._tag === "Submitted"
      ? request.state.selectedWorkId
      : undefined;
  return (
    request.state._tag === "Submitted" &&
    request.workspaceId === input.executionWorkspaceId &&
    request.revision === episode.requestRevision + 1 &&
    selectedWorkId !== undefined &&
    request.candidateWorkIds.includes(selectedWorkId) &&
    workspace?.currentWorkId === selectedWorkId &&
    workspace.revision === request.workspaceRevision + 1 &&
    step !== undefined &&
    step.providerTurnId === input.providerTurnId &&
    step.state === "ActionsInProgress" &&
    step.manifestId !== undefined &&
    step.decodedOutputHash !== undefined &&
    step.modelOutputSessionSequence !== undefined &&
    pendingAction !== undefined &&
    pendingAction.actionIndex === step.nextActionIndex &&
    pendingAction.routeKind === "Control" &&
    pendingAction.actionKind === "select_current_work" &&
    pendingAction.state === "Pending" &&
    providerResult?._tag === "SettledSuccess" &&
    providerResult.manifestId === step.manifestId
  );
};

/** Root conversation shares the Workspace primary Session with Work episodes.
 * Only timeline items causally written by the exact conversation execution may
 * re-enter its next turn; all historical Work/tool traffic stays excluded. */
const belongsToConversationExecution = (
  entry: SessionEntryRecord,
  executionId: string,
): boolean => {
  const source = entry.source;
  if (source === undefined) return false;
  const providerTurnPrefix = `ptn_${executionId}_`;
  if (
    (source.kind === "ProviderTurn" || source.kind === "ProviderTurnCall") &&
    source.ref.startsWith(providerTurnPrefix)
  ) {
    return true;
  }
  return (
    source.kind === "AgentLoopAction" &&
    source.ref.startsWith(`observation_${executionId}_`)
  );
};

export const runModelDecision = (
  dependencies: ModelDecisionDependencies,
  turn: number,
  activity: ExecutionActivity,
): Effect.Effect<ModelDecisionOutcome, ExecutionDriverError> => {
  const {
    input,
    agentBinding,
    capability,
    currentControlBasis,
    modelContext,
    providerRuntime,
    tx,
    loopSteps,
    loopStepFence,
    providerTurns,
    sessions,
    humanMessages,
    turnProfileResolver,
    responseJobs,
    works,
    localPlans,
    decisionRequests,
    workspaces,
    workspaceKnowledge,
    workspacePlacement,
    options,
    admit,
    failure,
    now,
    leaseGeneration,
  } = dependencies;
  return Effect.gen(function* () {
    let repairAttempt = 0;
    let compactionAttempts = 0;
    let overflowRecoveryAttempt = 0;
    let overflowReplacementProviderTurnId:
      | import("@arbor/domain").ProviderTurnId
      | undefined;
    let repairFragments: ReadonlyArray<InstructionFragment> = [];
    while (true) {
      const controlBasis = yield* currentControlBasis();
      const providerTurnId =
        overflowReplacementProviderTurnId ??
        ((repairAttempt === 0
          ? `ptn_${input.execution.executionId}_${turn}`
          : `ptn_${input.execution.executionId}_${turn}_r${repairAttempt}`) as never);
      const loopStepIdentity = {
        executionId: input.execution.executionId,
        logicalStepNo: turn,
        repairAttempt,
      } as const;
      let loopStep: AgentLoopStepRecord | undefined;
      if (loopSteps !== undefined && loopStepFence !== undefined) {
        loopStep = yield* tx
          .transact(
            Effect.gen(function* () {
              const existing = yield* loopSteps.find(loopStepIdentity);
              if (Option.isSome(existing)) return existing.value;
              return yield* loopSteps.createPrepared(
                {
                  identity: loopStepIdentity,
                  providerTurnId,
                  state: "Prepared",
                  nextActionIndex: 0,
                  revision: 0,
                  updatedAt: yield* now(),
                },
                loopStepFence,
              );
            }),
          )
          .pipe(Effect.mapError(failure));
        if (
          loopStep.state === "SettlementProposed" &&
          loopStep.settlement !== undefined
        ) {
          return {
            _tag: "Settle",
            settlement: loopStep.settlement,
          };
        }
      }
      const proposeSettlement = (
        settlement: ExecutionSettlement,
      ): Effect.Effect<ModelDecisionOutcome, ExecutionDriverError> =>
        Effect.gen(function* () {
          if (
            loopStep !== undefined &&
            loopSteps !== undefined &&
            loopStepFence !== undefined &&
            loopStep.state === "Prepared"
          ) {
            const preparedStep = loopStep;
            if (
              settlement._tag === "Failed" &&
              options.qualificationProbe !== undefined
            ) {
              yield* Effect.promise(
                () =>
                  options.qualificationProbe?.({
                    boundary: "AH4BeforeSettlementProposal",
                    providerTurnId,
                  }) ?? Promise.resolve(),
              );
            }
            loopStep = yield* tx
              .transact(
                Effect.gen(function* () {
                  if (
                    settlement._tag === "Failed" &&
                    settlement.failure.reason.startsWith("ProviderFailure:") &&
                    providerTurns !== undefined
                  ) {
                    const dangling =
                      yield* providerTurns.findUnsettledByTurn(providerTurnId);
                    if (dangling !== null) {
                      yield* providerTurns.failTurn(
                        providerTurnId,
                        yield* now(),
                      );
                    }
                  }
                  return yield* loopSteps.transition(
                    {
                      identity: preparedStep.identity,
                      expectedRevision: preparedStep.revision,
                      expectedState: "Prepared",
                      next: {
                        ...preparedStep,
                        state: "SettlementProposed",
                        settlement,
                        revision: preparedStep.revision + 1,
                        updatedAt: yield* now(),
                      },
                    },
                    loopStepFence,
                  );
                }),
              )
              .pipe(Effect.mapError(failure));
            if (
              settlement._tag === "Failed" &&
              options.qualificationProbe !== undefined
            ) {
              yield* Effect.promise(
                () =>
                  options.qualificationProbe?.({
                    boundary: "AH4AfterSettlementProposal",
                    providerTurnId,
                  }) ?? Promise.resolve(),
              );
            }
          }
          return { _tag: "Settle", settlement };
        });
      // EGP: only an exact ConversationResponseEpisode can open conversation
      // history. A generic Workspace execution never implies conversation.
      const conversationMessages: Array<{
        readonly role: "user" | "assistant";
        readonly text: string;
      }> = [];
      const conversationContextRefs: Array<string> = [];
      const exactConversation = conversationResponseEpisode(input.execution);
      const history =
        exactConversation !== null
          ? yield* tx
              .transact(
                humanMessages.listForWorkspace(input.execution.workspaceId),
              )
              .pipe(Effect.mapError(failure))
          : [];
      let claimed = history.find(
        (message) =>
          message.claimedByExecutionId === String(input.execution.executionId),
      );
      if (exactConversation !== null) {
        const message = yield* tx
          .transact(humanMessages.findById(exactConversation.messageId))
          .pipe(Effect.mapError(failure));
        if (Option.isSome(message)) claimed = message.value;
      }
      const conversationExecution = exactConversation !== null;
      const placementExecution =
        conversationExecution ||
        executionEpisode(input.execution)?._tag === "InboxEpisode";
      if (conversationExecution) {
        const responseJobRows =
          responseJobs === undefined
            ? []
            : yield* tx
                .transact(
                  responseJobs.listForWorkspace(input.execution.workspaceId),
                )
                .pipe(Effect.mapError(failure));
        const responseJobsByMessage = new Map(
          responseJobRows.map((job) => [String(job.messageId), job] as const),
        );
        for (const message of history) {
          const responseJob = responseJobsByMessage.get(message.messageId);
          const responseBody =
            responseJob?.state._tag === "Answered"
              ? responseJob.state.responseBody
              : responseJob === undefined &&
                  message.state === "Answered" &&
                  message.responseBody !== null
                ? message.responseBody
                : null;
          if (responseBody !== null) {
            conversationMessages.push({
              role: "user",
              text: message.bodyRef,
            });
            conversationMessages.push({
              role: "assistant",
              text: responseBody,
            });
          }
        }
        if (claimed !== undefined) {
          conversationMessages.push({
            role: "user",
            text: claimed.bodyRef,
          });
          conversationContextRefs.push(`human-input:${claimed.messageId}`);
        }
      }
      // A Human Conversation has its own durable history above. The primary
      // Workspace Session is the execution timeline for non-conversation episodes and
      // may contain tool calls, observations, or a dangling invocation from a
      // completely different episode. Letting that timeline participate here
      // both leaks technical Work context into chat and can block a harmless
      // conversation on an unrelated invocation. Start from an empty Session
      // projection; answered HumanMessages + the claimed message are the sole
      // conversation continuity source.
      const recentTimeline = yield* tx
        .transact(
          sessions.listRecentEntries(
            input.execution.sessionId,
            SESSION_TIMELINE_ENTRY_LIMIT,
          ),
        )
        .pipe(Effect.mapError(failure));
      let recentSessionEntries = conversationExecution
        ? recentTimeline.filter((entry) =>
            belongsToConversationExecution(entry, input.execution.executionId),
          )
        : recentTimeline;
      let projectionDecision = decideSessionProjection(recentSessionEntries);
      if (
        projectionDecision._tag === "Blocked" &&
        loopStepFence !== undefined &&
        (yield* tx
          .transact(sessions.supportsTypedTimeline())
          .pipe(Effect.mapError(failure)))
      ) {
        const unresolved = projectionDecision.callRefs.map((callRef) => {
          const entry = recentSessionEntries.find(
            (candidate) =>
              candidate.entryKind === "ModelOutput" &&
              typeof candidate.payload === "object" &&
              candidate.payload !== null &&
              (candidate.payload as { readonly _tag?: unknown })._tag ===
                "ToolCall" &&
              (candidate.payload as { readonly callRef?: unknown }).callRef ===
                callRef,
          );
          if (entry === undefined) return undefined;
          const payload = entry.payload as {
            readonly providerTurnId?: unknown;
            readonly callRef: string;
            readonly toolRef?: unknown;
          };
          return typeof payload.providerTurnId === "string" &&
            payload.providerTurnId !== providerTurnId
            ? {
                callRef: payload.callRef,
                toolName:
                  typeof payload.toolRef === "string"
                    ? payload.toolRef
                    : "unknown",
              }
            : undefined;
        });
        if (
          unresolved.length > 0 &&
          unresolved.every(
            (entry): entry is NonNullable<typeof entry> => entry !== undefined,
          )
        ) {
          const repairSession = yield* tx
            .transact(sessions.findById(input.execution.sessionId))
            .pipe(Effect.mapError(failure));
          if (Option.isNone(repairSession)) {
            return {
              _tag: "Settle" as const,
              settlement: safetyStop("SessionContextBlocked:SessionNotFound"),
            };
          }
          for (const invocation of unresolved) {
            const observationRef = `observation_${sha256Hex(
              `session-frontier-repair:${input.execution.sessionId}:${invocation.callRef}`,
            )}`;
            const item = {
              _tag: "ToolResult" as const,
              callRef: invocation.callRef,
              toolName: invocation.toolName,
              status: "Interrupted" as const,
              observationRef,
              modelOutputRef: `result_${sha256Hex(observationRef)}`,
              outputText:
                "tool invocation interrupted when its originating execution ended",
              truncated: false,
              artifactRefs: [],
            };
            yield* tx
              .transact(
                sessions.appendItemIdempotent(
                  input.execution.sessionId,
                  {
                    item,
                    contextEpoch: repairSession.value.contextEpoch,
                    source: {
                      kind: "SessionFrontierRepair",
                      ref: observationRef,
                    },
                    contentHash: sha256Hex(JSON.stringify(item)),
                  },
                  loopStepFence,
                ),
              )
              .pipe(Effect.mapError(failure));
          }
          recentSessionEntries = yield* tx
            .transact(
              sessions.listRecentEntries(
                input.execution.sessionId,
                SESSION_TIMELINE_ENTRY_LIMIT,
              ),
            )
            .pipe(Effect.mapError(failure));
          projectionDecision = decideSessionProjection(recentSessionEntries);
        }
      }
      let sessionProjection: SessionTimelineProjection;
      if (projectionDecision._tag === "Blocked") {
        const settledForRecovery =
          loopStep !== undefined && providerTurns !== undefined
            ? yield* tx
                .transact(providerTurns.findSettledResult(providerTurnId))
                .pipe(Effect.mapError(failure))
            : undefined;
        if (settledForRecovery?._tag === "SettledSuccess") {
          const lastClosed = projectionDecision.closedFrontier.lastSequence;
          sessionProjection = projectSessionTimeline(
            lastClosed === null
              ? []
              : recentSessionEntries.filter(
                  (entry) => entry.sequence <= lastClosed,
                ),
          );
        } else {
          const settlement = safetyStop(
            `SessionContextBlocked:${projectionDecision.reason}:${projectionDecision.callRefs.join(",")}`,
          );
          if (
            loopStep !== undefined &&
            loopSteps !== undefined &&
            loopStepFence !== undefined &&
            loopStep.state === "Prepared"
          ) {
            yield* tx
              .transact(
                loopSteps.transition(
                  {
                    identity: loopStep.identity,
                    expectedRevision: loopStep.revision,
                    expectedState: "Prepared",
                    next: {
                      ...loopStep,
                      state: "SettlementProposed",
                      settlement,
                      revision: loopStep.revision + 1,
                      updatedAt: yield* now(),
                    },
                  },
                  loopStepFence,
                ),
              )
              .pipe(Effect.mapError(failure));
          }
          return { _tag: "Settle", settlement };
        }
      } else {
        sessionProjection = projectionDecision.projection;
      }
      const sessionRecord = yield* tx
        .transact(sessions.findById(input.execution.sessionId))
        .pipe(Effect.mapError(failure));
      if (Option.isNone(sessionRecord)) {
        return yield* Effect.fail(
          failure({
            _tag: "SessionContextMissing",
            sessionId: input.execution.sessionId,
          }),
        );
      }
      const stepContext = makeAgentStepContext({
        logicalStepNo: turn,
        repairAttempt,
        sessionId: input.execution.sessionId,
        contextEpoch: sessionRecord.value.contextEpoch,
        controlBasis,
        bindingFingerprint:
          capability.bindingFingerprint ??
          `legacy:${capability.providerRef ?? options.providerRef ?? "provider"}:${capability.modelRef}`,
        inputFrontier: sessionProjection.frontier,
      });
      const inputItems = [
        ...conversationMessages.map((message) => ({
          _tag: "Message" as const,
          role: message.role,
          text: message.text,
        })),
        ...sessionProjection.inputItems,
      ];
      const messageContextRefs = [
        ...conversationContextRefs,
        ...sessionProjection.contextRefs,
      ];
      const workspace = yield* tx
        .transact(workspaces.findById(input.execution.workspaceId))
        .pipe(Effect.mapError(failure));
      if (Option.isNone(workspace)) {
        return yield* Effect.fail(
          failure({
            _tag: "WorkspaceContextMissing",
            workspaceId: input.execution.workspaceId,
          }),
        );
      }
      if (workspaceKnowledge !== undefined) {
        const knowledge = yield* workspaceKnowledge
          .load(input.execution.workspaceId)
          .pipe(Effect.mapError(failure));
        if (knowledge.entries.length > 0) {
          inputItems.push({
            _tag: "ContextUpdate",
            sourceRef: `workspace-knowledge:${input.execution.workspaceId}`,
            revision: Number(workspace.value.revision),
            updateKind: "Full",
            text: JSON.stringify({
              scope: "accepted-workspace-knowledge",
              provenance: "CanonicalAcceptance",
              entries: knowledge.entries,
            }),
          });
          messageContextRefs.push(
            `workspace-knowledge:${input.execution.workspaceId}:${knowledge.fingerprint}`,
          );
        }
      }
      if (placementExecution && workspacePlacement !== undefined) {
        const placement = yield* workspacePlacement
          .list({ rootWorkspaceId: input.execution.workspaceId })
          .pipe(Effect.mapError(failure));
        inputItems.push({
          _tag: "ContextUpdate",
          sourceRef: `workspace-placement:${input.execution.workspaceId}`,
          revision: Number(workspace.value.revision),
          updateKind: "Full",
          text: JSON.stringify({
            scope: "workspace-placement",
            current: placement.current,
            directChildren: placement.directChildren,
            inFlightFormations: placement.inFlightFormations,
            nextCursor: placement.nextCursor,
          }),
        });
        messageContextRefs.push(
          `workspace-placement:${input.execution.workspaceId}:${placement.fingerprint}`,
        );
      }
      let currentWork: import("@arbor/domain").Work | null = null;
      const boundWork = workEpisode(input.execution);
      if (boundWork !== null) {
        const work = yield* tx
          .transact(works.findById(boundWork.workId))
          .pipe(Effect.mapError(failure));
        if (Option.isNone(work)) {
          return yield* Effect.fail(
            failure({
              _tag: "WorkContextMissing",
              workId: boundWork.workId,
            }),
          );
        }
        currentWork = work.value;
        if (
          localPlans !== undefined &&
          executionEpisode(input.execution)?._tag === "WorkEpisode"
        ) {
          const plan = yield* tx
            .transact(localPlans.findByWork(boundWork.workId))
            .pipe(Effect.mapError(failure));
          if (
            Option.isSome(plan) &&
            plan.value.targetWorkRevision === currentWork.revision
          ) {
            inputItems.push({
              _tag: "ContextUpdate",
              sourceRef: `local-plan:${boundWork.workId}`,
              revision: plan.value.revision,
              updateKind: "Full",
              text: JSON.stringify({
                scope: "progress-only",
                items: plan.value.items,
              }),
            });
            messageContextRefs.push(
              `local-plan:${boundWork.workId}:${String(plan.value.revision)}`,
            );
          }
        }
      }
      const workContext = assembleWorkContext(
        workspace.value,
        currentWork,
        input.execution,
      );
      const conversationActionAsset =
        GENERIC_INSTRUCTION_ASSETS.rootConversationAction;
      const conversationActionFragments = conversationExecution
        ? [
            instructionAssetFragment(
              "root-conversation-action",
              conversationActionAsset,
            ),
          ]
        : [];
      const instructionContents = new Map(workContext.contents);
      if (conversationExecution) {
        instructionContents.set(
          conversationActionAsset.contentRef,
          conversationActionAsset.text,
        );
      }
      const boundEpisode = executionEpisode(input.execution);
      if (
        boundEpisode?._tag === "DecisionEpisode" &&
        decisionRequests !== undefined
      ) {
        const request = yield* tx
          .transact(decisionRequests.findById(boundEpisode.decisionId))
          .pipe(Effect.mapError(failure));
        if (Option.isNone(request)) {
          return yield* proposeSettlement({
            _tag: "Failed",
            failure: {
              _tag: "ExecutionFailure",
              reason: "DecisionRequestMissingOrSettled",
            },
          });
        }
        let requestContextRevision = request.value.revision;
        if (request.value.state._tag !== "Pending") {
          const pinnedActions =
            loopStep !== undefined && loopSteps !== undefined
              ? yield* tx
                  .transact(loopSteps.listActions(loopStep.identity))
                  .pipe(Effect.mapError(failure))
              : [];
          const pendingSelectionAction = pinnedActions.find(
            (action) =>
              action.actionIndex === loopStep?.nextActionIndex &&
              action.routeKind === "Control" &&
              action.actionKind === "select_current_work" &&
              action.state === "Pending",
          );
          const pinnedProviderResult =
            loopStep !== undefined && providerTurns !== undefined
              ? yield* tx
                  .transact(
                    providerTurns.findSettledResult(loopStep.providerTurnId),
                  )
                  .pipe(Effect.mapError(failure))
              : undefined;
          const replayingPinnedSelection = isPinnedSubmittedDecisionReplay({
            executionWorkspaceId: String(input.execution.workspaceId),
            episode: boundEpisode,
            request: request.value,
            workspace: Option.isSome(workspace)
              ? {
                  currentWorkId:
                    workspace.value.currentWorkId === null
                      ? null
                      : String(workspace.value.currentWorkId),
                  revision: Number(workspace.value.revision),
                }
              : undefined,
            step: loopStep,
            pendingAction: pendingSelectionAction,
            providerTurnId: String(providerTurnId),
            providerResult:
              pinnedProviderResult?._tag === "SettledSuccess"
                ? {
                    _tag: "SettledSuccess",
                    manifestId: String(pinnedProviderResult.manifestId),
                  }
                : undefined,
          });
          if (!replayingPinnedSelection) {
            return yield* proposeSettlement({
              _tag: "Failed",
              failure: {
                _tag: "ExecutionFailure",
                reason: "DecisionRequestMissingOrSettled",
              },
            });
          }
          // The submitted canonical request is the result of this exact
          // pinned SelectCurrentWork Action. Rebuild its original decision
          // context only long enough to replay the settled Provider result;
          // no new Provider request or action is admitted from this snapshot.
          requestContextRevision = boundEpisode.requestRevision;
        }
        inputItems.push({
          _tag: "ContextUpdate",
          sourceRef: `decision-request:${boundEpisode.decisionId}`,
          revision: requestContextRevision,
          updateKind: "Full",
          text: JSON.stringify({
            decisionKind: "SelectCurrentWork",
            candidateWorkIds: request.value.candidateWorkIds,
            workspaceRevision: request.value.workspaceRevision,
          }),
        });
        messageContextRefs.push(
          `decision-request:${boundEpisode.decisionId}:${String(requestContextRevision)}`,
        );
      }
      const turnProfile = yield* turnProfileResolver
        .resolve({
          execution: input.execution,
          conversation:
            conversationExecution && conversationMessages.length > 0,
        })
        .pipe(Effect.mapError(failure));
      const prepared = yield* Effect.match(
        modelContext.prepareTurn({
          executionId: input.execution.executionId,
          sessionId: input.execution.sessionId,
          contextEpoch: stepContext.contextEpoch,
          providerTurnId,
          binding: agentBinding,
          workspaceId: input.execution.workspaceId,
          cognitiveMode: input.agentExecutionState.currentMode ?? "execute",
          program: GENERIC_COGNITION_PROGRAM,
          fragments: [
            runtimeSafetyFragment,
            ...workContext.fragments,
            ...conversationActionFragments,
            ...repairFragments,
          ],
          contextFragments: [],
          budget: {
            modelWindow: capability.contextWindow,
            outputReserve: capability.outputCeiling,
            protocolReserve: 100,
            toolReserve: 100,
          },
          controlBasis,
          maxOutputTokens: capability.outputCeiling,
          bodySkillIds: [],
          turnProfile,
          instructionContents,
          stepContext,
          ...(inputItems.length > 0 ? { inputItems } : {}),
          ...(messageContextRefs.length > 0 ? { messageContextRefs } : {}),
          ...(options.providerRef !== undefined
            ? { providerRef: options.providerRef }
            : {}),
        }),
        {
          onFailure: (cause) => ({ ok: false as const, cause }),
          onSuccess: (value) => ({ ok: true as const, value }),
        },
      );
      if (!prepared.ok) {
        if (prepared.cause._tag === "ContextUnsatisfiable") {
          return yield* proposeSettlement({
            _tag: "Failed",
            failure: {
              _tag: "ExecutionFailure",
              reason: "ContextUnsatisfiable",
            },
          });
        }
        return yield* Effect.fail(failure(prepared.cause));
      }
      const preparation = prepared.value;

      if (preparation._tag === "GovernanceBlocked") {
        return yield* proposeSettlement(safetyStop("GovernanceBlocked"));
      }
      if (preparation._tag === "NeedsCompaction") {
        if (loopStepFence === undefined) {
          return yield* Effect.fail(
            failure({
              _tag: "CompactionFenceUnavailable",
              executionId: input.execution.executionId,
            }),
          );
        }
        if (compactionAttempts >= 1) {
          return yield* proposeSettlement(safetyStop("CompactionNoGain"));
        }
        compactionAttempts += 1;
        yield* runCompaction(
          {
            execution: input.execution,
            logicalStepNo: turn,
            currentEpoch: stepContext.contextEpoch,
            modelRef: capability.modelRef,
            bindingFingerprint: stepContext.bindingFingerprint,
            inputItems,
            fence: loopStepFence,
            nativeSupported:
              capability.portableRequestCompatibility?.operationKinds.includes(
                "CompactionNative",
              ) === true,
          },
          { providerRuntime, sessions, tx },
        ).pipe(Effect.mapError(failure));
        continue;
      }

      const turnInput: ProviderRunInput = {
        providerTurnId: preparation.turn.manifest.providerTurnId,
        executionId: input.execution.executionId,
        sessionId: input.execution.sessionId,
        contextEpoch: preparation.turn.manifest.contextEpoch,
        modelRef: capability.modelRef,
        outputContractRef: preparation.turn.manifest.outputContractRef,
        ...(options.onProviderProgress !== undefined
          ? {
              onProgress: (
                event: import("@arbor/ports").ProviderRuntimeProgress,
              ) => {
                options.onProviderProgress?.(
                  String(input.execution.executionId),
                  event,
                );
              },
            }
          : {}),
        manifestJson: JSON.stringify(preparation.turn.manifest),
        request: preparation.turn.request,
        ...(options.secretRef !== undefined
          ? { secretRef: options.secretRef }
          : {}),
        ...(options.executionPolicyOverrides !== undefined
          ? {
              executionPolicyOverrides: options.executionPolicyOverrides,
            }
          : {}),
      };
      if (
        loopStep !== undefined &&
        loopSteps !== undefined &&
        loopStepFence !== undefined &&
        providerTurns !== undefined &&
        loopStep.state !== "OutputRejected"
      ) {
        const durableLoopSteps = loopSteps;
        const durableFence = loopStepFence;
        const settled = yield* tx
          .transact(
            providerTurns.findSettledResult(
              preparation.turn.manifest.providerTurnId,
            ),
          )
          .pipe(Effect.mapError(failure));
        if (settled._tag === "SettledSuccess") {
          let persistedManifest: typeof preparation.turn.manifest;
          try {
            persistedManifest = JSON.parse(
              settled.manifestJson,
            ) as typeof preparation.turn.manifest;
          } catch {
            return yield* Effect.fail(
              failure({
                _tag: "AgentLoopStepReplayManifestInvalid",
              }),
            );
          }
          if (
            settled.turn.executionId !== input.execution.executionId ||
            settled.turn.sessionId !== input.execution.sessionId ||
            settled.turn.contextEpoch !==
              preparation.turn.manifest.contextEpoch ||
            persistedManifest.providerTurnId !== settled.turn.providerTurnId ||
            persistedManifest.executionId !== settled.turn.executionId ||
            persistedManifest.sessionId !== settled.turn.sessionId ||
            persistedManifest.contextEpoch !== settled.turn.contextEpoch ||
            persistedManifest.modelRef !== settled.turn.modelRef ||
            persistedManifest.outputContractRef !==
              settled.turn.outputContractRef
          ) {
            return yield* Effect.fail(
              failure({
                _tag: "AgentLoopStepReplayBindingMismatch",
              }),
            );
          }
          const decoded = decodeTurn(settled.canonicalEvents);
          if (
            settled.evidenceVersion === "legacy-success-v1" &&
            (!decoded.ok || decoded.output.toolInvocations.length > 0)
          ) {
            return yield* Effect.fail(
              failure({
                _tag: "LegacyProviderResultRequiresAttention",
                reason: decoded.ok
                  ? "legacy output contains actions"
                  : decoded.reason,
              }),
            );
          }
          if (loopStep.state === "Prepared") {
            const preparedStep = loopStep;
            if (
              settled.evidenceVersion === "legacy-success-v1" &&
              options.qualificationProbe !== undefined
            ) {
              yield* Effect.promise(
                () =>
                  options.qualificationProbe?.({
                    boundary: "AH14BeforeLegacyAdoptionCommit",
                    providerTurnId: settled.turn.providerTurnId,
                    executionId: input.execution.executionId,
                  }) ?? Promise.resolve(),
              );
            }
            loopStep = yield* tx
              .transact(
                Effect.gen(function* () {
                  if (settled.evidenceVersion === "legacy-success-v1") {
                    yield* providerTurns.adoptSettledSuccessEvidence(
                      settled.turn.providerTurnId,
                      settled.attemptNo,
                      "legacy-success-v1",
                      "provider-success-v1",
                    );
                  }
                  return yield* durableLoopSteps.transition(
                    {
                      identity: preparedStep.identity,
                      expectedRevision: preparedStep.revision,
                      expectedState: "Prepared",
                      next: {
                        ...preparedStep,
                        manifestId: settled.manifestId,
                        state: "ProviderResultAvailable",
                        decoderVersion: "decode-turn-v1",
                        ...(settled.evidenceVersion === "legacy-success-v1"
                          ? {
                              migrationProvenance: {
                                _tag: "LegacySettledProviderSuccess",
                                evidenceVersion: settled.evidenceVersion,
                              },
                            }
                          : {}),
                        revision: preparedStep.revision + 1,
                        updatedAt: yield* now(),
                      },
                    },
                    durableFence,
                  );
                }),
              )
              .pipe(Effect.mapError(failure));
            if (
              settled.evidenceVersion === "legacy-success-v1" &&
              options.qualificationProbe !== undefined
            ) {
              yield* Effect.promise(
                () =>
                  options.qualificationProbe?.({
                    boundary: "AH14AfterLegacyAdoptionCommit",
                    providerTurnId: settled.turn.providerTurnId,
                    executionId: input.execution.executionId,
                  }) ?? Promise.resolve(),
              );
            }
          }
          if (decoded.ok) {
            return {
              _tag: "Ready",
              turn: {
                ...preparation.turn,
                manifest: persistedManifest,
                toolRoutes: persistedManifest.toolRoutes,
              },
              output: decoded.output,
              loopStep,
              ...(conversationExecution ? { conversation: true } : {}),
            };
          }
        } else if (settled._tag === "SettledFailure") {
          if (
            settled.turn.executionId !== input.execution.executionId ||
            settled.turn.sessionId !== input.execution.sessionId ||
            settled.turn.contextEpoch !== preparation.turn.manifest.contextEpoch
          ) {
            return yield* Effect.fail(
              failure({
                _tag: "AgentLoopStepReplayBindingMismatch",
              }),
            );
          }
          const settlement: ExecutionSettlement =
            settled.finishReason === "Cancelled"
              ? {
                  _tag: "Interrupted",
                  result: {
                    _tag: "ControlledInterruption",
                    reason: "ProviderTurnSettled:Cancelled",
                  },
                }
              : {
                  _tag: "Failed",
                  failure: {
                    _tag: "ExecutionFailure",
                    reason: `ProviderTurnSettled:${settled.finishReason}`,
                  },
                };
          if (loopStep.state === "Prepared") {
            const failedStep = loopStep;
            yield* tx
              .transact(
                durableLoopSteps.transition(
                  {
                    identity: failedStep.identity,
                    expectedRevision: failedStep.revision,
                    expectedState: "Prepared",
                    next: {
                      ...failedStep,
                      state: "SettlementProposed",
                      settlement,
                      revision: failedStep.revision + 1,
                      updatedAt: yield* now(),
                    },
                  },
                  durableFence,
                ),
              )
              .pipe(Effect.mapError(failure));
          }
          return { _tag: "Settle", settlement };
        } else if (settled._tag === "SettledEvidenceInvalid") {
          return yield* Effect.fail(
            failure({
              _tag: "SettledProviderEvidenceInvalid",
              reason: settled.reason,
            }),
          );
        }
      }
      const providerResult = yield* Effect.match(
        providerRuntime.runTurn(turnInput),
        {
          onFailure: (cause) => ({ ok: false as const, cause }),
          onSuccess: (value) => ({ ok: true as const, value }),
        },
      );
      if (!providerResult.ok) {
        if (isProviderTurnBindingChanged(providerResult.cause)) {
          return yield* proposeSettlement(
            providerTurnBindingChangedSettlement(),
          );
        }
        if (isProviderExecutionTimeout(providerResult.cause)) {
          return yield* proposeSettlement(
            providerExecutionTimeoutSettlement(providerResult.cause),
          );
        }
        if (
          typeof providerResult.cause === "object" &&
          providerResult.cause !== null &&
          "_tag" in providerResult.cause &&
          providerResult.cause._tag === "ProviderFailure" &&
          "kind" in providerResult.cause &&
          providerResult.cause.kind === "ContextLimitExceeded" &&
          overflowRecoveryAttempt === 0 &&
          loopStepFence !== undefined &&
          loopStep !== undefined &&
          loopSteps !== undefined
        ) {
          const overflowStep = loopStep;
          const overflowFence = loopStepFence;
          const overflowSteps = loopSteps;
          const observedAt = yield* now();
          if (providerTurns !== undefined) {
            const existingTurn = yield* tx
              .transact(providerTurns.findUnsettledByTurn(providerTurnId))
              .pipe(Effect.mapError(failure));
            if (existingTurn !== null) {
              yield* tx
                .transact(providerTurns.failTurn(providerTurnId, observedAt))
                .pipe(Effect.mapError(failure));
            }
          }
          const nativeSupported =
            capability.portableRequestCompatibility?.operationKinds.includes(
              "CompactionNative",
            ) === true;
          const compactTurnId =
            `${input.execution.executionId}_${turn}_${nativeSupported ? "native_" : ""}compact_${stepContext.contextEpoch}` as never;
          yield* tx
            .transact(
              Effect.gen(function* () {
                yield* overflowSteps.ensureProviderTurnLink(
                  {
                    identity: overflowStep.identity,
                    overflowOrdinal: 0,
                    role: "Inference",
                    providerTurnId,
                    contextEpoch: stepContext.contextEpoch,
                    state: "SettledFailure",
                    createdAt: observedAt,
                  },
                  overflowFence,
                );
                yield* overflowSteps.ensureProviderTurnLink(
                  {
                    identity: overflowStep.identity,
                    overflowOrdinal: 0,
                    role: "OverflowCompaction",
                    providerTurnId: `ptn_${compactTurnId}` as never,
                    predecessorProviderTurnId: providerTurnId,
                    contextEpoch: stepContext.contextEpoch,
                    state: "Prepared",
                    createdAt: observedAt,
                  },
                  overflowFence,
                );
              }),
            )
            .pipe(Effect.mapError(failure));
          const compacted = yield* runCompaction(
            {
              execution: input.execution,
              logicalStepNo: turn,
              currentEpoch: stepContext.contextEpoch,
              modelRef: capability.modelRef,
              bindingFingerprint: stepContext.bindingFingerprint,
              inputItems,
              fence: overflowFence,
              nativeSupported,
            },
            { providerRuntime, sessions, tx },
          ).pipe(Effect.mapError(failure));
          overflowReplacementProviderTurnId =
            `ptn_${input.execution.executionId}_${turn}_overflow_0` as never;
          yield* tx
            .transact(
              overflowSteps.ensureProviderTurnLink(
                {
                  identity: overflowStep.identity,
                  overflowOrdinal: 0,
                  role: "OverflowReplacement",
                  providerTurnId: overflowReplacementProviderTurnId,
                  predecessorProviderTurnId: compacted.providerTurnId,
                  contextEpoch: compacted.newEpoch,
                  state: "Prepared",
                  createdAt: yield* now(),
                },
                overflowFence,
              ),
            )
            .pipe(Effect.mapError(failure));
          overflowRecoveryAttempt = 1;
          continue;
        }
        if (isProviderFailure(providerResult.cause)) {
          return yield* proposeSettlement(
            providerFailureSettlement(providerResult.cause),
          );
        }
        return yield* Effect.fail(failure(providerResult.cause));
      }
      const providerRun = providerResult.value;
      const events = providerRun.events;
      if (
        loopStep !== undefined &&
        loopSteps !== undefined &&
        loopStepFence !== undefined
      ) {
        const settled =
          providerTurns === undefined
            ? undefined
            : yield* tx
                .transact(providerTurns.findSettledResult(providerTurnId))
                .pipe(Effect.mapError(failure));
        if (
          settled?._tag === "SettledSuccess" &&
          options.qualificationProbe !== undefined
        ) {
          yield* Effect.promise(
            () =>
              options.qualificationProbe?.({
                boundary: "AH3BeforeStepAvailable",
                providerTurnId,
              }) ?? Promise.resolve(),
          );
        }
        loopStep = yield* tx
          .transact(
            loopSteps.transition(
              {
                identity: loopStep.identity,
                expectedRevision: loopStep.revision,
                expectedState: "Prepared",
                next: {
                  ...loopStep,
                  ...(settled?._tag === "SettledSuccess"
                    ? { manifestId: settled.manifestId }
                    : {}),
                  state: "ProviderResultAvailable",
                  decoderVersion: "decode-turn-v1",
                  revision: loopStep.revision + 1,
                  updatedAt: yield* now(),
                },
              },
              loopStepFence,
            ),
          )
          .pipe(Effect.mapError(failure));
        if (options.qualificationProbe !== undefined) {
          yield* Effect.promise(
            () =>
              options.qualificationProbe?.({
                boundary: "AH3AfterStepAvailable",
                providerTurnId,
              }) ?? Promise.resolve(),
          );
        }
      }
      // D5: end-bracket the provider call (call completion). D1
      // (B-4): report the real ProviderAttempt ordinal observed by
      // ProviderRuntime, so the gate sees actual transient retries
      // (retry never creates a new ProviderTurn — DID §6A.9). The
      // end bracket is not a D4 turn boundary.
      if (leaseGeneration !== undefined || providerRun.attemptNo > 0) {
        const endDecision = yield* admit(activity, {
          retryCount: providerRun.attemptNo,
          inFlight: "end",
          ...(leaseGeneration !== undefined ? { leaseGeneration } : {}),
          observedAt: yield* now(),
        });
        if (endDecision === "Stop") {
          return {
            _tag: "Settle",
            settlement: safetyStop("RuntimeSafetyStop"),
          };
        }
      }
      const decoded = decodeTurn(events);
      if (decoded.ok) {
        return {
          _tag: "Ready",
          turn: preparation.turn,
          output: decoded.output,
          ...(loopStep === undefined ? {} : { loopStep }),
          ...(conversationExecution ? { conversation: true } : {}),
        };
      }
      const repair = decideRepair(
        REPAIR_POLICY,
        repairAttempt,
        preparation.turn.manifest.outputContractRef,
        decoded.reason,
      );
      if (repair._tag === "Exhausted") {
        if (
          loopStep !== undefined &&
          loopSteps !== undefined &&
          loopStepFence !== undefined &&
          loopStep.state === "ProviderResultAvailable"
        ) {
          const rejectedStep = loopStep;
          const outputRejected = yield* tx
            .transact(
              loopSteps.transition(
                {
                  identity: rejectedStep.identity,
                  expectedRevision: rejectedStep.revision,
                  expectedState: "ProviderResultAvailable",
                  next: {
                    ...rejectedStep,
                    state: "OutputRejected",
                    repairDisposition: {
                      _tag: "Exhausted",
                      settlement: repair.settlement,
                    },
                    revision: rejectedStep.revision + 1,
                    updatedAt: yield* now(),
                  },
                },
                loopStepFence,
              ),
            )
            .pipe(Effect.mapError(failure));
          if (
            repair.settlement._tag === "Failed" &&
            options.qualificationProbe !== undefined
          ) {
            yield* Effect.promise(
              () =>
                options.qualificationProbe?.({
                  boundary: "AH4RepairBeforeSettlementProposal",
                  providerTurnId,
                }) ?? Promise.resolve(),
            );
          }
          yield* tx
            .transact(
              loopSteps.transition(
                {
                  identity: outputRejected.identity,
                  expectedRevision: outputRejected.revision,
                  expectedState: "OutputRejected",
                  next: {
                    ...outputRejected,
                    state: "SettlementProposed",
                    settlement: repair.settlement,
                    revision: outputRejected.revision + 1,
                    updatedAt: yield* now(),
                  },
                },
                loopStepFence,
              ),
            )
            .pipe(Effect.mapError(failure));
          if (
            repair.settlement._tag === "Failed" &&
            options.qualificationProbe !== undefined
          ) {
            yield* Effect.promise(
              () =>
                options.qualificationProbe?.({
                  boundary: "AH4RepairAfterSettlementProposal",
                  providerTurnId,
                }) ?? Promise.resolve(),
            );
          }
        }
        return { _tag: "Settle", settlement: repair.settlement };
      }
      if (
        loopStep !== undefined &&
        loopSteps !== undefined &&
        loopStepFence !== undefined &&
        loopStep.state === "ProviderResultAvailable"
      ) {
        const rejectedStep = loopStep;
        const successorIdentity = {
          executionId: input.execution.executionId,
          logicalStepNo: turn,
          repairAttempt: repairAttempt + 1,
        } as const;
        const successorProviderTurnId =
          `ptn_${input.execution.executionId}_${turn}_r${repairAttempt + 1}` as never;
        yield* tx
          .transact(
            Effect.gen(function* () {
              yield* loopSteps.transition(
                {
                  identity: rejectedStep.identity,
                  expectedRevision: rejectedStep.revision,
                  expectedState: "ProviderResultAvailable",
                  next: {
                    ...rejectedStep,
                    state: "OutputRejected",
                    repairDisposition: {
                      _tag: "Retry",
                      successor: {
                        ...successorIdentity,
                        providerTurnId: successorProviderTurnId,
                      },
                    },
                    successor: {
                      ...successorIdentity,
                      providerTurnId: successorProviderTurnId,
                    },
                    revision: rejectedStep.revision + 1,
                    updatedAt: yield* now(),
                  },
                },
                loopStepFence,
              );
              yield* loopSteps.ensureSuccessor(
                rejectedStep.identity,
                {
                  identity: successorIdentity,
                  predecessor: rejectedStep.identity,
                  providerTurnId: successorProviderTurnId,
                  state: "Prepared",
                  nextActionIndex: 0,
                  revision: 0,
                  updatedAt: yield* now(),
                },
                loopStepFence,
              );
            }),
          )
          .pipe(Effect.mapError(failure));
      }
      repairFragments = [repair.repairFragment];
      repairAttempt += 1;
    }
  });
};
