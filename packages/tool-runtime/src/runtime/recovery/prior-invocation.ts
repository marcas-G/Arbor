import {
  canonicalArgumentsDigestV1,
  targetResourceIdentityDigestV1,
  verifyRecoveryBindingV1,
  type ClockService,
  type P39RecoveryEvidenceStoreService,
  type ToolDefinition,
  type ToolExecutionContext,
  type ToolIntent,
  type ToolObservationEvidenceStoreService,
  type ToolReconciliationFactStoreService,
  type ToolReconciliationPortService,
  type ToolReconciliationProfile,
  type ToolRuntimeError,
  type TransactionPortService,
} from "@arbor/ports";
import { Effect, Option } from "effect";
import { recoveryBindingToolDefinitionHashV1 } from "../../recovery-binding.js";
import { operationalFailure } from "../errors.js";
import type { makeObservationReplay } from "./observation-replay.js";

type Replay = ReturnType<typeof makeObservationReplay>;

/** Identify the exact prior invocation and authenticate any persisted replay binding. */
export const inspectPriorInvocation = (
  intent: ToolIntent,
  context: ToolExecutionContext,
  definition: ToolDefinition,
  trustedProfile: ToolReconciliationProfile | undefined,
  trustedEffectKey: string | null,
  tx: TransactionPortService,
  clock: ClockService,
  p39Recovery: Option.Option<P39RecoveryEvidenceStoreService>,
  p39RecoveryEvidence: Option.Option<P39RecoveryEvidenceStoreService>,
  observationEvidence: Option.Option<ToolObservationEvidenceStoreService>,
  reconciliationPort: Option.Option<ToolReconciliationPortService>,
  reconciliationFacts: Option.Option<ToolReconciliationFactStoreService>,
  findInvocationFenced: Replay["findInvocationFenced"],
  decodeRecordedEvidenceResult: Replay["decodeRecordedEvidenceResult"],
  resolveReplaySandboxPolicy: Parameters<Replay["decodeRecordedEvidenceResult"]>[4],
) =>
  Effect.gen(function* () {
    const prior = yield* findInvocationFenced(
      intent.invocationId,
      context,
      "IntentJournal",
    );
    const priorRecord = Option.isSome(prior) ? prior.value : undefined;
    const priorModelIdentityMatches =
      priorRecord !== undefined &&
      priorRecord.invocationId === intent.invocationId &&
      priorRecord.executionId === context.executionId &&
      priorRecord.workspaceId === context.workspaceId &&
      priorRecord.toolName === intent.toolName &&
      priorRecord.toolVersion === intent.toolVersion &&
      priorRecord.sideEffectSemantics ===
        definition.sideEffectSemantics &&
      priorRecord.argumentsJson === intent.argumentsJson &&
      priorRecord.approvalId === intent.approvalId &&
      (context.executableApproval === undefined ||
        context.executableApproval.approvalId === priorRecord.approvalId);
    if (priorRecord !== undefined && !priorModelIdentityMatches) {
      return yield* Effect.fail<ToolRuntimeError>(
        operationalFailure(
          "IntentJournal",
          String(intent.invocationId),
        )({ _tag: "ToolInvocationIdentityConflict" }),
      );
    }
    const terminalP39ReceiptCandidate =
      priorRecord !== undefined &&
      priorModelIdentityMatches &&
      priorRecord.settlement !== null &&
      priorRecord.sideEffectSemantics === "Reconcilable" &&
      priorRecord.effectAdmissionState === "MayHaveStarted" &&
      definition.sideEffectSemantics === "Reconcilable" &&
      trustedProfile !== undefined &&
      trustedEffectKey !== null &&
      Option.isSome(p39Recovery) &&
      Option.isSome(p39RecoveryEvidence) &&
      Option.isSome(observationEvidence) &&
      priorRecord.approvalId === intent.approvalId &&
      (context.executableApproval === undefined ||
        context.executableApproval.approvalId === priorRecord.approvalId);
    if (terminalP39ReceiptCandidate && priorRecord !== undefined) {
      const receipt = yield* decodeRecordedEvidenceResult(
        intent,
        context,
        priorRecord,
        {
          allowMissingSelected: true,
          definition,
          profile: trustedProfile,
          effectKey: trustedEffectKey as string,
        },
        resolveReplaySandboxPolicy,
      );
      if (receipt._tag !== "NotP39Receipt") {
        return { _tag: "Terminal" as const, observation: receipt };
      }
    }
    const exactReconcilableReplayCandidate =
      priorModelIdentityMatches &&
      priorRecord.settlement === null &&
      priorRecord.effectAdmissionState === "MayHaveStarted" &&
      priorRecord.sideEffectSemantics === "Reconcilable" &&
      definition.sideEffectSemantics === "Reconcilable" &&
      trustedProfile !== undefined &&
      Option.isSome(p39Recovery) &&
      Option.isSome(reconciliationPort) &&
      Option.isSome(reconciliationFacts) &&
      Option.isSome(observationEvidence);
    let verifiedReplayBinding:
      | import("@arbor/ports").VerifiedRecoveryBindingV1
      | undefined;
    if (exactReconcilableReplayCandidate && priorRecord !== undefined) {
      const identity = context.recoveryBindingIdentity;
      if (Option.isNone(p39Recovery)) {
        return yield* Effect.fail<ToolRuntimeError>(
          operationalFailure(
            "RecoveryBinding",
            String(intent.invocationId),
          )({ _tag: "P39RecoveryEvidenceStoreUnavailable" }),
        );
      }
      const stored = yield* tx
        .transact(
          Effect.gen(function* () {
            yield* observationEvidence.value.assertCurrentFence(
              context.executionFence,
              yield* clock.now(),
            );
            const binding = yield* p39Recovery.value.findBinding(
              intent.invocationId,
            );
            const attempt = yield* p39Recovery.value.findLatestAttempt(
              intent.invocationId,
            );
            return { binding, attempt };
          }),
        )
        .pipe(
          Effect.mapError(
            operationalFailure(
              "RecoveryBinding",
              String(intent.invocationId),
            ),
          ),
        );
      if (
        Option.isNone(stored.binding) ||
        Option.isNone(stored.attempt)
      ) {
        return yield* Effect.fail<ToolRuntimeError>(
          operationalFailure(
            "RecoveryBinding",
            String(intent.invocationId),
          )({ _tag: "RecoveryBindingReplayMismatch" }),
        );
      }
      const bound = stored.binding.value;
      const verified = verifyRecoveryBindingV1({
        invocationId: intent.invocationId,
        canonicalJson: bound.canonicalJson,
        bindingSha256: bound.bindingSha256,
      });
      const binding = verified?.value;
      const expectedArgumentsDigest = (() => {
        try {
          return canonicalArgumentsDigestV1(
            JSON.parse(intent.argumentsJson),
          );
        } catch {
          return null;
        }
      })();
      const attempt = stored.attempt.value;
      const bindingMatchesIdentity =
        identity !== undefined &&
        binding !== undefined &&
        binding.executionId === context.executionId &&
        binding.invocationId === intent.invocationId &&
        binding.providerTurnId === identity.providerTurnId &&
        binding.logicalStepNo === identity.logicalStepNo &&
        binding.repairAttempt === identity.repairAttempt &&
        binding.logicalActionId === identity.logicalActionId &&
        binding.actionIndex === identity.actionIndex &&
        binding.callRef === intent.callRef &&
        binding.toolName === intent.toolName &&
        binding.toolVersion === intent.toolVersion &&
        binding.toolDefinitionHash ===
          recoveryBindingToolDefinitionHashV1(definition) &&
        binding.sideEffectSemantics === "Reconcilable" &&
        binding.canonicalArgumentsDigest === expectedArgumentsDigest &&
        binding.targetResourceIdentityDigest ===
          targetResourceIdentityDigestV1(priorRecord.resolvedRegions) &&
        binding.approvalId === priorRecord.approvalId &&
        binding.approvalId ===
          (context.executableApproval?.approvalId ?? intent.approvalId) &&
        (binding.approvalId === null ||
          binding.approvalConsumedBy === intent.invocationId) &&
        attempt.invocationId === intent.invocationId &&
        attempt.admissionState === "MayHaveStarted" &&
        attempt.sideEffectSemantics === "Reconcilable" &&
        attempt.bindingSha256 === bound.bindingSha256 &&
        attempt.toolDefinitionHash === binding.toolDefinitionHash &&
        binding.profileId === attempt.profileId &&
        binding.profileVersion === attempt.profileVersion &&
        binding.profileHash === attempt.profileHash &&
        binding.profileProtocol === attempt.profileProtocol &&
        binding.effectKey === attempt.effectKey;
      if (verified === null || !bindingMatchesIdentity) {
        return yield* Effect.fail<ToolRuntimeError>(
          operationalFailure(
            "RecoveryBinding",
            String(intent.invocationId),
          )({ _tag: "RecoveryBindingReplayMismatch" }),
        );
      }
      const currentProfileMatchesPersistedAttempt =
        trustedProfile !== undefined &&
        trustedEffectKey !== null &&
        binding.profileId === trustedProfile.profileId &&
        binding.profileVersion === trustedProfile.profileVersion &&
        binding.profileHash === trustedProfile.profileHash &&
        binding.profileProtocol === trustedProfile.profileProtocol &&
        binding.effectKey === trustedEffectKey &&
        attempt.profileId === trustedProfile.profileId &&
        attempt.profileVersion === trustedProfile.profileVersion &&
        attempt.profileHash === trustedProfile.profileHash &&
        attempt.profileProtocol === trustedProfile.profileProtocol &&
        attempt.effectKey === trustedEffectKey;
      if (!currentProfileMatchesPersistedAttempt) {
        return {
          _tag: "Terminal" as const,
          observation: {
            _tag: "OutcomeUnknown" as const,
            reconciliationRefs: [String(intent.invocationId)],
          },
        };
      }
      verifiedReplayBinding = verified;
    }
    return {
      _tag: "Ready" as const,
      prior,
      priorRecord,
      priorModelIdentityMatches,
      verifiedReplayBinding,
    };
  });
