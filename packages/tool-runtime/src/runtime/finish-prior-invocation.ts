import { ArtifactId, parse } from "@arbor/domain";
import type {
  ArtifactServiceService,
  CanonicalToolObservation,
  ClockService,
  ToolExecutionContext,
  ToolIntent,
  ToolInvocationRecord,
  ToolInvocationStoreService,
  ToolObservationEvidenceStoreService,
  ToolRuntimeError,
  TransactionPortService,
} from "@arbor/ports";
import { Effect, Option } from "effect";
import { bounded, denied, isLeaseFencingRejected, operationalFailure } from "./errors.js";
import type { makeObservationReplay } from "./observation-replay.js";
import type { ToolExecutionResult, ToolRuntimeQualificationProbe } from "./types.js";

type Replay = ReturnType<typeof makeObservationReplay>;

/** Replay a terminal invocation or stop an unsafe ambiguous replay. */
export const finishPriorInvocation = (
  intent: ToolIntent,
  context: ToolExecutionContext,
  recorded: ToolInvocationRecord,
  recoveredToolOutcome: ToolExecutionResult | undefined,
  retryAdmitted: boolean,
  options: { readonly qualificationProbe?: ToolRuntimeQualificationProbe },
  tx: TransactionPortService,
  clock: ClockService,
  store: ToolInvocationStoreService,
  observationEvidence: Option.Option<ToolObservationEvidenceStoreService>,
  artifactService: Option.Option<ArtifactServiceService>,
  decodeRecordedEvidence: Replay["decodeRecordedEvidence"],
  resolveReplaySandboxPolicy: Parameters<Replay["decodeRecordedEvidence"]>[3],
): Effect.Effect<CanonicalToolObservation | undefined, ToolRuntimeError> =>
  Effect.gen(function* () {
    if (recorded.settlement !== null) {
      if (recorded.settlement._tag === "Denied") {
        return denied(recorded.settlement.reasonCode);
      }
      if (
        recorded.settlement._tag === "Interrupted" &&
        Option.isNone(observationEvidence)
      ) {
        return { _tag: "Interrupted" as const };
      }
      if (Option.isSome(observationEvidence)) {
        return yield* decodeRecordedEvidence(
          intent,
          context,
          recorded,
          resolveReplaySandboxPolicy,
        );
      }
      if (
        recorded.settlement._tag === "Success" &&
        recorded.resultRef !== null &&
        Option.isSome(artifactService)
      ) {
        let artifactId: ArtifactId;
        try {
          artifactId = parse(ArtifactId)(recorded.resultRef);
        } catch {
          return {
            _tag: "OutcomeUnknown" as const,
            reconciliationRefs: [String(intent.invocationId)],
          };
        }
        const bytes = yield* tx
          .transact(artifactService.value.load(artifactId))
          .pipe(
            Effect.mapError(
              operationalFailure(
                "SettlementJournal",
                String(intent.invocationId),
              ),
            ),
          );
        if (Option.isSome(bytes)) {
          return {
            _tag: "Success" as const,
            observation: bounded(new TextDecoder().decode(bytes.value)),
            resultRef: recorded.resultRef,
          };
        }
      }
      return {
        _tag: "OutcomeUnknown" as const,
        reconciliationRefs: [String(intent.invocationId)],
      };
    }
    if (
      recorded.effectAdmissionState !== "NotAdmitted" &&
      recoveredToolOutcome === undefined &&
      !retryAdmitted &&
      (recorded.sideEffectSemantics === "NonIdempotent" ||
        recorded.sideEffectSemantics === "Reconcilable")
    ) {
      const reconciliationRefs = [String(intent.invocationId)];
      if (recorded.sideEffectSemantics === "NonIdempotent") {
        const settledAt = yield* clock.now();
        const unknownWrite = yield* Effect.match(
          tx.transact(
            Effect.gen(function* () {
              const unknownSettlement = {
                _tag: "OutcomeUnknown" as const,
                reconciliationRefs,
              };
              const applied = Option.isSome(observationEvidence)
                ? (yield* observationEvidence.value.settleOrReadWinner({
                    invocation: recorded,
                    settlement: unknownSettlement,
                    resultRef: null,
                    observation: unknownSettlement,
                    settledAt,
                    executionFence: context.executionFence,
                    fenceNow: yield* clock.now(),
                  }))._tag === "Applied"
                : yield* store.settle(
                    intent.invocationId,
                    unknownSettlement,
                    null,
                    settledAt,
                    context.executionFence,
                    yield* clock.now(),
                  );
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
        if (!unknownWrite.ok) {
          if (
            isLeaseFencingRejected(unknownWrite.cause) &&
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
            isLeaseFencingRejected(unknownWrite.cause)
              ? unknownWrite.cause
              : operationalFailure(
                  "SettlementJournal",
                  String(intent.invocationId),
                )(unknownWrite.cause),
          );
        }
        if (!unknownWrite.value.applied) {
          const canonical = unknownWrite.value.current;
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
        }
      }
      return {
        _tag: "OutcomeUnknown" as const,
        reconciliationRefs,
      };
    }
    if (recorded.effectAdmissionState === "LegacyUnknown") {
      return {
        _tag: "OutcomeUnknown" as const,
        reconciliationRefs: [String(intent.invocationId)],
      };
    }
    return undefined;
  });
