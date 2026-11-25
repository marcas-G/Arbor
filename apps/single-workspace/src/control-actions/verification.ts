import type { AgentAction, AgentActionHandler } from "@arbor/agent-runtime";
import {
  type CommandGatewayService,
  type CommandHandlerRegistryService,
  type ConcludeVerificationPayload,
  type ConcludeVerificationResult,
  newUuid7,
  type RecordVerificationEvidencePayload,
  type RecordVerificationEvidenceResult,
  semanticRequestFingerprint,
} from "@arbor/application";
import {
  EvidenceId,
  parse,
  ToolInvocationId,
  workEpisode,
} from "@arbor/domain";
import {
  type AgentLoopStepStoreService,
  type BlobStorePortService,
  type ClockService,
  type CommandStoreService,
  type SessionRepositoryService,
  sha256Hex,
  type ToolInvocationStoreService,
  type TransactionPortService,
  type VerificationRepositoryService,
  type WorkRepositoryService,
  type WorkspaceRepositoryService,
} from "@arbor/ports";
import { Effect, Option } from "effect";
import {
  actionError,
  actionOperationalFailure,
  generationScopedCommandId,
  findPriorCommandReceipt,
  validatePriorCommittedReplay,
} from "./command-receipts.js";

export interface VerificationWaitEligibilityDependencies {
  readonly works: Pick<WorkRepositoryService, "findById">;
  readonly workspaces: Pick<WorkspaceRepositoryService, "findById">;
  readonly verifications: Pick<VerificationRepositoryService, "listByWork">;
  readonly tx: TransactionPortService;
  readonly blockedWaitEnabled: boolean;
}

export interface VerificationActionDependencies {
  readonly gateway: CommandGatewayService;
  readonly blobs: BlobStorePortService;
  readonly clock: ClockService;
  readonly tx: TransactionPortService;
  readonly verifications: Pick<
    VerificationRepositoryService,
    "findByExecutionId"
  >;
  readonly sessions: Pick<SessionRepositoryService, "listEntries">;
  readonly toolInvocations: Pick<ToolInvocationStoreService, "findById">;
  readonly commandHandlerRegistry?: CommandHandlerRegistryService;
  readonly commandReceipts?: Pick<CommandStoreService, "findResolution">;
  readonly loopSteps?: Pick<
    AgentLoopStepStoreService,
    "findCurrent" | "listActions"
  >;
}

/** P8 owns the source that can make a Work's VerificationChanged condition
 * true. A Work-bound Wait on one or more VerificationChanged conditions for
 * that same Work must have an exact Open Verification unless its Any set also
 * contains another independently producible condition. ClaimCompletion has
 * its own producer path: it atomically persists the exact VerificationChanged
 * Wait with CompletionClaimed and is not routed through this model-facing
 * Wait action. */
export const verificationWaitEligibilityHandler = (
  dependencies: VerificationWaitEligibilityDependencies,
): AgentActionHandler => ({
  action: "Wait",
  handle: (input) =>
    Effect.gen(function* () {
      const { action, execution } = input;
      if (action._tag !== "Wait") {
        return yield* Effect.fail(
          actionOperationalFailure("Wait.dispatch")(
            "Wait handler received a different AgentAction",
          ),
        );
      }
      const episode = workEpisode(execution);
      if (episode === null) {
        return yield* Effect.fail(
          actionError(
            "Wait requires an active Work binding for durable WorkWait registration",
            "action/not-applicable",
          ),
        );
      }
      if (action.disposition === "Blocked") {
        if (!dependencies.blockedWaitEnabled) {
          return yield* Effect.fail(
            actionError(
              "Blocked recovery is unavailable on this runtime because the durable WorkBlocker ledger is not active",
              "action/not-applicable",
            ),
          );
        }
        return {
          _tag: "BlockedWorkEpisodeRequest" as const,
          request: action.request,
        };
      }

      const sameWorkVerificationConditions = action.waitSpec.conditions.flatMap(
        (condition) =>
          condition._tag === "VerificationChanged" &&
          condition.workId === episode.workId
            ? [condition]
            : [],
      );
      const hasIndependentAlternative = action.waitSpec.conditions.some(
        (condition) =>
          condition._tag !== "VerificationChanged" ||
          condition.workId !== episode.workId,
      );

      if (sameWorkVerificationConditions.length > 0) {
        const eligibility = yield* dependencies.tx
          .transact(
            Effect.gen(function* () {
              const [storedWork, storedWorkspace] = yield* Effect.all([
                dependencies.works.findById(episode.workId),
                dependencies.workspaces.findById(execution.workspaceId),
              ]);
              if (
                Option.isNone(storedWork) ||
                Option.isNone(storedWorkspace) ||
                storedWork.value.workspaceId !== execution.workspaceId ||
                storedWorkspace.value.currentWorkId !== episode.workId ||
                storedWork.value.lifecycle !== "Open" ||
                Number(storedWork.value.revision) !==
                  Number(episode.targetWorkRevision)
              ) {
                return "not-current" as const;
              }

              const history = yield* dependencies.verifications.listByWork(
                episode.workId,
              );
              const targetRevisions = new Set(
                sameWorkVerificationConditions.map((condition) =>
                  Number(condition.targetWorkRevision),
                ),
              );
              const openRevisions = new Set(
                history
                  .filter((verification) =>
                    targetRevisions.has(
                      Number(verification.targetWorkRevision),
                    ),
                  )
                  .filter(
                    (verification) => verification.state.status === "Open",
                  )
                  .map((verification) =>
                    Number(verification.targetWorkRevision),
                  ),
              );
              if (openRevisions.size > 0) return "open-verification" as const;
              const hasConcludedSource = history.some(
                (verification) =>
                  targetRevisions.has(
                    Number(verification.targetWorkRevision),
                  ) && verification.state.status === "Concluded",
              );
              return hasConcludedSource
                ? ("verification-concluded" as const)
                : ("missing-source" as const);
            }),
          )
          .pipe(Effect.mapError(actionOperationalFailure("WaitEligibility")));

        if (eligibility === "not-current") {
          return yield* Effect.fail(
            actionError(
              "This Work execution is no longer bound to the current open Work revision. Refresh the Work context before waiting.",
              "action/precondition",
              "ChooseAlternative",
            ),
          );
        }
        if (eligibility === "verification-concluded") {
          return yield* Effect.fail(
            actionError(
              "Verification for this Work revision already has a conclusion. Read that result and continue instead of waiting again.",
              "action/precondition",
              "ChooseAlternative",
            ),
          );
        }
        if (eligibility === "missing-source" && !hasIndependentAlternative) {
          return yield* Effect.fail(
            actionError(
              "This Work has no pending independent verification for its current revision. Continue advancing the Work or wait on a real external condition.",
              "action/precondition",
              "ChooseAlternative",
            ),
          );
        }
      }

      return {
        _tag: "Settle" as const,
        settlement: {
          _tag: "Completed" as const,
          result: {
            _tag: "Yielded" as const,
            reason: action.reason,
            waitSpec: action.waitSpec,
          },
        },
      };
    }).pipe(Effect.mapError(actionOperationalFailure("Wait"))),
});

const verifierBinding = (
  dependencies: VerificationActionDependencies,
  executionId: import("@arbor/domain").ExecutionId,
) =>
  dependencies.tx.transact(
    dependencies.verifications.findByExecutionId(executionId),
  );

const toolResultMatchesSettlement = (
  status: string,
  settlement: import("@arbor/ports").ToolInvocationSettlement | null,
): boolean => {
  if (settlement === null) return false;
  switch (status) {
    case "Succeeded":
      return settlement._tag === "Success";
    case "Failed":
      return (
        settlement._tag === "ExpectedFailure" ||
        settlement._tag === "RuntimeFailure" ||
        settlement._tag === "ReconciledNoEffect"
      );
    case "Interrupted":
      return settlement._tag === "Interrupted";
    case "OutcomeUnknown":
      return settlement._tag === "OutcomeUnknown";
    default:
      return false;
  }
};

export const recordVerificationEvidenceHandler = (
  dependencies: VerificationActionDependencies & {
    readonly loopSteps: NonNullable<
      VerificationActionDependencies["loopSteps"]
    >;
  },
): AgentActionHandler => ({
  action: "RecordVerificationEvidence",
  handle: ({ action, invocation, execution, context }) =>
    Effect.gen(function* () {
      if (action._tag !== "RecordVerificationEvidence") {
        return yield* Effect.fail(
          actionOperationalFailure("RecordVerificationEvidence.dispatch")(
            "verification evidence handler received another action",
          ),
        );
      }
      const verification = yield* verifierBinding(
        dependencies,
        execution.executionId,
      );
      if (Option.isNone(verification)) {
        return yield* Effect.fail(
          actionError("execution is not bound to a Verification"),
        );
      }
      const entries = yield* dependencies.tx.transact(
        dependencies.sessions.listEntries(execution.sessionId, -1, 10_000),
      );
      const visibleResults = [...entries].reverse().filter((entry) => {
        const payload = entry.payload as {
          readonly _tag?: unknown;
          readonly status?: unknown;
        };
        return (
          payload._tag === "ToolResult" &&
          (payload.status === "Succeeded" ||
            payload.status === "Failed" ||
            payload.status === "Interrupted" ||
            payload.status === "OutcomeUnknown")
        );
      });
      const exact = visibleResults.find(
        (entry) =>
          (entry.payload as { readonly callRef?: unknown }).callRef ===
          action.sourceCallRef,
      );
      const ordinal = /^\d+$/u.test(action.sourceCallRef)
        ? Number(action.sourceCallRef)
        : 0;
      const resultEntry =
        exact ?? (ordinal > 0 ? visibleResults[ordinal - 1] : undefined);
      if (resultEntry === undefined) {
        return yield* Effect.fail(
          actionError(
            "sourceCallRef has no visible terminal ToolResult (exact callRef or newest-first ordinal)",
          ),
        );
      }
      const result = resultEntry.payload as {
        readonly _tag: "ToolResult";
        readonly callRef: string;
        readonly invocationId?: string;
        readonly observationRef: string;
        readonly status: string;
      };
      if (
        typeof result.invocationId !== "string" ||
        typeof result.observationRef !== "string"
      ) {
        return yield* Effect.fail(
          actionError(
            "ToolObservation source must carry canonical invocation identity",
          ),
        );
      }
      let toolInvocationId: import("@arbor/domain").ToolInvocationId;
      try {
        toolInvocationId = parse(ToolInvocationId)(result.invocationId);
      } catch {
        return yield* Effect.fail(
          actionError(
            "ToolObservation invocation identity is invalid",
            "action/precondition",
            "RetryWithChangedInput",
          ),
        );
      }
      const storedInvocation = yield* dependencies.tx.transact(
        dependencies.toolInvocations.findById(toolInvocationId),
      );
      if (
        Option.isNone(storedInvocation) ||
        storedInvocation.value.executionId !== execution.executionId ||
        storedInvocation.value.settledAt === null ||
        !toolResultMatchesSettlement(
          result.status,
          storedInvocation.value.settlement,
        )
      ) {
        return yield* Effect.fail(
          actionError(
            "ToolObservation source is missing, unsettled, inconsistent, or belongs to another execution",
          ),
        );
      }
      const occurrence = `${invocation.providerTurnId}:${invocation.outputPosition}`;
      const currentStep = yield* dependencies.tx.transact(
        dependencies.loopSteps.findCurrent(execution.executionId),
      );
      if (
        Option.isNone(currentStep) ||
        currentStep.value.providerTurnId !== invocation.providerTurnId ||
        currentStep.value.state !== "ActionsInProgress"
      ) {
        return yield* Effect.fail(
          actionError(
            "persisted AgentLoopStep does not bind this ProviderTurn",
          ),
        );
      }
      const actionIntents = yield* dependencies.tx.transact(
        dependencies.loopSteps.listActions(currentStep.value.identity),
      );
      const actionIntent = actionIntents.find(
        (candidate) => candidate.actionIndex === invocation.outputPosition,
      );
      if (
        actionIntent === undefined ||
        actionIntent.state !== "Pending" ||
        actionIntent.routeKind !== "Control" ||
        actionIntent.callRef !== invocation.callRef ||
        actionIntent.actionKind !== invocation.toolName ||
        actionIntent.inputHash !== sha256Hex(invocation.argumentsJson) ||
        !Number.isFinite(Date.parse(actionIntent.updatedAt)) ||
        new Date(actionIntent.updatedAt).toISOString() !==
          actionIntent.updatedAt
      ) {
        return yield* Effect.fail(
          actionError("durable P9 ActionIntent timestamp cannot be proven"),
        );
      }
      const evidenceId = parse(EvidenceId)(
        `evd_${newUuid7("verification-evidence", occurrence)}`,
      );
      const payload: RecordVerificationEvidencePayload = {
        verificationId: verification.value.verificationId,
        evidence: {
          evidenceId,
          criterionId: action.criterionId,
          kind: "ToolObservation",
          toolInvocationId,
          observationRef: result.observationRef,
          callRef: result.callRef,
          recordedAt: actionIntent.updatedAt,
        },
      };
      if (context._tag !== "ExecutionOrigin") {
        return yield* Effect.fail(
          actionError("verification evidence requires an Execution origin"),
        );
      }
      const commandId = generationScopedCommandId(
        "record-verification-evidence",
        occurrence,
        context,
      );
      const actor = context.principal as never;
      if (context.fencingGeneration > 0) {
        const prior = yield* findPriorCommandReceipt({
          context,
          namespace: "record-verification-evidence",
          occurrence,
          commandReceipts: dependencies.commandReceipts,
          commandType: "RecordVerificationEvidence",
          commandHandlerRegistry: dependencies.commandHandlerRegistry,
          tx: dependencies.tx,
          projectId: execution.projectId,
          operation: "RecordVerificationEvidence.priorReceipt",
          errorOperation: "RecordVerificationEvidence",
          lookupOperation: "RecordVerificationEvidence.receiptLookup",
        });
        if (prior._tag === "Committed") {
          yield* validatePriorCommittedReplay({
            receipt: prior.receipt,
            commandType: "RecordVerificationEvidence",
            payload,
            context,
            actor,
            registry: dependencies.commandHandlerRegistry,
            tx: dependencies.tx,
          });
          const result = prior.receipt.resolution.result;
          if (
            typeof result !== "object" ||
            result === null ||
            !("verificationId" in result) ||
            result.verificationId !== payload.verificationId ||
            !("evidenceId" in result) ||
            result.evidenceId !== evidenceId ||
            !("state" in result) ||
            result.state !== "Recorded"
          ) {
            return yield* Effect.fail(
              actionOperationalFailure(
                "RecordVerificationEvidence.priorReceipt",
              )(
                "committed evidence receipt result does not match the exact Evidence identity",
              ),
            );
          }
          return {
            _tag: "Observation" as const,
            source: "Runtime" as const,
            observation: {
              text: `VerificationEvidenceRecorded(${evidenceId}, ${action.criterionId})`,
              truncated: false,
            },
          };
        }
        if (prior._tag === "TerminalRejected") {
          return yield* Effect.fail(
            actionError(JSON.stringify(prior.receipt.resolution.error)),
          );
        }
      }
      const receipt = yield* dependencies.gateway.execute<
        RecordVerificationEvidencePayload,
        RecordVerificationEvidenceResult
      >(
        {
          commandType: "RecordVerificationEvidence",
          commandId,
          projectId: execution.projectId,
          actor,
          issuedAt: yield* dependencies.clock.now(),
          payload,
        },
        context,
        {
          _tag: "VerifierExecutionAuthority",
          principal: context.principal,
          commandId,
          semanticRequestFingerprint: semanticRequestFingerprint({
            commandType: "RecordVerificationEvidence",
            projectId: execution.projectId,
            actor,
            schemaVersion: "1",
            payload,
          }),
          projectId: execution.projectId,
          verificationId: verification.value.verificationId,
          executionId: execution.executionId,
        },
      );
      if (receipt.resolution._tag !== "Committed") {
        return yield* Effect.fail(
          actionError(
            receipt.resolution._tag === "TerminalRejected"
              ? JSON.stringify(receipt.resolution.error)
              : "evidence command failed operationally",
          ),
        );
      }
      return {
        _tag: "Observation" as const,
        source: "Runtime" as const,
        observation: {
          text: `VerificationEvidenceRecorded(${evidenceId}, ${action.criterionId})`,
          truncated: false,
        },
      };
    }).pipe(
      Effect.mapError(actionOperationalFailure("RecordVerificationEvidence")),
    ),
});

export const concludeVerificationHandler = (
  dependencies: Omit<VerificationActionDependencies, "loopSteps">,
): AgentActionHandler => ({
  action: "ConcludeVerification",
  handle: ({ action, invocation, execution, context }) =>
    Effect.gen(function* () {
      if (action._tag !== "ConcludeVerification") {
        return yield* Effect.fail(
          actionOperationalFailure("ConcludeVerification.dispatch")(
            "verification conclusion handler received another action",
          ),
        );
      }
      const verification = yield* verifierBinding(
        dependencies,
        execution.executionId,
      );
      if (Option.isNone(verification)) {
        return yield* Effect.fail(
          actionError("execution is not bound to a Verification"),
        );
      }
      const summaryBytes = new TextEncoder().encode(action.summary);
      const summaryRef = yield* dependencies.blobs.put(summaryBytes);
      const resolved = yield* dependencies.blobs.get(summaryRef);
      if (
        resolved.length !== summaryBytes.length ||
        resolved.some((byte, index) => byte !== summaryBytes[index])
      ) {
        return yield* Effect.fail(
          actionOperationalFailure("ConcludeVerification.blobRoundTrip")(
            "persisted verification summary failed byte validation",
          ),
        );
      }
      const payload: ConcludeVerificationPayload = {
        verificationId: verification.value.verificationId,
        verdict: action.verdict,
        criteriaResults: action.criteriaResults,
        summaryRef,
      };
      const occurrence = `${invocation.providerTurnId}:${invocation.outputPosition}`;
      if (context._tag !== "ExecutionOrigin") {
        return yield* Effect.fail(
          actionError("verification conclusion requires an Execution origin"),
        );
      }
      const commandId = generationScopedCommandId(
        "conclude-verification",
        occurrence,
        context,
      );
      const actor = context.principal as never;
      if (context.fencingGeneration > 0) {
        const prior = yield* findPriorCommandReceipt({
          context,
          namespace: "conclude-verification",
          occurrence,
          commandReceipts: dependencies.commandReceipts,
          commandType: "ConcludeVerification",
          commandHandlerRegistry: dependencies.commandHandlerRegistry,
          tx: dependencies.tx,
          projectId: execution.projectId,
          operation: "ConcludeVerification.priorReceipt",
          errorOperation: "ConcludeVerification",
          lookupOperation: "ConcludeVerification.receiptLookup",
        });
        if (prior._tag === "Committed") {
          yield* validatePriorCommittedReplay({
            receipt: prior.receipt,
            commandType: "ConcludeVerification",
            payload,
            context,
            actor,
            registry: dependencies.commandHandlerRegistry,
            tx: dependencies.tx,
          });
          const result = prior.receipt.resolution.result;
          if (
            typeof result !== "object" ||
            result === null ||
            !("verificationId" in result) ||
            result.verificationId !== payload.verificationId ||
            !("state" in result) ||
            result.state !== "Concluded" ||
            !("verdict" in result) ||
            result.verdict !== payload.verdict ||
            !("summaryRef" in result) ||
            result.summaryRef !== payload.summaryRef
          ) {
            return yield* Effect.fail(
              actionOperationalFailure("ConcludeVerification.priorReceipt")(
                "committed conclusion receipt result does not match canonical Verification identity",
              ),
            );
          }
          return {
            _tag: "Settle" as const,
            settlement: {
              _tag: "Completed" as const,
              result: {
                _tag: "VerificationConcluded" as const,
                verificationId: verification.value.verificationId,
                verdict: action.verdict,
              },
            },
          };
        }
        if (prior._tag === "TerminalRejected") {
          return yield* Effect.fail(
            actionError(JSON.stringify(prior.receipt.resolution.error)),
          );
        }
      }
      const receipt = yield* dependencies.gateway.execute<
        ConcludeVerificationPayload,
        ConcludeVerificationResult
      >(
        {
          commandType: "ConcludeVerification",
          commandId,
          projectId: execution.projectId,
          actor,
          issuedAt: yield* dependencies.clock.now(),
          payload,
        },
        context,
        {
          _tag: "VerifierExecutionAuthority",
          principal: context.principal,
          commandId,
          semanticRequestFingerprint: semanticRequestFingerprint({
            commandType: "ConcludeVerification",
            projectId: execution.projectId,
            actor,
            schemaVersion: "2",
            payload,
          }),
          projectId: execution.projectId,
          verificationId: verification.value.verificationId,
          executionId: execution.executionId,
        },
      );
      if (receipt.resolution._tag !== "Committed") {
        return yield* Effect.fail(
          actionError(
            receipt.resolution._tag === "TerminalRejected"
              ? JSON.stringify(receipt.resolution.error)
              : "verification conclusion failed operationally",
          ),
        );
      }
      return {
        _tag: "Settle" as const,
        settlement: {
          _tag: "Completed" as const,
          result: {
            _tag: "VerificationConcluded" as const,
            verificationId: verification.value.verificationId,
            verdict: action.verdict,
          },
        },
      };
    }).pipe(Effect.mapError(actionOperationalFailure("ConcludeVerification"))),
});
