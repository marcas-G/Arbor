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
  AGENT_DIRECTIVE_CONTRACT,
  type ControlBasis,
  decodeTurn,
  type InstructionFragment,
  ModelContext,
  type ModelOutput,
  type PreparedModelTurn,
  WORK_EXECUTION_PROGRAM,
} from "@arbor/model-context";
import {
  type BoundedObservation,
  EnvironmentRevisionStore,
  type ExecutionActivity,
  type ExecutionDriverError,
  ExecutionDriverPort,
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
import type { DirectiveHandler, DirectiveUnsupported } from "./directive.js";
import { checkFreshness, requirementForDirective } from "./freshness.js";
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
};

export interface AgentDriverOptions {
  /** P12 `03` §3: the credential reference the driver binds to a ProviderTurn.
   * Comes from Composition-Root config; the driver never hardcodes a raw ref.
   * The raw credential is resolved by ProviderRuntime at the execution
   * boundary and never reaches the Agent. */
  readonly secretRef?: SecretRef;
}

export const AgentDriverLive = (
  handlers: ReadonlyArray<DirectiveHandler> = [],
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
> =>
  Layer.effect(
    ExecutionDriverPort,
    Effect.gen(function* () {
      const modelContext = yield* ModelContext;
      const providerRuntime = yield* ProviderRuntime;
      const capabilityPort = yield* ModelCapabilityPort;
      const sessions = yield* SessionRepository;
      const tx = yield* TransactionPort;
      const environmentRevisions = yield* EnvironmentRevisionStore;
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
                  outputContractRef: AGENT_DIRECTIVE_CONTRACT,
                  manifestId: preparation.turn.manifest.compiledRequestHash,
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
                const decoded = decodeTurn(
                  events,
                  AGENT_DIRECTIVE_CONTRACT,
                  preparation.turn.manifest.compiledRequestHash,
                );
                if (decoded.ok) {
                  return {
                    _tag: "Ready",
                    turn: preparation.turn,
                    output: decoded.output,
                  };
                }
                const repair = decideRepair(
                  REPAIR_POLICY,
                  repairAttempt,
                  AGENT_DIRECTIVE_CONTRACT,
                  decoded.reason,
                );
                if (repair._tag === "Exhausted") {
                  return { _tag: "Settle", settlement: repair.settlement };
                }
                repairFragments = [repair.repairFragment];
                repairAttempt += 1;
              }
            });

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
                      outputContractRef: AGENT_DIRECTIVE_CONTRACT,
                      directiveKinds: decodedOutput.directives.map(
                        (entry) => entry.directive._tag,
                      ),
                    },
                  },
                  input.context._tag === "ExecutionOrigin"
                    ? sessionFence(input.execution.executionId, input.context)
                    : undefined,
                ),
              )
              .pipe(Effect.mapError(failure));

            const observations: Array<
              | {
                  readonly source: "Runtime" | "Tool";
                  readonly observation: BoundedObservation;
                }
              | DirectiveUnsupported
            > = [];
            let stale = false;
            for (const { directive } of decodedOutput.directives) {
              // DID §8.19 / P3 `06` §4: an effectful directive must validate
              // its relevant ControlBasis against the Manifest it was decided
              // under. A changed revision means the action is NOT executed and
              // the runtime must re-prepareTurn.
              const requirement = requirementForDirective(directive);
              if (requirement !== "None") {
                const current = yield* currentControlBasis();
                const freshness = checkFreshness(
                  preparedTurn.manifest.controlBasis,
                  current,
                  requirement,
                );
                if (freshness !== null) {
                  stale = true;
                  break;
                }
              }
              if (directive._tag === "CompletionClaim") {
                return {
                  _tag: "Completed",
                  result: {
                    _tag: "CompletionClaimed",
                    workRevision: directive.claim.workRevision as never,
                    claimRef: directive.claim.claimRef,
                  },
                };
              }
              if (directive._tag === "Yield") {
                return {
                  _tag: "Completed",
                  result: {
                    _tag: "Yielded",
                    reason: directive.reason,
                    waitSpec: directive.waitSpec,
                  },
                };
              }
              // D3: report tool recursion / chaining depth at each
              // ToolInvocation / Specialist action boundary. A top-level
              // call sits at depth 1 (the ProviderTurn is the root at 0).
              if (
                directive._tag === "InvokeTool" ||
                directive._tag === "SpawnSpecialist"
              ) {
                const actionActivity: ExecutionActivity =
                  directive._tag === "InvokeTool"
                    ? {
                        _tag: "ToolInvocation",
                        fingerprint: `tool:${directive.intent.toolName}:${directive.intent.argumentsJson}`,
                      }
                    : {
                        _tag: "SpecialistAction",
                        fingerprint: `spawn:${JSON.stringify(directive.spec)}`,
                      };
                const actionDecision = yield* admit(actionActivity, {
                  chainDepth: 1,
                  observedAt: yield* now(),
                });
                if (actionDecision === "Stop") {
                  return safetyStop("RuntimeSafetyStop");
                }
              }
              const handler = handlers.find(
                (candidate) => candidate.kind === directive._tag,
              );
              if (handler === undefined) {
                observations.push({
                  _tag: "DirectiveUnsupported",
                  directiveKind: directive._tag,
                  reason: "not implemented in this slice",
                });
                continue;
              }
              const outcome = yield* handler.handle({
                directive,
                execution: input.execution,
                context: input.context,
              });
              if (outcome._tag === "Settle") {
                return outcome.settlement;
              }
              if (outcome._tag === "Unsupported") {
                observations.push({
                  _tag: "DirectiveUnsupported",
                  directiveKind: directive._tag,
                  reason: outcome.reason,
                });
                continue;
              }
              observations.push({
                source: outcome.source,
                observation: outcome.observation,
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
