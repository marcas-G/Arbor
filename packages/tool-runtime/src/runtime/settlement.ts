import type {
  ArtifactServiceService,
  CanonicalToolObservation,
  ClockService,
  P39RecoveryEvidenceStoreService,
  SelectedP39RecoveryEvidence,
  ToolExecutionContext,
  ToolIntent,
  ToolInvocationStoreService,
  ToolObservationEvidenceStoreService,
  ToolRuntimeError,
  TransactionPortService,
} from "@arbor/ports";
import { Effect, Option } from "effect";
import { matchesAuthenticatedP39Evidence } from "../recovery-binding.js";
import { denied, isLeaseFencingRejected, operationalFailure } from "./errors.js";
import type { makeObservationReplay } from "./recovery/observation-replay.js";
import type {
  PendingReconciliation,
  ToolExecutionResult,
  ToolExecutor,
  ToolRuntimeQualificationProbe,
} from "./types.js";

type Replay = ReturnType<typeof makeObservationReplay>;

/** Own terminal observation selection and persistence, including the P40 winner transaction. */
export const settleToolOutcome = (
  intent: ToolIntent,
  context: ToolExecutionContext,
  executor: ToolExecutor,
  outcome: ToolExecutionResult,
  recoveredToolOutcome: ToolExecutionResult | undefined,
  pendingReconciliation: PendingReconciliation | undefined,
  now: string,
  options: { readonly qualificationProbe?: ToolRuntimeQualificationProbe },
  tx: TransactionPortService,
  clock: ClockService,
  store: ToolInvocationStoreService,
  p39RecoveryEvidence: Option.Option<P39RecoveryEvidenceStoreService>,
  observationEvidence: Option.Option<ToolObservationEvidenceStoreService>,
  artifactService: Option.Option<ArtifactServiceService>,
  findInvocationFenced: Replay["findInvocationFenced"],
  recordReplayFailure: Replay["recordReplayFailure"],
  replayFailureCode: Replay["replayFailureCode"],
): Effect.Effect<CanonicalToolObservation, ToolRuntimeError> =>
  Effect.gen(function* () {
    if (
      options.qualificationProbe !== undefined &&
      recoveredToolOutcome === undefined &&
      outcome.sandboxProviderUnavailable === undefined
    ) {
      yield* Effect.promise(
        () =>
          options.qualificationProbe?.({
            boundary: "AH7AfterToolEffectBeforeSettlement",
            executionId: context.executionId,
            invocationId: intent.invocationId,
            callRef: intent.callRef,
          }) ?? Promise.resolve(),
      );
    }

    let authenticatedRecoveryEvidence:
      | SelectedP39RecoveryEvidence
      | undefined;
    if (outcome.settlement._tag === "ReconciledNoEffect") {
      const rejectUnverifiedSelection = (
        cause: unknown,
      ): Effect.Effect<never, ToolRuntimeError> =>
        Effect.fail({
          _tag: "ToolRuntimeOperationalFailure",
          stage: "SettlementJournal",
          effectDisposition: "OutcomeUncertain",
          invocationRef: String(intent.invocationId),
          cause: {
            _tag: "P40AuthenticatedRecoveryEvidenceUnavailable",
            cause,
          },
        });
      if (Option.isNone(p39RecoveryEvidence)) {
        return yield* rejectUnverifiedSelection({
          _tag: "P39RecoveryEvidenceStoreUnavailable",
        });
      }
      if (
        pendingReconciliation !== undefined &&
        pendingReconciliation.result._tag === "NotOccurred" &&
        outcome.settlement.reconciliationFactRef ===
          pendingReconciliation.selection.factId
      ) {
        // This invocation just recorded the exact RecoveryInput fact.
        // The P4 winner transaction validates the fact/binding/attempt
        // tuple and selects it atomically with the terminal Observation;
        // findSelected is intentionally reserved for replay of an
        // already-selected terminal winner.
      } else {
        const selectedRead = yield* Effect.match(
          tx.transact(
            p39RecoveryEvidence.value.findSelected(intent.invocationId),
          ),
          {
            onFailure: (cause) => ({ ok: false as const, cause }),
            onSuccess: (value) => ({ ok: true as const, value }),
          },
        );
        if (!selectedRead.ok) {
          return yield* rejectUnverifiedSelection(selectedRead.cause);
        }
        if (Option.isNone(selectedRead.value)) {
          return yield* rejectUnverifiedSelection({
            _tag: "P39SelectedRecoveryEvidenceMissing",
          });
        }
        const selected = selectedRead.value.value;
        if (
          !matchesAuthenticatedP39Evidence({
            selected,
            intent,
            context,
            factId: outcome.settlement.reconciliationFactRef,
          })
        ) {
          return yield* rejectUnverifiedSelection({
            _tag: "P39SelectedRecoveryEvidenceMismatch",
          });
        }
        authenticatedRecoveryEvidence = selected;
      }
    }

    let resultRef = outcome.resultRef;
    if (
      Option.isNone(observationEvidence) &&
      outcome.settlement._tag === "ReconciledNoEffect"
    ) {
      return yield* Effect.fail<ToolRuntimeError>(
        operationalFailure(
          "SettlementJournal",
          String(intent.invocationId),
        )({
          _tag: "P40ObservationEvidenceStoreUnavailable",
        }),
      );
    }
    if (
      Option.isNone(observationEvidence) &&
      outcome.settlement._tag === "Success" &&
      resultRef === null &&
      Option.isSome(artifactService)
    ) {
      resultRef = String(
        (yield* tx
          .transact(
            artifactService.value.store(
              new TextEncoder().encode(outcome.observation.text),
              `tool-result:${intent.toolName}`,
              {
                invocationId: intent.invocationId,
                executionId: context.executionId,
              },
              now,
            ),
          )
          .pipe(
            Effect.mapError(
              operationalFailure(
                "SettlementJournal",
                String(intent.invocationId),
              ),
            ),
          )).artifactId,
      );
    }

    const settledAt = yield* clock.now();
    if (options.qualificationProbe !== undefined) {
      yield* Effect.promise(
        () =>
          options.qualificationProbe?.({
            boundary: "AH7BeforeToolSettlementTransaction",
            executionId: context.executionId,
            invocationId: intent.invocationId,
            callRef: intent.callRef,
          }) ?? Promise.resolve(),
      );
    }
    if (
      Option.isSome(observationEvidence) &&
      outcome.settlement._tag !== "Denied"
    ) {
      if (context.executionFence === undefined) {
        return yield* Effect.fail<ToolRuntimeError>(
          operationalFailure(
            "SettlementJournal",
            String(intent.invocationId),
          )({
            _tag: "P40ObservationEvidenceFenceUnavailable",
          }),
        );
      }
      const p4Intent = yield* findInvocationFenced(
        intent.invocationId,
        context,
        "SettlementJournal",
      );
      if (Option.isNone(p4Intent)) {
        return yield* Effect.fail<ToolRuntimeError>(
          operationalFailure(
            "SettlementJournal",
            String(intent.invocationId),
          )({
            _tag: "P4IntentMissingAtObservationSettlement",
          }),
        );
      }
      const record = p4Intent.value;
      const invocation = {
        invocationId: record.invocationId,
        executionId: record.executionId,
        workspaceId: record.workspaceId,
        toolName: record.toolName,
        toolVersion: record.toolVersion,
        sideEffectSemantics: record.sideEffectSemantics,
        argumentsJson: record.argumentsJson,
        resolvedRegions: record.resolvedRegions,
        approvalId: record.approvalId,
        intentAt: record.intentAt,
      } as const;
      const candidateObservation: CanonicalToolObservation = (() => {
        switch (outcome.settlement._tag) {
          case "Success":
            return {
              _tag: "Success",
              observation: outcome.observation,
              resultRef,
            };
          case "ExpectedFailure":
            return {
              _tag: "ExpectedFailure",
              observation: outcome.observation,
              ...(outcome.sandboxProviderUnavailable === undefined
                ? {}
                : {
                    sandboxProviderUnavailable: {
                      policyRevision:
                        outcome.sandboxProviderUnavailable.policyRevision,
                      policyDigest:
                        outcome.sandboxProviderUnavailable.policyDigest,
                      profile:
                        outcome.sandboxProviderUnavailable.profileId,
                      providerId:
                        outcome.sandboxProviderUnavailable.providerId,
                      providerVersion:
                        outcome.sandboxProviderUnavailable
                          .providerVersion,
                      capabilityRevision:
                        outcome.sandboxProviderUnavailable
                          .capabilityRevision,
                      probeEvidenceRef:
                        outcome.sandboxProviderUnavailable
                          .probeEvidenceRef,
                      failureCode:
                        outcome.sandboxProviderUnavailable.failureCode,
                      effectDisposition: "NoEffect" as const,
                    },
                  }),
            };
          case "Interrupted":
            return { _tag: "Interrupted" };
          case "OutcomeUnknown":
            return {
              _tag: "OutcomeUnknown",
              reconciliationRefs: outcome.settlement.reconciliationRefs,
            };
          case "RuntimeFailure":
            return {
              _tag: "RuntimeFailure",
              cause: outcome.settlement.cause,
            };
          case "ReconciledNoEffect":
            return {
              _tag: "ReconciledNoEffect",
              reasonCode: outcome.settlement.reasonCode,
              reconciliationFactRef:
                outcome.settlement.reconciliationFactRef,
              observation: outcome.observation,
              resultRef: resultRef ?? "",
            };
        }
      })();
      const candidate = {
        invocation,
        settlement: outcome.settlement,
        resultRef,
        observation: candidateObservation,
        ...(authenticatedRecoveryEvidence === undefined
          ? {}
          : {
              reconciliationSelection: {
                attemptNo:
                  authenticatedRecoveryEvidence.attempt.attemptNo,
                factId: authenticatedRecoveryEvidence.fact.factId,
              },
              authenticatedRecoveryEvidence,
            }),
        ...(pendingReconciliation === undefined
          ? {}
          : {
              reconciliationSelection: pendingReconciliation.selection,
            }),
        ...(Option.isSome(artifactService) && resultRef === null
          ? {
              materializeResultRef: () =>
                artifactService.value
                  .store(
                    new TextEncoder().encode(outcome.observation.text),
                    `tool-result:${intent.toolName}`,
                    {
                      invocationId: intent.invocationId,
                      executionId: context.executionId,
                    },
                    now,
                  )
                  .pipe(
                    Effect.map((artifact) => String(artifact.artifactId)),
                  ),
            }
          : {}),
        settledAt,
        executionFence: context.executionFence,
        fenceNow: yield* clock.now(),
      } as const;
      const p40Write = yield* Effect.match(
        tx.transact(
          Effect.gen(function* () {
            const result =
              yield* observationEvidence.value.settleOrReadWinner(
                candidate,
              );
            if (
              result._tag === "Applied" &&
              options.qualificationProbe !== undefined
            ) {
              yield* Effect.promise(
                () =>
                  options.qualificationProbe?.({
                    boundary: "AH7BeforeToolSettlementCommit",
                    executionId: context.executionId,
                    invocationId: intent.invocationId,
                    callRef: intent.callRef,
                  }) ?? Promise.resolve(),
              );
            }
            return result;
          }),
        ),
        {
          onFailure: (cause) => ({ ok: false as const, cause }),
          onSuccess: (value) => ({ ok: true as const, value }),
        },
      );
      if (!p40Write.ok) {
        if (isLeaseFencingRejected(p40Write.cause)) {
          return yield* Effect.fail<ToolRuntimeError>(p40Write.cause);
        }
        const failureCode = replayFailureCode(p40Write.cause);
        if (failureCode !== undefined) {
          const afterFailure = yield* findInvocationFenced(
            intent.invocationId,
            context,
            "SettlementJournal",
          );
          if (
            (Option.isSome(afterFailure) &&
              afterFailure.value.settlement !== null) ||
            record.settledAt !== null
          ) {
            return yield* recordReplayFailure(
              intent,
              context,
              failureCode,
              yield* clock.now(),
            );
          }
        }
        return yield* Effect.fail<ToolRuntimeError>(
          operationalFailure(
            "SettlementJournal",
            String(intent.invocationId),
          )(p40Write.cause),
        );
      }
      if (
        p40Write.value._tag === "Applied" &&
        options.qualificationProbe !== undefined
      ) {
        yield* Effect.promise(
          () =>
            options.qualificationProbe?.({
              boundary: "AH7AfterToolSettlementCommit",
              executionId: context.executionId,
              invocationId: intent.invocationId,
              callRef: intent.callRef,
            }) ?? Promise.resolve(),
        );
      }
      if (p40Write.value._tag === "ExistingDenied") {
        return denied(p40Write.value.reasonCode);
      }
      return p40Write.value.evidence
        .observation as CanonicalToolObservation;
    }
    const settlementWrite = yield* Effect.match(
      tx.transact(
        Effect.gen(function* () {
          const fenceNow = yield* clock.now();
          const applied = yield* store.settle(
            intent.invocationId,
            outcome.settlement,
            resultRef,
            settledAt,
            context.executionFence,
            fenceNow,
          );
          if (applied && options.qualificationProbe !== undefined) {
            yield* Effect.promise(
              () =>
                options.qualificationProbe?.({
                  boundary: "AH7BeforeToolSettlementCommit",
                  executionId: context.executionId,
                  invocationId: intent.invocationId,
                  callRef: intent.callRef,
                }) ?? Promise.resolve(),
            );
          }
          return {
            applied,
            current: applied
              ? Option.none()
              : yield* store.findById(intent.invocationId),
          };
        }),
      ),
      {
        onFailure: (cause) => ({ ok: false as const, cause }),
        onSuccess: (value) => ({ ok: true as const, value }),
      },
    );
    if (!settlementWrite.ok) {
      if (
        isLeaseFencingRejected(settlementWrite.cause) &&
        options.qualificationProbe !== undefined
      ) {
        yield* Effect.promise(
          () =>
            options.qualificationProbe?.({
              boundary: "AH7ToolSettlementFenceRejected",
              executionId: context.executionId,
              invocationId: intent.invocationId,
              callRef: intent.callRef,
            }) ?? Promise.resolve(),
        );
      }
      return yield* Effect.fail<ToolRuntimeError>(
        isLeaseFencingRejected(settlementWrite.cause)
          ? settlementWrite.cause
          : operationalFailure(
              "SettlementJournal",
              String(intent.invocationId),
            )(settlementWrite.cause),
      );
    }
    if (!settlementWrite.value.applied) {
      const canonical = settlementWrite.value.current;
      if (
        Option.isSome(canonical) &&
        canonical.value.settlement?._tag === "OutcomeUnknown"
      ) {
        return {
          _tag: "OutcomeUnknown" as const,
          reconciliationRefs:
            canonical.value.settlement.reconciliationRefs,
        };
      }
      return yield* Effect.fail<ToolRuntimeError>(
        operationalFailure(
          "SettlementJournal",
          String(intent.invocationId),
        )({
          _tag: "ToolInvocationSettlementNotApplied",
          canonicalSettlement: Option.isSome(canonical)
            ? (canonical.value.settlement?._tag ?? "Unsettled")
            : "Missing",
        }),
      );
    }
    if (options.qualificationProbe !== undefined) {
      yield* Effect.promise(
        () =>
          options.qualificationProbe?.({
            boundary: "AH7AfterToolSettlementCommit",
            executionId: context.executionId,
            invocationId: intent.invocationId,
            callRef: intent.callRef,
          }) ?? Promise.resolve(),
      );
    }

    if (
      executor.processCapability === "SandboxProcess" &&
      outcome.sandboxProviderUnavailable !== undefined
    ) {
      return outcome.sandboxProviderUnavailable;
    }

    const observation: CanonicalToolObservation = (() => {
      switch (outcome.settlement._tag) {
        case "Success":
          return {
            _tag: "Success",
            observation: outcome.observation,
            resultRef,
          };
        case "ExpectedFailure":
          return {
            _tag: "ExpectedFailure",
            observation: outcome.observation,
          };
        case "Denied":
          return denied(outcome.settlement.reasonCode);
        case "Interrupted":
          return { _tag: "Interrupted" };
        case "OutcomeUnknown":
          return {
            _tag: "OutcomeUnknown",
            reconciliationRefs: outcome.settlement.reconciliationRefs,
          };
        case "RuntimeFailure":
          return {
            _tag: "RuntimeFailure",
            cause: outcome.settlement.cause,
          };
        case "ReconciledNoEffect":
          return {
            _tag: "ReconciledNoEffect",
            reasonCode: outcome.settlement.reasonCode,
            reconciliationFactRef:
              outcome.settlement.reconciliationFactRef,
            observation: outcome.observation,
            resultRef: resultRef ?? "",
          };
      }
    })();
    return observation;
  });
