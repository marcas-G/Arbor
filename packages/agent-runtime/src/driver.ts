import type {
  AgentBinding,
  AgentExecutionState,
  CommandSubmissionContext,
  Execution,
  ExecutionId,
  ExecutionSettlement,
  LeaseGeneration,
  WakeReason,
} from "@arbor/domain";
import {
  type ControlBasis,
  decodeTurn,
  type InstructionFragment,
  ModelContext,
  type ModelOutput,
  type PreparedModelTurn,
  TOOL_INVOCATION_CONTRACT,
  WORK_EXECUTION_PROGRAM,
} from "@arbor/model-context";
import {
  type AgentLoopStepActionRecord,
  type AgentLoopStepFence,
  type AgentLoopStepRecord,
  AgentLoopStepStore,
  type BoundedObservation,
  EnvironmentRevisionStore,
  type ExecutionActivity,
  type ExecutionDriverError,
  ExecutionDriverPort,
  HumanMessageStore,
  ModelCapabilityPort,
  type ProviderExecutionPolicyOverrides,
  type ProviderExecutionTimeout,
  type ProviderFailure,
  type ProviderRunInput,
  ProviderRuntime,
  ProviderTurnStore,
  type RuntimeSafetyGateService,
  type RuntimeSafetyObservation,
  type SecretRef,
  SessionRepository,
  sha256Hex,
  TransactionPort,
  WorkRepository,
} from "@arbor/ports";
import { Effect, Layer, Option } from "effect";
import {
  type ControlToolRegistryService,
  classifyToolRoute,
  type ExecutableInvocationHandler,
  makeControlToolRegistry,
} from "./control.js";
import type { DirectiveHandler } from "./directive.js";
import { checkFreshness, requirementForAction } from "./freshness.js";
import { CANONICAL_TRUST } from "./prompt-assets.js";
import { decideRepair, type RepairPolicy } from "./repair.js";

const MAX_TURNS = 8;

/** P3 `06` §3: N is empirical; the bounded mechanism and the
 * settle-after-exhaustion rule are contract. */
const MAX_REPAIRS = 2;
const REPAIR_POLICY: RepairPolicy = { maxRepairs: MAX_REPAIRS };

/** One decoded decision: either a validated turn to act on, or the frozen
 * settlement reached when bounded repair is exhausted / a control result
 * requires settling. */
type DecisionTurn =
  | {
      readonly _tag: "Ready";
      readonly turn: PreparedModelTurn;
      readonly output: ModelOutput;
      readonly loopStep?: AgentLoopStepRecord;
      /** P14: this turn carried conversation context (a claimed human
       * message) — the first text answer settles the episode. */
      readonly conversation?: boolean;
    }
  | { readonly _tag: "Settle"; readonly settlement: ExecutionSettlement };

const safetyStop = (reason: string): ExecutionSettlement => ({
  _tag: "Interrupted",
  result: { _tag: "ControlledInterruption", reason },
});

/** A ProviderTurn is immutable once its manifest is durable. This exact
 * rejection means configuration changed after an execution started: it is a
 * terminal result for that execution, not a daemon-level operational fault.
 * All other ProviderRuntime failures retain their narrow typed error path. */
const isProviderTurnBindingChanged = (
  cause: unknown,
): cause is ProviderFailure =>
  typeof cause === "object" &&
  cause !== null &&
  (cause as { readonly _tag?: unknown })._tag === "ProviderFailure" &&
  (cause as { readonly kind?: unknown }).kind === "UnknownProviderFailure" &&
  (cause as { readonly safeDiagnostic?: unknown }).safeDiagnostic ===
    "provider-turn-resume-binding-invalid";

const providerTurnBindingChangedSettlement = (): ExecutionSettlement => ({
  _tag: "Failed",
  failure: {
    _tag: "ExecutionFailure",
    reason: "ProviderTurnBindingChanged",
  },
});

const isProviderExecutionTimeout = (
  cause: unknown,
): cause is ProviderExecutionTimeout =>
  typeof cause === "object" &&
  cause !== null &&
  (cause as { readonly _tag?: unknown })._tag === "ProviderExecutionTimeout" &&
  typeof (cause as { readonly phase?: unknown }).phase === "string";

const providerExecutionTimeoutSettlement = (
  timeout: ProviderExecutionTimeout,
): ExecutionSettlement => ({
  _tag: "Failed",
  failure: {
    _tag: "ExecutionFailure",
    reason: `ProviderExecutionTimedOut:${timeout.phase}`,
  },
});

/** P12 `06` §3 (TR-9): the session-append fence. The authenticated worker
 * identity is threaded from the ExecutionOrigin context when present; legacy
 * in-process contexts omit it (generation-only fence). */
const sessionFence = (
  executionId: ExecutionId,
  context: CommandSubmissionContext,
):
  | {
      readonly executionId: ExecutionId;
      readonly workerId?: string;
      readonly workerIncarnationId?: string;
      readonly fencingGeneration: LeaseGeneration;
    }
  | undefined =>
  context._tag === "ExecutionOrigin"
    ? {
        executionId,
        fencingGeneration: context.fencingGeneration,
        ...(context.workerId !== undefined
          ? { workerId: context.workerId }
          : {}),
        ...(context.workerIncarnationId !== undefined
          ? { workerIncarnationId: context.workerIncarnationId }
          : {}),
      }
    : undefined;

const isConversationExecution = (execution: Execution): boolean =>
  execution.binding._tag === "WorkspaceExecution" &&
  execution.binding.focus._tag === "Coordination";

const workObjectiveFragment = (execution: Execution): InstructionFragment => ({
  identity: "work-objective",
  revision: 1,
  hash: "h",
  semanticKind: "WorkObjective",
  source: "Canonical",
  scope: "work-objective",
  authorityRole: "A3",
  strength: "Hard",
  compositionMode: "Constrain",
  activationCondition: "always",
  lifetime: "Pinned",
  cacheClass: "Stable",
  budgetClass: "b",
  modelCompatibility: [],
  contentRef: `work:${execution.executionId}`,
  provenance: CANONICAL_TRUST,
});

const runtimeSafetyFragment: InstructionFragment = {
  identity: "runtime-safety",
  revision: 1,
  hash: "h0",
  semanticKind: "RuntimeSafety",
  source: "Canonical",
  scope: "runtime-safety",
  authorityRole: "A0",
  strength: "Hard",
  compositionMode: "Constrain",
  activationCondition: "always",
  lifetime: "Pinned",
  cacheClass: "Stable",
  budgetClass: "b",
  modelCompatibility: [],
  contentRef: "runtime safety",
  provenance: CANONICAL_TRUST,
};

export interface AgentDriverOptions {
  /** P12 `03` §3: the credential reference the driver binds to a ProviderTurn.
   * Comes from Composition-Root config; the driver never hardcodes a raw ref.
   * The raw credential is resolved by ProviderRuntime at the execution
   * boundary and never reaches the Agent. */
  readonly secretRef?: SecretRef;
  /** Deployment-level execution limits resolved at the composition root.
   * Provider Runtime owns their final merge with system/provider defaults. */
  readonly executionPolicyOverrides?: ProviderExecutionPolicyOverrides;
  /** The typed control-tool registry. Composition supplies the live registry;
   * the default keeps Wait available for focused runtime tests. */
  readonly controlRegistry?: ControlToolRegistryService;
  readonly executableInvocationHandler?: ExecutableInvocationHandler;
  /** Adapter identity recorded on manifests (P14 conversation audit). */
  readonly providerRef?: string;
  /** Presentation-only progress tap (conversation streaming): receives every
   * ProviderRuntimeProgress event tagged with the driving executionId. It
   * must never affect model/execution semantics (the provider runtime
   * already isolates observer throws). */
  readonly onProviderProgress?:
    | ((
        executionId: string,
        event: import("@arbor/ports").ProviderRuntimeProgress,
      ) => void)
    | undefined;
}
export const AgentDriverLive = (
  _legacyHandlers: ReadonlyArray<DirectiveHandler> = [],
  options: AgentDriverOptions = {},
): Layer.Layer<
  ExecutionDriverPort,
  never,
  | ModelContext
  | ProviderRuntime
  | ModelCapabilityPort
  | SessionRepository
  | TransactionPort
  | EnvironmentRevisionStore
  | HumanMessageStore
  | WorkRepository
> =>
  Layer.effect(
    ExecutionDriverPort,
    Effect.gen(function* () {
      const modelContext = yield* ModelContext;
      const providerRuntime = yield* ProviderRuntime;
      const capabilityPort = yield* ModelCapabilityPort;
      const sessions = yield* SessionRepository;
      const humanMessages = yield* HumanMessageStore;
      const tx = yield* TransactionPort;
      const loopStepStoreOption =
        yield* Effect.serviceOption(AgentLoopStepStore);
      const providerTurnStoreOption =
        yield* Effect.serviceOption(ProviderTurnStore);
      const configuredLoopSteps = Option.isSome(loopStepStoreOption)
        ? loopStepStoreOption.value
        : undefined;
      const providerTurns = Option.isSome(providerTurnStoreOption)
        ? providerTurnStoreOption.value
        : undefined;
      const environmentRevisions = yield* EnvironmentRevisionStore;
      const works = yield* WorkRepository;
      const controlRegistry =
        options.controlRegistry ?? makeControlToolRegistry();
      const failure = (cause: unknown): ExecutionDriverError => ({
        _tag: "ExecutionDriverError",
        cause,
      });

      const drive = (input: {
        readonly execution: Execution;
        readonly agentExecutionState: AgentExecutionState;
        readonly wakeReason: WakeReason;
        readonly context: import("@arbor/domain").CommandSubmissionContext;
        readonly safetyGate: RuntimeSafetyGateService;
      }): Effect.Effect<ExecutionSettlement, ExecutionDriverError> =>
        Effect.gen(function* () {
          const loopSteps =
            configuredLoopSteps !== undefined &&
            (yield* tx
              .transact(configuredLoopSteps.isAvailable())
              .pipe(Effect.mapError(failure)))
              ? configuredLoopSteps
              : undefined;
          const agentBinding: AgentBinding =
            input.execution.binding._tag === "WorkspaceExecution"
              ? {
                  _tag: "ResponsibilityBoundAgentBinding",
                  workspaceId: input.execution.binding.workspaceId,
                }
              : input.execution.binding;
          const capability = yield* capabilityPort
            .resolve({
              binding: agentBinding,
              cognitiveMode: input.agentExecutionState.currentMode ?? "execute",
              requiredCapabilities: [],
            })
            .pipe(
              Effect.mapError(
                (cause): ExecutionDriverError => ({
                  _tag: "ExecutionDriverError",
                  cause,
                }),
              ),
            );
          // DID §8.19 / P3 `06` §4: the ControlBasis is captured into the
          // Manifest at prepareTurn and re-read at effectful-directive
          // admission. Only the environment revision has a live store in this
          // slice (P11-003); the other revisions are anchored constants here.
          const staticControlBasis = {
            projectPolicyRevision: 0,
            workspacePolicyRevision: 0,
            responsibilityRevision: 0,
            resourceBoundaryRevision: 0,
            authorizationDigest: "digest",
          } as const;
          const currentControlBasis = (): Effect.Effect<
            ControlBasis,
            ExecutionDriverError
          > =>
            tx
              .transact(environmentRevisions.current(input.execution.projectId))
              .pipe(
                Effect.mapError(failure),
                Effect.map(Option.getOrElse(() => "0")),
                Effect.map(
                  (environmentRevision): ControlBasis => ({
                    ...staticControlBasis,
                    environmentRevision,
                  }),
                ),
              );

          // P12 `08` §7: the driver reports the D1/D3/D4/D5/D6 observation
          // signals at the ProviderTurn / ToolInvocation / Specialist
          // boundaries. The gate never reads durable state (R = never).
          const now = (): Effect.Effect<string> =>
            Effect.sync(() => new Date().toISOString());
          const leaseGeneration =
            input.context._tag === "ExecutionOrigin"
              ? input.context.fencingGeneration
              : undefined;
          const loopStepFence: AgentLoopStepFence | undefined =
            input.context._tag === "ExecutionOrigin" &&
            input.context.workerId !== undefined &&
            input.context.workerIncarnationId !== undefined
              ? {
                  executionId: input.execution.executionId,
                  workerId: input.context.workerId,
                  workerIncarnationId: input.context.workerIncarnationId,
                  fencingGeneration: input.context.fencingGeneration,
                }
              : undefined;
          const admit = (
            activity: ExecutionActivity,
            observation: RuntimeSafetyObservation,
          ): Effect.Effect<"Continue" | "Stop"> =>
            input.safetyGate.admitActivity(
              input.execution.executionId,
              activity,
              observation,
            );
          let progressedSinceBoundary = false;

          // P3 `06` §3: bounded `ModelOutputContractViolation` repair. A
          // violated output is NOT a provider transport failure: re-invoke
          // prepareTurn with an A4 repair instruction fragment (a fresh
          // ProviderTurn) and re-validate, up to the bounded attempt count.
          // On exhaustion the frozen settle rule applies (Failed, or
          // Interrupted for a safety/looping signal).
          const runDecisionTurn = (
            turn: number,
            activity: ExecutionActivity,
          ): Effect.Effect<DecisionTurn, ExecutionDriverError> =>
            Effect.gen(function* () {
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
                        const existing =
                          yield* loopSteps.find(loopStepIdentity);
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
                    .transact(
                      humanMessages.listForWorkspace(
                        input.execution.workspaceId,
                      ),
                    )
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
                    if (
                      message.state === "Answered" &&
                      message.responseBody !== null
                    ) {
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
                    conversationContextRefs.push(
                      `human-input:${claimed.messageId}`,
                    );
                  }
                }
                // Work executions carry the objective body through the
                // content table so the compiled instruction shows the task
                // text instead of the bare `work:<executionId>` reference.
                let instructionContents:
                  | ReadonlyMap<string, string>
                  | undefined;
                if (
                  input.execution.binding._tag === "WorkspaceExecution" &&
                  input.execution.binding.focus._tag === "Work"
                ) {
                  const work = yield* tx
                    .transact(
                      works.findById(input.execution.binding.focus.workId),
                    )
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
                    cognitiveMode:
                      input.agentExecutionState.currentMode ?? "execute",
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
                    ...(instructionContents !== undefined
                      ? { instructionContents }
                      : {}),
                    ...(isConversationExecution(input.execution) &&
                    conversationMessages.length > 0
                      ? {
                          outputContractRef: "agent-directive-v1",
                          includeTools: false,
                        }
                      : { outputContractRef: TOOL_INVOCATION_CONTRACT }),
                    ...(conversationMessages.length > 0
                      ? { conversationMessages }
                      : {}),
                    ...(conversationContextRefs.length > 0
                      ? { conversationContextRefs: conversationContextRefs }
                      : {}),
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
                  outputContractRef:
                    preparation.turn.manifest.outputContractRef,
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
                        executionPolicyOverrides:
                          options.executionPolicyOverrides,
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
                      settled.turn.executionId !==
                        input.execution.executionId ||
                      settled.turn.sessionId !== input.execution.sessionId ||
                      settled.turn.contextEpoch !== 0 ||
                      persistedManifest.providerTurnId !==
                        settled.turn.providerTurnId ||
                      persistedManifest.executionId !==
                        settled.turn.executionId ||
                      persistedManifest.sessionId !== settled.turn.sessionId ||
                      persistedManifest.contextEpoch !==
                        settled.turn.contextEpoch ||
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
                            if (
                              settled.evidenceVersion === "legacy-success-v1"
                            ) {
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
                                  ...(settled.evidenceVersion ===
                                  "legacy-success-v1"
                                    ? {
                                        migrationProvenance: {
                                          _tag: "LegacySettledProviderSuccess",
                                          evidenceVersion:
                                            settled.evidenceVersion,
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
                      settled.turn.executionId !==
                        input.execution.executionId ||
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
                          .transact(
                            providerTurns.findSettledResult(providerTurnId),
                          )
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
                if (
                  leaseGeneration !== undefined ||
                  providerRun.attemptNo > 0
                ) {
                  const endDecision = yield* admit(activity, {
                    retryCount: providerRun.attemptNo,
                    inFlight: "end",
                    ...(leaseGeneration !== undefined
                      ? { leaseGeneration }
                      : {}),
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
                    ...(conversationMessages.length > 0
                      ? { conversation: true }
                      : {}),
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

          let sawToolInvocation = false;
          let producedText = false;
          for (let turn = 0; turn < MAX_TURNS; turn += 1) {
            const activity: ExecutionActivity = {
              _tag: "ProviderTurn",
              fingerprint: `turn-${turn}`,
            };
            // D4: durable progress since the previous turn boundary. The
            // driver holds the journal capability and reports the boolean;
            // the gate only counts it. D5: begin-bracket the provider call.
            const decision = yield* admit(activity, {
              retryCount: 0,
              chainDepth: 0,
              durableProgress: progressedSinceBoundary,
              ...(leaseGeneration !== undefined
                ? { inFlight: "begin" as const, leaseGeneration }
                : {}),
              observedAt: yield* now(),
            });
            if (decision === "Stop") {
              return safetyStop("RuntimeSafetyStop");
            }
            progressedSinceBoundary = false;

            const decisionTurn = yield* runDecisionTurn(turn, activity);
            if (decisionTurn._tag === "Settle") {
              return decisionTurn.settlement;
            }
            const preparedTurn = decisionTurn.turn;
            const decodedOutput = decisionTurn.output;
            const modelOutputPayload = {
              providerTurnId: preparedTurn.manifest.providerTurnId,
              outputContractRef: preparedTurn.manifest.outputContractRef,
              decoderVersion: "decode-turn-v1",
              text: decodedOutput.text,
              finishReason: decodedOutput.finishReason,
              toolInvocations: decodedOutput.toolInvocations,
            };
            let currentLoopStep = decisionTurn.loopStep;
            if (
              currentLoopStep !== undefined &&
              loopSteps !== undefined &&
              loopStepFence !== undefined
            ) {
              if (currentLoopStep.state === "ProviderResultAvailable") {
                const acceptedFrom = currentLoopStep;
                const durableLoopSteps = loopSteps;
                const durableFence = loopStepFence;
                currentLoopStep = yield* tx
                  .transact(
                    Effect.gen(function* () {
                      const appended = yield* sessions.appendEntryIdempotent(
                        input.execution.sessionId,
                        {
                          kind: "ProviderTurn",
                          ref: preparedTurn.manifest.providerTurnId,
                        },
                        {
                          entryKind: "ModelOutput",
                          payload: modelOutputPayload,
                        },
                        sha256Hex(JSON.stringify(modelOutputPayload)),
                        durableFence,
                      );
                      return yield* durableLoopSteps.transition(
                        {
                          identity: acceptedFrom.identity,
                          expectedRevision: acceptedFrom.revision,
                          expectedState: "ProviderResultAvailable",
                          next: {
                            ...acceptedFrom,
                            state: "OutputAccepted",
                            decodedOutputHash: sha256Hex(
                              JSON.stringify(modelOutputPayload),
                            ),
                            modelOutputSessionSequence: appended.sequence,
                            revision: acceptedFrom.revision + 1,
                            updatedAt: yield* now(),
                          },
                        },
                        durableFence,
                      );
                    }),
                  )
                  .pipe(Effect.mapError(failure));
              }
            } else {
              yield* tx
                .transact(
                  sessions.appendEntry(
                    input.execution.sessionId,
                    { entryKind: "ModelOutput", payload: modelOutputPayload },
                    input.context._tag === "ExecutionOrigin"
                      ? sessionFence(input.execution.executionId, input.context)
                      : undefined,
                  ),
                )
                .pipe(Effect.mapError(failure));
            }

            if (
              currentLoopStep !== undefined &&
              loopSteps !== undefined &&
              loopStepFence !== undefined &&
              currentLoopStep.state === "OutputAccepted"
            ) {
              const acceptedStep = currentLoopStep;
              currentLoopStep = yield* tx
                .transact(
                  loopSteps.transition(
                    {
                      identity: acceptedStep.identity,
                      expectedRevision: acceptedStep.revision,
                      expectedState: "OutputAccepted",
                      next: {
                        ...acceptedStep,
                        state: "ActionsInProgress",
                        revision: acceptedStep.revision + 1,
                        updatedAt: yield* now(),
                      },
                    },
                    loopStepFence,
                  ),
                )
                .pipe(Effect.mapError(failure));
            }

            const observations: Array<{
              readonly source: "Runtime" | "Tool";
              readonly observation: BoundedObservation;
            }> = [];
            let stale = false;
            for (const [
              actionIndex,
              invocation,
            ] of decodedOutput.toolInvocations.entries()) {
              const route = classifyToolRoute(
                preparedTurn.toolRoutes,
                controlRegistry,
                invocation.toolName,
              );
              if (route._tag === "Invalid") {
                return safetyStop(route.reason);
              }
              let loopAction: AgentLoopStepActionRecord | undefined;
              if (
                currentLoopStep !== undefined &&
                loopSteps !== undefined &&
                loopStepFence !== undefined &&
                currentLoopStep.state === "ActionsInProgress"
              ) {
                const existingActions = yield* tx
                  .transact(loopSteps.listActions(currentLoopStep.identity))
                  .pipe(Effect.mapError(failure));
                loopAction = existingActions.find(
                  (candidate) => candidate.actionIndex === actionIndex,
                );
                if (loopAction === undefined) {
                  loopAction = yield* tx
                    .transact(
                      loopSteps.createAction(
                        {
                          identity: currentLoopStep.identity,
                          actionIndex,
                          logicalActionId: `lac_${sha256Hex(
                            JSON.stringify({
                              executionId: input.execution.executionId,
                              providerTurnId:
                                preparedTurn.manifest.providerTurnId,
                              callRef: invocation.callRef,
                              routeKind: route._tag,
                              actionKind: invocation.toolName,
                            }),
                          )}`,
                          callRef: invocation.callRef,
                          routeKind: route._tag,
                          actionKind: invocation.toolName,
                          inputHash: sha256Hex(invocation.argumentsJson),
                          state: "Pending",
                          revision: 0,
                          updatedAt: yield* now(),
                        },
                        loopStepFence,
                      ),
                    )
                    .pipe(Effect.mapError(failure));
                } else if (loopAction.state !== "Pending") {
                  continue;
                }
              }
              const persistActionSettlement = (
                settlement: ExecutionSettlement,
              ): Effect.Effect<void, ExecutionDriverError> =>
                Effect.gen(function* () {
                  if (
                    loopAction === undefined ||
                    currentLoopStep === undefined ||
                    loopSteps === undefined ||
                    loopStepFence === undefined ||
                    currentLoopStep.state !== "ActionsInProgress"
                  ) {
                    return;
                  }
                  const pendingAction = loopAction;
                  const actionsStep = currentLoopStep;
                  const settlementRef = `settlement_${sha256Hex(
                    JSON.stringify(settlement),
                  )}`;
                  currentLoopStep = yield* tx
                    .transact(
                      Effect.gen(function* () {
                        yield* loopSteps.transitionAction(
                          {
                            identity: pendingAction.identity,
                            actionIndex: pendingAction.actionIndex,
                            expectedRevision: pendingAction.revision,
                            expectedState: "Pending",
                            next: {
                              ...pendingAction,
                              state:
                                settlement._tag === "OutcomeUnknown"
                                  ? "ReconciliationPending"
                                  : "Applied",
                              settlementRef,
                              revision: pendingAction.revision + 1,
                              updatedAt: yield* now(),
                            },
                          },
                          loopStepFence,
                        );
                        for (
                          let skippedIndex = actionIndex + 1;
                          skippedIndex < decodedOutput.toolInvocations.length;
                          skippedIndex += 1
                        ) {
                          const skippedInvocation =
                            decodedOutput.toolInvocations[skippedIndex];
                          if (skippedInvocation === undefined) continue;
                          const skippedRoute = classifyToolRoute(
                            preparedTurn.toolRoutes,
                            controlRegistry,
                            skippedInvocation.toolName,
                          );
                          if (skippedRoute._tag === "Invalid") continue;
                          const pending = yield* loopSteps.createAction(
                            {
                              identity: actionsStep.identity,
                              actionIndex: skippedIndex,
                              logicalActionId: `lac_${sha256Hex(
                                JSON.stringify({
                                  executionId: input.execution.executionId,
                                  providerTurnId:
                                    preparedTurn.manifest.providerTurnId,
                                  callRef: skippedInvocation.callRef,
                                  routeKind: skippedRoute._tag,
                                  actionKind: skippedInvocation.toolName,
                                }),
                              )}`,
                              callRef: skippedInvocation.callRef,
                              routeKind: skippedRoute._tag,
                              actionKind: skippedInvocation.toolName,
                              inputHash: sha256Hex(
                                skippedInvocation.argumentsJson,
                              ),
                              state: "Pending",
                              revision: 0,
                              updatedAt: yield* now(),
                            },
                            loopStepFence,
                          );
                          yield* loopSteps.transitionAction(
                            {
                              identity: pending.identity,
                              actionIndex: pending.actionIndex,
                              expectedRevision: pending.revision,
                              expectedState: "Pending",
                              next: {
                                ...pending,
                                state: "SkippedEarlySettlement",
                                settlementRef,
                                revision: pending.revision + 1,
                                updatedAt: yield* now(),
                              },
                            },
                            loopStepFence,
                          );
                        }
                        return yield* loopSteps.transition(
                          {
                            identity: actionsStep.identity,
                            expectedRevision: actionsStep.revision,
                            expectedState: "ActionsInProgress",
                            next: {
                              ...actionsStep,
                              state: "SettlementProposed",
                              nextActionIndex:
                                decodedOutput.toolInvocations.length,
                              settlement,
                              revision: actionsStep.revision + 1,
                              updatedAt: yield* now(),
                            },
                          },
                          loopStepFence,
                        );
                      }),
                    )
                    .pipe(Effect.mapError(failure));
                });
              const persistActionObservation = (
                source: "Runtime" | "Tool",
                observation: BoundedObservation,
              ): Effect.Effect<boolean, ExecutionDriverError> =>
                Effect.gen(function* () {
                  if (
                    loopAction === undefined ||
                    currentLoopStep === undefined ||
                    loopSteps === undefined ||
                    loopStepFence === undefined ||
                    currentLoopStep.state !== "ActionsInProgress"
                  ) {
                    return false;
                  }
                  const pendingAction = loopAction;
                  const actionsStep = currentLoopStep;
                  const payload = { source, observation };
                  const resultRef = `result_${sha256Hex(
                    JSON.stringify(payload),
                  )}`;
                  const observationSourceRef = `observation_${sha256Hex(
                    JSON.stringify({
                      providerTurnId: preparedTurn.manifest.providerTurnId,
                      callRef: invocation.callRef,
                      resultRef,
                    }),
                  )}`;
                  currentLoopStep = yield* tx
                    .transact(
                      Effect.gen(function* () {
                        yield* sessions.appendEntryIdempotent(
                          input.execution.sessionId,
                          {
                            kind: "AgentLoopAction",
                            ref: observationSourceRef,
                          },
                          { entryKind: "Observation", payload },
                          sha256Hex(JSON.stringify(payload)),
                          loopStepFence,
                        );
                        yield* loopSteps.transitionAction(
                          {
                            identity: pendingAction.identity,
                            actionIndex: pendingAction.actionIndex,
                            expectedRevision: pendingAction.revision,
                            expectedState: "Pending",
                            next: {
                              ...pendingAction,
                              state: "Applied",
                              resultRef,
                              observationSourceRef,
                              revision: pendingAction.revision + 1,
                              updatedAt: yield* now(),
                            },
                          },
                          loopStepFence,
                        );
                        return yield* loopSteps.transition(
                          {
                            identity: actionsStep.identity,
                            expectedRevision: actionsStep.revision,
                            expectedState: "ActionsInProgress",
                            next: {
                              ...actionsStep,
                              nextActionIndex: Math.max(
                                actionsStep.nextActionIndex,
                                actionIndex + 1,
                              ),
                              revision: actionsStep.revision + 1,
                              updatedAt: yield* now(),
                            },
                          },
                          loopStepFence,
                        );
                      }),
                    )
                    .pipe(Effect.mapError(failure));
                  return true;
                });
              const activityDecision = yield* admit(
                {
                  _tag: "ToolInvocation",
                  fingerprint: `tool:${invocation.toolName}:${invocation.callRef}`,
                },
                {
                  chainDepth: 1,
                  observedAt: yield* now(),
                },
              );
              if (activityDecision === "Stop") {
                return safetyStop("RuntimeSafetyStop");
              }

              if (route._tag === "Executable") {
                const executableHandler = options.executableInvocationHandler;
                if (executableHandler === undefined) {
                  return safetyStop("ExecutableToolHandlerUnavailable");
                }
                const executed = yield* Effect.match(
                  executableHandler.handle({
                    invocation,
                    execution: input.execution,
                    context: input.context,
                  }),
                  {
                    onFailure: (cause) => ({ ok: false as const, cause }),
                    onSuccess: (outcome) => ({ ok: true as const, outcome }),
                  },
                );
                if (!executed.ok) {
                  return safetyStop("ExecutableToolInvocationRejected");
                }
                if (executed.outcome._tag === "Settle") {
                  yield* persistActionSettlement(executed.outcome.settlement);
                  return executed.outcome.settlement;
                }
                const persisted = yield* persistActionObservation(
                  executed.outcome.source,
                  executed.outcome.observation,
                );
                if (!persisted) {
                  observations.push({
                    source: executed.outcome.source,
                    observation: executed.outcome.observation,
                  });
                }
                progressedSinceBoundary = true;
                continue;
              }

              const decodedAction = yield* Effect.match(
                controlRegistry.decode(invocation),
                {
                  onFailure: (cause) => ({ ok: false as const, cause }),
                  onSuccess: (value) => ({ ok: true as const, value }),
                },
              );
              if (!decodedAction.ok) {
                return safetyStop(
                  `ControlToolDecodeFailed:${decodedAction.cause._tag}`,
                );
              }

              const current = yield* currentControlBasis();
              const freshness = checkFreshness(
                preparedTurn.manifest.controlBasis,
                current,
                requirementForAction(decodedAction.value.action),
              );
              if (freshness !== null) {
                if (
                  loopAction !== undefined &&
                  currentLoopStep !== undefined &&
                  loopSteps !== undefined &&
                  loopStepFence !== undefined &&
                  currentLoopStep.state === "ActionsInProgress" &&
                  turn + 1 < MAX_TURNS
                ) {
                  const staleAction = loopAction;
                  const staleStep = currentLoopStep;
                  const successorIdentity = {
                    executionId: input.execution.executionId,
                    logicalStepNo: turn + 1,
                    repairAttempt: 0,
                  } as const;
                  const successorProviderTurnId =
                    `ptn_${input.execution.executionId}_${turn + 1}` as never;
                  yield* tx
                    .transact(
                      Effect.gen(function* () {
                        yield* loopSteps.transitionAction(
                          {
                            identity: staleAction.identity,
                            actionIndex: staleAction.actionIndex,
                            expectedRevision: staleAction.revision,
                            expectedState: "Pending",
                            next: {
                              ...staleAction,
                              state: "SkippedStale",
                              disposition: {
                                _tag: "DecisionStale",
                              },
                              revision: staleAction.revision + 1,
                              updatedAt: yield* now(),
                            },
                          },
                          loopStepFence,
                        );
                        for (
                          let skippedIndex = actionIndex + 1;
                          skippedIndex < decodedOutput.toolInvocations.length;
                          skippedIndex += 1
                        ) {
                          const skippedInvocation =
                            decodedOutput.toolInvocations[skippedIndex];
                          if (skippedInvocation === undefined) continue;
                          const skippedRoute = classifyToolRoute(
                            preparedTurn.toolRoutes,
                            controlRegistry,
                            skippedInvocation.toolName,
                          );
                          if (skippedRoute._tag === "Invalid") continue;
                          const pending = yield* loopSteps.createAction(
                            {
                              identity: staleStep.identity,
                              actionIndex: skippedIndex,
                              logicalActionId: `lac_${sha256Hex(
                                JSON.stringify({
                                  executionId: input.execution.executionId,
                                  providerTurnId:
                                    preparedTurn.manifest.providerTurnId,
                                  callRef: skippedInvocation.callRef,
                                  routeKind: skippedRoute._tag,
                                  actionKind: skippedInvocation.toolName,
                                }),
                              )}`,
                              callRef: skippedInvocation.callRef,
                              routeKind: skippedRoute._tag,
                              actionKind: skippedInvocation.toolName,
                              inputHash: sha256Hex(
                                skippedInvocation.argumentsJson,
                              ),
                              state: "Pending",
                              revision: 0,
                              updatedAt: yield* now(),
                            },
                            loopStepFence,
                          );
                          yield* loopSteps.transitionAction(
                            {
                              identity: pending.identity,
                              actionIndex: pending.actionIndex,
                              expectedRevision: pending.revision,
                              expectedState: "Pending",
                              next: {
                                ...pending,
                                state: "SkippedStale",
                                disposition: {
                                  _tag: "DecisionStale",
                                },
                                revision: pending.revision + 1,
                                updatedAt: yield* now(),
                              },
                            },
                            loopStepFence,
                          );
                        }
                        yield* loopSteps.transition(
                          {
                            identity: staleStep.identity,
                            expectedRevision: staleStep.revision,
                            expectedState: "ActionsInProgress",
                            next: {
                              ...staleStep,
                              state: "NextStepReady",
                              nextActionIndex:
                                decodedOutput.toolInvocations.length,
                              successor: {
                                ...successorIdentity,
                                providerTurnId: successorProviderTurnId,
                              },
                              nextStepReason: "DecisionStale",
                              revision: staleStep.revision + 1,
                              updatedAt: yield* now(),
                            },
                          },
                          loopStepFence,
                        );
                        yield* loopSteps.ensureSuccessor(
                          staleStep.identity,
                          {
                            identity: successorIdentity,
                            predecessor: staleStep.identity,
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
                stale = true;
                break;
              }

              const handled = yield* Effect.match(
                controlRegistry.handle({
                  action: decodedAction.value.action,
                  invocation,
                  execution: input.execution,
                  context: input.context,
                }),
                {
                  onFailure: (cause) => ({ ok: false as const, cause }),
                  onSuccess: (outcome) => ({ ok: true as const, outcome }),
                },
              );
              if (!handled.ok) {
                return safetyStop("ControlActionHandlerRejected");
              }
              if (handled.outcome._tag === "Settle") {
                yield* persistActionSettlement(handled.outcome.settlement);
                return handled.outcome.settlement;
              }
              const persisted = yield* persistActionObservation(
                handled.outcome.source,
                handled.outcome.observation,
              );
              if (!persisted) {
                observations.push({
                  source: handled.outcome.source,
                  observation: handled.outcome.observation,
                });
              }
              // P12 `08` §5: a journal-recorded action settlement since the
              // previous turn boundary is durable progress; the next turn
              // boundary reports it. The gate never reads durable state.
              progressedSinceBoundary = true;
            }

            // DecisionStale: the stale action was not executed; re-prepareTurn
            // by advancing to the next turn (P3 `06` §4).
            if (stale) {
              continue;
            }

            for (const entry of observations) {
              yield* tx
                .transact(
                  sessions.appendEntry(
                    input.execution.sessionId,
                    { entryKind: "Observation", payload: entry },
                    input.context._tag === "ExecutionOrigin"
                      ? sessionFence(input.execution.executionId, input.context)
                      : undefined,
                  ),
                )
                .pipe(Effect.mapError(failure));
            }

            if (
              currentLoopStep !== undefined &&
              loopSteps !== undefined &&
              loopStepFence !== undefined &&
              currentLoopStep.state === "ActionsInProgress" &&
              currentLoopStep.nextActionIndex >=
                decodedOutput.toolInvocations.length
            ) {
              const actionsCompleteStep = currentLoopStep;
              currentLoopStep = yield* tx
                .transact(
                  loopSteps.transition(
                    {
                      identity: actionsCompleteStep.identity,
                      expectedRevision: actionsCompleteStep.revision,
                      expectedState: "ActionsInProgress",
                      next: {
                        ...actionsCompleteStep,
                        state: "StepEffectsCommitted",
                        revision: actionsCompleteStep.revision + 1,
                        updatedAt: yield* now(),
                      },
                    },
                    loopStepFence,
                  ),
                )
                .pipe(Effect.mapError(failure));
            }

            // P14 `02` (G-B): a Coordination execution that runs out of turns
            // WITHOUT ever issuing a tool invocation is a pure-conversation
            // episode — its text turns ARE the user-visible response. Settle
            // Completed(QueryCompleted) rather than Failed. A turn that did
            // issue tool invocations settles through the control/executable
            // handler path (e.g. CoordinationCompleted) instead.
            sawToolInvocation =
              sawToolInvocation || decodedOutput.toolInvocations.length > 0;
            producedText = producedText || decodedOutput.text.trim().length > 0;
            // A true conversation turn (claimed human message driving the
            // execution) settles on its FIRST text answer — one provider
            // call per response episode (WAVE1 S04).
            if (
              decisionTurn.conversation === true &&
              decodedOutput.toolInvocations.length === 0 &&
              decodedOutput.text.trim().length > 0
            ) {
              const settlement: ExecutionSettlement = {
                _tag: "Completed",
                result: { _tag: "QueryCompleted" },
              };
              if (
                currentLoopStep !== undefined &&
                loopSteps !== undefined &&
                loopStepFence !== undefined &&
                currentLoopStep.state === "StepEffectsCommitted"
              ) {
                yield* tx
                  .transact(
                    loopSteps.transition(
                      {
                        identity: currentLoopStep.identity,
                        expectedRevision: currentLoopStep.revision,
                        expectedState: "StepEffectsCommitted",
                        next: {
                          ...currentLoopStep,
                          state: "SettlementProposed",
                          settlement,
                          revision: currentLoopStep.revision + 1,
                          updatedAt: yield* now(),
                        },
                      },
                      loopStepFence,
                    ),
                  )
                  .pipe(Effect.mapError(failure));
              }
              return settlement;
            }
            if (
              turn + 1 < MAX_TURNS &&
              currentLoopStep !== undefined &&
              loopSteps !== undefined &&
              loopStepFence !== undefined &&
              currentLoopStep.state === "StepEffectsCommitted"
            ) {
              const predecessor = currentLoopStep;
              const successorIdentity = {
                executionId: input.execution.executionId,
                logicalStepNo: turn + 1,
                repairAttempt: 0,
              } as const;
              const successorProviderTurnId =
                `ptn_${input.execution.executionId}_${turn + 1}` as never;
              yield* tx
                .transact(
                  Effect.gen(function* () {
                    yield* loopSteps.transition(
                      {
                        identity: predecessor.identity,
                        expectedRevision: predecessor.revision,
                        expectedState: "StepEffectsCommitted",
                        next: {
                          ...predecessor,
                          state: "NextStepReady",
                          successor: {
                            ...successorIdentity,
                            providerTurnId: successorProviderTurnId,
                          },
                          nextStepReason: "Continue",
                          revision: predecessor.revision + 1,
                          updatedAt: yield* now(),
                        },
                      },
                      loopStepFence,
                    );
                    yield* loopSteps.ensureSuccessor(
                      predecessor.identity,
                      {
                        identity: successorIdentity,
                        predecessor: predecessor.identity,
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
          }
          if (
            isConversationExecution(input.execution) &&
            !sawToolInvocation &&
            producedText
          ) {
            return {
              _tag: "Completed",
              result: { _tag: "QueryCompleted" },
            };
          }
          return {
            _tag: "Failed",
            failure: { _tag: "ExecutionFailure", reason: "max turns reached" },
          };
        });

      return ExecutionDriverPort.of({ drive });
    }),
  );

export { Option };
