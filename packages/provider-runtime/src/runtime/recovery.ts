import {
  providerRetryCauseFromAttempt,
  type ClockService,
  type ProviderCancellationSignal,
  type ProviderFailure,
  type ProviderFailureKind,
  type ProviderRunInput,
  type ProviderRunResult,
  type ProviderTurnStoreService,
  type RuntimeClockService,
  type TransactionPortService,
  type UnsettledProviderTurn,
} from "@arbor/ports";
import { Effect } from "effect";
import { decideProviderRetry, noAttemptObservation, unknownAttemptObservation } from "../policy.js";
import type { ProviderRuntimeConfig } from "./config.js";
import { completeNativeSuccessEvidence, type CompleteNativeSuccessEvidence } from "./continuation-evidence.js";
import { stoppedRecoveryDecision, unknownFailure } from "./failures.js";

/** Discover a durable prior turn, preserving atomic recovery decisions and native-success settlement. */
export const discoverProviderRecovery = (
  input: ProviderRunInput,
  externalSignal: ProviderCancellationSignal | undefined,
  config: ProviderRuntimeConfig,
  tx: TransactionPortService,
  store: ProviderTurnStoreService,
  clock: ClockService,
  runtimeClock: RuntimeClockService,
  onNativeSuccessStarting: (evidence: CompleteNativeSuccessEvidence) => void,
  onNativeSuccessSettled: () => void,
) =>
  Effect.gen(function* () {
    let recovery = input.recovery;
    let recoveryTurn: UnsettledProviderTurn | null = null;
    if (recovery === undefined) {
      if (externalSignal?.aborted === true) {
        return yield* Effect.interrupt;
      }
      recoveryTurn = yield* tx.transact(
        store.findUnsettledByTurn(input.providerTurnId),
      );
      if (recoveryTurn !== null) {
        const resumeBindingChecks = {
          manifestMatches:
            recoveryTurn.manifestJson === input.manifestJson,
          portableRequestMatches:
            recoveryTurn.portableRequestJson ===
            JSON.stringify(input.request),
          executionMatches:
            recoveryTurn.turn.executionId === input.executionId,
          sessionMatches:
            recoveryTurn.turn.sessionId === input.sessionId,
          epochMatches:
            recoveryTurn.turn.contextEpoch === input.contextEpoch,
          modelMatches: recoveryTurn.turn.modelRef === input.modelRef,
          outputContractMatches:
            recoveryTurn.turn.outputContractRef ===
            input.outputContractRef,
        };
        if (
          Object.values(resumeBindingChecks).some((matches) => !matches)
        ) {
          // A persisted turn is permanently pinned to its original
          // manifest and portable request. A later model/provider
          // configuration must never resume it under a new binding;
          // close this stale Turn so it cannot remain an invisible
          // recovery candidate after its owning execution fails.
          yield* tx.transact(
            store.failTurn(input.providerTurnId, yield* clock.now()),
          );
          return yield* Effect.fail(
            unknownFailure("provider-turn-resume-binding-invalid"),
          );
        }
        if (
          input.request.requestVersion === 2 &&
          input.request.operationKind === "CompactionNative"
        ) {
          const successEvidence = completeNativeSuccessEvidence(
            recoveryTurn,
            input,
            config.continuationBinding,
          );
          if (successEvidence !== null) {
            onNativeSuccessStarting(successEvidence);
            const settledAt = yield* clock.now();
            yield* tx.transact(
              store.settleSuccessAtomically(
                input.providerTurnId,
                successEvidence.attemptNo,
                {
                  outcome: "Success",
                  taxonomyVersion: "phase1-v2",
                  observation: successEvidence.observation,
                  canonicalEventPrefixJson:
                    successEvidence.canonicalEventPrefixJson,
                  deliveredPosition: successEvidence.deliveredPosition,
                },
                successEvidence.finishReason,
                successEvidence.usageJson,
                settledAt,
                "provider-success-v1",
              ),
            );
            onNativeSuccessSettled();
            return {
              _tag: "Recovered" as const,
              result: {
                events: successEvidence.events,
                attemptNo: successEvidence.attemptNo,
                retryDecisions: [],
              } satisfies ProviderRunResult,
            };
          }
        }
        const last = recoveryTurn.attempts.at(-1) ?? null;
        const cause = providerRetryCauseFromAttempt(last);
        const observation =
          last === null
            ? noAttemptObservation()
            : (last.observation ?? unknownAttemptObservation());
        const persistedPolicy = recoveryTurn.turn.executionPolicy;
        const persistedDeadline =
          recoveryTurn.turn.turnDeadlineAt ?? null;
        const deadlineAtMs =
          persistedDeadline === null
            ? Number.NaN
            : Date.parse(persistedDeadline);
        const retryDecision =
          persistedPolicy === undefined ||
          !Number.isFinite(deadlineAtMs)
            ? stoppedRecoveryDecision(
                "persisted attempt evidence or execution limits are incomplete",
              )
            : decideProviderRetry({
                cause,
                observation,
                continuationCheckpoint:
                  last?.continuationCheckpoint ?? null,
                attemptNo: last?.attemptNo ?? -1,
                maxAttempts: persistedPolicy.maxAttempts,
                cancelled: last?.outcome === "Cancelled",
                deadlineExpired:
                  deadlineAtMs <= runtimeClock.epochMillis(),
              });
        const decidedAt = yield* clock.now();
        const recordDecision = () =>
          store.recordRecoveryDecision(input.providerTurnId, {
            attemptNo: last?.attemptNo ?? -1,
            cause,
            retryDecision,
            decidedAt,
          });
        const settleLostAttempt = (
          outcome: "RetryableFailure" | "TerminalFailure",
        ) =>
          last?.outcome !== "InProgress"
            ? Effect.void
            : store.settleAttempt(
                input.providerTurnId,
                last.attemptNo,
                {
                  outcome,
                  taxonomyVersion: "phase1-v2",
                  observation:
                    last.observation ?? unknownAttemptObservation(),
                  canonicalEventPrefixJson:
                    last.canonicalEventPrefixJson ?? "[]",
                  deliveredPosition: last.deliveredPosition ?? 0,
                  ...(last.continuationCheckpoint === null ||
                  last.continuationCheckpoint === undefined
                    ? {}
                    : {
                        continuationCheckpoint:
                          last.continuationCheckpoint,
                      }),
                  retryDecision,
                },
                decidedAt,
              );

        if (retryDecision.decision === "Stop") {
          yield* tx.transact(
            Effect.gen(function* () {
              yield* recordDecision();
              yield* settleLostAttempt("TerminalFailure");
              yield* store.failTurn(input.providerTurnId, decidedAt);
            }),
          );
          const kind = last?.providerErrorKind;
          return yield* Effect.fail<ProviderFailure>(
            kind === null || kind === undefined
              ? unknownFailure("provider-turn-recovery-stopped")
              : {
                  _tag: "ProviderFailure",
                  kind: kind as ProviderFailureKind,
                  ...(last?.taxonomyVersion === undefined
                    ? {}
                    : { taxonomyVersion: last.taxonomyVersion }),
                  safeDiagnostic: "provider-turn-recovery-stopped",
                },
          );
        }

        yield* tx.transact(
          Effect.gen(function* () {
            yield* recordDecision();
            yield* settleLostAttempt("RetryableFailure");
          }),
        );
        recovery = {
          manifestId: recoveryTurn.turn.manifestId,
          nextAttemptNo: last === null ? 0 : last.attemptNo + 1,
          retryDecision,
          ...(retryDecision.strategy === "Resume" &&
          last?.continuationCheckpoint !== null &&
          last?.continuationCheckpoint !== undefined
            ? { continuationCheckpoint: last.continuationCheckpoint }
            : {}),
        };
      }
    }
    return { _tag: "Ready" as const, recovery, recoveryTurn };
  });
