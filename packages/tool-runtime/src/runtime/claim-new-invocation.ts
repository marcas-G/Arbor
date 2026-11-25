import {
  type ExecutableApprovalConsumptionReceipt,
  type ExecutableApprovalStoreService,
  executableApprovalBindingMatches,
  type P39RecoveryEvidenceStoreService,
  type RecoveryBindingV1,
  type ToolDefinition,
  type ToolExecutionContext,
  type ToolIntent,
  type ToolInvocationStoreService,
  type ToolReconciliationProfile,
  type ToolRuntimeError,
  type TransactionPortService,
} from "@arbor/ports";
import { Effect, Option } from "effect";
import {
  makeRecoveryBindingV1,
  type RecoveryApprovalSnapshot,
  recoveryApprovalSnapshotFromReceipt,
} from "../recovery-binding.js";
import {
  isLeaseFencingRejected,
  isP39ResourceResolutionStale,
  operationalFailure,
} from "./errors.js";
import type {
  AuthorityCapture,
  NoEffectSettlement,
  RefreshAfterStale,
  ResourceCapture,
} from "./phase-contracts.js";
import type { ToolRuntimeQualificationProbe } from "./types.js";

/** Claim an invocation and consume its approval in the same binding transaction. */
export const claimNewInvocation = (
  intent: ToolIntent,
  context: ToolExecutionContext,
  definition: ToolDefinition,
  resources: ResourceCapture,
  authority: AuthorityCapture,
  now: string,
  trustedProfile: ToolReconciliationProfile | undefined,
  trustedEffectKey: string | null,
  tx: TransactionPortService,
  store: ToolInvocationStoreService,
  p39Recovery: Option.Option<P39RecoveryEvidenceStoreService>,
  p39BindingEnabled: boolean,
  executableApprovals: Option.Option<ExecutableApprovalStoreService>,
  options: { readonly qualificationProbe?: ToolRuntimeQualificationProbe },
  recordNoEffectDenial: NoEffectSettlement["recordNoEffectDenial"],
  refreshAfterStale: RefreshAfterStale,
) =>
  Effect.gen(function* () {
    const {
      regions,
      capturedWorkspace,
      resolved,
      validateCapturedSnapshotAndAdmit,
    } = resources;
    const { resolvedAuthority, needsApproval } = authority;
    let { approvalAlreadyConsumedBySelf } = authority;
    if (
      p39BindingEnabled &&
      definition.sideEffectSemantics === "Reconcilable" &&
      trustedProfile === undefined
    ) {
      return yield* Effect.fail<ToolRuntimeError>(
        operationalFailure(
          "RecoveryBinding",
          String(intent.invocationId),
        )({ _tag: "ReconciliationProfileUnavailable" }),
      );
    }
    const invocation = {
      invocationId: intent.invocationId,
      executionId: context.executionId,
      workspaceId: context.workspaceId,
      toolName: intent.toolName,
      toolVersion: intent.toolVersion,
      sideEffectSemantics: definition.sideEffectSemantics,
      argumentsJson: intent.argumentsJson,
      resolvedRegions: regions,
      approvalId: context.executableApproval?.approvalId ?? intent.approvalId,
      intentAt: now,
    } as const;
    const claimStopped = { _tag: "AH7ClaimStopped" as const };
    const approvalClaimLost = { _tag: "AH7ApprovalClaimLost" as const };
    let approvalReceipt: ExecutableApprovalConsumptionReceipt | null = null;
    if (p39BindingEnabled && options.qualificationProbe !== undefined) {
      yield* Effect.promise(
        () =>
          options.qualificationProbe?.({
            boundary: "P38P39ClaimBeforeTransaction",
            executionId: context.executionId,
            invocationId: intent.invocationId,
            callRef: intent.callRef,
            approvalId:
              context.executableApproval?.approvalId ?? intent.approvalId,
          }) ?? Promise.resolve(),
      );
    }
    const claim = yield* Effect.match(
      tx.transact(
        Effect.gen(function* () {
          const snapshotAdmission =
            yield* validateCapturedSnapshotAndAdmit().pipe(
              Effect.mapError((cause) =>
                isP39ResourceResolutionStale(cause)
                  ? cause
                  : operationalFailure(
                      "ResourceAdmission",
                      String(intent.invocationId),
                    )(cause),
              ),
            );
          if (snapshotAdmission._tag === "Denied") {
            return "AdmissionDenied" as const;
          }
          const recordedIntent = yield* store.recordIntent(
            invocation,
            context.executionFence,
            now,
          );
          if (recordedIntent === "ExecutionStopping") {
            return "ExecutionStopping" as const;
          }
          if (
            needsApproval &&
            context.executableApproval !== undefined &&
            Option.isSome(executableApprovals)
          ) {
            if (approvalAlreadyConsumedBySelf) {
              if (p39BindingEnabled) {
                return yield* Effect.fail<ToolRuntimeError>(
                  operationalFailure(
                    "RecoveryBinding",
                    String(intent.invocationId),
                  )({ _tag: "ConsumedApprovalHasNoPriorBinding" }),
                );
              }
              return "Claimed" as const;
            }
            const consumed = yield* executableApprovals.value.consumeApproved({
              approvalId: context.executableApproval.approvalId,
              expectedRevision: context.executableApproval.expectedRevision,
              consumedBy: intent.invocationId,
              consumedAt: now,
              binding: context.executableApproval.binding,
              executionFence: context.executionFence,
            });
            if (consumed === "ExecutionStopping") {
              return yield* Effect.fail(claimStopped);
            }
            if (consumed === false) {
              return yield* Effect.fail(approvalClaimLost);
            }
            if (p39BindingEnabled) approvalReceipt = consumed;
          } else if (
            needsApproval &&
            intent.approvalId !== null &&
            !approvalAlreadyConsumedBySelf
          ) {
            if (p39BindingEnabled) {
              return yield* Effect.fail<ToolRuntimeError>(
                operationalFailure(
                  "RecoveryBinding",
                  String(intent.invocationId),
                )({ _tag: "P38ConsumptionReceiptUnavailable" }),
              );
            }
            const consumed = yield* store.consumeApproval(
              intent.approvalId,
              intent.invocationId,
              context.executionFence,
              now,
            );
            if (consumed === "ExecutionStopping") {
              return yield* Effect.fail(claimStopped);
            }
            if (!consumed) {
              return yield* Effect.fail(approvalClaimLost);
            }
          }
          if (p39BindingEnabled) {
            if (Option.isNone(p39Recovery)) {
              return yield* Effect.fail<ToolRuntimeError>(
                operationalFailure(
                  "RecoveryBinding",
                  String(intent.invocationId),
                )({ _tag: "P39RecoveryEvidenceStoreUnavailable" }),
              );
            }
            let approvalSnapshot: RecoveryApprovalSnapshot | null = null;
            if (needsApproval) {
              const receipt = approvalReceipt;
              const expected = context.executableApproval;
              if (
                receipt === null ||
                expected === undefined ||
                receipt.approvalId !== expected.approvalId ||
                receipt.consumedBy !== intent.invocationId ||
                receipt.preConsumeRevision !== expected.expectedRevision ||
                receipt.consumedRevision !== expected.expectedRevision + 1 ||
                !executableApprovalBindingMatches(
                  receipt.binding,
                  expected.binding,
                )
              ) {
                return yield* Effect.fail<ToolRuntimeError>(
                  operationalFailure(
                    "RecoveryBinding",
                    String(intent.invocationId),
                  )({ _tag: "P38ReceiptBindingMismatch" }),
                );
              }
              approvalSnapshot = recoveryApprovalSnapshotFromReceipt(receipt);
            }
            let recoveryBinding: RecoveryBindingV1;
            try {
              recoveryBinding = makeRecoveryBindingV1({
                context,
                intent,
                definition,
                authority: resolvedAuthority,
                regions,
                resourceBoundaryRevision:
                  capturedWorkspace.resourceBoundaryRevision,
                environmentRevision: resolved.observedEnvironmentRevision,
                approval: approvalSnapshot,
                ...(trustedProfile === undefined
                  ? {}
                  : {
                      profile: trustedProfile,
                      effectKey: trustedEffectKey,
                    }),
              });
            } catch (cause) {
              return yield* Effect.fail<ToolRuntimeError>(
                operationalFailure(
                  "RecoveryBinding",
                  String(intent.invocationId),
                )(cause),
              );
            }
            yield* p39Recovery.value
              .bindClaim({
                binding: recoveryBinding,
                createdAt: now,
              })
              .pipe(
                Effect.mapError(
                  operationalFailure(
                    "RecoveryBinding",
                    String(intent.invocationId),
                  ),
                ),
              );
          }
          return "Claimed" as const;
        }),
      ),
      {
        onFailure: (cause) => ({ _tag: "Failed" as const, cause }),
        onSuccess: (value) => ({ _tag: "Succeeded" as const, value }),
      },
    );
    if (claim._tag === "Failed") {
      if (isP39ResourceResolutionStale(claim.cause)) {
        return {
          _tag: "Terminal" as const,
          observation: yield* refreshAfterStale(claim.cause),
        };
      }
      if (
        typeof claim.cause === "object" &&
        claim.cause !== null &&
        "_tag" in claim.cause &&
        claim.cause._tag === "AH7ApprovalClaimLost"
      ) {
        return {
          _tag: "Terminal" as const,
          observation: yield* recordNoEffectDenial(
            definition.sideEffectSemantics,
            regions,
            "ApprovalConsumedByOtherInvocation",
          ),
        };
      }
      if (
        typeof claim.cause === "object" &&
        claim.cause !== null &&
        "_tag" in claim.cause &&
        claim.cause._tag === "AH7ClaimStopped"
      ) {
        return {
          _tag: "Terminal" as const,
          observation: { _tag: "Interrupted" as const },
        };
      }
      return yield* Effect.fail<ToolRuntimeError>(
        isLeaseFencingRejected(claim.cause) ||
          (typeof claim.cause === "object" &&
            claim.cause !== null &&
            "_tag" in claim.cause &&
            claim.cause._tag === "ToolRuntimeOperationalFailure")
          ? claim.cause
          : operationalFailure(
              "IntentJournal",
              String(intent.invocationId),
            )(claim.cause),
      );
    }
    if (claim.value === "ExecutionStopping") {
      return {
        _tag: "Terminal" as const,
        observation: { _tag: "Interrupted" as const },
      };
    }
    if (claim.value === "AdmissionDenied") {
      return {
        _tag: "Terminal" as const,
        observation: yield* recordNoEffectDenial(
          definition.sideEffectSemantics,
          regions,
          "ResourceAdmissionDenied",
        ),
      };
    }
    if (needsApproval) approvalAlreadyConsumedBySelf = true;
    if (options.qualificationProbe !== undefined) {
      yield* Effect.promise(
        () =>
          options.qualificationProbe?.({
            boundary: "AH7AfterToolIntentCommit",
            executionId: context.executionId,
            invocationId: intent.invocationId,
            callRef: intent.callRef,
          }) ?? Promise.resolve(),
      );
    }
    return { _tag: "Ready" as const, approvalAlreadyConsumedBySelf };
  });
