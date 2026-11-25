import { type ExecutionSettlement, executionEpisode } from "@arbor/domain";
import { decodeTurn, type TurnPreparation } from "@arbor/model-context";
import type { AgentLoopStepRecord, ExecutionDriverError } from "@arbor/ports";
import {
  canonicalizeLegacyAdoptionEvidenceV1,
  LEGACY_ADOPTION_MISSING,
  RecoveryAttentionFactStore,
  sha256Hex,
} from "@arbor/ports";
import { Effect, Option } from "effect";
import type { ModelDecisionOutcome } from "../../agent-loop-policy.js";
import type { ModelDecisionDependencies } from "../contract.js";

type ReplayDependencies = Pick<
  ModelDecisionDependencies,
  | "input"
  | "tx"
  | "loopSteps"
  | "loopStepFence"
  | "providerTurns"
  | "options"
  | "failure"
  | "now"
>;

type ReplayResult =
  | ModelDecisionOutcome
  | {
      readonly _tag: "Proceed";
      readonly loopStep: AgentLoopStepRecord | undefined;
    };

/** Resolve durable Provider evidence before admitting any new call. Legacy
 * adoption and the corresponding Step transition retain their transaction. */
export const replayPreparedProviderTurn = (
  dependencies: ReplayDependencies,
  phase: {
    readonly loopStep: AgentLoopStepRecord | undefined;
    readonly preparation: Extract<TurnPreparation, { readonly _tag: "Ready" }>;
    readonly conversationExecution: boolean;
    readonly replayPersistedContextLimit: boolean;
  },
): Effect.Effect<
  ReplayResult,
  ExecutionDriverError,
  RecoveryAttentionFactStore
> => {
  const {
    input,
    tx,
    loopSteps,
    loopStepFence,
    providerTurns,
    options,
    failure,
    now,
  } = dependencies;
  const { preparation, conversationExecution, replayPersistedContextLimit } =
    phase;
  return Effect.gen(function* () {
    let loopStep = phase.loopStep;
    if (
      loopStep !== undefined &&
      loopSteps !== undefined &&
      loopStepFence !== undefined &&
      providerTurns !== undefined &&
      loopStep.state !== "OutputRejected"
    ) {
      const durableLoopSteps = loopSteps;
      const durableFence = loopStepFence;
      const settled = yield* tx
        .transact(
          providerTurns.findSettledResult(
            preparation.turn.manifest.providerTurnId,
          ),
        )
        .pipe(Effect.mapError(failure));
      if (settled._tag === "SettledSuccess") {
        let persistedManifest: typeof preparation.turn.manifest;
        try {
          persistedManifest = JSON.parse(
            settled.manifestJson,
          ) as typeof preparation.turn.manifest;
        } catch {
          return yield* Effect.fail(
            failure({
              _tag: "AgentLoopStepReplayManifestInvalid",
            }),
          );
        }
        if (
          settled.turn.executionId !== input.execution.executionId ||
          settled.turn.sessionId !== input.execution.sessionId ||
          settled.turn.contextEpoch !==
            preparation.turn.manifest.contextEpoch ||
          persistedManifest.providerTurnId !== settled.turn.providerTurnId ||
          persistedManifest.executionId !== settled.turn.executionId ||
          persistedManifest.sessionId !== settled.turn.sessionId ||
          persistedManifest.contextEpoch !== settled.turn.contextEpoch ||
          persistedManifest.modelRef !== settled.turn.modelRef ||
          persistedManifest.outputContractRef !== settled.turn.outputContractRef
        ) {
          return yield* Effect.fail(
            failure({
              _tag: "AgentLoopStepReplayBindingMismatch",
            }),
          );
        }
        const decoded = decodeTurn(settled.canonicalEvents);
        if (settled.evidenceVersion === "legacy-success-v1" && !decoded.ok) {
          return yield* Effect.fail(
            failure({
              _tag: "LegacyProviderResultRequiresAttention",
              reason: decoded.reason,
            }),
          );
        }
        if (
          settled.evidenceVersion === "legacy-success-v1" &&
          decoded.ok &&
          decoded.output.toolInvocations.length > 0 &&
          loopStep.state === "Prepared"
        ) {
          const episode = executionEpisode(input.execution);
          // E05 sink: acquired from the environment; production-required
          // since the E06 normalization.
          const recoveryStore = yield* RecoveryAttentionFactStore;
          const recordLegacyAdoptionFailure =
            recoveryStore.recordLegacyAdoptionFailure;
          const resolveLegacyAdoptionFailure =
            recoveryStore.resolveLegacyAdoptionFailure;
          if (
            loopStepFence === undefined ||
            recordLegacyAdoptionFailure === undefined ||
            resolveLegacyAdoptionFailure === undefined ||
            episode === undefined ||
            settled.settledAt === undefined ||
            settled.settledAt.length === 0
          ) {
            return yield* Effect.fail(
              failure({
                _tag: "LegacyProviderResultRequiresAttention",
                reason: "legacy action disposition cannot be safely inspected",
              }),
            );
          }
          const actionEvidence = [];
          for (const [
            actionIndex,
            invocation,
          ] of decoded.output.toolInvocations.entries()) {
            const matches = persistedManifest.toolRoutes.filter(
              (route) => route.name === invocation.toolName,
            );
            const route = matches[0];
            if (
              matches.length !== 1 ||
              route === undefined ||
              typeof route.version !== "string" ||
              route.version.length === 0
            ) {
              return yield* Effect.fail(
                failure({
                  _tag: "LegacyProviderResultRequiresAttention",
                  reason: "legacy action route identity is not uniquely bound",
                }),
              );
            }
            const logicalActionId = `lac_${sha256Hex(
              JSON.stringify({
                executionId: input.execution.executionId,
                providerTurnId: settled.turn.providerTurnId,
                callRef: invocation.callRef,
                routeKind: route.route,
                actionKind: invocation.toolName,
              }),
            )}`;
            actionEvidence.push({
              actionIndex,
              logicalActionId,
              callRef: invocation.callRef,
              toolName: invocation.toolName,
              toolSchemaVersion: route.version,
              inputHash: sha256Hex(invocation.argumentsJson),
              stableActionId:
                typeof route.stableId === "string"
                  ? route.stableId
                  : LEGACY_ADOPTION_MISSING,
              actionVersion: route.version,
              argumentsSha256: sha256Hex(invocation.argumentsJson),
              // A P9 action row alone is not P4 disposition evidence. The
              // explicit marker lets a later exact P4 proof resolve this
              // original fingerprint without guessing at restart.
              disposition: LEGACY_ADOPTION_MISSING,
            });
          }
          const episodeEvidence = (() => {
            switch (episode._tag) {
              case "WorkEpisode":
                return {
                  kind: episode._tag,
                  ref: episode.workId,
                  revision: episode.targetWorkRevision,
                };
              case "ConversationResponseEpisode":
                return {
                  kind: episode._tag,
                  ref: episode.messageId,
                  revision: episode.responseJobRevision,
                };
              case "InboxEpisode":
                return {
                  kind: episode._tag,
                  ref: episode.entryKey,
                  revision: 0,
                };
              case "DecisionEpisode":
                return {
                  kind: episode._tag,
                  ref: episode.decisionId,
                  revision: episode.requestRevision,
                };
            }
          })();
          let canonicalEventsSha256: string;
          try {
            canonicalEventsSha256 = sha256Hex(
              canonicalizeLegacyAdoptionEvidenceV1(settled.canonicalEvents),
            );
          } catch {
            return yield* Effect.fail(
              failure({
                _tag: "LegacyProviderResultRequiresAttention",
                reason:
                  "legacy canonical Provider evidence cannot be fingerprinted",
              }),
            );
          }
          const evidence = {
            version: 1 as const,
            executionId: input.execution.executionId,
            projectId: input.execution.projectId,
            workspaceId: input.execution.workspaceId,
            episode: episodeEvidence,
            step: {
              logicalStepNo: loopStep.identity.logicalStepNo,
              repairAttempt: loopStep.identity.repairAttempt,
              providerTurnId: settled.turn.providerTurnId,
              manifestId: settled.manifestId,
              decoderVersion: "decode-turn-v1",
            },
            providerSuccess: {
              attemptNo: settled.attemptNo,
              evidenceVersion: settled.evidenceVersion,
              finishReason: settled.finishReason,
              settledAt: settled.settledAt,
              canonicalEventsSha256,
            },
            actions: actionEvidence,
            failureCode: "LegacyActionDispositionUnproven" as const,
          };
          const preparedLegacyStep = loopStep;
          const resolution = yield* tx
            .transact(
              Effect.gen(function* () {
                const firstDetectedAt = yield* now();
                const resolved = yield* resolveLegacyAdoptionFailure({
                  evidence,
                  fence: loopStepFence,
                  resolvedAt: firstDetectedAt,
                });
                if (Option.isSome(resolved)) {
                  if (options.qualificationProbe !== undefined) {
                    yield* Effect.promise(
                      () =>
                        options.qualificationProbe?.({
                          boundary: "AH14BeforeLegacyAdoptionResolutionCommit",
                          providerTurnId: settled.turn.providerTurnId,
                          executionId: input.execution.executionId,
                          logicalActionId: resolved.value.resolutionFactId,
                        }) ?? Promise.resolve(),
                    );
                  }
                  yield* providerTurns.adoptSettledSuccessEvidence(
                    settled.turn.providerTurnId,
                    settled.attemptNo,
                    "legacy-success-v1",
                    "provider-success-v1",
                  );
                  const adoptedStep = yield* durableLoopSteps.transition(
                    {
                      identity: preparedLegacyStep.identity,
                      expectedRevision: preparedLegacyStep.revision,
                      expectedState: "Prepared",
                      next: {
                        ...preparedLegacyStep,
                        manifestId: settled.manifestId,
                        state: "ProviderResultAvailable",
                        decoderVersion: "decode-turn-v1",
                        migrationProvenance: {
                          _tag: "LegacySettledProviderSuccess",
                          evidenceVersion: settled.evidenceVersion,
                        },
                        revision: preparedLegacyStep.revision + 1,
                        updatedAt: yield* now(),
                      },
                    },
                    durableFence,
                  );
                  return {
                    _tag: "Resolved" as const,
                    fact: resolved.value,
                    step: adoptedStep,
                  };
                }
                const fact = yield* recordLegacyAdoptionFailure({
                  evidence,
                  fence: loopStepFence,
                  firstDetectedAt,
                });
                if (options.qualificationProbe !== undefined) {
                  yield* Effect.promise(
                    () =>
                      options.qualificationProbe?.({
                        boundary: "AH14BeforeLegacyAdoptionAttentionCommit",
                        providerTurnId: settled.turn.providerTurnId,
                        executionId: input.execution.executionId,
                      }) ?? Promise.resolve(),
                  );
                }
                return { _tag: "Blocked" as const, fact };
              }),
            )
            .pipe(Effect.mapError(failure));
          if (resolution._tag === "Blocked") {
            if (options.qualificationProbe !== undefined) {
              yield* Effect.promise(
                () =>
                  options.qualificationProbe?.({
                    boundary: "AH14AfterLegacyAdoptionAttentionCommit",
                    providerTurnId: settled.turn.providerTurnId,
                    executionId: input.execution.executionId,
                    logicalActionId: resolution.fact.attentionFactId,
                  }) ?? Promise.resolve(),
              );
            }
            return { _tag: "RecoveryBlocked" as const };
          }
          loopStep = resolution.step;
          if (options.qualificationProbe !== undefined) {
            yield* Effect.promise(
              () =>
                options.qualificationProbe?.({
                  boundary: "AH14AfterLegacyAdoptionResolutionCommit",
                  providerTurnId: settled.turn.providerTurnId,
                  executionId: input.execution.executionId,
                  logicalActionId: resolution.fact.resolutionFactId,
                }) ?? Promise.resolve(),
            );
          }
        }
        if (loopStep.state === "Prepared") {
          const preparedStep = loopStep;
          if (
            settled.evidenceVersion === "legacy-success-v1" &&
            options.qualificationProbe !== undefined
          ) {
            yield* Effect.promise(
              () =>
                options.qualificationProbe?.({
                  boundary: "AH14BeforeLegacyAdoptionCommit",
                  providerTurnId: settled.turn.providerTurnId,
                  executionId: input.execution.executionId,
                }) ?? Promise.resolve(),
            );
          }
          loopStep = yield* tx
            .transact(
              Effect.gen(function* () {
                if (settled.evidenceVersion === "legacy-success-v1") {
                  yield* providerTurns.adoptSettledSuccessEvidence(
                    settled.turn.providerTurnId,
                    settled.attemptNo,
                    "legacy-success-v1",
                    "provider-success-v1",
                  );
                }
                return yield* durableLoopSteps.transition(
                  {
                    identity: preparedStep.identity,
                    expectedRevision: preparedStep.revision,
                    expectedState: "Prepared",
                    next: {
                      ...preparedStep,
                      manifestId: settled.manifestId,
                      state: "ProviderResultAvailable",
                      decoderVersion: "decode-turn-v1",
                      ...(settled.evidenceVersion === "legacy-success-v1"
                        ? {
                            migrationProvenance: {
                              _tag: "LegacySettledProviderSuccess",
                              evidenceVersion: settled.evidenceVersion,
                            },
                          }
                        : {}),
                      revision: preparedStep.revision + 1,
                      updatedAt: yield* now(),
                    },
                  },
                  durableFence,
                );
              }),
            )
            .pipe(Effect.mapError(failure));
          if (
            settled.evidenceVersion === "legacy-success-v1" &&
            options.qualificationProbe !== undefined
          ) {
            yield* Effect.promise(
              () =>
                options.qualificationProbe?.({
                  boundary: "AH14AfterLegacyAdoptionCommit",
                  providerTurnId: settled.turn.providerTurnId,
                  executionId: input.execution.executionId,
                }) ?? Promise.resolve(),
            );
          }
        }
        if (decoded.ok) {
          return {
            _tag: "Ready" as const,
            turn: {
              ...preparation.turn,
              manifest: persistedManifest,
              toolRoutes: persistedManifest.toolRoutes,
            },
            output: decoded.output,
            loopStep,
            ...(conversationExecution ? { conversation: true } : {}),
          };
        }
      } else if (settled._tag === "SettledFailure") {
        if (
          settled.turn.executionId !== input.execution.executionId ||
          settled.turn.sessionId !== input.execution.sessionId ||
          settled.turn.contextEpoch !== preparation.turn.manifest.contextEpoch
        ) {
          return yield* Effect.fail(
            failure({
              _tag: "AgentLoopStepReplayBindingMismatch",
            }),
          );
        }
        const settlement: ExecutionSettlement =
          settled.finishReason === "Cancelled"
            ? {
                _tag: "Interrupted",
                result: {
                  _tag: "ControlledInterruption",
                  reason: "ProviderTurnSettled:Cancelled",
                },
              }
            : {
                _tag: "Failed",
                failure: {
                  _tag: "ExecutionFailure",
                  reason: `ProviderTurnSettled:${settled.finishReason}`,
                },
              };
        if (
          settled.failureKind === "ContextLimitExceeded" &&
          replayPersistedContextLimit
        ) {
          // The same settled inference failure is fed to the existing
          // ordinal-0 overflow path below; do not terminalize the step.
        } else if (loopStep.state === "Prepared") {
          const failedStep = loopStep;
          yield* tx
            .transact(
              durableLoopSteps.transition(
                {
                  identity: failedStep.identity,
                  expectedRevision: failedStep.revision,
                  expectedState: "Prepared",
                  next: {
                    ...failedStep,
                    state: "SettlementProposed",
                    settlement,
                    revision: failedStep.revision + 1,
                    updatedAt: yield* now(),
                  },
                },
                durableFence,
              ),
            )
            .pipe(Effect.mapError(failure));
        }
        if (!replayPersistedContextLimit) {
          return { _tag: "Settle" as const, settlement };
        }
      } else if (settled._tag === "SettledEvidenceInvalid") {
        return yield* Effect.fail(
          failure({
            _tag: "SettledProviderEvidenceInvalid",
            reason: settled.reason,
          }),
        );
      }
    }
    return { _tag: "Proceed" as const, loopStep };
  });
};
