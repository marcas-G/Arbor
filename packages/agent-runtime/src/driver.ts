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
  type BoundedObservation,
  EnvironmentRevisionStore,
  type ExecutionActivity,
  type ExecutionDriverError,
  ExecutionDriverPort,
  type HumanMessageRecord,
  HumanMessageStore,
  ModelCapabilityPort,
  type ProviderRunInput,
  ProviderRuntime,
  type RuntimeSafetyGateService,
  type RuntimeSafetyObservation,
  type SecretRef,
  SessionRepository,
  TransactionPort,
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
      /** P14: this turn carried conversation context (a claimed human
       * message) — the first text answer settles the episode. */
      readonly conversation?: boolean;
    }
  | { readonly _tag: "Settle"; readonly settlement: ExecutionSettlement };

const safetyStop = (reason: string): ExecutionSettlement => ({
  _tag: "Interrupted",
  result: { _tag: "ControlledInterruption", reason },
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
  /** The typed control-tool registry. Composition supplies the live registry;
   * the default keeps Wait available for focused runtime tests. */
  readonly controlRegistry?: ControlToolRegistryService;
  readonly executableInvocationHandler?: ExecutableInvocationHandler;
  /** Adapter identity recorded on manifests (P14 conversation audit). */
  readonly providerRef?: string;
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
      const environmentRevisions = yield* EnvironmentRevisionStore;
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
                  manifestId: preparation.turn.manifest.compiledRequestHash,
                  manifest: {
                    manifestId: preparation.turn.manifest.compiledRequestHash,
                    providerTurnId: preparation.turn.manifest.providerTurnId,
                    executionId: preparation.turn.manifest.executionId,
                    sessionId: preparation.turn.manifest.sessionId,
                    contextEpoch: preparation.turn.manifest.contextEpoch,
                    modelRef: preparation.turn.manifest.modelRef,
                    compiledRequestHash:
                      preparation.turn.manifest.compiledRequestHash,
                    manifestJson: JSON.stringify(preparation.turn.manifest),
                  },
                  request: preparation.turn.request,
                  ...(options.secretRef !== undefined
                    ? { secretRef: options.secretRef }
                    : {}),
                  timeoutMs: 30_000,
                  cancellationRef: "cancel",
                };
                const providerRun = yield* providerRuntime
                  .runTurn(turnInput)
                  .pipe(
                    Effect.mapError(
                      (cause): ExecutionDriverError => ({
                        _tag: "ExecutionDriverError",
                        cause,
                      }),
                    ),
                  );
                const events = providerRun.events;
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
                  return { _tag: "Settle", settlement: repair.settlement };
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

            yield* tx
              .transact(
                sessions.appendEntry(
                  input.execution.sessionId,
                  {
                    entryKind: "ModelOutput",
                    payload: {
                      providerTurnId: preparedTurn.manifest.providerTurnId,
                      outputContractRef:
                        preparedTurn.manifest.outputContractRef,
                      text: decodedOutput.text,
                      finishReason: decodedOutput.finishReason,
                      toolInvocations: decodedOutput.toolInvocations,
                    },
                  },
                  input.context._tag === "ExecutionOrigin"
                    ? sessionFence(input.execution.executionId, input.context)
                    : undefined,
                ),
              )
              .pipe(Effect.mapError(failure));

            const observations: Array<{
              readonly source: "Runtime" | "Tool";
              readonly observation: BoundedObservation;
            }> = [];
            let stale = false;
            for (const invocation of decodedOutput.toolInvocations) {
              const route = classifyToolRoute(
                preparedTurn.toolRoutes,
                controlRegistry,
                invocation.toolName,
              );
              if (route._tag === "Invalid") {
                return safetyStop(route.reason);
              }
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
                  return executed.outcome.settlement;
                }
                observations.push({
                  source: executed.outcome.source,
                  observation: executed.outcome.observation,
                });
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
                return handled.outcome.settlement;
              }
              observations.push({
                source: handled.outcome.source,
                observation: handled.outcome.observation,
              });
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
              return {
                _tag: "Completed",
                result: { _tag: "QueryCompleted" },
              };
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
