import {
  blockedFailureFingerprint,
  verifyBlockedActionRefs,
  workBlockerIdentity,
} from "@arbor/application";
import type {
  BlockedActionRef,
  CommandSubmissionContext,
  Execution,
  ExecutionSettlement,
  ProviderTurnId,
  TerminalActionDenial,
  WorkRevision,
} from "@arbor/domain";
import { workEpisode as exactWorkEpisode } from "@arbor/domain";
import {
  type ControlBasis,
  decodeTurn,
  type ModelOutput,
  type PreparedModelTurn,
  type ToolInvocation,
} from "@arbor/model-context";
import type {
  AgentLoopStepActionRecord,
  AgentLoopStepFence,
  AgentLoopStepRecord,
  AgentLoopStepStoreService,
  BoundedObservation,
  ExecutionActivity,
  ExecutionDriverError,
  InboxProjectionStoreService,
  LeaseFencingRejected,
  ProviderTurnStoreService,
  RecoveryBindingPolicyRevisions,
  RecoveryBindingSourceIdentity,
  RuntimeSafetyObservation,
  SessionRepositoryService,
  TransactionPortService,
} from "@arbor/ports";
import { sha256Hex } from "@arbor/ports";
import { Effect, Option } from "effect";
import { MAX_TURNS, safetyStop } from "./agent-loop-policy.js";
import {
  type AgentActionError,
  type ControlToolRegistryService,
  classifyToolRoute,
  type ExecutableInvocationHandler,
} from "./control.js";
import type { ControlActionAuthorizerService } from "./control-authorization.js";
import { checkFreshness, requirementForAction } from "./freshness.js";
import { matchesPersistedModelOutput } from "./persisted-model-output.js";
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

export const recoveryBindingIdentityFor = (input: {
  readonly step: AgentLoopStepRecord | undefined;
  readonly action: AgentLoopStepActionRecord | undefined;
  readonly executionId: Execution["executionId"];
  readonly providerTurnId: ProviderTurnId;
  readonly actionIndex: number;
  readonly callRef: string;
}): RecoveryBindingSourceIdentity | undefined => {
  const { step, action } = input;
  if (
    step === undefined ||
    action === undefined ||
    step.identity.executionId !== input.executionId ||
    step.providerTurnId !== input.providerTurnId ||
    action.identity.executionId !== step.identity.executionId ||
    action.identity.logicalStepNo !== step.identity.logicalStepNo ||
    action.identity.repairAttempt !== step.identity.repairAttempt ||
    action.actionIndex !== input.actionIndex ||
    action.callRef !== input.callRef ||
    action.logicalActionId.trim().length === 0
  ) {
    return undefined;
  }
  return {
    executionId: step.identity.executionId,
    providerTurnId: step.providerTurnId,
    logicalStepNo: step.identity.logicalStepNo,
    repairAttempt: step.identity.repairAttempt,
    logicalActionId: action.logicalActionId,
    actionIndex: action.actionIndex,
    callRef: action.callRef,
  };
};

export const recoveryBindingPolicyRevisionsFor = (
  controlBasis: Pick<
    ControlBasis,
    "workspacePolicyRevision" | "projectPolicyRevision"
  >,
): RecoveryBindingPolicyRevisions | undefined => {
  const workspacePolicyRevision = controlBasis.workspacePolicyRevision;
  const projectPolicyRevision = controlBasis.projectPolicyRevision;
  if (
    !Number.isSafeInteger(workspacePolicyRevision) ||
    workspacePolicyRevision < 0 ||
    !Number.isSafeInteger(projectPolicyRevision) ||
    projectPolicyRevision < 0
  ) {
    return undefined;
  }
  return { workspacePolicyRevision, projectPolicyRevision };
};

const isLeaseFencingRejected = (
  cause: unknown,
): cause is LeaseFencingRejected =>
  typeof cause === "object" &&
  cause !== null &&
  "_tag" in cause &&
  cause._tag === "LeaseFencingRejected";

const terminalDenialOf = (
  value: unknown,
): BlockedActionRef["terminalDenial"] | null => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  if (record._tag === "HandlerRejected" && record.routeKind === "Executable") {
    return { _tag: "HandlerRejected", routeKind: "Executable" };
  }
  if (
    record._tag === "P4NoEffectDenied" &&
    typeof record.reasonCode === "string" &&
    record.reasonCode !== "ApprovalRequired"
  ) {
    return {
      _tag: "P4NoEffectDenied",
      reasonCode: record.reasonCode as Extract<
        BlockedActionRef["terminalDenial"],
        { readonly _tag: "P4NoEffectDenied" }
      >["reasonCode"],
    };
  }
  return null;
};

const compareActionOrder = (
  left: {
    readonly logicalStepNo: number;
    readonly repairAttempt: number;
    readonly actionIndex?: number;
  },
  right: {
    readonly logicalStepNo: number;
    readonly repairAttempt: number;
    readonly actionIndex?: number;
  },
): number =>
  left.logicalStepNo - right.logicalStepNo ||
  left.repairAttempt - right.repairAttempt ||
  (left.actionIndex ?? 0) - (right.actionIndex ?? 0);

export const makeBlockedSettlement = (
  dependencies: AgentLoopActionDependencies,
  request: string,
  currentLoopStep: AgentLoopStepRecord | undefined,
): Effect.Effect<ExecutionSettlement | null, ExecutionDriverError> =>
  Effect.gen(function* () {
    const execution = dependencies.input.execution;
    const episode = exactWorkEpisode(execution);
    const current = currentLoopStep;
    const steps = dependencies.loopSteps;
    const turns = dependencies.providerTurns;
    const inbox = dependencies.inboxSequence;
    if (
      episode === null ||
      current === undefined ||
      steps === undefined ||
      turns === undefined ||
      inbox === undefined
    ) {
      return null;
    }

    const chain: AgentLoopStepRecord[] = [];
    let step: AgentLoopStepRecord | undefined = current;
    for (let count = 0; step !== undefined && count < 256; count += 1) {
      chain.push(step);
      if (step.predecessor === undefined) break;
      const previous: Option.Option<AgentLoopStepRecord> =
        yield* dependencies.tx
          .transact(steps.find(step.predecessor))
          .pipe(Effect.mapError(dependencies.failure));
      if (previous._tag === "None") return null;
      step = previous.value;
    }
    if (step?.predecessor !== undefined) return null;
    chain.sort((left, right) =>
      compareActionOrder(left.identity, right.identity),
    );

    const actions: Array<{
      readonly step: AgentLoopStepRecord;
      readonly action: AgentLoopStepActionRecord;
    }> = [];
    for (const candidate of chain) {
      const records = yield* dependencies.tx
        .transact(steps.listActions(candidate.identity))
        .pipe(Effect.mapError(dependencies.failure));
      for (const action of records) actions.push({ step: candidate, action });
    }
    actions.sort(
      (left, right) =>
        compareActionOrder(left.action.identity, right.action.identity) ||
        left.action.actionIndex - right.action.actionIndex,
    );
    const terminalDenials: Array<{
      readonly step: AgentLoopStepRecord;
      readonly action: AgentLoopStepActionRecord;
      readonly terminalDenial: BlockedActionRef["terminalDenial"];
    }> = [];
    for (const row of actions) {
      if (
        row.action.state !== "TerminalRejected" ||
        row.action.routeKind !== "Executable"
      ) {
        continue;
      }
      const disposition = row.action.disposition;
      const record =
        typeof disposition === "object" &&
        disposition !== null &&
        !Array.isArray(disposition)
          ? (disposition as Record<string, unknown>)
          : null;
      const terminalDenial = terminalDenialOf(record?.terminalDenial);
      if (
        record?.status !== "Denied" ||
        terminalDenial === null ||
        row.action.resultRef === undefined ||
        row.action.settlementRef === undefined ||
        row.action.observationSourceRef === undefined
      ) {
        // A legacy or malformed P9 row is not upgraded from its free-form
        // disposition. The Agent must explicitly repair/dispose it first.
        return null;
      }
      terminalDenials.push({ ...row, terminalDenial });
    }
    const unresolved = terminalDenials.filter((denied) => {
      const laterSuccess = actions.some(
        (candidate) =>
          candidate.action.routeKind === "Executable" &&
          candidate.action.state === "Applied" &&
          candidate.action.actionKind === denied.action.actionKind &&
          candidate.action.inputHash === denied.action.inputHash &&
          compareActionOrder(
            candidate.action.identity,
            denied.action.identity,
          ) > 0 &&
          candidate.action.disposition !== undefined &&
          typeof candidate.action.disposition === "object" &&
          candidate.action.disposition !== null &&
          (candidate.action.disposition as Record<string, unknown>).status ===
            "Succeeded",
      );
      return !laterSuccess;
    });
    if (unresolved.length === 0) return null;
    const mappedRefs = unresolved.map(
      ({ step: item, action, terminalDenial }) => ({
        executionId: execution.executionId,
        providerTurnId: item.providerTurnId,
        logicalStepNo: item.identity.logicalStepNo,
        repairAttempt: item.identity.repairAttempt,
        actionIndex: action.actionIndex,
        logicalActionId: action.logicalActionId,
        callRef: action.callRef,
        resultRef: action.resultRef as string,
        settlementRef: action.settlementRef as string,
        observationSourceRef: action.observationSourceRef as string,
        terminalDenial,
      }),
    );
    const firstRef = mappedRefs[0];
    if (firstRef === undefined) return null;
    const refs = [firstRef, ...mappedRefs.slice(1)] as const;
    const verification = yield* Effect.match(
      dependencies.tx.transact(
        verifyBlockedActionRefs(
          { executionId: execution.executionId, refs },
          { loopSteps: steps, providerTurns: turns },
        ),
      ),
      {
        onFailure: (cause) => ({ ok: false as const, cause }),
        onSuccess: (value) => ({ ok: true as const, value }),
      },
    );
    if (!verification.ok) {
      if (
        typeof verification.cause === "object" &&
        verification.cause !== null &&
        "_tag" in verification.cause &&
        verification.cause._tag === "BlockedActionEvidenceInvalid"
      ) {
        return null;
      }
      return yield* Effect.fail(dependencies.failure(verification.cause));
    }
    const verified = verification.value;
    const failureFingerprint = blockedFailureFingerprint(verified);
    const blockerId = workBlockerIdentity({
      projectId: execution.projectId,
      workId: episode.workId,
      targetWorkRevision: episode.targetWorkRevision,
      failureFingerprint,
    });
    const observedSequence = yield* dependencies.tx
      .transact(inbox.currentSequence(execution.workspaceId))
      .pipe(Effect.mapError(dependencies.failure));
    return {
      _tag: "Completed",
      result: {
        _tag: "Blocked",
        workId: episode.workId,
        targetWorkRevision: episode.targetWorkRevision as WorkRevision,
        blockerId: blockerId as never,
        waitFor: {
          mode: "Any",
          conditions: [
            { _tag: "Manual" },
            {
              _tag: "InboxAdvanced",
              workspaceId: execution.workspaceId,
              observedSequence,
            },
          ],
        },
        request,
        failedActionRefs: refs,
      },
    };
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
  readonly providerTurns?: Pick<
    ProviderTurnStoreService,
    "findManifestByTurn" | "findSettledResult"
  >;
  readonly inboxSequence?: Pick<InboxProjectionStoreService, "currentSequence">;
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
  | { readonly _tag: "RecoveryBlocked" }
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
    providerTurns,
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

    // This state may advance only when its exact accepted ProviderTurn output,
    // cursor, and every terminal action row still agree. Otherwise a corrupt
    // ledger could be mistaken for completed effects during recovery.
    if (currentLoopStep?.state === "StepEffectsCommitted") {
      const committedStep = currentLoopStep;
      if (
        loopSteps === undefined ||
        loopStepFence === undefined ||
        providerTurns === undefined
      ) {
        return yield* Effect.fail(
          failure({ _tag: "AgentLoopStepReplayBindingMismatch" }),
        );
      }
      const expectedOutput = {
        providerTurnId: preparedTurn.manifest.providerTurnId,
        outputContractRef: preparedTurn.manifest.outputContractRef,
        decoderVersion: "decode-turn-v1",
        text: decodedOutput.text,
        finishReason: decodedOutput.finishReason,
        toolInvocations: decodedOutput.toolInvocations,
      } as const;
      const expectedOutputHash = sha256Hex(JSON.stringify(expectedOutput));
      const verification = yield* tx
        .transact(
          Effect.gen(function* () {
            const stepOption = yield* loopSteps.find(committedStep.identity);
            if (!Option.isSome(stepOption)) return undefined;
            const step = stepOption.value;
            if (
              step.state !== "StepEffectsCommitted" ||
              step.revision !== committedStep.revision ||
              step.providerTurnId !== preparedTurn.manifest.providerTurnId ||
              step.manifestId === undefined ||
              step.decodedOutputHash !== expectedOutputHash ||
              step.decoderVersion !== "decode-turn-v1" ||
              step.modelOutputSessionSequence === undefined ||
              step.nextActionIndex !== decodedOutput.toolInvocations.length
            ) {
              return undefined;
            }

            const providerResult = yield* providerTurns.findSettledResult(
              step.providerTurnId,
            );
            const persistedManifest = yield* providerTurns.findManifestByTurn(
              step.providerTurnId,
            );
            if (
              providerResult._tag !== "SettledSuccess" ||
              providerResult.evidenceVersion !== "provider-success-v1" ||
              persistedManifest === null ||
              providerResult.manifestId !== step.manifestId ||
              providerResult.manifestJson !== persistedManifest.manifestJson ||
              providerResult.turn.providerTurnId !== step.providerTurnId ||
              providerResult.turn.executionId !== input.execution.executionId ||
              providerResult.turn.sessionId !== input.execution.sessionId ||
              providerResult.turn.contextEpoch !==
                preparedTurn.manifest.contextEpoch ||
              providerResult.turn.modelRef !== preparedTurn.manifest.modelRef ||
              providerResult.turn.outputContractRef !==
                preparedTurn.manifest.outputContractRef ||
              providerResult.finishReason !== decodedOutput.finishReason
            ) {
              return undefined;
            }

            let manifest: Record<string, unknown>;
            try {
              const parsed = JSON.parse(
                persistedManifest.manifestJson,
              ) as unknown;
              if (
                typeof parsed !== "object" ||
                parsed === null ||
                Array.isArray(parsed)
              ) {
                return undefined;
              }
              manifest = parsed as Record<string, unknown>;
            } catch {
              return undefined;
            }
            const manifestRoutes = manifest.toolRoutes;
            if (
              manifest.providerTurnId !== step.providerTurnId ||
              manifest.executionId !== input.execution.executionId ||
              manifest.sessionId !== input.execution.sessionId ||
              manifest.contextEpoch !== preparedTurn.manifest.contextEpoch ||
              manifest.modelRef !== preparedTurn.manifest.modelRef ||
              manifest.outputContractRef !==
                preparedTurn.manifest.outputContractRef ||
              manifest.logicalStepNo !== step.identity.logicalStepNo ||
              manifest.repairAttempt !== step.identity.repairAttempt ||
              !Array.isArray(manifestRoutes) ||
              JSON.stringify(manifestRoutes) !==
                JSON.stringify(preparedTurn.manifest.toolRoutes) ||
              JSON.stringify(manifestRoutes) !==
                JSON.stringify(preparedTurn.toolRoutes)
            ) {
              return undefined;
            }

            const providerOutput = decodeTurn(providerResult.canonicalEvents);
            if (
              !providerOutput.ok ||
              JSON.stringify({
                providerTurnId: step.providerTurnId,
                outputContractRef: manifest.outputContractRef,
                decoderVersion: "decode-turn-v1",
                text: providerOutput.output.text,
                finishReason: providerOutput.output.finishReason,
                toolInvocations: providerOutput.output.toolInvocations,
              }) !== JSON.stringify(expectedOutput)
            ) {
              return undefined;
            }

            const outputRows = yield* sessions.listEntries(
              input.execution.sessionId,
              step.modelOutputSessionSequence - 1,
              1,
            );
            const outputEntry = outputRows[0];
            if (
              outputRows.length !== 1 ||
              !matchesPersistedModelOutput({
                providerTurnId: step.providerTurnId,
                outputContractRef: preparedTurn.manifest.outputContractRef,
                text: decodedOutput.text,
                finishReason: decodedOutput.finishReason,
                toolInvocations: decodedOutput.toolInvocations,
                decodedOutputHash: step.decodedOutputHash,
                modelOutputSessionSequence: step.modelOutputSessionSequence,
                entry: outputEntry,
              })
            ) {
              return undefined;
            }
            const actions = yield* loopSteps.listActions(step.identity);
            if (
              actions.length !== decodedOutput.toolInvocations.length ||
              new Set(actions.map((action) => action.actionIndex)).size !==
                actions.length
            ) {
              return undefined;
            }
            for (
              let actionIndex = 0;
              actionIndex < decodedOutput.toolInvocations.length;
              actionIndex += 1
            ) {
              const invocation = decodedOutput.toolInvocations[actionIndex];
              const action = actions.find(
                (candidate) => candidate.actionIndex === actionIndex,
              );
              if (invocation === undefined || action === undefined) {
                return undefined;
              }
              const routes = manifestRoutes.filter(
                (
                  route,
                ): route is { name: string; route: "Executable" | "Control" } =>
                  typeof route === "object" &&
                  route !== null &&
                  "name" in route &&
                  typeof route.name === "string" &&
                  "route" in route &&
                  (route.route === "Executable" || route.route === "Control"),
              );
              const matchingRoutes = routes.filter(
                (route) => route.name === invocation.toolName,
              );
              const route = matchingRoutes[0];
              const logicalActionId = `lac_${sha256Hex(
                JSON.stringify({
                  executionId: input.execution.executionId,
                  providerTurnId: step.providerTurnId,
                  callRef: invocation.callRef,
                  routeKind: route?.route,
                  actionKind: invocation.toolName,
                }),
              )}`;
              if (
                matchingRoutes.length !== 1 ||
                action.identity.executionId !== step.identity.executionId ||
                action.identity.logicalStepNo !== step.identity.logicalStepNo ||
                action.identity.repairAttempt !== step.identity.repairAttempt ||
                action.logicalActionId !== logicalActionId ||
                action.callRef !== invocation.callRef ||
                action.routeKind !== route?.route ||
                action.actionKind !== invocation.toolName ||
                action.inputHash !== sha256Hex(invocation.argumentsJson) ||
                // StepEffectsCommitted is reachable only after the action loop
                // completed without an action-settling disposition.
                action.state !== "Applied" ||
                action.resultRef === undefined ||
                action.observationSourceRef === undefined
              ) {
                return undefined;
              }
            }
            return step;
          }),
        )
        .pipe(Effect.mapError(failure));
      if (verification === undefined) {
        return yield* Effect.fail(
          failure({ _tag: "AgentLoopStepReplayBindingMismatch" }),
        );
      }
      return {
        _tag: "Completed",
        loopStep: verification,
        observations,
        durableProgress,
      };
    }

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
          readonly truncated?: boolean;
          readonly canonicalRefs?: ReadonlyArray<string>;
          readonly modelOutputRef?: string;
          readonly artifactRefs?: ReadonlyArray<string>;
          readonly reconciliationFactRef?: string;
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
                    ...(terminal.reconciliationFactRef === undefined
                      ? {}
                      : {
                          reconciliationFactRef: terminal.reconciliationFactRef,
                        }),
                    ...(terminal.reconciliationFactRef === undefined
                      ? {}
                      : { disposition: terminal.disposition }),
                    status: terminal.status,
                    observationRef: observationSourceRef,
                    modelOutputRef: terminal.modelOutputRef ?? resultRef,
                    outputText: terminal.outputText,
                    truncated: terminal.truncated ?? false,
                    artifactRefs: terminal.artifactRefs ?? [],
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
                truncated: terminal.truncated ?? false,
              },
              ...(terminal.reconciliationFactRef === undefined
                ? {}
                : { reconciliationFactRef: terminal.reconciliationFactRef }),
              ...(terminal.modelOutputRef === undefined
                ? {}
                : { modelOutputRef: terminal.modelOutputRef }),
              ...(terminal.artifactRefs === undefined
                ? {}
                : { artifactRefs: terminal.artifactRefs }),
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
        readonly terminalDenial?: TerminalActionDenial;
        readonly truncated?: boolean;
        readonly modelOutputRef?: string;
        readonly artifactRefs?: ReadonlyArray<string>;
        readonly reconciliationFactRef?: string;
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
          if (dependencies.qualificationProbe !== undefined) {
            yield* Effect.promise(
              () =>
                dependencies.qualificationProbe?.({
                  boundary: "AH9BeforeTerminalActionCommit",
                  providerTurnId: preparedTurn.manifest.providerTurnId,
                  executionId: input.execution.executionId,
                  logicalActionId: pendingAction.logicalActionId,
                  callRef: invocation.callRef,
                  actionIndex,
                }) ?? Promise.resolve(),
            );
          }
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
                    ...(terminal.truncated === undefined
                      ? {}
                      : { truncated: terminal.truncated }),
                    canonicalRefs: [settlementRef],
                    ...(terminal.modelOutputRef === undefined
                      ? {}
                      : { modelOutputRef: terminal.modelOutputRef }),
                    ...(terminal.artifactRefs === undefined
                      ? {}
                      : { artifactRefs: terminal.artifactRefs }),
                    ...(terminal.reconciliationFactRef === undefined
                      ? {}
                      : {
                          reconciliationFactRef: terminal.reconciliationFactRef,
                        }),
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
                      disposition: {
                        _tag: terminal.disposition,
                        status: terminal.status,
                        ...(terminal.terminalDenial === undefined
                          ? {}
                          : { terminalDenial: terminal.terminalDenial }),
                      },
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
          if (dependencies.qualificationProbe !== undefined) {
            yield* Effect.promise(
              () =>
                dependencies.qualificationProbe?.({
                  boundary: "AH9AfterTerminalActionCommit",
                  providerTurnId: preparedTurn.manifest.providerTurnId,
                  executionId: input.execution.executionId,
                  logicalActionId: pendingAction.logicalActionId,
                  callRef: invocation.callRef,
                  actionIndex,
                }) ?? Promise.resolve(),
            );
          }
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
        terminalDenial?: TerminalActionDenial,
      ): Effect.Effect<void, ExecutionDriverError> =>
        persistTerminalAction({
          settlement,
          actionState: "TerminalRejected",
          status,
          disposition,
          outputText: `${invocation.toolName} rejected by runtime (${disposition})`,
          ...(terminalDenial === undefined ? {} : { terminalDenial }),
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
          readonly terminalDenial?: TerminalActionDenial;
          readonly reconciliationFactRef?: string;
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
          const payload = {
            source,
            observation,
            status,
            disposition,
            ...(resultMetadata.terminalDenial === undefined
              ? {}
              : { terminalDenial: resultMetadata.terminalDenial }),
          };
          const resultRef = `result_${sha256Hex(JSON.stringify(payload))}`;
          const denialSettlementRef =
            status === "Denied" && resultMetadata.terminalDenial !== undefined
              ? `settlement_${sha256Hex(
                  JSON.stringify({
                    logicalActionId: loopAction?.logicalActionId,
                    resultRef,
                    terminalDenial: resultMetadata.terminalDenial,
                  }),
                )}`
              : undefined;
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
                          ...(resultMetadata.reconciliationFactRef === undefined
                            ? {}
                            : {
                                reconciliationFactRef:
                                  resultMetadata.reconciliationFactRef,
                              }),
                          ...(resultMetadata.reconciliationFactRef === undefined
                            ? {}
                            : { disposition }),
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
                  const durablePayload = {
                    ...payload,
                    ...(resultMetadata.reconciliationFactRef === undefined
                      ? {}
                      : {
                          reconciliationFactRef:
                            resultMetadata.reconciliationFactRef,
                        }),
                  };
                  yield* sessions.appendEntryIdempotent(
                    input.execution.sessionId,
                    { kind: "AgentLoopAction", ref: observationSourceRef },
                    { entryKind: "Observation", payload: durablePayload },
                    sha256Hex(JSON.stringify(durablePayload)),
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
                      state:
                        route._tag === "Executable" && status === "Denied"
                          ? "TerminalRejected"
                          : "Applied",
                      resultRef,
                      ...(denialSettlementRef === undefined
                        ? {}
                        : { settlementRef: denialSettlementRef }),
                      disposition: {
                        _tag: disposition,
                        status,
                        ...(resultMetadata.terminalDenial === undefined
                          ? {}
                          : { terminalDenial: resultMetadata.terminalDenial }),
                      },
                      observationSourceRef,
                      revision: pendingAction.revision + 1,
                      updatedAt: yield* now(),
                    },
                  },
                  loopStepFence,
                );
                const advancedStep = yield* loopSteps.transition(
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
                if (dependencies.qualificationProbe !== undefined) {
                  yield* Effect.promise(
                    () =>
                      dependencies.qualificationProbe?.({
                        boundary: "AH7BeforeActionResultCommit",
                        providerTurnId: preparedTurn.manifest.providerTurnId,
                        executionId: input.execution.executionId,
                        logicalActionId: pendingAction.logicalActionId,
                        callRef: invocation.callRef,
                        actionIndex,
                      }) ?? Promise.resolve(),
                  );
                }
                return advancedStep;
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
        const recoveryBindingIdentity = recoveryBindingIdentityFor({
          step: currentLoopStep,
          action: loopAction,
          executionId: input.execution.executionId,
          providerTurnId: preparedTurn.manifest.providerTurnId,
          actionIndex,
          callRef: invocation.callRef,
        });
        const recoveryBindingPolicyRevisions =
          recoveryBindingPolicyRevisionsFor(preparedTurn.manifest.controlBasis);
        const executed = yield* Effect.match(
          executableInvocationHandler.handle({
            invocation,
            execution: input.execution,
            context: input.context,
            controlBasis: preparedTurn.manifest.controlBasis,
            ...(loopAction === undefined
              ? {}
              : {
                  action: {
                    logicalStepNo: loopAction.identity.logicalStepNo,
                    repairAttempt: loopAction.identity.repairAttempt,
                    actionIndex: loopAction.actionIndex,
                    logicalActionId: loopAction.logicalActionId,
                  },
                }),
            ...(recoveryBindingIdentity === undefined
              ? {}
              : { recoveryBindingIdentity }),
            ...(recoveryBindingPolicyRevisions === undefined
              ? {}
              : { recoveryBindingPolicyRevisions }),
            ...(loopStepFence === undefined
              ? {}
              : { executionFence: loopStepFence }),
            providerTurnId: preparedTurn.manifest.providerTurnId,
            ...(loopAction === undefined
              ? {}
              : { logicalActionId: loopAction.logicalActionId }),
          }),
          {
            onFailure: (cause) => ({ ok: false as const, cause }),
            onSuccess: (outcome) => ({ ok: true as const, outcome }),
          },
        );
        if (!executed.ok) {
          if (executed.cause._tag === "AgentActionRecoveryBlocked") {
            return { _tag: "RecoveryBlocked" };
          }
          if (
            executed.cause._tag === "AgentActionOperationalFailure" &&
            isLeaseFencingRejected(executed.cause.cause)
          ) {
            return yield* Effect.fail(failure(executed.cause.cause));
          }
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
          yield* persistActionRejection(
            settlement,
            "HandlerRejected",
            "Denied",
            {
              _tag: "HandlerRejected",
              routeKind: "Executable",
            },
          );
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
        if (executed.outcome._tag === "ApprovalRequired") {
          return {
            _tag: "ApprovalRequired",
            approvalId: executed.outcome.approvalId,
            revision: executed.outcome.revision,
          };
        }
        if (executed.outcome.status === "Interrupted") {
          if (
            executed.outcome.reconciliationFactRef !== undefined &&
            executed.outcome.disposition === "ExecutionStopping"
          ) {
            const settlement: ExecutionSettlement = {
              _tag: "Interrupted",
              result: { _tag: "StopRequested" },
            };
            yield* persistTerminalAction({
              settlement,
              actionState: "TerminalRejected",
              status: "Interrupted",
              disposition: "ExecutionStopping",
              outputText: executed.outcome.observation.text,
              truncated: executed.outcome.observation.truncated,
              ...(executed.outcome.resultRef === undefined
                ? {}
                : { modelOutputRef: executed.outcome.resultRef }),
              ...(executed.outcome.artifactRefs === undefined
                ? {}
                : { artifactRefs: executed.outcome.artifactRefs }),
              reconciliationFactRef: executed.outcome.reconciliationFactRef,
            });
            return { _tag: "Settle", settlement };
          }
          const settlement: ExecutionSettlement = {
            _tag: "Interrupted",
            result: { _tag: "StopRequested" },
          };
          const disposition =
            executed.outcome.disposition ?? "ExecutionStopping";
          yield* persistActionRejection(settlement, disposition, "Interrupted");
          return { _tag: "Settle", settlement };
        }
        const persisted = yield* persistActionObservation(
          executed.outcome.source,
          executed.outcome.observation,
          {
            ...(executed.outcome.status === undefined
              ? {}
              : { status: executed.outcome.status }),
            ...(executed.outcome.disposition === undefined
              ? {}
              : { disposition: executed.outcome.disposition }),
            ...(executed.outcome.resultRef === undefined
              ? {}
              : { resultRef: executed.outcome.resultRef }),
            ...(executed.outcome.artifactRefs === undefined
              ? {}
              : { artifactRefs: executed.outcome.artifactRefs }),
            ...(executed.outcome.invocationId === undefined
              ? {}
              : { invocationId: executed.outcome.invocationId }),
            ...(executed.outcome.terminalDenial === undefined
              ? {}
              : { terminalDenial: executed.outcome.terminalDenial }),
            ...(executed.outcome.reconciliationFactRef === undefined
              ? {}
              : {
                  reconciliationFactRef: executed.outcome.reconciliationFactRef,
                }),
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
              ...(loopAction === undefined
                ? {}
                : { logicalActionId: loopAction.logicalActionId }),
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
      if (authorization._tag === "RecoveryBlocked") {
        return { _tag: "RecoveryBlocked" };
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
          ...(loopAction === undefined
            ? {}
            : {
                logicalActionId: loopAction.logicalActionId,
                actionContext: {
                  identity: loopAction.identity,
                  actionIndex: loopAction.actionIndex,
                  providerTurnId: preparedTurn.manifest.providerTurnId,
                  callRef: invocation.callRef,
                  contextEpoch: preparedTurn.manifest.contextEpoch,
                },
                ...(loopStepFence === undefined ? {} : { loopStepFence }),
              }),
          ...(authorization.assignWorkEvidence === undefined
            ? {}
            : { assignWorkEvidence: authorization.assignWorkEvidence }),
          ...(authorization.assignWorkReplay === true
            ? { assignWorkReplay: true }
            : {}),
          ...(authorization.assignWorkCommandReplay === undefined
            ? {}
            : {
                assignWorkCommandReplay: authorization.assignWorkCommandReplay,
              }),
        }),
        {
          onFailure: (cause) => ({ ok: false as const, cause }),
          onSuccess: (outcome) => ({ ok: true as const, outcome }),
        },
      );
      if (!handled.ok) {
        if (handled.cause._tag === "AgentActionRecoveryBlocked") {
          return { _tag: "RecoveryBlocked" };
        }
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
        controlAuthorizer !== undefined
      ) {
        const consumption =
          handled.outcome._tag === "Observation"
            ? handled.outcome.approvalConsumption
            : undefined;
        const expectedRevision = authorization.approvalRevision ?? 0;
        const commandBoundAssignWork =
          decodedAction.value.action._tag === "AssignWork" &&
          authorization.assignWorkEvidence?._tag === "ActionApproval";
        const commandConsumptionMatches =
          consumption !== undefined &&
          consumption.approvalId === authorization.approvalId &&
          consumption.consumedRevision === expectedRevision + 1;
        const consumed =
          commandBoundAssignWork && !commandConsumptionMatches
            ? false
            : yield* controlAuthorizer.consumeApproval({
                approvalId: authorization.approvalId,
                approvalRevision: expectedRevision,
                actionDigest: authorization.actionDigest,
                controlBasisDigest: authorization.controlBasisDigest,
                consumedBy: commandConsumptionMatches
                  ? consumption.commandId
                  : (loopAction?.logicalActionId ??
                    `lac_${sha256Hex(
                      JSON.stringify({
                        executionId: input.execution.executionId,
                        providerTurnId: preparedTurn.manifest.providerTurnId,
                        callRef: invocation.callRef,
                        routeKind: route._tag,
                        actionKind: invocation.toolName,
                      }),
                    )}`),
                ...(commandConsumptionMatches
                  ? { alreadyConsumedByCommandId: consumption.commandId }
                  : {}),
              });
        if (!consumed) {
          const settlement = safetyStop("ControlApprovalConsumptionRejected");
          yield* persistActionRejection(
            settlement,
            "ApprovalConsumptionRejected",
          );
          return { _tag: "Settle", settlement };
        }
      }
      if (handled.outcome._tag === "Settle") {
        yield* persistActionSettlement(handled.outcome.settlement);
        return {
          _tag: "Settle",
          settlement: handled.outcome.settlement,
        };
      }
      if (
        handled.outcome._tag === "Observation" &&
        handled.outcome.durableActionCommit !== undefined
      ) {
        currentLoopStep = handled.outcome.durableActionCommit.loopStep;
        observations.push({
          source: handled.outcome.source,
          observation: handled.outcome.observation,
        });
        durableProgress = true;
        continue;
      }
      if (handled.outcome._tag === "BlockedWorkEpisodeRequest") {
        const blocked = yield* makeBlockedSettlement(
          dependencies,
          handled.outcome.request,
          currentLoopStep,
        );
        if (blocked === null) {
          const observation: BoundedObservation = {
            text: JSON.stringify({
              code: "undispositioned_action_failure",
              message:
                "Blocked requires exact current-Execution TerminalRejected executable actions, a paired Denied result, and a matching pinned manifest. Use a later successful action to recover each denial or provide a valid Blocked disposition.",
            }),
            truncated: false,
          };
          const persisted = yield* persistActionObservation(
            "Runtime",
            observation,
            {
              status: "Failed",
              disposition: "UndispositionedActionFailure",
            },
          );
          if (!persisted) observations.push({ source: "Runtime", observation });
          durableProgress = true;
          continue;
        }
        yield* persistActionSettlement(blocked);
        return { _tag: "Settle", settlement: blocked };
      }
      if (
        route._tag === "Control" &&
        loopAction !== undefined &&
        dependencies.qualificationProbe !== undefined
      ) {
        const pendingAction = loopAction;
        yield* Effect.promise(
          () =>
            dependencies.qualificationProbe?.({
              boundary: "AH10AfterControlHandlerReturnBeforeObservationCommit",
              providerTurnId: preparedTurn.manifest.providerTurnId,
              executionId: input.execution.executionId,
              logicalActionId: pendingAction.logicalActionId,
              callRef: invocation.callRef,
              actionIndex,
            }) ?? Promise.resolve(),
        );
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
