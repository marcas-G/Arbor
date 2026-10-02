import type {
  AgentBinding,
  AgentExecutionState,
  Execution,
  ExecutionSettlement,
  LeaseGeneration,
} from "@arbor/domain";
import {
  type ControlBasis,
  decideSessionProjection,
  decodeTurn,
  GENERIC_COGNITION_PROGRAM,
  type InstructionFragment,
  type ModelContextService,
  projectSessionTimeline,
  type SessionTimelineProjection,
  type TurnProfileResolverService,
} from "@arbor/model-context";
import type {
  AgentLoopStepFence,
  AgentLoopStepRecord,
  AgentLoopStepStoreService,
  ConversationResponseJobStoreService,
  ExecutionActivity,
  ExecutionDriverError,
  HumanMessageStoreService,
  InboxProjectionStoreService,
  ModelCapability,
  ProviderExecutionPolicyOverrides,
  ProviderRunInput,
  ProviderRuntimeProgress,
  ProviderRuntimeService,
  ProviderTurnStoreService,
  RuntimeSafetyObservation,
  SecretRef,
  SessionRepositoryService,
  TransactionPortService,
  WorkRepositoryService,
  WorkspaceRepositoryService,
} from "@arbor/ports";
import { sha256Hex } from "@arbor/ports";
import { Effect, Option } from "effect";
import {
  isConversationExecution,
  isProviderExecutionTimeout,
  isProviderTurnBindingChanged,
  type ModelDecisionOutcome,
  providerExecutionTimeoutSettlement,
  providerTurnBindingChangedSettlement,
  REPAIR_POLICY,
  runtimeSafetyFragment,
  safetyStop,
} from "./agent-loop-policy.js";
import { runCompaction } from "./compaction-coordinator.js";
import { assembleInboxContext } from "./inbox-context.js";
import { decideRepair } from "./repair.js";
import { SESSION_CONTEXT_ENTRY_LIMIT } from "./session-context.js";
import { makeAgentStepContext } from "./step-context.js";
import { assembleWorkContext } from "./work-context.js";

export interface ModelDecisionOptions {
  readonly secretRef?: SecretRef;
  readonly executionPolicyOverrides?: ProviderExecutionPolicyOverrides;
  readonly providerRef?: string;
  readonly onProviderProgress?:
    | ((executionId: string, event: ProviderRuntimeProgress) => void)
    | undefined;
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
  readonly inbox?: InboxProjectionStoreService;
  readonly works: WorkRepositoryService;
  readonly workspaces: WorkspaceRepositoryService;
  readonly options: ModelDecisionOptions;
  readonly admit: (
    activity: ExecutionActivity,
    observation: RuntimeSafetyObservation,
  ) => Effect.Effect<"Continue" | "Stop">;
  readonly failure: (cause: unknown) => ExecutionDriverError;
  readonly now: () => Effect.Effect<string>;
  readonly leaseGeneration?: LeaseGeneration;
}

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
    inbox,
    works,
    workspaces,
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
      // P14 `02` (WAVE1 S02/S04): for a Coordination execution the
      // current claimed human message is the user turn; recent
      // answered turns carry conversation continuity.
      const conversationMessages: Array<{
        readonly role: "user" | "assistant";
        readonly text: string;
      }> = [];
      const conversationContextRefs: Array<string> = [];
      if (isConversationExecution(input.execution)) {
        const history = yield* tx
          .transact(humanMessages.listForWorkspace(input.execution.workspaceId))
          .pipe(
            Effect.mapError(
              (cause): ExecutionDriverError => ({
                _tag: "ExecutionDriverError",
                cause,
              }),
            ),
          );
        let claimed = history.find(
          (message) =>
            message.claimedByExecutionId ===
            String(input.execution.executionId),
        );
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
        if (responseJobs !== undefined) {
          const job = yield* tx
            .transact(responseJobs.findByExecution(input.execution.executionId))
            .pipe(Effect.mapError(failure));
          if (Option.isSome(job)) {
            const message = yield* tx
              .transact(humanMessages.findById(job.value.messageId))
              .pipe(Effect.mapError(failure));
            if (Option.isSome(message)) claimed = message.value;
          }
        }
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
      let recentSessionEntries = yield* tx
        .transact(
          sessions.listRecentEntries(
            input.execution.sessionId,
            SESSION_CONTEXT_ENTRY_LIMIT,
          ),
        )
        .pipe(Effect.mapError(failure));
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
                SESSION_CONTEXT_ENTRY_LIMIT,
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
      const inboxEntries =
        inbox === undefined
          ? []
          : yield* tx
              .transact(inbox.listUnconsumed(input.execution.workspaceId))
              .pipe(Effect.mapError(failure));
      const inboxContext = assembleInboxContext(inboxEntries);
      const messages: Array<{
        readonly role: "system" | "user" | "assistant" | "tool";
        readonly text: string;
      }> = [];
      messages.push(...inboxContext.messages);
      const inputItems = [
        ...conversationMessages.map((message) => ({
          _tag: "Message" as const,
          role: message.role,
          text: message.text,
        })),
        ...messages.map((message) => ({
          _tag: "Message" as const,
          role: message.role,
          text: message.text,
        })),
        ...sessionProjection.inputItems,
      ];
      const messageContextRefs = [
        ...conversationContextRefs,
        ...sessionProjection.contextRefs,
        ...inboxContext.contextRefs,
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
      let currentWork: import("@arbor/domain").Work | null = null;
      if (
        input.execution.binding._tag === "WorkspaceExecution" &&
        input.execution.binding.focus._tag === "Work"
      ) {
        const work = yield* tx
          .transact(works.findById(input.execution.binding.focus.workId))
          .pipe(Effect.mapError(failure));
        if (Option.isNone(work)) {
          return yield* Effect.fail(
            failure({
              _tag: "WorkContextMissing",
              workId: input.execution.binding.focus.workId,
            }),
          );
        }
        currentWork = work.value;
      }
      const workContext = assembleWorkContext(
        workspace.value,
        currentWork,
        input.execution,
      );
      const turnProfile = yield* turnProfileResolver
        .resolve({
          execution: input.execution,
          conversation:
            isConversationExecution(input.execution) &&
            conversationMessages.length > 0,
        })
        .pipe(Effect.mapError(failure));
      const preparation = yield* modelContext
        .prepareTurn({
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
          instructionContents: workContext.contents,
          stepContext,
          ...(inputItems.length > 0 ? { inputItems } : {}),
          ...(messageContextRefs.length > 0 ? { messageContextRefs } : {}),
          ...(options.providerRef !== undefined
            ? { providerRef: options.providerRef }
            : {}),
        })
        .pipe(
          Effect.mapError(
            (cause): ExecutionDriverError => ({
              _tag: "ExecutionDriverError",
              cause,
            }),
          ),
        );

      if (preparation._tag === "GovernanceBlocked") {
        return {
          _tag: "Settle",
          settlement: safetyStop("GovernanceBlocked"),
        };
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
          return yield* Effect.fail(
            failure({
              _tag: "CompactionNoGain",
              executionId: input.execution.executionId,
            }),
          );
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
              ...(conversationMessages.length > 0
                ? { conversation: true }
                : {}),
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
          return {
            _tag: "Settle",
            settlement: providerTurnBindingChangedSettlement(),
          };
        }
        if (isProviderExecutionTimeout(providerResult.cause)) {
          return {
            _tag: "Settle",
            settlement: providerExecutionTimeoutSettlement(
              providerResult.cause,
            ),
          };
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
          ...(conversationMessages.length > 0 ? { conversation: true } : {}),
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
