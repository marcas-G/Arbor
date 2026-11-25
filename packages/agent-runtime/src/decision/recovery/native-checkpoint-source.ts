import type { Execution } from "@arbor/domain";
import type { SessionTimelineProjection } from "@arbor/model-context";
import {
  isEffectsCommittedStepState,
  isPreEffectsStepState,
  isRecoverableStepState,
  sha256Hex,
} from "@arbor/ports";
import { Effect, Option } from "effect";
import {
  decodeUniqueNativePortableFrontier,
  nativeCompactionProviderTurnId,
} from "../../checkpoint/native-evidence.js";
import type { ModelDecisionDependencies } from "../contract.js";
import type { DecisionCursor } from "../startup-recovery.js";

type NativeSourceDependencies = Pick<
  ModelDecisionDependencies,
  "input" | "options" | "providerTurns" | "loopSteps" | "tx" | "failure"
>;

/** Resolve and validate the checkpoint's durable producer and its source
 * Step. The caller retains ownership of the process-local decision cursor. */
export const validateNativeCheckpointSource = (
  dependencies: NativeSourceDependencies,
  phase: {
    readonly nativeCheckpoint: NonNullable<
      SessionTimelineProjection["nativeCheckpoint"]
    >;
    readonly sessionRecord: {
      readonly value: { readonly contextEpoch: number };
    };
    readonly checkpointOwnerExecutionId: Execution["executionId"] | undefined;
    readonly nativeCheckpointIsInherited: boolean;
    readonly cursor: DecisionCursor;
  },
) => {
  const { input, options, providerTurns, loopSteps, tx, failure } =
    dependencies;
  const {
    nativeCheckpoint,
    sessionRecord,
    checkpointOwnerExecutionId,
    nativeCheckpointIsInherited,
  } = phase;
  return Effect.gen(function* () {
    let { turn, repairAttempt } = phase.cursor;
    if (options.qualificationProbe !== undefined) {
      yield* Effect.promise(
        () =>
          options.qualificationProbe?.({
            boundary: "AH19NativeCheckpointRecovery",
            stage: `NativeCheckpointRecoveryEntered:bindingMatches=${nativeCheckpoint.bindingMatches}:source=${nativeCheckpoint.providerTurnId ?? "unknown"}:cursor=${turn}/${repairAttempt}:from=${nativeCheckpoint.fromEpoch ?? "missing"}:to=${nativeCheckpoint.toEpoch ?? "missing"}:sessionEpoch=${sessionRecord.value.contextEpoch}`,
            executionId: String(input.execution.executionId),
            providerTurnId: nativeCheckpoint.providerTurnId ?? "unknown",
          }) ?? Promise.resolve(),
      );
    }
    if (
      nativeCheckpoint.toEpoch === undefined ||
      nativeCheckpoint.toEpoch !== Number(sessionRecord.value.contextEpoch)
    ) {
      return yield* Effect.fail(
        failure({ _tag: "AgentLoopStepReplayBindingMismatch" }),
      );
    }
    // A checkpoint can outlive the in-memory model-loop cursor. Bind it to
    // the persisted AgentLoopStep in every binding branch, including an
    // exact-binding restart; never derive the step from ProviderTurn text.
    if (
      nativeCheckpoint.providerTurnId === undefined ||
      nativeCheckpoint.fromEpoch === undefined ||
      nativeCheckpoint.opaqueItemRef === undefined ||
      nativeCheckpoint.bindingFingerprint === undefined ||
      providerTurns === undefined ||
      loopSteps === undefined
    ) {
      return yield* Effect.fail(
        failure({ _tag: "AgentLoopStepReplayBindingMismatch" }),
      );
    }
    const checkpointNativeProviderTurnId = nativeCompactionProviderTurnId(
      nativeCheckpoint.providerTurnId,
    );
    if (checkpointNativeProviderTurnId === null) {
      return yield* Effect.fail(
        failure({ _tag: "AgentLoopStepReplayBindingMismatch" }),
      );
    }
    if (options.qualificationProbe !== undefined) {
      yield* Effect.promise(
        () =>
          options.qualificationProbe?.({
            boundary: "AH19NativeCheckpointRecovery",
            stage: "NativeCheckpointProviderTurnParsed",
            executionId: String(input.execution.executionId),
            providerTurnId: checkpointNativeProviderTurnId,
          }) ?? Promise.resolve(),
      );
    }
    const [checkpointManifest, checkpointReceipt] = yield* Effect.all(
      [
        tx.transact(
          providerTurns.findManifestByTurn(checkpointNativeProviderTurnId),
        ),
        tx.transact(
          providerTurns.findSettledResult(checkpointNativeProviderTurnId),
        ),
      ],
      { concurrency: 1 },
    ).pipe(Effect.mapError(failure));
    if (options.qualificationProbe !== undefined) {
      yield* Effect.promise(
        () =>
          options.qualificationProbe?.({
            boundary: "AH19NativeCheckpointRecovery",
            stage: `NativeCheckpointManifestReceiptRead:manifest=${checkpointManifest !== null}:receipt=${checkpointReceipt._tag}:sameManifest=${checkpointReceipt._tag === "SettledSuccess" && checkpointReceipt.manifestJson === checkpointManifest?.manifestJson}`,
            executionId: String(input.execution.executionId),
            providerTurnId: checkpointNativeProviderTurnId,
          }) ?? Promise.resolve(),
      );
    }
    const checkpointFrontier =
      checkpointManifest === null
        ? null
        : decodeUniqueNativePortableFrontier(
            checkpointManifest.manifestJson,
            checkpointManifest.portableRequestJson,
          );
    const checkpointManifestJson = checkpointFrontier?.manifest;
    const checkpointSource = checkpointManifestJson?.sourceAgentLoopStep;
    const expectedCheckpointOwnerExecutionId =
      checkpointOwnerExecutionId ?? input.execution.executionId;
    const checkpointSourceIdentity =
      typeof checkpointSource === "object" &&
      checkpointSource !== null &&
      !Array.isArray(checkpointSource) &&
      (checkpointSource as Record<string, unknown>).executionId ===
        expectedCheckpointOwnerExecutionId &&
      Number.isSafeInteger(
        (checkpointSource as Record<string, unknown>).logicalStepNo,
      ) &&
      Number((checkpointSource as Record<string, unknown>).logicalStepNo) >=
        0 &&
      Number.isSafeInteger(
        (checkpointSource as Record<string, unknown>).repairAttempt,
      ) &&
      Number((checkpointSource as Record<string, unknown>).repairAttempt) >=
        0 &&
      typeof (checkpointSource as Record<string, unknown>).providerTurnId ===
        "string"
        ? {
            executionId: expectedCheckpointOwnerExecutionId,
            logicalStepNo: Number(
              (checkpointSource as Record<string, unknown>).logicalStepNo,
            ),
            repairAttempt: Number(
              (checkpointSource as Record<string, unknown>).repairAttempt,
            ),
          }
        : undefined;
    let checkpointRawSourceIsValid = false;
    if (checkpointManifest !== null) {
      try {
        const rawManifest = JSON.parse(
          checkpointManifest.manifestJson,
        ) as Record<string, unknown>;
        const rawSource = rawManifest.sourceAgentLoopStep;
        checkpointRawSourceIsValid =
          typeof rawSource === "object" &&
          rawSource !== null &&
          !Array.isArray(rawSource) &&
          (rawSource as Record<string, unknown>).executionId ===
            expectedCheckpointOwnerExecutionId &&
          Number.isSafeInteger(
            (rawSource as Record<string, unknown>).logicalStepNo,
          ) &&
          Number((rawSource as Record<string, unknown>).logicalStepNo) >= 0 &&
          Number.isSafeInteger(
            (rawSource as Record<string, unknown>).repairAttempt,
          ) &&
          Number((rawSource as Record<string, unknown>).repairAttempt) >= 0 &&
          typeof (rawSource as Record<string, unknown>).providerTurnId ===
            "string";
      } catch {
        checkpointRawSourceIsValid = false;
      }
    }
    if (options.qualificationProbe !== undefined) {
      yield* Effect.promise(
        () =>
          options.qualificationProbe?.({
            boundary: "AH19NativeCheckpointRecovery",
            stage: `NativeCheckpointEvidence:frontier=${checkpointFrontier !== null}:source=${checkpointRawSourceIsValid}:receipt=${checkpointReceipt._tag}:manifestTurn=${checkpointManifestJson?.providerTurnId === checkpointNativeProviderTurnId}:requestEpoch=${checkpointManifestJson?.contextEpoch === nativeCheckpoint.fromEpoch}`,
            executionId: String(input.execution.executionId),
            providerTurnId: checkpointNativeProviderTurnId,
          }) ?? Promise.resolve(),
      );
    }
    if (
      checkpointManifest === null ||
      checkpointFrontier === null ||
      checkpointManifestJson === undefined ||
      checkpointSourceIdentity === undefined ||
      checkpointReceipt._tag !== "SettledSuccess" ||
      checkpointReceipt.evidenceVersion !== "provider-success-v1" ||
      checkpointReceipt.finishReason !== "Stop" ||
      checkpointReceipt.turn.providerTurnId !==
        checkpointNativeProviderTurnId ||
      checkpointReceipt.turn.manifestId !== checkpointManifest.manifestId ||
      checkpointReceipt.turn.executionId !==
        expectedCheckpointOwnerExecutionId ||
      checkpointReceipt.turn.sessionId !== input.execution.sessionId ||
      checkpointReceipt.turn.contextEpoch !== nativeCheckpoint.fromEpoch ||
      checkpointReceipt.turn.outputContractRef !==
        "provider-native-compaction-v1" ||
      checkpointReceipt.manifestJson !== checkpointManifest.manifestJson ||
      checkpointManifestJson.providerTurnId !==
        checkpointNativeProviderTurnId ||
      checkpointManifestJson.executionId !==
        expectedCheckpointOwnerExecutionId ||
      checkpointManifestJson.sessionId !== input.execution.sessionId ||
      checkpointManifestJson.contextEpoch !== nativeCheckpoint.fromEpoch ||
      checkpointManifestJson.operationKind !== "CompactionNative" ||
      checkpointManifestJson.outputContractRef !==
        "provider-native-compaction-v1" ||
      checkpointManifestJson.resolvedModelBindingFingerprint !==
        nativeCheckpoint.bindingFingerprint ||
      checkpointManifestJson.compiledRequestHash !==
        sha256Hex(checkpointManifest.portableRequestJson) ||
      checkpointFrontier.request.modelRef !== checkpointManifestJson.modelRef ||
      checkpointReceipt.turn.modelRef !== checkpointManifestJson.modelRef ||
      checkpointFrontier.request.operationKind !== "CompactionNative" ||
      checkpointFrontier.request.outputContractRef !==
        "provider-native-compaction-v1" ||
      checkpointReceipt.canonicalEvents.filter(
        (event) =>
          event._tag === "ContinuationState" &&
          event.stateRef === nativeCheckpoint.opaqueItemRef,
      ).length !== 1
    ) {
      return yield* Effect.fail(
        failure({ _tag: "AgentLoopStepReplayBindingMismatch" }),
      );
    }
    const checkpointSourceStepOption = yield* tx
      .transact(loopSteps.find(checkpointSourceIdentity))
      .pipe(Effect.mapError(failure));
    if (!Option.isSome(checkpointSourceStepOption)) {
      return yield* Effect.fail(
        failure({ _tag: "AgentLoopStepReplayBindingMismatch" }),
      );
    }
    const checkpointSourceStep = checkpointSourceStepOption.value;
    if (
      checkpointSourceStep.identity.executionId !==
        expectedCheckpointOwnerExecutionId ||
      checkpointSourceStep.identity.logicalStepNo !==
        checkpointSourceIdentity.logicalStepNo ||
      checkpointSourceStep.identity.repairAttempt !==
        checkpointSourceIdentity.repairAttempt ||
      checkpointSourceStep.providerTurnId !==
        (checkpointSource as Record<string, unknown>).providerTurnId
    ) {
      return yield* Effect.fail(
        failure({ _tag: "AgentLoopStepReplayBindingMismatch" }),
      );
    }
    if (
      checkpointSourceStep.state === "NextStepReady" &&
      checkpointSourceStep.successor === undefined
    ) {
      return yield* Effect.fail(
        failure({ _tag: "AgentLoopStepReplayBindingMismatch" }),
      );
    }
    if (!isRecoverableStepState(checkpointSourceStep.state)) {
      return yield* Effect.fail(
        failure({ _tag: "AgentLoopStepReplayBindingMismatch" }),
      );
    }
    // A checkpoint produced by an earlier Work execution is valid
    // Session context, but its source step is not this execution's cursor.
    // The current execution creates its own Prepared step below.
    if (!nativeCheckpointIsInherited) {
      if (isPreEffectsStepState(checkpointSourceStep.state)) {
        turn = checkpointSourceIdentity.logicalStepNo;
        repairAttempt = checkpointSourceIdentity.repairAttempt;
      } else if (isEffectsCommittedStepState(checkpointSourceStep.state)) {
        if (
          !nativeCheckpoint.bindingMatches ||
          checkpointSourceStep.successor === undefined
        ) {
          turn = checkpointSourceIdentity.logicalStepNo;
          repairAttempt = checkpointSourceIdentity.repairAttempt;
        } else {
          turn = checkpointSourceStep.successor.logicalStepNo;
          repairAttempt = checkpointSourceStep.successor.repairAttempt;
        }
      }
    }
    if (options.qualificationProbe !== undefined) {
      yield* Effect.promise(
        () =>
          options.qualificationProbe?.({
            boundary: "AH19NativeCheckpointRecovery",
            stage: `NativeCheckpointSourceValidated:state=${checkpointSourceStep.state}:source=${checkpointSourceStep.providerTurnId}:cursor=${turn}/${repairAttempt}:bindingMatches=${nativeCheckpoint.bindingMatches}`,
            executionId: String(input.execution.executionId),
            providerTurnId: nativeCheckpoint.providerTurnId ?? "unknown",
          }) ?? Promise.resolve(),
      );
    }
    return {
      cursor: { turn, repairAttempt },
      checkpointSourceIdentity,
      checkpointFrontier,
      checkpointReceipt,
      checkpointManifestJson,
      checkpointNativeProviderTurnId,
      expectedCheckpointOwnerExecutionId,
    };
  });
};
