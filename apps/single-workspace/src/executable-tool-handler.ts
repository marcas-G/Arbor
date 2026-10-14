import { createHash } from "node:crypto";
import type {
  ExecutableInvocationHandler,
  ExecutableInvocationOutcome,
} from "@arbor/agent-runtime";
import type { ParentUserGovernanceFacts } from "@arbor/application";
import {
  AuthorityResolverPort,
  issueExecutableApproval,
} from "@arbor/application";
import { parse, ToolInvocationId } from "@arbor/domain";
import {
  type BoundedObservation,
  type CanonicalToolObservation,
  Clock,
  type ExecutableApprovalBinding,
  ExecutableApprovalStore,
  type ExecutableApprovalStoreService,
  executableApprovalBindingMatches,
  type InvocationAuthority,
  PermissionGrantRepository,
  sha256Hex,
  ToolCatalogPort,
  type ToolCatalogPortService,
  type ToolDefinitionRef,
  type ToolExecutionContext,
  type ToolIntent,
  type ToolInvocationRecord,
  ToolInvocationStore,
  ToolRuntimePort,
  TransactionPort,
  WorkspaceRepository,
} from "@arbor/ports";
import { Context, Effect, Layer, Option } from "effect";

export class ExecutableToolHandler extends Context.Service<
  ExecutableToolHandler,
  ExecutableInvocationHandler
>()("arbor/ExecutableToolHandler") {}

/** Test-only catalog visibility probe. Production composition leaves this
 * absent; it observes the candidate refs immediately before the unchanged
 * exact-one handler gate. */
export type ExecutableToolHandlerQualificationProbe = (event: {
  readonly boundary:
    | "P4ExecutableCatalogRefs"
    | "P4ExecutableToolRuntimeOutcome";
  readonly executionId: string;
  readonly toolName: string;
  readonly invocationId?: string;
  readonly callRef?: string;
  readonly providerTurnId?: string;
  readonly logicalActionId?: string;
  readonly actionIndex?: number;
  readonly matchingRefs?: ReadonlyArray<ToolDefinitionRef>;
  readonly outcomeTag?: string;
  readonly errorTag?: string;
  readonly causeTag?: string;
  readonly stage?: string;
  readonly operation?: string;
  readonly causeRepository?: string;
  readonly causeOperation?: string;
  readonly nestedStage?: string;
  readonly safeDetailsSourceTag?: string;
  readonly approvalId?: string;
  readonly recoveryBindingIdentity?: {
    readonly executionId: string;
    readonly providerTurnId: string;
    readonly logicalStepNo: number;
    readonly repairAttempt: number;
    readonly logicalActionId: string;
    readonly actionIndex: number;
    readonly callRef: string;
  };
}) => Promise<void>;

const bounded = (text: string, limit = 2000): BoundedObservation => ({
  text: text.length > limit ? text.slice(0, limit) : text,
  truncated: text.length > limit,
});

export const toExecutableOutcome = (
  result: Exclude<
    CanonicalToolObservation,
    { readonly _tag: "ApprovalRequired" }
  >,
): ExecutableInvocationOutcome => {
  switch (result._tag) {
    case "Success":
      return {
        _tag: "Observation",
        source: "Tool",
        observation: result.observation,
        status: "Succeeded",
        ...(result.resultRef === null ? {} : { resultRef: result.resultRef }),
        artifactRefs: result.resultRef === null ? [] : [result.resultRef],
      };
    case "ExpectedFailure":
      return {
        _tag: "Observation",
        source: "Tool",
        observation: result.observation,
        status: "Failed",
      };
    case "Denied":
      return {
        _tag: "Observation",
        source: "Runtime",
        observation: bounded(`tool denied: ${result.reason}`),
        status: "Denied",
        disposition: "AuthorizationDenied",
        ...(result.reasonCode === "ApprovalRequired"
          ? {}
          : {
              terminalDenial: {
                _tag: "P4NoEffectDenied" as const,
                reasonCode: result.reasonCode,
              },
            }),
      };
    case "Interrupted":
      return {
        _tag: "Observation",
        source: "Runtime",
        observation: bounded("tool invocation interrupted"),
        status: "Interrupted",
        disposition: "ExecutionStopping",
      };
    case "OutcomeUnknown":
      return {
        _tag: "Settle",
        settlement: {
          _tag: "OutcomeUnknown",
          reconciliation: {
            _tag: "ReconciliationRequired",
            invocationRefs: result.reconciliationRefs,
          },
        },
      };
    case "RuntimeFailure":
      return {
        _tag: "Observation",
        source: "Runtime",
        observation: bounded(`tool runtime failure: ${result.cause}`),
        status: "Failed",
      };
    case "ReconciledNoEffect": {
      const status =
        result.reasonCode === "StopRequested"
          ? "Interrupted"
          : result.reasonCode === "ReplayLimitReached"
            ? "Failed"
            : "Denied";
      const disposition =
        result.reasonCode === "StopRequested"
          ? "ExecutionStopping"
          : `ReconciledNoEffect:${result.reasonCode}`;
      return {
        _tag: "Observation",
        source: "Tool",
        observation: result.observation,
        status,
        disposition,
        resultRef: result.resultRef,
        artifactRefs: [result.resultRef],
        reconciliationFactRef: result.reconciliationFactRef,
      };
    }
  }
};

const toolInvocationIdFor = (executionId: string, callRef: string) =>
  parse(ToolInvocationId)(
    `tin_018f2b3c-4d5e-7abc-8def-${createHash("sha256")
      .update(JSON.stringify({ executionId, callRef }))
      .digest("hex")
      .slice(0, 12)}`,
  );

/** Pre-AH7 identities were derived from callRef alone. Read the exact old
 * record before choosing it for an in-flight replay; never assign that ID to
 * a different Execution that happens to reuse the provider callRef. */
const legacyToolInvocationIdFor = (callRef: string) =>
  parse(ToolInvocationId)(
    `tin_018f2b3c-4d5e-7abc-8def-${createHash("sha256")
      .update(callRef)
      .digest("hex")
      .slice(0, 12)}`,
  );

export const makeExecutableToolHandler = (
  tools: import("@arbor/ports").ToolRuntimePortService,
  clock: import("@arbor/ports").ClockService,
  catalog: ToolCatalogPortService,
  legacyLookup?: (
    id: ToolInvocationId,
  ) => Effect.Effect<Option.Option<ToolInvocationRecord>, unknown>,
  approvalDependencies?: {
    readonly store: ExecutableApprovalStoreService;
    readonly transaction: import("@arbor/ports").TransactionPortService;
    readonly resolveCandidate: (input: {
      readonly binding: ExecutableApprovalBinding;
      readonly authority: InvocationAuthority;
      readonly requestedAt: string;
      readonly requestedCapabilities: ReadonlyArray<string>;
      readonly delegationDepth: number;
    }) => Effect.Effect<
      { readonly approvalId: string; readonly expiresAt: string },
      unknown
    >;
  },
  qualificationProbe?: ExecutableToolHandlerQualificationProbe,
): ExecutableInvocationHandler => ({
  handle: ({
    invocation,
    execution,
    context,
    controlBasis,
    action,
    recoveryBindingIdentity,
    recoveryBindingPolicyRevisions,
    executionFence: actionFence,
    providerTurnId,
    logicalActionId,
  }) =>
    Effect.gen(function* () {
      const requestedAt = yield* clock.now();
      const executionFence =
        context._tag === "ExecutionOrigin" &&
        context.workerId !== undefined &&
        context.workerIncarnationId !== undefined
          ? {
              executionId: execution.executionId,
              workerId: context.workerId,
              workerIncarnationId: context.workerIncarnationId,
              fencingGeneration: context.fencingGeneration,
            }
          : undefined;
      if (executionFence === undefined) {
        return yield* Effect.fail({
          _tag: "AgentActionOperationalFailure" as const,
          operation: "ToolRuntime.LeaseFenceUnavailable",
          cause: "active ExecutionOrigin is missing its lease-holder triple",
        });
      }
      const visibleRefs = yield* catalog.visibleRefs().pipe(
        Effect.mapError((cause) => ({
          _tag: "AgentActionOperationalFailure" as const,
          operation: "ToolCatalog.visibleRefs",
          cause,
        })),
      );
      const matchingRefs = visibleRefs.filter(
        (ref) => ref.name === invocation.toolName,
      );
      if (qualificationProbe !== undefined) {
        yield* Effect.promise(() =>
          qualificationProbe({
            boundary: "P4ExecutableCatalogRefs",
            executionId: execution.executionId,
            toolName: invocation.toolName,
            matchingRefs,
          }),
        );
      }
      if (matchingRefs.length !== 1) {
        return yield* Effect.fail({
          _tag: "AgentActionRejected" as const,
          code: "action/tool-unavailable" as const,
          safeMessage:
            matchingRefs.length === 0
              ? `tool is not visible: ${invocation.toolName}`
              : `tool identity is ambiguous: ${invocation.toolName}`,
          correction: "ChooseAlternative" as const,
        });
      }
      const toolVersion = matchingRefs[0]?.version as string;
      let invocationId = toolInvocationIdFor(
        execution.executionId,
        invocation.callRef,
      );
      if (legacyLookup !== undefined) {
        const oldId = legacyToolInvocationIdFor(invocation.callRef);
        const old = yield* legacyLookup(oldId).pipe(
          Effect.mapError((cause) => ({
            _tag: "AgentActionOperationalFailure" as const,
            operation: "LegacyToolInvocationLookup",
            cause,
          })),
        );
        if (
          Option.isSome(old) &&
          old.value.executionId === execution.executionId &&
          old.value.workspaceId === execution.workspaceId &&
          old.value.toolName === invocation.toolName &&
          old.value.toolVersion === toolVersion &&
          old.value.argumentsJson === invocation.argumentsJson
        ) {
          invocationId = oldId;
        }
      }
      let intent: ToolIntent = {
        callRef: invocation.callRef,
        toolName: invocation.toolName,
        toolVersion,
        argumentsJson: invocation.argumentsJson,
        invocationId,
        approvalId: null,
      };
      let currentApproval:
        | import("@arbor/ports").ExecutableApprovalRecord
        | undefined;
      if (action !== undefined && approvalDependencies !== undefined) {
        const existing = yield* approvalDependencies.transaction
          .transact(
            approvalDependencies.store.findByActionKey({
              executionId: execution.executionId,
              logicalStepNo: action.logicalStepNo,
              repairAttempt: action.repairAttempt,
              actionIndex: action.actionIndex,
              logicalActionId: action.logicalActionId,
            }),
          )
          .pipe(
            Effect.mapError((cause) => ({
              _tag: "AgentActionOperationalFailure" as const,
              operation: "ExecutableApprovalReplayLookup",
              cause,
            })),
          );
        if (Option.isSome(existing)) currentApproval = existing.value;
      }
      if (currentApproval !== undefined) {
        // This value comes only from the trusted Executable ActionApproval
        // lookup; no model-facing argument can set it.
        intent = { ...intent, approvalId: currentApproval.approvalId };
      }
      const controlBasisDigest = sha256Hex(JSON.stringify(controlBasis));
      const toolContext: ToolExecutionContext = {
        executionId: execution.executionId,
        workspaceId: execution.workspaceId,
        sessionId: execution.sessionId,
        projectId: execution.projectId,
        actor: context.principal as never,
        authenticatedPrincipal: context.principal,
        controlBasisDigest,
        ...(recoveryBindingIdentity === undefined
          ? {}
          : { recoveryBindingIdentity }),
        ...(recoveryBindingPolicyRevisions === undefined
          ? {}
          : { recoveryBindingPolicyRevisions }),
        ...(providerTurnId === undefined ? {} : { providerTurnId }),
        ...(logicalActionId === undefined ? {} : { logicalActionId }),
        executionFence,
        delegationDepth:
          execution.binding._tag === "ExecutionBoundAgentBinding" ? 1 : 0,
        requestedAt,
        ...(currentApproval === undefined
          ? {}
          : {
              executableApproval: {
                approvalId: currentApproval.approvalId,
                expectedRevision:
                  currentApproval.state === "Consumed"
                    ? currentApproval.revision - 1
                    : currentApproval.revision,
                state: currentApproval.state,
                binding: currentApproval,
              },
            }),
      };
      const invoked = yield* Effect.match(tools.invoke(intent, toolContext), {
        onFailure: (cause) => ({ ok: false as const, cause }),
        onSuccess: (value) => ({ ok: true as const, value }),
      });
      if (qualificationProbe !== undefined) {
        const identity = {
          boundary: "P4ExecutableToolRuntimeOutcome" as const,
          executionId: execution.executionId,
          invocationId: String(intent.invocationId),
          callRef: invocation.callRef,
          toolName: invocation.toolName,
          ...(providerTurnId === undefined ? {} : { providerTurnId }),
          ...(logicalActionId === undefined ? {} : { logicalActionId }),
          ...(action === undefined ? {} : { actionIndex: action.actionIndex }),
          ...(currentApproval === undefined
            ? {}
            : { approvalId: currentApproval.approvalId }),
          ...(recoveryBindingIdentity === undefined
            ? {}
            : { recoveryBindingIdentity }),
        };
        const outcome = invoked.ok
          ? {
              ...identity,
              outcomeTag: invoked.value._tag,
            }
          : (() => {
              const cause = invoked.cause as unknown as Record<string, unknown>;
              const nestedCause =
                typeof cause.cause === "object" && cause.cause !== null
                  ? (cause.cause as Record<string, unknown>)
                  : undefined;
              const safeDetails =
                typeof cause.safeDetails === "object" &&
                cause.safeDetails !== null
                  ? (cause.safeDetails as Record<string, unknown>)
                  : undefined;
              const safeSourceTag = [
                safeDetails?.sourceTag,
                cause.sourceTag,
                nestedCause?.sourceTag,
              ].find(
                (value): value is string =>
                  typeof value === "string" &&
                  /^[A-Za-z0-9_.:-]{1,96}$/u.test(value),
              );
              const nestedStage =
                typeof nestedCause?.stage === "string"
                  ? nestedCause.stage
                  : undefined;
              return {
                ...identity,
                ...(typeof cause._tag === "string"
                  ? { errorTag: cause._tag }
                  : {}),
                ...(typeof nestedCause?._tag === "string"
                  ? { causeTag: nestedCause._tag }
                  : {}),
                ...(typeof cause.stage === "string"
                  ? { stage: cause.stage }
                  : {}),
                ...(typeof cause.operation === "string"
                  ? { operation: cause.operation }
                  : {}),
                ...(typeof nestedCause?.repository === "string"
                  ? { causeRepository: nestedCause.repository }
                  : {}),
                ...(typeof nestedCause?.operation === "string"
                  ? { causeOperation: nestedCause.operation }
                  : {}),
                ...(nestedStage === undefined ? {} : { nestedStage }),
                ...(safeSourceTag === undefined
                  ? {}
                  : { safeDetailsSourceTag: safeSourceTag }),
              };
            })();
        yield* Effect.promise(() => qualificationProbe(outcome));
      }
      if (!invoked.ok) {
        if (invoked.cause._tag === "ToolObservationRecoveryBlocked") {
          return yield* Effect.fail({
            _tag: "AgentActionRecoveryBlocked" as const,
            executionId: invoked.cause.executionId,
            logicalActionId: invoked.cause.logicalActionId,
          });
        }
        if (
          "effectDisposition" in invoked.cause &&
          invoked.cause.effectDisposition === "OutcomeUncertain"
        ) {
          return {
            _tag: "Settle" as const,
            settlement: {
              _tag: "OutcomeUnknown" as const,
              reconciliation: {
                _tag: "ReconciliationRequired" as const,
                invocationRefs: [invoked.cause.invocationRef],
              },
            },
          };
        }
        if (invoked.cause._tag === "LeaseFencingRejected") {
          return yield* Effect.fail({
            _tag: "AgentActionOperationalFailure" as const,
            operation: "ToolRuntime.LeaseFencingRejected",
            cause: invoked.cause,
          });
        }
        return yield* Effect.fail({
          _tag: "AgentActionOperationalFailure" as const,
          operation: `ToolRuntime.${invoked.cause.stage}`,
          cause: invoked.cause,
        });
      }
      const result = invoked.value;
      if (result._tag === "ApprovalRequired") {
        if (
          action === undefined ||
          actionFence === undefined ||
          approvalDependencies === undefined
        ) {
          return yield* Effect.fail({
            _tag: "AgentActionOperationalFailure" as const,
            operation: "ExecutableApproval.P3BindingUnavailable",
            cause:
              "P4 requested approval without a durable P3 action identity and lease fence",
          });
        }
        const binding: ExecutableApprovalBinding = {
          projectId: execution.projectId,
          workspaceId: execution.workspaceId,
          executionId: execution.executionId,
          subject: context.principal,
          logicalStepNo: action.logicalStepNo,
          repairAttempt: action.repairAttempt,
          actionIndex: action.actionIndex,
          logicalActionId: action.logicalActionId,
          callRef: invocation.callRef,
          toolInvocationId: intent.invocationId,
          toolName: invocation.toolName,
          toolVersion,
          sideEffectSemantics: result.sideEffectSemantics,
          argumentsJson: invocation.argumentsJson,
          actionDigest: result.actionDigest,
          targetResourceSpaceIds: result.targetResourceSpaceIds,
          controlBasisDigest: result.controlBasisDigest,
        };
        const issued = yield* issueExecutableApproval(
          {
            binding,
            authority: result.authority,
            requestedAt,
            executionFence: actionFence,
          },
          {
            store: approvalDependencies.store,
            transaction: approvalDependencies.transaction,
            resolveCandidate: (candidateBinding, candidateRequestedAt) =>
              approvalDependencies
                .resolveCandidate({
                  binding: candidateBinding,
                  authority: result.authority,
                  requestedAt: candidateRequestedAt,
                  requestedCapabilities: result.requestedCapabilities,
                  delegationDepth:
                    execution.binding._tag === "ExecutionBoundAgentBinding"
                      ? 1
                      : 0,
                })
                .pipe(
                  Effect.mapError((cause) => ({
                    _tag: "AgentActionOperationalFailure" as const,
                    operation: "ExecutableApproval.P12Resolve",
                    cause,
                  })),
                ),
          },
        ).pipe(
          Effect.mapError((cause) => ({
            _tag: "AgentActionOperationalFailure" as const,
            operation: "ExecutableApproval.Issue",
            cause,
          })),
        );
        if (issued === "ExecutionStopping") {
          return {
            _tag: "Observation",
            source: "Runtime",
            observation: bounded("tool invocation interrupted"),
            status: "Interrupted",
            disposition: "ExecutionStopping",
          };
        }
        if (!executableApprovalBindingMatches(issued, binding)) {
          return yield* Effect.fail({
            _tag: "AgentActionOperationalFailure" as const,
            operation: "ExecutableApproval.BindingConflict",
            cause: { _tag: "ExecutableApprovalBindingConflict" },
          });
        }
        return {
          _tag: "ApprovalRequired",
          approvalId: issued.approvalId,
          revision: issued.revision,
        };
      }
      const outcome = toExecutableOutcome(result);
      return outcome._tag === "Observation"
        ? { ...outcome, invocationId: intent.invocationId }
        : outcome;
    }),
});

export const ExecutableToolHandlerLive = (
  governance: ParentUserGovernanceFacts = {
    authenticatedHumans: [],
    directParentOf: [],
  },
  qualificationProbe?: ExecutableToolHandlerQualificationProbe,
): Layer.Layer<
  ExecutableToolHandler,
  never,
  | ToolRuntimePort
  | Clock
  | ToolCatalogPort
  | ToolInvocationStore
  | ExecutableApprovalStore
  | TransactionPort
  | AuthorityResolverPort
  | PermissionGrantRepository
  | WorkspaceRepository
> =>
  Layer.effect(
    ExecutableToolHandler,
    Effect.gen(function* () {
      const tools = yield* ToolRuntimePort;
      const clock = yield* Clock;
      const catalog = yield* ToolCatalogPort;
      const invocations = yield* ToolInvocationStore;
      const approvals = yield* ExecutableApprovalStore;
      const tx = yield* TransactionPort;
      const authorityResolver = yield* AuthorityResolverPort;
      const grants = yield* PermissionGrantRepository;
      const workspaces = yield* WorkspaceRepository;
      return ExecutableToolHandler.of(
        makeExecutableToolHandler(
          tools,
          clock,
          catalog,
          (id) => tx.transact(invocations.findById(id)),
          {
            store: approvals,
            transaction: tx,
            resolveCandidate: (input) =>
              Effect.gen(function* () {
                const snapshot = yield* tx.transact(
                  Effect.gen(function* () {
                    const workspace = yield* workspaces.findById(
                      input.binding.workspaceId,
                    );
                    const activeGrants = yield* grants.activeGrants(
                      input.binding.projectId,
                    );
                    return { workspace, activeGrants };
                  }),
                );
                if (Option.isNone(snapshot.workspace)) {
                  return yield* Effect.fail({
                    _tag: "ExecutableApprovalAuthorityResolutionFailed",
                    reason:
                      "workspace disappeared before P12 approval resolution",
                  });
                }
                const candidate = yield* authorityResolver.resolveApproval({
                  principal: input.authority.principal,
                  projectId: input.binding.projectId,
                  workspaceId: input.binding.workspaceId,
                  executionId: input.binding.executionId,
                  intent: {
                    toolName: input.binding.toolName,
                    toolVersion: input.binding.toolVersion,
                    argumentsJson: input.binding.argumentsJson,
                    actionDigest: input.binding.actionDigest,
                    sideEffectSemantics: input.binding.sideEffectSemantics,
                    requestedCapabilities: input.requestedCapabilities,
                    resolvedRegions: input.binding.targetResourceSpaceIds,
                  },
                  controlBasisDigest: input.binding.controlBasisDigest,
                  grants: snapshot.activeGrants,
                  governance,
                  policy: snapshot.workspace.value.workspacePolicy,
                  delegationDepth: input.delegationDepth,
                  now: input.requestedAt,
                  approvalIdentity: {
                    logicalStepNo: input.binding.logicalStepNo,
                    repairAttempt: input.binding.repairAttempt,
                    actionIndex: input.binding.actionIndex,
                    logicalActionId: input.binding.logicalActionId,
                    callRef: input.binding.callRef,
                    toolInvocationId: input.binding.toolInvocationId,
                  },
                });
                return {
                  approvalId: candidate.approvalId,
                  expiresAt: candidate.expiresAt,
                };
              }),
          },
          qualificationProbe,
        ),
      );
    }),
  );
