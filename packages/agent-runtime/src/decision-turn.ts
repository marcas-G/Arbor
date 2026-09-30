import type {
  AgentBinding,
  AgentExecutionState,
  Execution,
  ExecutionSettlement,
  LeaseGeneration,
} from "@arbor/domain";
import {
  type ControlBasis,
  decodeTurn,
  type InstructionFragment,
  type ModelContextService,
  TOOL_INVOCATION_CONTRACT,
  WORK_EXECUTION_PROGRAM,
} from "@arbor/model-context";
import type {
  AgentLoopStepFence,
  AgentLoopStepRecord,
  AgentLoopStepStoreService,
  ExecutionActivity,
  ExecutionDriverError,
  HumanMessageStoreService,
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
} from "@arbor/ports";
import { Effect, Option } from "effect";
import {
  type DecisionTurn,
  isConversationExecution,
  isProviderExecutionTimeout,
  isProviderTurnBindingChanged,
  providerExecutionTimeoutSettlement,
  providerTurnBindingChangedSettlement,
  REPAIR_POLICY,
  runtimeSafetyFragment,
  safetyStop,
  workObjectiveFragment,
} from "./driver-policy.js";
import { decideRepair } from "./repair.js";
import {
  assembleSessionContext,
  SESSION_CONTEXT_ENTRY_LIMIT,
} from "./session-context.js";

export interface DecisionTurnOptions {
  readonly secretRef?: SecretRef;
  readonly executionPolicyOverrides?: ProviderExecutionPolicyOverrides;
  readonly providerRef?: string;
  readonly onProviderProgress?:
    | ((executionId: string, event: ProviderRuntimeProgress) => void)
    | undefined;
}

export interface DecisionTurnRunnerDependencies {
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
  readonly works: WorkRepositoryService;
  readonly options: DecisionTurnOptions;
  readonly admit: (
    activity: ExecutionActivity,
    observation: RuntimeSafetyObservation,
  ) => Effect.Effect<"Continue" | "Stop">;
  readonly failure: (cause: unknown) => ExecutionDriverError;
  readonly now: () => Effect.Effect<string>;
  readonly leaseGeneration?: LeaseGeneration;
}

export const runDecisionTurn = (
  dependencies: DecisionTurnRunnerDependencies,
  turn: number,
  activity: ExecutionActivity,
): Effect.Effect<DecisionTurn, ExecutionDriverError> => {
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
    works,
    options,
    admit,
    failure,
    now,
    leaseGeneration,
  } = dependencies;
  return Effect.gen(function* () {
    let repairAttempt = 0;
    let repairFragments: ReadonlyArray<InstructionFragment> = [];
    while (true) {
      const controlBasis = yield* currentControlBasis();
      const providerTurnId = (
        repairAttempt === 0
          ? `ptn_${input.execution.executionId}_${turn}`
          : `ptn_${input.execution.executionId}_${turn}_r${repairAttempt}`
      ) as never;
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
        const claimed = history.find(
          (message) =>
            message.claimedByExecutionId ===
            String(input.execution.executionId),
        );
        for (const message of history) {
          if (message.state === "Answered" && message.responseBody !== null) {
            conversationMessages.push({
              role: "user",
              text: message.bodyRef,
            });
            conversationMessages.push({
              role: "assistant",
              text: message.responseBody,
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
      const recentSessionEntries = yield* tx
        .transact(
          sessions.listRecentEntries(
            input.execution.sessionId,
            SESSION_CONTEXT_ENTRY_LIMIT,
          ),
        )
        .pipe(Effect.mapError(failure));
      const sessionContext = assembleSessionContext(recentSessionEntries);
      const messages = [...conversationMessages, ...sessionContext.messages];
      const messageContextRefs = [
        ...conversationContextRefs,
        ...sessionContext.contextRefs,
      ];
      // Work executions carry the objective body through the
      // content table so the compiled instruction shows the task
      // text instead of the bare `work:<executionId>` reference.
      let instructionContents: ReadonlyMap<string, string> | undefined;
      if (
        input.execution.binding._tag === "WorkspaceExecution" &&
        input.execution.binding.focus._tag === "Work"
      ) {
        const work = yield* tx
          .transact(works.findById(input.execution.binding.focus.workId))
          .pipe(Effect.mapError(failure));
        if (Option.isSome(work)) {
          instructionContents = new Map([
            [
              `work:${input.execution.executionId}`,
              [
                `objective: ${work.value.objective}`,
                `why: ${work.value.why}`,
                `completion expectation: ${work.value.completionExpectation}`,
              ].join("\n"),
            ],
          ]);
        }
      }
      const preparation = yield* modelContext
        .prepareTurn({
          executionId: input.execution.executionId,
          sessionId: input.execution.sessionId,
          contextEpoch: 0 as never,
          providerTurnId,
          binding: agentBinding,
          workspaceId: input.execution.workspaceId,
          cognitiveMode: input.agentExecutionState.currentMode ?? "execute",
          program: WORK_EXECUTION_PROGRAM,
          fragments: [
            runtimeSafetyFragment,
            workObjectiveFragment(input.execution),
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
          ...(instructionContents !== undefined ? { instructionContents } : {}),
          ...(isConversationExecution(input.execution) &&
          conversationMessages.length > 0
            ? {
                outputContractRef: "agent-directive-v1",
                includeTools: false,
              }
            : { outputContractRef: TOOL_INVOCATION_CONTRACT }),
          ...(messages.length > 0 ? { messages } : {}),
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
        // Kernel: an explicit compaction ProviderTurn would run here
        // (P3-008 protocol); the fake provider treats it as normal.
        return {
          _tag: "Settle",
          settlement: safetyStop("CompactionRequired"),
        };
      }

      const turnInput: ProviderRunInput = {
        providerTurnId: preparation.turn.manifest.providerTurnId,
        executionId: input.execution.executionId,
        sessionId: input.execution.sessionId,
        contextEpoch: 0 as never,
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
            settled.turn.contextEpoch !== 0 ||
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
            settled.turn.contextEpoch !== 0
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
