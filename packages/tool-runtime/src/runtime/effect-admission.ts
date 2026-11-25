import type {
  ClockService,
  P39RecoveryEvidenceStoreService,
  SandboxProcessPolicyResolution,
  ToolAuthorityResolverService,
  ToolDefinition,
  ToolExecutionContext,
  ToolIntent,
  ToolInvocationRecord,
  ToolInvocationStoreService,
  ToolRuntimeError,
  TransactionPortService,
} from "@arbor/ports";
import { Effect, Option } from "effect";
import { matchApproval } from "../approval.js";
import { checkInvocationAuthority } from "../authority.js";
import { approvalDenialCode, isLeaseFencingRejected, operationalFailure } from "./errors.js";
import type { NoEffectSettlement, ResourceCapture } from "./phase-contracts.js";
import type { ToolExecutionResult, ToolExecutor, ToolRuntimeQualificationProbe } from "./types.js";

/** Revalidate current authority and commit new effect admission before execution.
 * Sandbox policy cleanup remains owned by the invocation's ensuring bracket.
 */
export const admitNewEffect = (
  intent: ToolIntent,
  context: ToolExecutionContext,
  definition: ToolDefinition,
  executor: ToolExecutor,
  resources: ResourceCapture,
  needsApproval: boolean,
  approvalAlreadyConsumedBySelf: boolean,
  recoveredToolOutcome: ToolExecutionResult | undefined,
  prior: Option.Option<ToolInvocationRecord>,
  retryAdmitted: boolean,
  p39BindingEnabled: boolean,
  p39Recovery: Option.Option<P39RecoveryEvidenceStoreService>,
  authorityResolver: Option.Option<ToolAuthorityResolverService>,
  tx: TransactionPortService,
  clock: ClockService,
  store: ToolInvocationStoreService,
  options: { readonly maxDelegationDepth?: number; readonly qualificationProbe?: ToolRuntimeQualificationProbe },
  recordNoEffectDenial: NoEffectSettlement["recordNoEffectDenial"],
  persistNoEffectInterruption: NoEffectSettlement["persistNoEffectInterruption"],
  resolveSandboxPolicyOnce: (now: string) => Effect.Effect<SandboxProcessPolicyResolution | undefined>,
  registerSandboxCleanup: (dispose: Effect.Effect<void>) => void,
) =>
  Effect.gen(function* () {
    const { regions } = resources;
    let processExecutionContext = context;
  const effectGateNow = yield* clock.now();
  const effectAuthority = Option.isSome(authorityResolver)
    ? yield* authorityResolver.value
        .resolve({
          intent,
          definition,
          context,
          regions,
          now: effectGateNow,
        })
        .pipe(
          Effect.catchTag("ToolAuthorityDenied", () =>
            Effect.succeed(undefined),
          ),
          Effect.mapError(
            operationalFailure(
              "AuthorityResolution",
              String(intent.invocationId),
            ),
          ),
        )
    : context.authority;
  if (effectAuthority === undefined) {
    return {
      _tag: "Terminal" as const,
      observation: yield* recordNoEffectDenial(
      definition.sideEffectSemantics,
      regions,
      approvalAlreadyConsumedBySelf
        ? "ApprovalNoLongerAuthorized"
        : "InvocationAuthorityDenied",
      ),
    };
  }
  if (options.qualificationProbe !== undefined) {
    yield* Effect.promise(
      () =>
        options.qualificationProbe?.({
          boundary: "AH7AfterEffectAuthorityResolvedBeforeAdmission",
          executionId: context.executionId,
          invocationId: intent.invocationId,
          callRef: intent.callRef,
        }) ?? Promise.resolve(),
    );
  }
  if (effectAuthority.sourceRevision === undefined) {
    return {
      _tag: "Terminal" as const,
      observation: yield* recordNoEffectDenial(
      definition.sideEffectSemantics,
      regions,
      approvalAlreadyConsumedBySelf
        ? "ApprovalNoLongerAuthorized"
        : "InvocationAuthorityDenied",
      ),
    };
  }
  const effectAuthorityCheck = checkInvocationAuthority({
    authority: effectAuthority,
    definition,
    intent,
    context,
    regions,
    now: effectGateNow,
    maxDelegationDepth: options.maxDelegationDepth ?? 1,
  });
  if (effectAuthorityCheck._tag === "Denied") {
    return {
      _tag: "Terminal" as const,
      observation: yield* recordNoEffectDenial(
      definition.sideEffectSemantics,
      regions,
      approvalAlreadyConsumedBySelf
        ? "ApprovalNoLongerAuthorized"
        : "InvocationAuthorityDenied",
      ),
    };
  }
  if (
    needsApproval &&
    intent.approvalId !== null &&
    context.executableApproval === undefined
  ) {
    const approval = yield* tx
      .transact(store.findApproval(intent.approvalId))
      .pipe(
        Effect.mapError(
          operationalFailure(
            "ApprovalLookup",
            String(intent.invocationId),
          ),
        ),
      );
    const matched = Option.isSome(approval)
      ? matchApproval({
          approval: approval.value,
          intent,
          definition,
          context,
          regions,
          now: effectGateNow,
          replayOfRecordedInvocation: approvalAlreadyConsumedBySelf,
        })
      : { _tag: "Denied" as const, reason: "approval not found" };
    if (matched._tag === "Denied") {
      return {
        _tag: "Terminal" as const,
        observation: yield* recordNoEffectDenial(
        definition.sideEffectSemantics,
        regions,
        approvalAlreadyConsumedBySelf
          ? "ApprovalNoLongerAuthorized"
          : approvalDenialCode(matched.reason),
        ),
      };
    }
  }
  if (
    executor.processCapability === "SandboxProcess" &&
    p39BindingEnabled &&
    Option.isSome(p39Recovery) &&
    recoveredToolOutcome === undefined &&
    (retryAdmitted ||
      Option.isNone(prior) ||
      prior.value.effectAdmissionState === "NotAdmitted")
  ) {
    const isPolicyExpired = (
      policy: ToolExecutionContext["sandboxProcessPolicy"],
      now: string,
    ) =>
      policy?.expiresAt !== undefined &&
      Number.isFinite(Date.parse(policy.expiresAt)) &&
      new Date(Date.parse(policy.expiresAt)).toISOString() ===
        policy.expiresAt &&
      Date.parse(policy.expiresAt) <= Date.parse(now);
    let processPolicy = context.sandboxProcessPolicy;
    let policyNow = effectGateNow;
    const authorizationRevision =
      effectAuthority.workspaceSandboxSources?.find(
        (source) => source.workspaceId === context.workspaceId,
      )?.authorizationRevision;
    const sourceMatches = (
      policy: ToolExecutionContext["sandboxProcessPolicy"],
    ) =>
      authorizationRevision == null ||
      policy?.workspaceAuthorizationRevision ===
        authorizationRevision;
    if (
      (processPolicy === undefined ||
        isPolicyExpired(processPolicy, policyNow) ||
        !sourceMatches(processPolicy)) &&
      context.resolveSandboxProcessPolicy !== undefined
    ) {
      // This resolver may read the current durable decision,
      // authority bundle and P11 paths. It is intentionally run
      // after the exact NotAdmitted intent/RecoveryBinding commit,
      // after the existing authority/approval gate, and outside
      // every TransactionPort scope.
      policyNow = yield* clock.now();
      const materialized = yield* resolveSandboxPolicyOnce(policyNow);
      if (materialized !== undefined) {
        processPolicy = materialized.policy;
        registerSandboxCleanup(materialized.dispose ?? Effect.void);
        processExecutionContext = {
          ...context,
          sandboxProcessPolicy: materialized.policy,
          sandboxProcessMountBindings: materialized.mounts,
        };
      }
    }
    if (
      processPolicy === undefined ||
      isPolicyExpired(processPolicy, policyNow) ||
      !sourceMatches(processPolicy)
    ) {
      // P4 has already durably claimed the exact P3 action and bound
      // its immutable recovery proof above. Policy absence parks that
      // same action before effect admission; it is neither a denial
      // nor a terminal ExpectedFailure/Observation.
      return { _tag: "Terminal" as const, observation: { _tag: "SandboxPolicyRequiredInterruption" as const } };
    }
  }
  if (options.qualificationProbe !== undefined) {
    yield* Effect.promise(
      () =>
        options.qualificationProbe?.({
          boundary: "AH7BeforeEffectAdmission",
          executionId: context.executionId,
          invocationId: intent.invocationId,
          callRef: intent.callRef,
        }) ?? Promise.resolve(),
    );
  }
  const effectAdmission = retryAdmitted
    ? {
        _tag: "Succeeded" as const,
        value: { _tag: "Admitted" as const },
      }
    : yield* Effect.match(
        tx.transact(
          Effect.gen(function* () {
            const admissionNow = yield* clock.now();
            const admissionResult = yield* store.admitEffect(
              intent.invocationId,
              effectAuthority,
              admissionNow,
              context.executionFence,
            );
            if (
              admissionResult._tag === "Admitted" &&
              p39BindingEnabled &&
              Option.isSome(p39Recovery)
            ) {
              yield* p39Recovery.value.admitFirstAttempt(
                intent.invocationId,
                admissionNow,
              );
            }
            return admissionResult;
          }),
        ),
        {
          onFailure: (cause) => ({ _tag: "Failed" as const, cause }),
          onSuccess: (value) => ({
            _tag: "Succeeded" as const,
            value,
          }),
        },
      );
  if (effectAdmission._tag === "Failed") {
    return yield* Effect.fail<ToolRuntimeError>(
      isLeaseFencingRejected(effectAdmission.cause)
        ? effectAdmission.cause
        : operationalFailure(
            "IntentJournal",
            String(intent.invocationId),
          )(effectAdmission.cause),
    );
  }
  if (effectAdmission.value._tag === "Denied") {
    if (recoveredToolOutcome !== undefined) {
      // A known Occurred fact is accounted under the current fence even
      // if current authority no longer admits new effects.
    } else {
      return {
        _tag: "Terminal" as const,
        observation: yield* recordNoEffectDenial(
        definition.sideEffectSemantics,
        regions,
        approvalAlreadyConsumedBySelf
          ? "ApprovalNoLongerAuthorized"
          : effectAdmission.value.reasonCode,
        ),
      };
    }
  }
  if (effectAdmission.value._tag === "ExecutionStopping") {
    if (options.qualificationProbe !== undefined) {
      yield* Effect.promise(
        () =>
          options.qualificationProbe?.({
            boundary: "P38StopEffectAdmissionResult",
            executionId: context.executionId,
            invocationId: intent.invocationId,
            callRef: intent.callRef,
            logicalActionId:
              context.logicalActionId ??
              context.recoveryBindingIdentity?.logicalActionId,
            fencingGeneration:
              context.executionFence.fencingGeneration,
            admissionResult: effectAdmission.value._tag,
          }) ?? Promise.resolve(),
      );
    }
    if (recoveredToolOutcome !== undefined) {
      // Stop gates new execution; it does not discard a confirmed
      // external outcome.
    } else {
      const settledAt = yield* clock.now();
      return {
        _tag: "Terminal" as const,
        observation: yield* persistNoEffectInterruption(
        Option.isSome(prior)
          ? {
              invocationId: intent.invocationId,
              executionId: context.executionId,
              workspaceId: context.workspaceId,
              toolName: intent.toolName,
              toolVersion: intent.toolVersion,
              sideEffectSemantics: definition.sideEffectSemantics,
              argumentsJson: intent.argumentsJson,
              resolvedRegions: regions,
              approvalId:
                context.executableApproval?.approvalId ??
                intent.approvalId,
              intentAt: prior.value.intentAt,
            }
          : undefined,
        settledAt,
        ),
      };
    }
  }

  if (
    options.qualificationProbe !== undefined &&
    recoveredToolOutcome === undefined
  ) {
    yield* Effect.promise(
      () =>
        options.qualificationProbe?.({
          boundary: "P38StopEffectAdmissionResult",
          executionId: context.executionId,
          invocationId: intent.invocationId,
          callRef: intent.callRef,
          ...((context.logicalActionId ??
            context.recoveryBindingIdentity?.logicalActionId) ===
          undefined
            ? {}
            : {
                logicalActionId:
                  context.logicalActionId ??
                  context.recoveryBindingIdentity?.logicalActionId,
              }),
          fencingGeneration: context.executionFence.fencingGeneration,
          admissionResult: effectAdmission.value._tag,
          ...(effectAdmission.value._tag === "Denied"
            ? {
                admissionDenialReason:
                  effectAdmission.value.reasonCode,
              }
            : {}),
        }) ?? Promise.resolve(),
    );
  }

  if (options.qualificationProbe !== undefined) {
    yield* Effect.promise(
      () =>
        options.qualificationProbe?.({
          boundary: "AH7AfterEffectAdmissionCommit",
          executionId: context.executionId,
          invocationId: intent.invocationId,
          callRef: intent.callRef,
        }) ?? Promise.resolve(),
    );
  }
    return { _tag: "Ready" as const, processExecutionContext };
  });
