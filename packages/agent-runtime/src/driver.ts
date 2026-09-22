import type {
  AgentBinding,
  AgentExecutionState,
  Execution,
  ExecutionSettlement,
  WakeReason,
} from "@arbor/domain";
import {
  AGENT_DIRECTIVE_CONTRACT,
  type ControlBasis,
  decodeTurn,
  type InstructionFragment,
  ModelContext,
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
  SessionRepository,
  TransactionPort,
} from "@arbor/ports";
import { Effect, Layer, Option } from "effect";
import type { DirectiveHandler, DirectiveUnsupported } from "./directive.js";

const MAX_TURNS = 8;

const safetyStop = (reason: string): ExecutionSettlement => ({
  _tag: "Interrupted",
  result: { _tag: "ControlledInterruption", reason },
});

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

export const AgentDriverLive = (
  handlers: ReadonlyArray<DirectiveHandler> = [],
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
          // P11 GQ4b: service-internal read of the project's environment
          // revision counter (CI-2 — callers never pass a revision). None
          // means the anchor is not yet initialized; observing "0" keeps the
          // P11-003 resolver semantics. DecisionStale still fires per DID
          // §8.19 when the counter moves after this capture.
          const environmentRevision = yield* tx
            .transact(environmentRevisions.current(input.execution.projectId))
            .pipe(
              Effect.mapError(failure),
              Effect.map(Option.getOrElse(() => "0")),
            );
          const controlBasis: ControlBasis = {
            projectPolicyRevision: 0,
            workspacePolicyRevision: 0,
            responsibilityRevision: 0,
            resourceBoundaryRevision: 0,
            authorizationDigest: "digest",
            environmentRevision,
          };

          for (let turn = 0; turn < MAX_TURNS; turn += 1) {
            const activity: ExecutionActivity = {
              _tag: "ProviderTurn",
              fingerprint: `turn-${turn}`,
            };
            const decision = yield* input.safetyGate.admitActivity(
              input.execution.executionId,
              activity,
            );
            if (decision === "Stop") {
              return safetyStop("RuntimeSafetyStop");
            }

            const preparation = yield* modelContext
              .prepareTurn({
                executionId: input.execution.executionId,
                sessionId: input.execution.sessionId,
                contextEpoch: 0 as never,
                providerTurnId:
                  `ptn_${input.execution.executionId}_${turn}` as never,
                binding: agentBinding,
                workspaceId: input.execution.workspaceId,
                cognitiveMode:
                  input.agentExecutionState.currentMode ?? "execute",
                program: WORK_EXECUTION_PROGRAM,
                fragments: [
                  runtimeSafetyFragment,
                  workObjectiveFragment(input.execution),
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
              return safetyStop("GovernanceBlocked");
            }
            if (preparation._tag === "NeedsCompaction") {
              // Kernel: an explicit compaction ProviderTurn would run here (P3-008
              // protocol); the fake provider treats it as a normal turn.
              return safetyStop("CompactionRequired");
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
              secretRef: "secret",
              timeoutMs: 30_000,
              cancellationRef: "cancel",
            };
            const events = yield* providerRuntime.runTurn(turnInput).pipe(
              Effect.mapError(
                (cause): ExecutionDriverError => ({
                  _tag: "ExecutionDriverError",
                  cause,
                }),
              ),
            );
            const decoded = decodeTurn(
              events,
              AGENT_DIRECTIVE_CONTRACT,
              preparation.turn.manifest.compiledRequestHash,
            );
            if (!decoded.ok) {
              return {
                _tag: "Failed",
                failure: { _tag: "ExecutionFailure", reason: decoded.reason },
              };
            }

            yield* tx
              .transact(
                sessions.appendEntry(
                  input.execution.sessionId,
                  {
                    entryKind: "ModelOutput",
                    payload: {
                      providerTurnId: preparation.turn.manifest.providerTurnId,
                      outputContractRef: AGENT_DIRECTIVE_CONTRACT,
                      directiveKinds: decoded.output.directives.map(
                        (entry) => entry.directive._tag,
                      ),
                    },
                  },
                  input.context._tag === "ExecutionOrigin"
                    ? {
                        executionId: input.execution.executionId,
                        fencingGeneration: input.context.fencingGeneration,
                      }
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
            for (const { directive } of decoded.output.directives) {
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
            }

            for (const entry of observations) {
              yield* tx
                .transact(
                  sessions.appendEntry(
                    input.execution.sessionId,
                    { entryKind: "Observation", payload: entry },
                    input.context._tag === "ExecutionOrigin"
                      ? {
                          executionId: input.execution.executionId,
                          fencingGeneration: input.context.fencingGeneration,
                        }
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
