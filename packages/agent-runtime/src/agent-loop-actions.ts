import type {
  CommandSubmissionContext,
  Execution,
  ExecutionSettlement,
} from "@arbor/domain";
import type {
  ControlBasis,
  ModelOutput,
  PreparedModelTurn,
  ToolInvocation,
} from "@arbor/model-context";
import type {
  AgentLoopStepActionRecord,
  AgentLoopStepFence,
  AgentLoopStepRecord,
  AgentLoopStepStoreService,
  BoundedObservation,
  ExecutionActivity,
  ExecutionDriverError,
  RuntimeSafetyObservation,
  SessionRepositoryService,
  TransactionPortService,
} from "@arbor/ports";
import { sha256Hex } from "@arbor/ports";
import { Effect } from "effect";
import { MAX_TURNS, safetyStop } from "./agent-loop-policy.js";
import {
  type AgentActionError,
  type ControlToolRegistryService,
  classifyToolRoute,
  type ExecutableInvocationHandler,
} from "./control.js";
import type { ControlActionAuthorizerService } from "./control-authorization.js";
import { checkFreshness, requirementForAction } from "./freshness.js";
import type { AgentLoopQualificationProbe } from "./qualification-probe.js";

const actionRejectionObservation = (
  error: Extract<AgentActionError, { readonly _tag: "AgentActionRejected" }>,
): BoundedObservation => ({
  text: JSON.stringify({
    code: error.code,
    message: error.safeMessage,
    correction: error.correction,
  }),
  truncated: false,
});

export interface AgentLoopActionDependencies {
  readonly input: {
    readonly execution: Execution;
    readonly context: CommandSubmissionContext;
  };
  readonly preparedTurn: PreparedModelTurn;
  readonly decodedOutput: ModelOutput;
  readonly turn: number;
  readonly currentLoopStep?: AgentLoopStepRecord;
  readonly loopSteps?: AgentLoopStepStoreService;
  readonly loopStepFence?: AgentLoopStepFence;
  readonly tx: TransactionPortService;
  readonly sessions: SessionRepositoryService;
  readonly controlRegistry: ControlToolRegistryService;
  readonly controlAuthorizer?: ControlActionAuthorizerService;
  readonly executableInvocationHandler?: ExecutableInvocationHandler;
  readonly currentControlBasis: () => Effect.Effect<
    ControlBasis,
    ExecutionDriverError
  >;
  readonly admit: (
    activity: ExecutionActivity,
    observation: RuntimeSafetyObservation,
  ) => Effect.Effect<"Continue" | "Stop">;
  readonly failure: (cause: unknown) => ExecutionDriverError;
  readonly now: () => Effect.Effect<string>;
  readonly qualificationProbe?: AgentLoopQualificationProbe;
}

export type AgentLoopActionOutcome =
  | {
      readonly _tag: "Completed";
      readonly loopStep?: AgentLoopStepRecord;
      readonly observations: ReadonlyArray<{
        readonly source: "Runtime" | "Tool";
        readonly observation: BoundedObservation;
      }>;
      readonly durableProgress: boolean;
    }
  | { readonly _tag: "DecisionStale" }
  | {
      readonly _tag: "ApprovalRequired";
      readonly approvalId: string;
      readonly revision: number;
    }
  | { readonly _tag: "Settle"; readonly settlement: ExecutionSettlement };

/**
 * Owns one decoded turn's action phase. This boundary deliberately includes
 * both executable and control routes because they share the same durable
 * action ledger, idempotency rules, freshness admission, and early-settlement
 * semantics. The driver only consumes the resulting progression state.
 */
export const executeAgentLoopActions = (
  dependencies: AgentLoopActionDependencies,
): Effect.Effect<AgentLoopActionOutcome, ExecutionDriverError> => {
  const {
    input,
    preparedTurn,
    decodedOutput,
    turn,
    loopSteps,
    loopStepFence,
    tx,
    sessions,
    controlRegistry,
    controlAuthorizer,
    executableInvocationHandler,
    currentControlBasis,
    admit,
    failure,
    now,
  } = dependencies;

  return Effect.gen(function* () {
    let currentLoopStep = dependencies.currentLoopStep;
    const observations: Array<{
      readonly source: "Runtime" | "Tool";
      readonly observation: BoundedObservation;
    }> = [];
    let durableProgress = false;

    for (const [
      actionIndex,
      invocation,
    ] of decodedOutput.toolInvocations.entries()) {
      const classification = classifyToolRoute(
        preparedTurn.toolRoutes,
        controlRegistry,
        invocation.toolName,
      );
      if (classification._tag === "Invalid") {
        return {
          _tag: "Settle",
          settlement: safetyStop(classification.reason),
        };
      }
      const staleRegistration = classification._tag === "Stale";
      const route =
        classification._tag === "Stale"
          ? ({ _tag: classification.route } as const)
          : classification;

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
                      providerTurnId: preparedTurn.manifest.providerTurnId,
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
        if (
          dependencies.qualificationProbe !== undefined &&
          loopAction !== undefined
        ) {
          const pendingAction = loopAction;
          yield* Effect.promise(
            () =>
              dependencies.qualificationProbe?.({
                boundary: "AH7AfterActionIntentCommit",
                providerTurnId: preparedTurn.manifest.providerTurnId,
                executionId: input.execution.executionId,
                logicalActionId: pendingAction.logicalActionId,
                callRef: invocation.callRef,
                actionIndex,
              }) ?? Promise.resolve(),
          );
        }
      }

      const appendTerminalResult = (
        targetInvocation: ToolInvocation,
        targetRoute:
          | { readonly _tag: "Executable" }
          | { readonly _tag: "Control" },
        terminal: {
          readonly status: import("@arbor/ports").PortableToolResultStatus;
          readonly disposition: string;
          readonly outputText: string;
          readonly canonicalRefs?: ReadonlyArray<string>;
        },
        fence: AgentLoopStepFence,
      ) =>
        Effect.gen(function* () {
          const resultRef = `result_${sha256Hex(
            JSON.stringify({
              callRef: targetInvocation.callRef,
              status: terminal.status,
              disposition: terminal.disposition,
              outputText: terminal.outputText,
            }),
          )}`;
          const observationSourceRef = `observation_${input.execution.executionId}_${sha256Hex(
            JSON.stringify({
              providerTurnId: preparedTurn.manifest.providerTurnId,
              callRef: targetInvocation.callRef,
              resultRef,
            }),
          )}`;
          if (yield* sessions.supportsTypedTimeline()) {
            const item =
              targetRoute._tag === "Executable"
                ? {
                    _tag: "ToolResult" as const,
                    callRef: targetInvocation.callRef,
                    toolName: targetInvocation.toolName,
                    status: terminal.status,
                    observationRef: observationSourceRef,
                    modelOutputRef: resultRef,
                    outputText: terminal.outputText,
                    truncated: false,
                    artifactRefs: [],
                  }
                : {
                    _tag: "ControlResult" as const,
                    callRef: targetInvocation.callRef,
                    actionKind: targetInvocation.toolName,
                    status: terminal.status,
                    disposition: terminal.disposition,
                    outputText: terminal.outputText,
                    truncated: false,
                    canonicalRefs: terminal.canonicalRefs ?? [],
                    observationRef: observationSourceRef,
                  };
            yield* sessions.appendItemIdempotent(
              input.execution.sessionId,
              {
                item,
                contextEpoch: preparedTurn.manifest.contextEpoch,
                source: {
                  kind: "AgentLoopAction",
                  ref: observationSourceRef,
                },
                contentHash: sha256Hex(JSON.stringify(item)),
              },
              fence,
            );
          } else {
            const payload = {
              source: targetRoute._tag === "Executable" ? "Tool" : "Runtime",
              observation: {
                text: terminal.outputText,
                truncated: false,
              },
            } as const;
            yield* sessions.appendEntryIdempotent(
              input.execution.sessionId,
              { kind: "AgentLoopAction", ref: observationSourceRef },
              { entryKind: "Observation", payload },
              sha256Hex(JSON.stringify(payload)),
              fence,
            );
          }
          return { resultRef, observationSourceRef };
        });

      const persistTerminalAction = (terminal: {
        readonly settlement: ExecutionSettlement;
        readonly actionState:
          | "Applied"
          | "TerminalRejected"
          | "ReconciliationPending";
        readonly status: import("@arbor/ports").PortableToolResultStatus;
        readonly disposition: string;
        readonly outputText: string;
      }): Effect.Effect<void, ExecutionDriverError> =>
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
            JSON.stringify(terminal.settlement),
          )}`;
          currentLoopStep = yield* tx
            .transact(
              Effect.gen(function* () {
                const terminalResult = yield* appendTerminalResult(
                  invocation,
                  route,
                  {
                    status: terminal.status,
                    disposition: terminal.disposition,
                    outputText: terminal.outputText,
                    canonicalRefs: [settlementRef],
                  },
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
                      state: terminal.actionState,
                      resultRef: terminalResult.resultRef,
                      settlementRef,
                      disposition: { _tag: terminal.disposition },
                      observationSourceRef: terminalResult.observationSourceRef,
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
                  const skippedClassification = classifyToolRoute(
                    preparedTurn.toolRoutes,
                    controlRegistry,
                    skippedInvocation.toolName,
                  );
                  if (skippedClassification._tag === "Invalid") continue;
                  const skippedRoute =
                    skippedClassification._tag === "Stale"
                      ? ({ _tag: skippedClassification.route } as const)
                      : skippedClassification;
                  const pending = yield* loopSteps.createAction(
                    {
                      identity: actionsStep.identity,
                      actionIndex: skippedIndex,
                      logicalActionId: `lac_${sha256Hex(
                        JSON.stringify({
                          executionId: input.execution.executionId,
                          providerTurnId: preparedTurn.manifest.providerTurnId,
                          callRef: skippedInvocation.callRef,
                          routeKind: skippedRoute._tag,
                          actionKind: skippedInvocation.toolName,
                        }),
                      )}`,
                      callRef: skippedInvocation.callRef,
                      routeKind: skippedRoute._tag,
                      actionKind: skippedInvocation.toolName,
                      inputHash: sha256Hex(skippedInvocation.argumentsJson),
                      state: "Pending",
                      revision: 0,
                      updatedAt: yield* now(),
                    },
                    loopStepFence,
                  );
                  const skippedResult = yield* appendTerminalResult(
                    skippedInvocation,
                    skippedRoute,
                    {
                      status: "Interrupted",
                      disposition: "SkippedEarlySettlement",
                      outputText: `${skippedInvocation.toolName} skipped because an earlier action settled the execution`,
                      canonicalRefs: [settlementRef],
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
                        resultRef: skippedResult.resultRef,
                        settlementRef,
                        disposition: { _tag: "SkippedEarlySettlement" },
                        observationSourceRef:
                          skippedResult.observationSourceRef,
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
                      nextActionIndex: decodedOutput.toolInvocations.length,
                      settlement: terminal.settlement,
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

      const persistActionSettlement = (
        settlement: ExecutionSettlement,
      ): Effect.Effect<void, ExecutionDriverError> =>
        persistTerminalAction({
          settlement,
          actionState:
            settlement._tag === "OutcomeUnknown"
              ? "ReconciliationPending"
              : "Applied",
          status:
            settlement._tag === "OutcomeUnknown"
              ? "OutcomeUnknown"
              : settlement._tag === "Interrupted"
                ? "Interrupted"
                : settlement._tag === "Failed"
                  ? "Failed"
                  : "Succeeded",
          disposition: `ExecutionSettlement:${settlement._tag}`,
          outputText: `Control action settled the execution (${settlement._tag})`,
        });

      const persistActionRejection = (
        settlement: ExecutionSettlement,
        disposition: string,
        status: import("@arbor/ports").PortableToolResultStatus = "Denied",
      ): Effect.Effect<void, ExecutionDriverError> =>
        persistTerminalAction({
          settlement,
          actionState: "TerminalRejected",
          status,
          disposition,
          outputText: `${invocation.toolName} rejected by runtime (${disposition})`,
        });

      const persistActionObservation = (
        source: "Runtime" | "Tool",
        observation: BoundedObservation,
        resultMetadata: {
          readonly status?: import("@arbor/ports").PortableToolResultStatus;
          readonly disposition?: string;
          readonly resultRef?: string;
          readonly artifactRefs?: ReadonlyArray<string>;
          readonly invocationId?: import("@arbor/domain").ToolInvocationId;
        } = {},
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
          const status = resultMetadata.status ?? "Succeeded";
          const disposition = resultMetadata.disposition ?? "Applied";
          const payload = { source, observation, status, disposition };
          const resultRef = `result_${sha256Hex(JSON.stringify(payload))}`;
          const observationSourceRef = `observation_${input.execution.executionId}_${sha256Hex(
            JSON.stringify({
              providerTurnId: preparedTurn.manifest.providerTurnId,
              callRef: invocation.callRef,
              resultRef,
            }),
          )}`;
          currentLoopStep = yield* tx
            .transact(
              Effect.gen(function* () {
                if (yield* sessions.supportsTypedTimeline()) {
                  const item =
                    route._tag === "Executable"
                      ? {
                          _tag: "ToolResult" as const,
                          callRef: invocation.callRef,
                          toolName: invocation.toolName,
                          ...(resultMetadata.invocationId === undefined
                            ? {}
                            : { invocationId: resultMetadata.invocationId }),
                          status,
                          observationRef: observationSourceRef,
                          modelOutputRef: resultMetadata.resultRef ?? resultRef,
                          outputText: observation.text,
                          truncated: observation.truncated,
                          artifactRefs: resultMetadata.artifactRefs ?? [],
                        }
                      : {
                          _tag: "ControlResult" as const,
                          callRef: invocation.callRef,
                          actionKind: invocation.toolName,
                          status,
                          disposition,
                          outputText: observation.text,
                          truncated: observation.truncated,
                          canonicalRefs: [],
                          observationRef: observationSourceRef,
                        };
                  yield* sessions.appendItemIdempotent(
                    input.execution.sessionId,
                    {
                      item,
                      contextEpoch: preparedTurn.manifest.contextEpoch,
                      source: {
                        kind: "AgentLoopAction",
                        ref: observationSourceRef,
                      },
                      contentHash: sha256Hex(JSON.stringify(item)),
                    },
                    loopStepFence,
                  );
                } else {
                  yield* sessions.appendEntryIdempotent(
                    input.execution.sessionId,
                    { kind: "AgentLoopAction", ref: observationSourceRef },
                    { entryKind: "Observation", payload },
                    sha256Hex(JSON.stringify(payload)),
                    loopStepFence,
                  );
                }
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
                      disposition: { _tag: disposition, status },
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
          if (dependencies.qualificationProbe !== undefined) {
            yield* Effect.promise(
              () =>
                dependencies.qualificationProbe?.({
                  boundary: "AH7AfterActionResultCommit",
                  providerTurnId: preparedTurn.manifest.providerTurnId,
                  executionId: input.execution.executionId,
                  logicalActionId: pendingAction.logicalActionId,
                  callRef: invocation.callRef,
                  actionIndex,
                }) ?? Promise.resolve(),
            );
          }
          return true;
        });

      const activityDecision = yield* admit(
        {
          _tag: "ToolInvocation",
          fingerprint: `tool:${invocation.toolName}:${invocation.callRef}`,
        },
        { chainDepth: 1, observedAt: yield* now() },
      );
      if (staleRegistration) {
        const settlement = safetyStop("StaleToolRegistration");
        yield* persistActionRejection(settlement, "StaleToolRegistration");
        return { _tag: "Settle", settlement };
      }
      if (activityDecision === "Stop") {
        const settlement = safetyStop("RuntimeSafetyStop");
        yield* persistActionRejection(
          settlement,
          "RuntimeSafetyStop",
          "Interrupted",
        );
        return {
          _tag: "Settle",
          settlement,
        };
      }

      if (route._tag === "Executable") {
        if (executableInvocationHandler === undefined) {
          const settlement = safetyStop("ExecutableToolHandlerUnavailable");
          yield* persistActionRejection(settlement, "HandlerUnavailable");
          return {
            _tag: "Settle",
            settlement,
          };
        }
        const executed = yield* Effect.match(
          executableInvocationHandler.handle({
            invocation,
            execution: input.execution,
            context: input.context,
            controlBasis: preparedTurn.manifest.controlBasis,
          }),
          {
            onFailure: (cause) => ({ ok: false as const, cause }),
            onSuccess: (outcome) => ({ ok: true as const, outcome }),
          },
        );
        if (!executed.ok) {
          if (executed.cause._tag === "AgentActionRejected") {
            const disposition = `ModelUsable:${executed.cause.code}`;
            const observation = actionRejectionObservation(executed.cause);
            const persisted = yield* persistActionObservation(
              "Runtime",
              observation,
              { status: "Failed", disposition },
            );
            if (!persisted) {
              observations.push({ source: "Runtime", observation });
            }
            durableProgress = true;
            continue;
          }
          const settlement = safetyStop("ExecutableToolInvocationRejected");
          yield* persistActionRejection(settlement, "HandlerRejected");
          return {
            _tag: "Settle",
            settlement,
          };
        }
        if (executed.outcome._tag === "Settle") {
          yield* persistActionSettlement(executed.outcome.settlement);
          return {
            _tag: "Settle",
            settlement: executed.outcome.settlement,
          };
        }
        const persisted = yield* persistActionObservation(
          executed.outcome.source,
          executed.outcome.observation,
          {
            ...(executed.outcome.status === undefined
              ? {}
              : { status: executed.outcome.status }),
            ...(executed.outcome.resultRef === undefined
              ? {}
              : { resultRef: executed.outcome.resultRef }),
            ...(executed.outcome.artifactRefs === undefined
              ? {}
              : { artifactRefs: executed.outcome.artifactRefs }),
            ...(executed.outcome.invocationId === undefined
              ? {}
              : { invocationId: executed.outcome.invocationId }),
          },
        );
        if (!persisted) {
          observations.push({
            source: executed.outcome.source,
            observation: executed.outcome.observation,
          });
        }
        durableProgress = true;
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
        if (decodedAction.cause._tag === "InvalidControlArguments") {
          const disposition =
            "ModelCorrectable:InvalidControlArguments" as const;
          const observation = {
            text: JSON.stringify({
              code: "invalid_control_arguments",
              toolName: decodedAction.cause.toolName,
              reason: decodedAction.cause.reason,
              correction:
                "Correct the arguments for this control action and try again with a new tool call.",
            }),
            truncated: false,
          };
          const persisted = yield* persistActionObservation(
            "Runtime",
            observation,
            { status: "Failed", disposition },
          );
          if (!persisted) {
            observations.push({ source: "Runtime", observation });
          }
          durableProgress = true;
          continue;
        }
        const settlement = safetyStop(
          `ControlToolDecodeFailed:${decodedAction.cause._tag}`,
        );
        yield* persistActionRejection(settlement, "DecodeRejected");
        return {
          _tag: "Settle",
          settlement,
        };
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
                const staleResult = yield* appendTerminalResult(
                  invocation,
                  route,
                  {
                    status: "Denied",
                    disposition: "DecisionStale",
                    outputText: `${invocation.toolName} skipped because the decision basis became stale`,
                  },
                  loopStepFence,
                );
                yield* loopSteps.transitionAction(
                  {
                    identity: staleAction.identity,
                    actionIndex: staleAction.actionIndex,
                    expectedRevision: staleAction.revision,
                    expectedState: "Pending",
                    next: {
                      ...staleAction,
                      state: "SkippedStale",
                      resultRef: staleResult.resultRef,
                      disposition: { _tag: "DecisionStale" },
                      observationSourceRef: staleResult.observationSourceRef,
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
                  const skippedClassification = classifyToolRoute(
                    preparedTurn.toolRoutes,
                    controlRegistry,
                    skippedInvocation.toolName,
                  );
                  if (skippedClassification._tag === "Invalid") continue;
                  const skippedRoute =
                    skippedClassification._tag === "Stale"
                      ? ({ _tag: skippedClassification.route } as const)
                      : skippedClassification;
                  const pending = yield* loopSteps.createAction(
                    {
                      identity: staleStep.identity,
                      actionIndex: skippedIndex,
                      logicalActionId: `lac_${sha256Hex(
                        JSON.stringify({
                          executionId: input.execution.executionId,
                          providerTurnId: preparedTurn.manifest.providerTurnId,
                          callRef: skippedInvocation.callRef,
                          routeKind: skippedRoute._tag,
                          actionKind: skippedInvocation.toolName,
                        }),
                      )}`,
                      callRef: skippedInvocation.callRef,
                      routeKind: skippedRoute._tag,
                      actionKind: skippedInvocation.toolName,
                      inputHash: sha256Hex(skippedInvocation.argumentsJson),
                      state: "Pending",
                      revision: 0,
                      updatedAt: yield* now(),
                    },
                    loopStepFence,
                  );
                  const skippedStaleResult = yield* appendTerminalResult(
                    skippedInvocation,
                    skippedRoute,
                    {
                      status: "Denied",
                      disposition: "DecisionStale",
                      outputText: `${skippedInvocation.toolName} skipped because the decision basis became stale`,
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
                        resultRef: skippedStaleResult.resultRef,
                        disposition: { _tag: "DecisionStale" },
                        observationSourceRef:
                          skippedStaleResult.observationSourceRef,
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
                      nextActionIndex: decodedOutput.toolInvocations.length,
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
        return { _tag: "DecisionStale" };
      }

      const authorization =
        controlAuthorizer === undefined
          ? {
              _tag: "Authorized" as const,
              authorityRef: "legacy-test-only",
              actionDigest: sha256Hex(
                JSON.stringify(decodedAction.value.action),
              ),
              controlBasisDigest: sha256Hex(JSON.stringify(current)),
            }
          : yield* controlAuthorizer.authorize({
              action: decodedAction.value.action,
              invocation,
              execution: input.execution,
              context: input.context,
              controlBasis: current,
            });
      if (authorization._tag === "ApprovalRequired") {
        return {
          _tag: "ApprovalRequired",
          approvalId: authorization.approvalId,
          revision: authorization.revision,
        };
      }
      if (authorization._tag === "Denied") {
        const observation = {
          text: JSON.stringify({
            code: "control_action_denied",
            reason: authorization.reason,
            correction: "RequestHumanApprovalOrChooseAlternative",
          }),
          truncated: false,
        };
        const persisted = yield* persistActionObservation(
          "Runtime",
          observation,
          { status: "Denied", disposition: "AuthorizationDenied" },
        );
        if (!persisted) observations.push({ source: "Runtime", observation });
        durableProgress = true;
        continue;
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
        if (handled.cause._tag === "AgentActionRejected") {
          const disposition = `ModelUsable:${handled.cause.code}`;
          const observation = actionRejectionObservation(handled.cause);
          const persisted = yield* persistActionObservation(
            "Runtime",
            observation,
            { status: "Failed", disposition },
          );
          if (!persisted) {
            observations.push({ source: "Runtime", observation });
          }
          durableProgress = true;
          continue;
        }
        const settlement = safetyStop("ControlActionHandlerRejected");
        yield* persistActionRejection(settlement, "HandlerRejected");
        return {
          _tag: "Settle",
          settlement,
        };
      }
      if (
        authorization.approvalId !== undefined &&
        controlAuthorizer !== undefined &&
        !(yield* controlAuthorizer.consumeApproval({
          approvalId: authorization.approvalId,
          approvalRevision: authorization.approvalRevision ?? 0,
          actionDigest: authorization.actionDigest,
          controlBasisDigest: authorization.controlBasisDigest,
        }))
      ) {
        const settlement = safetyStop("ControlApprovalConsumptionRejected");
        yield* persistActionRejection(
          settlement,
          "ApprovalConsumptionRejected",
        );
        return { _tag: "Settle", settlement };
      }
      if (handled.outcome._tag === "Settle") {
        yield* persistActionSettlement(handled.outcome.settlement);
        return {
          _tag: "Settle",
          settlement: handled.outcome.settlement,
        };
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
      durableProgress = true;
    }

    return {
      _tag: "Completed",
      ...(currentLoopStep === undefined ? {} : { loopStep: currentLoopStep }),
      observations,
      durableProgress,
    };
  });
};
