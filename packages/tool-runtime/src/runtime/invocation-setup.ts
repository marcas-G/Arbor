import type {
  EnvironmentRevisionStoreService,
  NoEffectDenialCode,
  RecoveryEvidenceStoreService,
  ToolDefinitionStoreService,
  ToolExecutionContext,
  ToolIntent,
  ToolInvocationStoreService,
  ToolReconciliationProfileRegistryService,
  ToolRuntimeError,
  TransactionPortService,
  WorkspaceRepositoryService,
} from "@arbor/ports";
import { Effect, Option } from "effect";
import { recoveryBindingIdentityMatches } from "../recovery-binding.js";
import { validateToolInput } from "../validation.js";
import {
  bounded,
  denied,
  hasCompleteExecutionFence,
  operationalFailure,
} from "./errors.js";
import type { ToolExecutor } from "./types.js";

/** Validate invocation identity, resolve the executor, and reject invalid input before admission. */
export const prepareInvocation = (
  intent: ToolIntent,
  context: ToolExecutionContext,
  executors: ReadonlyArray<ToolExecutor>,
  definitions: ToolDefinitionStoreService,
  reconciliationProfiles: Option.Option<ToolReconciliationProfileRegistryService>,
  p39Recovery: Option.Option<RecoveryEvidenceStoreService>,
  environmentRevisions: Option.Option<EnvironmentRevisionStoreService>,
  workspaces: Option.Option<WorkspaceRepositoryService>,
  tx: TransactionPortService,
  store: ToolInvocationStoreService,
  processModeBlocksSpawn: boolean,
  testOnlyAllowTrustedLocalProcessExecution: boolean,
  processUnavailableReason: NoEffectDenialCode,
  isIndependentVerificationExecution: (
    context: ToolExecutionContext,
  ) => boolean,
) =>
  Effect.gen(function* () {
    const completeFence = hasCompleteExecutionFence(context.executionFence);
    if (
      !completeFence ||
      context.executionFence.executionId !== context.executionId
    ) {
      return yield* Effect.fail<ToolRuntimeError>(
        operationalFailure(
          "IntentJournal",
          String(intent.invocationId),
        )({
          _tag: completeFence
            ? "ExecutionFenceExecutionMismatch"
            : "ExecutionFenceUnavailable",
        }),
      );
    }
    const definitionOption = yield* definitions.definition(
      intent.toolName,
      intent.toolVersion,
    );
    if (Option.isNone(definitionOption)) {
      return {
        _tag: "Terminal" as const,
        observation: denied("InvocationAuthorityDenied"),
      };
    }
    const definition = definitionOption.value;
    const trustedProfile =
      definition.sideEffectSemantics === "Reconcilable" &&
      Option.isSome(reconciliationProfiles)
        ? reconciliationProfiles.value.resolve({
            toolName: definition.name,
            toolVersion: definition.version,
            toolDefinitionHash: definition.hash,
          })
        : undefined;
    let trustedEffectKey: string | null = null;
    if (trustedProfile !== undefined) {
      try {
        trustedEffectKey = trustedProfile.effectKey({
          invocationId: intent.invocationId,
          argumentsJson: intent.argumentsJson,
        });
      } catch {
        trustedEffectKey = null;
      }
      if (
        typeof trustedEffectKey !== "string" ||
        trustedEffectKey.trim().length === 0
      ) {
        return yield* Effect.fail<ToolRuntimeError>(
          operationalFailure(
            "RecoveryBinding",
            String(intent.invocationId),
          )({ _tag: "ReconciliationEffectIdentityUnavailable" }),
        );
      }
    }
    const executor = executors.find((entry) => entry.name === intent.toolName);
    if (executor === undefined) {
      return {
        _tag: "Terminal" as const,
        observation: denied("InvocationAuthorityDenied"),
      };
    }
    if (
      executor.processCapability === "SandboxProcess" &&
      processModeBlocksSpawn &&
      !testOnlyAllowTrustedLocalProcessExecution &&
      !isIndependentVerificationExecution(context)
    ) {
      const durableInvocation = yield* tx
        .transact(store.findById(intent.invocationId))
        .pipe(
          Effect.mapError(
            operationalFailure("IntentJournal", String(intent.invocationId)),
          ),
        );
      if (Option.isNone(durableInvocation)) {
        return {
          _tag: "Terminal" as const,
          observation: denied(processUnavailableReason),
        };
      }
    }
    const p39BindingEnabled = Option.isSome(p39Recovery);
    if (
      p39BindingEnabled &&
      (!recoveryBindingIdentityMatches({
        identity: context.recoveryBindingIdentity,
        executionId: context.executionId,
        invocationId: intent.invocationId,
        callRef: intent.callRef,
        ...(context.executableApproval === undefined
          ? {}
          : { approvalBinding: context.executableApproval.binding }),
      }) ||
        context.recoveryBindingPolicyRevisions === undefined ||
        !Number.isSafeInteger(
          context.recoveryBindingPolicyRevisions.workspacePolicyRevision,
        ) ||
        context.recoveryBindingPolicyRevisions.workspacePolicyRevision < 0 ||
        !Number.isSafeInteger(
          context.recoveryBindingPolicyRevisions.projectPolicyRevision,
        ) ||
        context.recoveryBindingPolicyRevisions.projectPolicyRevision < 0 ||
        Option.isNone(environmentRevisions) ||
        Option.isNone(workspaces))
    ) {
      return yield* Effect.fail<ToolRuntimeError>(
        operationalFailure(
          "RecoveryBinding",
          String(intent.invocationId),
        )({ _tag: "RecoveryBindingSourceUnavailable" }),
      );
    }
    const validation = validateToolInput(
      definition.inputSchemaJson,
      intent.argumentsJson,
    );
    if (validation._tag === "Invalid") {
      return {
        _tag: "Terminal" as const,
        observation: {
          _tag: "ExpectedFailure" as const,
          observation: bounded(validation.reason),
        },
      };
    }

    if (p39BindingEnabled && Option.isSome(p39Recovery)) {
      const priorDenial = yield* tx
        .transact(store.findById(intent.invocationId))
        .pipe(
          Effect.mapError(
            operationalFailure("IntentJournal", String(intent.invocationId)),
          ),
        );
      if (
        Option.isSome(priorDenial) &&
        priorDenial.value.settlement?._tag === "Denied" &&
        priorDenial.value.settledAt !== null &&
        priorDenial.value.effectAdmissionState === "NotAdmitted" &&
        priorDenial.value.resultRef === null &&
        priorDenial.value.executionId === context.executionId &&
        priorDenial.value.workspaceId === context.workspaceId &&
        priorDenial.value.toolName === intent.toolName &&
        priorDenial.value.toolVersion === intent.toolVersion &&
        priorDenial.value.sideEffectSemantics ===
          definition.sideEffectSemantics &&
        priorDenial.value.argumentsJson === intent.argumentsJson &&
        priorDenial.value.approvalId ===
          (context.executableApproval?.approvalId ?? intent.approvalId)
      ) {
        const unboundDenial = yield* tx
          .transact(
            p39Recovery.value.findTerminalUnboundDenial(intent.invocationId),
          )
          .pipe(
            Effect.mapError(
              operationalFailure(
                "RecoveryBinding",
                String(intent.invocationId),
              ),
            ),
          );
        if (Option.isSome(unboundDenial)) {
          return {
            _tag: "Terminal" as const,
            observation: denied(priorDenial.value.settlement.reasonCode),
          };
        }
      }
    }

    return {
      _tag: "Ready" as const,
      definition,
      trustedProfile,
      trustedEffectKey,
      executor,
      p39BindingEnabled,
    };
  });
