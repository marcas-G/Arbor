import {
  type ClockService,
  canonicalizeRecoveryBindingV1,
  type RecoveryEvidenceStoreService,
  type RecoveryBindingV1,
  recoveryBindingV1Digest,
  type ToolDefinition,
  type ToolExecutionContext,
  type ToolIntent,
  type ToolInvocationRecord,
  type ToolObservationEvidenceStoreService,
  type ToolReconciliationProfile,
  type ToolRuntimeError,
  type TransactionPortService,
  type VerifiedRecoveryBindingV1,
} from "@arbor/ports";
import { Effect, Option } from "effect";
import {
  makeRecoveryBindingV1,
  recoveryApprovalSnapshotFromRecord,
} from "../../recovery-binding.js";
import { isP39ResourceResolutionStale, operationalFailure } from "../errors.js";
import type {
  AuthorityCapture,
  NoEffectSettlement,
  RefreshAfterStale,
  ResourceCapture,
} from "../phase-contracts.js";

/** Check prior invocation identity and the exact immutable replay binding before reconciliation. */
export const verifyPriorReplayAdmission = (
  intent: ToolIntent,
  context: ToolExecutionContext,
  definition: ToolDefinition,
  recorded: ToolInvocationRecord,
  resources: ResourceCapture,
  authority: AuthorityCapture,
  verifiedReplayBinding: VerifiedRecoveryBindingV1 | undefined,
  p39BindingEnabled: boolean,
  p39Recovery: Option.Option<RecoveryEvidenceStoreService>,
  observationEvidence: Option.Option<ToolObservationEvidenceStoreService>,
  trustedProfile: ToolReconciliationProfile | undefined,
  trustedEffectKey: string | null,
  tx: TransactionPortService,
  clock: ClockService,
  recordNoEffectDenial: NoEffectSettlement["recordNoEffectDenial"],
  refreshAfterStale: RefreshAfterStale,
) =>
  Effect.gen(function* () {
    const {
      regions,
      capturedWorkspace,
      resolved,
      checkCapturedSnapshotAndAdmit,
    } = resources;
    const { needsApproval, currentApprovalRecord, resolvedAuthority } =
      authority;
    let replayBindingValue: RecoveryBindingV1 | undefined;
    let replayBindingSha256: string | undefined;
    const sameIntent =
      recorded.executionId === context.executionId &&
      recorded.workspaceId === context.workspaceId &&
      recorded.toolName === intent.toolName &&
      recorded.toolVersion === intent.toolVersion &&
      recorded.sideEffectSemantics === definition.sideEffectSemantics &&
      recorded.argumentsJson === intent.argumentsJson &&
      recorded.approvalId === intent.approvalId;
    if (
      !sameIntent ||
      (verifiedReplayBinding === undefined &&
        JSON.stringify(recorded.resolvedRegions) !== JSON.stringify(regions))
    ) {
      return yield* Effect.fail<ToolRuntimeError>(
        operationalFailure(
          "IntentJournal",
          String(intent.invocationId),
        )({
          _tag: "ToolInvocationIdentityConflict",
        }),
      );
    }
    if (
      recorded.settlement === null &&
      recorded.sideEffectSemantics === "Reconcilable" &&
      recorded.effectAdmissionState !== "NotAdmitted" &&
      trustedProfile === undefined
    ) {
      // Historical shell@2 and any other profile-less legacy row are
      // ambiguous external effects. Do not synthesize P39 identity or
      // enter the Executor path during recovery.
      return {
        _tag: "Terminal" as const,
        observation: {
          _tag: "OutcomeUnknown" as const,
          reconciliationRefs: [String(intent.invocationId)],
        },
      };
    }
    if (verifiedReplayBinding !== undefined) {
      replayBindingValue = verifiedReplayBinding.value;
      replayBindingSha256 = verifiedReplayBinding.bindingSha256;
    } else {
      const replayAdmission = yield* Effect.match(
        checkCapturedSnapshotAndAdmit(),
        {
          onFailure: (cause) => ({ ok: false as const, cause }),
          onSuccess: (value) => ({ ok: true as const, value }),
        },
      );
      if (!replayAdmission.ok) {
        if (isP39ResourceResolutionStale(replayAdmission.cause)) {
          return {
            _tag: "Terminal" as const,
            observation: yield* refreshAfterStale(replayAdmission.cause),
          };
        }
        return yield* Effect.fail<ToolRuntimeError>(
          replayAdmission.cause as ToolRuntimeError,
        );
      }
      if (replayAdmission.value._tag === "Denied") {
        return {
          _tag: "Terminal" as const,
          observation: yield* recordNoEffectDenial(
            definition.sideEffectSemantics,
            regions,
            "ResourceAdmissionDenied",
          ),
        };
      }
    }
    if (
      verifiedReplayBinding === undefined &&
      p39BindingEnabled &&
      Option.isSome(p39Recovery)
    ) {
      const approvalSnapshot = needsApproval
        ? recoveryApprovalSnapshotFromRecord(
            currentApprovalRecord,
            intent.invocationId,
          )
        : null;
      if (needsApproval && approvalSnapshot === null) {
        return yield* Effect.fail<ToolRuntimeError>(
          operationalFailure(
            "RecoveryBinding",
            String(intent.invocationId),
          )({ _tag: "ConsumedApprovalSourceUnavailable" }),
        );
      }
      let expectedBinding: RecoveryBindingV1;
      try {
        expectedBinding = makeRecoveryBindingV1({
          context,
          intent,
          definition,
          authority: resolvedAuthority,
          regions,
          resourceBoundaryRevision: capturedWorkspace.resourceBoundaryRevision,
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
      const bound = yield* tx
        .transact(
          Effect.gen(function* () {
            if (Option.isSome(observationEvidence)) {
              yield* observationEvidence.value.assertCurrentFence(
                context.executionFence,
                yield* clock.now(),
              );
            }
            return yield* p39Recovery.value.findBinding(intent.invocationId);
          }),
        )
        .pipe(
          Effect.mapError(
            operationalFailure("RecoveryBinding", String(intent.invocationId)),
          ),
        );
      if (
        Option.isNone(bound) ||
        bound.value.canonicalJson !==
          canonicalizeRecoveryBindingV1(expectedBinding) ||
        bound.value.bindingSha256 !== recoveryBindingV1Digest(expectedBinding)
      ) {
        return yield* Effect.fail<ToolRuntimeError>(
          operationalFailure(
            "RecoveryBinding",
            String(intent.invocationId),
          )({ _tag: "RecoveryBindingReplayMismatch" }),
        );
      }
      replayBindingValue = bound.value.value;
      replayBindingSha256 = bound.value.bindingSha256;
    }
    return {
      _tag: "Ready" as const,
      replayBindingValue,
      replayBindingSha256,
    };
  });
