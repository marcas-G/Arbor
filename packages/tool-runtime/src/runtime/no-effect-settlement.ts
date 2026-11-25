import type { CanonicalResourceRegion } from "@arbor/domain";
import { ArtifactId, parse } from "@arbor/domain";
import type {
  ArtifactServiceService,
  CanonicalToolObservation,
  ClockService,
  NoEffectDenialCode,
  ToolDefinition,
  ToolExecutionContext,
  ToolIntent,
  ToolInvocationIntent,
  ToolInvocationStoreService,
  ToolObservationEvidenceStoreService,
  ToolRuntimeError,
  TransactionPortService,
} from "@arbor/ports";
import { Effect, Option } from "effect";
import { bounded, denied, operationalFailure } from "./errors.js";
import type { makeObservationReplay } from "./recovery/observation-replay.js";
import type { ToolRuntimeQualificationProbe } from "./types.js";

type Replay = ReturnType<typeof makeObservationReplay>;

/** Own no-effect terminal writes and winner reads, preserving the original fences. */
export const makeNoEffectSettlement = (
  intent: ToolIntent,
  context: ToolExecutionContext,
  now: string,
  options: { readonly qualificationProbe?: ToolRuntimeQualificationProbe },
  tx: TransactionPortService,
  clock: ClockService,
  store: ToolInvocationStoreService,
  observationEvidence: Option.Option<ToolObservationEvidenceStoreService>,
  artifactService: Option.Option<ArtifactServiceService>,
  findInvocationFenced: Replay["findInvocationFenced"],
  decodeRecordedEvidence: Replay["decodeRecordedEvidence"],
  resolveReplaySandboxPolicy: Parameters<Replay["decodeRecordedEvidence"]>[3],
) => {
  const persistNoEffectInterruption = (
    invocation: ToolInvocationIntent | undefined,
    settledAt: string,
  ): Effect.Effect<CanonicalToolObservation, ToolRuntimeError> =>
    Effect.gen(function* () {
      const failure = operationalFailure(
        "IntentJournal",
        String(intent.invocationId),
      );
      const current = yield* findInvocationFenced(
        intent.invocationId,
        context,
        "IntentJournal",
      );
      if (Option.isNone(current))
        return { _tag: "Interrupted" as const };
      const currentRecord = current.value;
      if (currentRecord.settlement !== null) {
        if (currentRecord.settlement._tag === "Denied") {
          return denied(currentRecord.settlement.reasonCode);
        }
        if (currentRecord.settlement._tag === "Interrupted") {
          return Option.isSome(observationEvidence)
            ? yield* decodeRecordedEvidence(
                intent,
                context,
                currentRecord,
                resolveReplaySandboxPolicy,
              )
            : { _tag: "Interrupted" as const };
        }
        if (Option.isSome(observationEvidence)) {
          return yield* decodeRecordedEvidence(
            intent,
            context,
            currentRecord,
            resolveReplaySandboxPolicy,
          );
        }
        return {
          _tag: "OutcomeUnknown" as const,
          reconciliationRefs: [String(intent.invocationId)],
        };
      }
      if (currentRecord.effectAdmissionState !== "NotAdmitted") {
        return {
          _tag: "OutcomeUnknown" as const,
          reconciliationRefs: [String(intent.invocationId)],
        };
      }
      if (
        Option.isSome(observationEvidence) &&
        invocation !== undefined
      ) {
        const winner = yield* tx
          .transact(
            observationEvidence.value.settleOrReadWinner({
              invocation,
              settlement: { _tag: "Interrupted" },
              resultRef: null,
              observation: { _tag: "Interrupted" },
              settledAt,
              executionFence: context.executionFence,
              fenceNow: settledAt,
            }),
          )
          .pipe(Effect.mapError(failure));
        if (winner._tag === "Applied") {
          return { _tag: "Interrupted" as const };
        }
        if (winner._tag === "ExistingDenied") {
          return denied(winner.reasonCode);
        }
        const committed = yield* findInvocationFenced(
          intent.invocationId,
          context,
          "IntentJournal",
        );
        if (Option.isSome(committed)) {
          if (committed.value.settlement?._tag === "Denied") {
            return denied(committed.value.settlement.reasonCode);
          }
          if (committed.value.settlement !== null) {
            return yield* decodeRecordedEvidence(
              intent,
              context,
              committed.value,
              resolveReplaySandboxPolicy,
            );
          }
        }
        return yield* Effect.fail<ToolRuntimeError>(
          failure({
            _tag: "NoEffectInterruptionWinnerMissing",
          }),
        );
      }
      const interrupted = yield* tx
        .transact(
          store.recordNoEffectInterruption(
            intent.invocationId,
            settledAt,
            context.executionFence,
            settledAt,
          ),
        )
        .pipe(Effect.mapError(failure));
      if (interrupted) return { _tag: "Interrupted" as const };
      const winner = yield* findInvocationFenced(
        intent.invocationId,
        context,
        "IntentJournal",
      );
      if (Option.isNone(winner))
        return { _tag: "Interrupted" as const };
      if (winner.value.settlement?._tag === "Denied") {
        return denied(winner.value.settlement.reasonCode);
      }
      if (
        winner.value.settlement?._tag === "Interrupted" &&
        Option.isNone(observationEvidence)
      ) {
        return { _tag: "Interrupted" as const };
      }
      if (
        winner.value.settlement !== null &&
        Option.isSome(observationEvidence)
      ) {
        return yield* decodeRecordedEvidence(
          intent,
          context,
          winner.value,
          resolveReplaySandboxPolicy,
        );
      }
      if (winner.value.effectAdmissionState !== "NotAdmitted") {
        return {
          _tag: "OutcomeUnknown" as const,
          reconciliationRefs: [String(intent.invocationId)],
        };
      }
      return { _tag: "Interrupted" as const };
    });
  const recordNoEffectDenial = (
    sideEffectSemantics: ToolDefinition["sideEffectSemantics"],
    resolvedRegions: ReadonlyArray<CanonicalResourceRegion>,
    reasonCode: NoEffectDenialCode,
    nativeProcessModeDenial = false,
  ) =>
    Effect.gen(function* () {
      const settledAt = yield* clock.now();
      const current = yield* findInvocationFenced(
        intent.invocationId,
        context,
        "IntentJournal",
      );
      if (Option.isSome(current)) {
        const record = current.value;
        const exact =
          record.executionId === context.executionId &&
          record.workspaceId === context.workspaceId &&
          record.toolName === intent.toolName &&
          record.toolVersion === intent.toolVersion &&
          record.sideEffectSemantics === sideEffectSemantics &&
          record.argumentsJson === intent.argumentsJson &&
          JSON.stringify(record.resolvedRegions) ===
            JSON.stringify(resolvedRegions) &&
          record.approvalId === intent.approvalId;
        if (exact && record.settlement !== null) {
          if (record.settlement._tag === "Denied") {
            return denied(record.settlement.reasonCode);
          }
          if (
            record.settlement._tag === "Interrupted" &&
            Option.isNone(observationEvidence)
          ) {
            return { _tag: "Interrupted" as const };
          }
          if (Option.isSome(observationEvidence)) {
            return yield* decodeRecordedEvidence(
              intent,
              context,
              record,
              resolveReplaySandboxPolicy,
            );
          }
          if (
            record.settlement._tag === "Success" &&
            record.resultRef !== null &&
            Option.isSome(artifactService)
          ) {
            let artifactId: ArtifactId;
            try {
              artifactId = parse(ArtifactId)(record.resultRef);
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
                observation: bounded(
                  new TextDecoder().decode(bytes.value),
                ),
                resultRef: record.resultRef,
              };
            }
          }
          return {
            _tag: "OutcomeUnknown" as const,
            reconciliationRefs: [String(intent.invocationId)],
          };
        }
        if (exact && record.effectAdmissionState !== "NotAdmitted") {
          return {
            _tag: "OutcomeUnknown" as const,
            reconciliationRefs: [String(intent.invocationId)],
          };
        }
      }
      const recorded = yield* tx
        .transact(
          Effect.gen(function* () {
            const winner = yield* store.recordNoEffectDenial(
              {
                invocationId: intent.invocationId,
                executionId: context.executionId,
                workspaceId: context.workspaceId,
                toolName: intent.toolName,
                toolVersion: intent.toolVersion,
                sideEffectSemantics,
                argumentsJson: intent.argumentsJson,
                resolvedRegions,
                approvalId:
                  context.executableApproval?.approvalId ??
                  intent.approvalId,
                intentAt: Option.isSome(current)
                  ? current.value.intentAt
                  : now,
              },
              reasonCode,
              settledAt,
              context.executionFence,
              settledAt,
              nativeProcessModeDenial
                ? context.recoveryBindingIdentity
                : undefined,
            );
            if (
              nativeProcessModeDenial &&
              winner !== "ExecutionStopping" &&
              options.qualificationProbe !== undefined
            ) {
              yield* Effect.promise(
                () =>
                  options.qualificationProbe?.({
                    boundary: "NativeProcessModeDenialBeforeCommit",
                    executionId: context.executionId,
                    invocationId: intent.invocationId,
                    callRef: intent.callRef,
                    logicalActionId:
                      context.recoveryBindingIdentity?.logicalActionId,
                    denialReasonCode: reasonCode,
                  }) ?? Promise.resolve(),
              );
            }
            return winner;
          }),
        )
        .pipe(
          Effect.mapError(
            operationalFailure(
              "IntentJournal",
              String(intent.invocationId),
            ),
          ),
        );
      if (
        nativeProcessModeDenial &&
        recorded !== "ExecutionStopping" &&
        options.qualificationProbe !== undefined
      ) {
        yield* Effect.promise(
          () =>
            options.qualificationProbe?.({
              boundary: "NativeProcessModeDenialAfterCommit",
              executionId: context.executionId,
              invocationId: intent.invocationId,
              callRef: intent.callRef,
              logicalActionId:
                context.recoveryBindingIdentity?.logicalActionId,
              denialReasonCode: reasonCode,
            }) ?? Promise.resolve(),
        );
      }
      if (recorded === "ExecutionStopping") {
        return yield* persistNoEffectInterruption(
          Option.isSome(current)
            ? {
                invocationId: intent.invocationId,
                executionId: context.executionId,
                workspaceId: context.workspaceId,
                toolName: intent.toolName,
                toolVersion: intent.toolVersion,
                sideEffectSemantics,
                argumentsJson: intent.argumentsJson,
                resolvedRegions,
                approvalId:
                  context.executableApproval?.approvalId ??
                  intent.approvalId,
                intentAt: current.value.intentAt,
              }
            : undefined,
          settledAt,
        );
      }
      return denied(
        recorded.settlement?._tag === "Denied"
          ? recorded.settlement.reasonCode
          : reasonCode,
      );
    });
  return { persistNoEffectInterruption, recordNoEffectDenial };
};
