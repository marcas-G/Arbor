import type { CanonicalResourceRegion } from "@arbor/domain";
import { decodeExecutionEpisodeBinding, encodeExecutionEpisodeBinding } from "@arbor/domain";
import {
  canonicalArgumentsDigestV1,
  targetResourceIdentityDigestV1,
  type CanonicalToolObservation,
  type ClockService,
  type P39RecoveryEvidenceStoreService,
  type SandboxProcessPolicyResolution,
  type SelectedP39RecoveryEvidence,
  type ToolDefinition,
  type ToolExecutionContext,
  type ToolIntent,
  type ToolInvocationStoreService,
  type ToolObservationEvidenceStoreService,
  type ToolObservationReplayAttentionFactStoreService,
  type ToolObservationReplayFailureCode,
  type ToolReconciliationProfile,
  type ToolRuntimeError,
  type TransactionPortService,
} from "@arbor/ports";
import { Effect, Option } from "effect";
import { matchesAuthenticatedP39Evidence, recoveryBindingToolDefinitionHashV1 } from "../recovery-binding.js";
import { isLeaseFencingRejected, operationalFailure } from "./errors.js";

/** Read and verify recorded evidence without acquiring a new effect admission. */
export const makeObservationReplay = (
  tx: TransactionPortService,
  clock: ClockService,
  store: ToolInvocationStoreService,
  observationEvidence: Option.Option<ToolObservationEvidenceStoreService>,
  replayAttentionFacts: Option.Option<ToolObservationReplayAttentionFactStoreService>,
  p39RecoveryEvidence: Option.Option<P39RecoveryEvidenceStoreService>,
) => {
  const replayFailureCode = (
    cause: unknown,
  ): ToolObservationReplayFailureCode | undefined =>
    typeof cause === "object" &&
    cause !== null &&
    "_tag" in cause &&
    cause._tag === "ToolObservationReplayEvidenceFailure" &&
    "failureCode" in cause
      ? (cause.failureCode as ToolObservationReplayFailureCode)
      : undefined;

  const recordReplayFailure = (
    intent: ToolIntent,
    context: ToolExecutionContext,
    failureCode: ToolObservationReplayFailureCode,
    detectedAt: string,
  ): Effect.Effect<never, ToolRuntimeError> =>
    Effect.gen(function* () {
      const fence = context.executionFence;
      if (
        fence === undefined ||
        context.providerTurnId === undefined ||
        context.logicalActionId === undefined ||
        Option.isNone(replayAttentionFacts)
      ) {
        return yield* Effect.fail<ToolRuntimeError>(
          operationalFailure(
            "SettlementJournal",
            String(intent.invocationId),
          )({
            _tag: "ToolObservationReplayEscalationUnavailable",
          }),
        );
      }
      yield* tx
        .transact(
          replayAttentionFacts.value.recordFailure({
            projectId: context.projectId,
            executionId: context.executionId,
            targetWorkspaceId: context.workspaceId,
            logicalActionId: context.logicalActionId,
            providerTurnId: context.providerTurnId,
            callRef: intent.callRef,
            invocationId: intent.invocationId,
            failureCode,
            firstDetectedAt: detectedAt,
            executionFence: fence,
          }),
        )
        .pipe(
          Effect.mapError((cause) =>
            isLeaseFencingRejected(cause)
              ? cause
              : operationalFailure(
                  "SettlementJournal",
                  String(intent.invocationId),
                )(cause),
          ),
        );
      return yield* Effect.fail<ToolRuntimeError>({
        _tag: "ToolObservationRecoveryBlocked",
        executionId: context.executionId,
        logicalActionId: context.logicalActionId,
      });
    });

  const NOT_P39_RECEIPT = { _tag: "NotP39Receipt" } as const;
  type NotP39Receipt = typeof NOT_P39_RECEIPT;

  const decodeRecordedEvidenceResult = (
    intent: ToolIntent,
    context: ToolExecutionContext,
    recorded: {
      readonly invocationId: string;
      readonly executionId: string;
      readonly workspaceId: string;
      readonly toolName: string;
      readonly toolVersion: string;
      readonly sideEffectSemantics: import("@arbor/ports").SideEffectSemantics;
      readonly argumentsJson: string;
      readonly resolvedRegions: ReadonlyArray<CanonicalResourceRegion>;
      readonly approvalId: string | null;
      readonly intentAt: string;
      readonly settlement?: import("@arbor/ports").ToolInvocationRecord["settlement"];
      readonly resultRef?: string | null;
    },
    terminalP39Receipt?: {
      readonly allowMissingSelected?: boolean;
      readonly definition: ToolDefinition;
      readonly profile: ToolReconciliationProfile;
      readonly effectKey: string;
    },
    resolveSandboxPolicy?: (
      now: string,
    ) => Effect.Effect<SandboxProcessPolicyResolution | undefined>,
  ): Effect.Effect<
    CanonicalToolObservation | NotP39Receipt,
    ToolRuntimeError
  > =>
    Effect.gen(function* () {
      if (Option.isNone(observationEvidence)) {
        return yield* Effect.fail(
          operationalFailure(
            "SettlementJournal",
            String(intent.invocationId),
          )({
            _tag: "ToolObservationEvidenceStoreUnavailable",
          }),
        );
      }
      const fence = context.executionFence;
      if (fence === undefined) {
        return yield* Effect.fail<ToolRuntimeError>(
          operationalFailure(
            "SettlementJournal",
            String(intent.invocationId),
          )({
            _tag: "ToolObservationEvidenceReplayFenceUnavailable",
          }),
        );
      }
      const invocation = {
        invocationId: recorded.invocationId as ToolIntent["invocationId"],
        executionId:
          recorded.executionId as ToolExecutionContext["executionId"],
        workspaceId:
          recorded.workspaceId as ToolExecutionContext["workspaceId"],
        toolName: recorded.toolName,
        toolVersion: recorded.toolVersion,
        sideEffectSemantics: recorded.sideEffectSemantics,
        argumentsJson: recorded.argumentsJson,
        resolvedRegions: recorded.resolvedRegions,
        approvalId: recorded.approvalId,
        intentAt: recorded.intentAt,
      } as const;
      const read = yield* Effect.match(
        tx.transact(
          Effect.gen(function* () {
            yield* observationEvidence.value.assertCurrentFence(
              fence,
              yield* clock.now(),
            );
            const evidence = yield* observationEvidence.value.read(
              invocation,
              fence,
              yield* clock.now(),
            );
            let selected = Option.none<SelectedP39RecoveryEvidence>();
            if (
              terminalP39Receipt !== undefined ||
              evidence.observation._tag === "ReconciledNoEffect"
            ) {
              if (Option.isSome(p39RecoveryEvidence)) {
                selected = yield* p39RecoveryEvidence.value.findSelected(
                  intent.invocationId,
                );
              }
            }
            return { evidence, selected };
          }),
        ),
        {
          onFailure: (cause) => ({ ok: false as const, cause }),
          onSuccess: (value) => ({ ok: true as const, value }),
        },
      );
      if (!read.ok) {
        if (isLeaseFencingRejected(read.cause)) {
          return yield* Effect.fail<ToolRuntimeError>(read.cause);
        }
        const failureCode = replayFailureCode(read.cause);
        if (failureCode !== undefined) {
          return yield* recordReplayFailure(
            intent,
            context,
            failureCode,
            yield* clock.now(),
          );
        }
        if (terminalP39Receipt !== undefined) {
          return yield* recordReplayFailure(
            intent,
            context,
            "SettlementMismatch",
            yield* clock.now(),
          );
        }
        return yield* Effect.fail<ToolRuntimeError>(
          operationalFailure(
            "SettlementJournal",
            String(intent.invocationId),
          )(read.cause),
        );
      }
      const observation = read.value.evidence
        .observation as CanonicalToolObservation;
      const requiresSelectedFact =
        terminalP39Receipt !== undefined ||
        observation._tag === "ReconciledNoEffect";
      if (requiresSelectedFact) {
        if (Option.isNone(p39RecoveryEvidence)) {
          return yield* recordReplayFailure(
            intent,
            context,
            "SettlementMismatch",
            yield* clock.now(),
          );
        }
        const selected = read.value.selected;
        if (Option.isNone(selected)) {
          if (terminalP39Receipt?.allowMissingSelected === true) {
            return NOT_P39_RECEIPT;
          }
          return yield* recordReplayFailure(
            intent,
            context,
            "SettlementMismatch",
            yield* clock.now(),
          );
        }
        const selectedOutcome = selected.value.fact.outcome;
        if (
          selectedOutcome !== "NotOccurred" &&
          selectedOutcome !== "Occurred"
        ) {
          return yield* recordReplayFailure(
            intent,
            context,
            "SettlementMismatch",
            yield* clock.now(),
          );
        }
        const expectedP39Outcome = terminalP39Receipt
          ? selectedOutcome
          : "NotOccurred";
        const factId =
          expectedP39Outcome === "NotOccurred"
            ? observation._tag === "ReconciledNoEffect"
              ? observation.reconciliationFactRef
              : ""
            : selected.value.fact.factId;
        if (
          !matchesAuthenticatedP39Evidence({
            selected: selected.value,
            intent,
            context,
            factId,
            expectedOutcome: expectedP39Outcome,
          })
        ) {
          return yield* recordReplayFailure(
            intent,
            context,
            "SettlementMismatch",
            yield* clock.now(),
          );
        }
        if (terminalP39Receipt !== undefined) {
          const selectedEvidence = selected.value;
          const binding = selectedEvidence.binding.value;
          let argumentsDigest: string | null;
          try {
            argumentsDigest = canonicalArgumentsDigestV1(
              JSON.parse(recorded.argumentsJson),
            );
          } catch {
            argumentsDigest = null;
          }
          const exactReceiptSource =
            binding.sideEffectSemantics === "Reconcilable" &&
            binding.toolName === recorded.toolName &&
            binding.toolVersion === recorded.toolVersion &&
            binding.toolDefinitionHash ===
              recoveryBindingToolDefinitionHashV1(
                terminalP39Receipt.definition,
              ) &&
            binding.canonicalArgumentsDigest === argumentsDigest &&
            binding.targetResourceIdentityDigest ===
              targetResourceIdentityDigestV1(recorded.resolvedRegions) &&
            binding.approvalId === recorded.approvalId &&
            binding.approvalId === intent.approvalId &&
            (context.executableApproval === undefined ||
              context.executableApproval.approvalId ===
                recorded.approvalId) &&
            binding.profileId === terminalP39Receipt.profile.profileId &&
            binding.profileVersion ===
              terminalP39Receipt.profile.profileVersion &&
            binding.profileHash ===
              terminalP39Receipt.profile.profileHash &&
            binding.profileProtocol ===
              terminalP39Receipt.profile.profileProtocol &&
            binding.effectKey === terminalP39Receipt.effectKey &&
            selectedEvidence.attempt.profileId ===
              terminalP39Receipt.profile.profileId &&
            selectedEvidence.attempt.profileVersion ===
              terminalP39Receipt.profile.profileVersion &&
            selectedEvidence.attempt.profileHash ===
              terminalP39Receipt.profile.profileHash &&
            selectedEvidence.attempt.profileProtocol ===
              terminalP39Receipt.profile.profileProtocol &&
            selectedEvidence.attempt.effectKey ===
              terminalP39Receipt.effectKey;
          const observationMatchesReceipt =
            expectedP39Outcome === "NotOccurred"
              ? observation._tag === "ReconciledNoEffect" &&
                recorded.settlement?._tag === "ReconciledNoEffect" &&
                observation.reconciliationFactRef ===
                  selectedEvidence.fact.factId &&
                recorded.settlement.reconciliationFactRef ===
                  selectedEvidence.fact.factId
              : (observation._tag === "Success" ||
                  observation._tag === "ExpectedFailure") &&
                recorded.settlement?._tag === observation._tag &&
                (observation._tag === "Success"
                  ? observation.resultRef ===
                      selectedEvidence.fact.resultRef &&
                    recorded.resultRef === selectedEvidence.fact.resultRef
                  : recorded.resultRef === null &&
                    selectedEvidence.fact.resultRef !== null);
          if (!exactReceiptSource || !observationMatchesReceipt) {
            return yield* recordReplayFailure(
              intent,
              context,
              "SettlementMismatch",
              yield* clock.now(),
            );
          }
        }
      }
      if (
        observation._tag === "ExpectedFailure" &&
        observation.sandboxProviderUnavailable !== undefined
      ) {
        const unavailable = observation.sandboxProviderUnavailable;
        const policyResolution =
          resolveSandboxPolicy === undefined
            ? undefined
            : yield* resolveSandboxPolicy(yield* clock.now());
        const policy =
          resolveSandboxPolicy === undefined
            ? context.sandboxProcessPolicy
            : policyResolution?.policy;
        const sourceAction = context.recoveryBindingIdentity;
        const currentEpisode =
          context.executionEpisodeBinding === undefined
            ? undefined
            : decodeExecutionEpisodeBinding(
                context.executionEpisodeBinding,
              );
        if (
          policy === undefined ||
          policy.kind === "IndependentVerificationProcessPolicyV1" ||
          policy.executionId !== context.executionId ||
          policy.policyRevision !== unavailable.policyRevision ||
          policy.policyDigest !== unavailable.policyDigest ||
          policy.profile !== unavailable.profile ||
          policy.providerId !== unavailable.providerId ||
          policy.providerVersion !== unavailable.providerVersion ||
          policy.capabilityRevision !== unavailable.capabilityRevision ||
          sourceAction === undefined ||
          sourceAction.executionId !== context.executionId ||
          sourceAction.callRef !== intent.callRef ||
          currentEpisode === undefined ||
          encodeExecutionEpisodeBinding(policy.episodeBinding) !==
            encodeExecutionEpisodeBinding(currentEpisode)
        ) {
          return yield* Effect.fail<ToolRuntimeError>(
            operationalFailure(
              "RecoveryBinding",
              String(intent.invocationId),
            )({ _tag: "SandboxUnavailableObservationPolicyMismatch" }),
          );
        }
        return {
          _tag: "SandboxProviderUnavailable" as const,
          projectId: context.projectId,
          workspaceId: context.workspaceId,
          executionId: context.executionId,
          episodeBinding: policy.episodeBinding,
          policyRevision: unavailable.policyRevision,
          policyDigest: unavailable.policyDigest,
          profileId: unavailable.profile,
          providerId: unavailable.providerId,
          providerVersion: unavailable.providerVersion,
          capabilityRevision: unavailable.capabilityRevision,
          probeEvidenceRef: unavailable.probeEvidenceRef,
          failureCode: unavailable.failureCode,
          actionBinding: {
            identity: {
              executionId: sourceAction.executionId,
              logicalStepNo: sourceAction.logicalStepNo,
              repairAttempt: sourceAction.repairAttempt,
            },
            providerTurnId: sourceAction.providerTurnId,
            logicalActionId: sourceAction.logicalActionId,
            actionIndex: sourceAction.actionIndex,
            callRef: sourceAction.callRef,
            invocationId: intent.invocationId,
          },
        };
      }
      return observation;
    });

  const decodeRecordedEvidence = (
    intent: ToolIntent,
    context: ToolExecutionContext,
    recorded: Parameters<typeof decodeRecordedEvidenceResult>[2],
    resolveSandboxPolicy?: Parameters<
      typeof decodeRecordedEvidenceResult
    >[4],
  ): Effect.Effect<CanonicalToolObservation, ToolRuntimeError> =>
    decodeRecordedEvidenceResult(
      intent,
      context,
      recorded,
      undefined,
      resolveSandboxPolicy,
    ).pipe(
      Effect.flatMap((result) =>
        result._tag === "NotP39Receipt"
          ? Effect.fail<ToolRuntimeError>(
              operationalFailure(
                "SettlementJournal",
                String(intent.invocationId),
              )({ _tag: "UnexpectedNotP39Receipt" }),
            )
          : Effect.succeed(result),
      ),
    );

  const findInvocationFenced = (
    invocationId: ToolIntent["invocationId"],
    context: ToolExecutionContext,
    stage: import("@arbor/ports").ToolRuntimeOperationalStage,
  ) =>
    tx
      .transact(
        Effect.gen(function* () {
          if (Option.isSome(observationEvidence)) {
            const fence = context.executionFence;
            if (fence === undefined) {
              return yield* Effect.fail<ToolRuntimeError>(
                operationalFailure(
                  stage,
                  String(invocationId),
                )({
                  _tag: "ToolObservationEvidenceReplayFenceUnavailable",
                }),
              );
            }
            yield* observationEvidence.value.assertCurrentFence(
              fence,
              yield* clock.now(),
            );
          }
          return yield* store.findById(invocationId);
        }),
      )
      .pipe(
        Effect.mapError((cause) =>
          isLeaseFencingRejected(cause) ||
          (typeof cause === "object" &&
            cause !== null &&
            "_tag" in cause &&
            cause._tag === "ToolRuntimeOperationalFailure")
            ? (cause as ToolRuntimeError)
            : operationalFailure(stage, String(invocationId))(cause),
        ),
      );

  return {
    decodeRecordedEvidence,
    decodeRecordedEvidenceResult,
    findInvocationFenced,
    recordReplayFailure,
    replayFailureCode,
  };
};
