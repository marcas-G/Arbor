import type { Execution, ProviderTurnId } from "@arbor/domain";
import {
  projectSessionTimeline,
  type SessionTimelineProjection,
} from "@arbor/model-context";
import type {
  AgentLoopStepIdentity,
  AgentLoopStepStoreService,
  PortableInputItem,
  ProviderTurnStoreService,
  SessionEntryRecord,
  SettledProviderTurnResult,
} from "@arbor/ports";
import { sha256Hex } from "@arbor/ports";
import { Effect, Option } from "effect";
import type { decodeUniqueNativePortableFrontier } from "../../checkpoint/native-evidence.js";
import type { ModelDecisionDependencies } from "../contract.js";
import type { DecisionCursor } from "../startup-recovery.js";

type PortableFrontierDependencies = Pick<
  ModelDecisionDependencies,
  "input" | "tx" | "options" | "failure"
> & {
  readonly loopSteps: AgentLoopStepStoreService;
  readonly providerTurns: ProviderTurnStoreService;
};

/** Reconstruct the exact portable context of a native checkpoint whose model
 * binding no longer matches, without committing the replacement checkpoint. */
export const reconstructNativePortableFrontier = (
  dependencies: PortableFrontierDependencies,
  phase: {
    readonly cursor: DecisionCursor;
    readonly nativeCheckpoint: NonNullable<
      SessionTimelineProjection["nativeCheckpoint"]
    >;
    readonly nativeCheckpointIsInherited: boolean;
    readonly nativeCheckpointProviderTurnId: string;
    readonly nativeProviderTurnId: ProviderTurnId;
    readonly expectedCheckpointOwnerExecutionId: Execution["executionId"];
    readonly checkpointSourceIdentity: AgentLoopStepIdentity;
    readonly checkpointFrontier: ReturnType<
      typeof decodeUniqueNativePortableFrontier
    >;
    readonly checkpointReceipt: SettledProviderTurnResult;
    readonly checkpointManifestJson: Record<string, unknown> | undefined;
    readonly checkpointNativeProviderTurnId: ProviderTurnId;
    readonly currentBindingFingerprint: string;
    readonly providerNativeSupported: boolean;
    readonly recentSessionEntries: ReadonlyArray<SessionEntryRecord>;
    readonly reasoningProjectionBinding: Parameters<
      typeof projectSessionTimeline
    >[3];
    readonly reasoningAttachmentBlobs: ReadonlyMap<string, Uint8Array>;
  },
) => {
  const { input, tx, loopSteps, providerTurns, options, failure } =
    dependencies;
  const {
    nativeCheckpoint,
    nativeCheckpointIsInherited,
    nativeCheckpointProviderTurnId,
    nativeProviderTurnId,
    expectedCheckpointOwnerExecutionId,
    checkpointSourceIdentity,
    checkpointFrontier,
    checkpointReceipt,
    checkpointManifestJson,
    checkpointNativeProviderTurnId,
    currentBindingFingerprint,
    providerNativeSupported,
    recentSessionEntries,
    reasoningProjectionBinding,
    reasoningAttachmentBlobs,
  } = phase;
  return Effect.gen(function* () {
    let { turn, repairAttempt } = phase.cursor;
    const sourceLinkOption = yield* tx
      .transact(
        loopSteps.findProviderTurnLinkByProviderTurnId(nativeProviderTurnId),
      )
      .pipe(Effect.mapError(failure));
    const nativeManifest = yield* tx
      .transact(providerTurns.findManifestByTurn(nativeProviderTurnId))
      .pipe(Effect.mapError(failure));
    if (nativeManifest === null) {
      return yield* Effect.fail(
        failure({ _tag: "AgentLoopStepReplayBindingMismatch" }),
      );
    }
    let nativeManifestValue: Record<string, unknown>;
    try {
      const parsed = JSON.parse(nativeManifest.manifestJson) as unknown;
      if (
        typeof parsed !== "object" ||
        parsed === null ||
        Array.isArray(parsed)
      ) {
        return yield* Effect.fail(
          failure({ _tag: "AgentLoopStepReplayBindingMismatch" }),
        );
      }
      nativeManifestValue = parsed as Record<string, unknown>;
    } catch {
      return yield* Effect.fail(
        failure({ _tag: "AgentLoopStepReplayBindingMismatch" }),
      );
    }
    const sourceIdentityValue = nativeManifestValue.sourceAgentLoopStep;
    const sourceIdentity =
      typeof sourceIdentityValue === "object" &&
      sourceIdentityValue !== null &&
      !Array.isArray(sourceIdentityValue)
        ? (sourceIdentityValue as Record<string, unknown>)
        : undefined;
    if (options.qualificationProbe !== undefined) {
      yield* Effect.promise(
        () =>
          options.qualificationProbe?.({
            boundary: "AH19NativeCheckpointRecovery",
            stage: `NativeCheckpointEvidence:frontier=${checkpointFrontier !== null}:source=${checkpointSourceIdentity !== undefined}:receipt=${checkpointReceipt._tag}:manifestTurn=${checkpointManifestJson?.providerTurnId === checkpointNativeProviderTurnId}:requestEpoch=${checkpointManifestJson?.contextEpoch === nativeCheckpoint.fromEpoch}`,
            executionId: String(input.execution.executionId),
            providerTurnId: checkpointNativeProviderTurnId,
          }) ?? Promise.resolve(),
      );
    }
    const sourceLink = Option.isSome(sourceLinkOption)
      ? sourceLinkOption.value
      : undefined;
    const sourceStepIdentity =
      sourceLink?.identity ??
      (sourceIdentity !== undefined &&
      sourceIdentity.executionId === expectedCheckpointOwnerExecutionId &&
      Number.isSafeInteger(sourceIdentity.logicalStepNo) &&
      Number(sourceIdentity.logicalStepNo) >= 0 &&
      Number.isSafeInteger(sourceIdentity.repairAttempt) &&
      Number(sourceIdentity.repairAttempt) >= 0
        ? {
            executionId: expectedCheckpointOwnerExecutionId,
            logicalStepNo: Number(sourceIdentity.logicalStepNo),
            repairAttempt: Number(sourceIdentity.repairAttempt),
          }
        : undefined);
    if (
      sourceStepIdentity === undefined ||
      (sourceLink !== undefined &&
        (sourceLink.providerTurnId !== nativeProviderTurnId ||
          sourceLink.identity.executionId !==
            expectedCheckpointOwnerExecutionId ||
          sourceLink.role !== "OverflowCompaction" ||
          sourceLink.overflowOrdinal !== 0 ||
          sourceLink.contextEpoch !== nativeCheckpoint.fromEpoch ||
          sourceLink.predecessorProviderTurnId === undefined)) ||
      sourceIdentity?.providerTurnId === undefined
    ) {
      return yield* Effect.fail(
        failure({ _tag: "AgentLoopStepReplayBindingMismatch" }),
      );
    }
    if (
      sourceIdentity.executionId !== expectedCheckpointOwnerExecutionId ||
      sourceStepIdentity.executionId !== expectedCheckpointOwnerExecutionId ||
      sourceIdentity.logicalStepNo !== sourceStepIdentity.logicalStepNo ||
      sourceIdentity.repairAttempt !== sourceStepIdentity.repairAttempt
    ) {
      return yield* Effect.fail(
        failure({ _tag: "AgentLoopStepReplayBindingMismatch" }),
      );
    }
    const sourceStepOption = yield* tx
      .transact(loopSteps.find(sourceStepIdentity))
      .pipe(Effect.mapError(failure));
    if (!Option.isSome(sourceStepOption)) {
      return yield* Effect.fail(
        failure({ _tag: "AgentLoopStepReplayBindingMismatch" }),
      );
    }
    const sourceStep = sourceStepOption.value;
    const sourceStepLinks = yield* tx
      .transact(loopSteps.listProviderTurnLinks(sourceStepIdentity))
      .pipe(Effect.mapError(failure));
    const inferenceLinks = sourceStepLinks.filter(
      (link) => link.role === "Inference",
    );
    const compactionLinks = sourceStepLinks.filter(
      (link) => link.role === "OverflowCompaction",
    );
    const sourceInferenceLink = inferenceLinks[0];
    const hasOverflowSource = sourceLink !== undefined;
    if (
      sourceStep.identity.executionId !== expectedCheckpointOwnerExecutionId ||
      sourceStep.providerTurnId !== sourceIdentity.providerTurnId ||
      (hasOverflowSource
        ? sourceStep.providerTurnId !== sourceLink.predecessorProviderTurnId ||
          inferenceLinks.length !== 1 ||
          compactionLinks.length !== 1 ||
          compactionLinks[0]?.providerTurnId !== nativeProviderTurnId ||
          sourceInferenceLink === undefined ||
          sourceInferenceLink.providerTurnId !==
            sourceLink.predecessorProviderTurnId ||
          sourceInferenceLink.contextEpoch !== sourceLink.contextEpoch
        : compactionLinks.length !== 0 ||
          inferenceLinks.length > 1 ||
          (sourceInferenceLink !== undefined &&
            sourceInferenceLink.providerTurnId !== sourceStep.providerTurnId))
    ) {
      return yield* Effect.fail(
        failure({ _tag: "AgentLoopStepReplayBindingMismatch" }),
      );
    }
    if (sourceLink !== undefined && sourceInferenceLink !== undefined) {
      const sourceInferenceResult = yield* tx
        .transact(
          providerTurns.findSettledResult(sourceInferenceLink.providerTurnId),
        )
        .pipe(Effect.mapError(failure));
      if (
        sourceInferenceResult._tag !== "SettledFailure" ||
        sourceInferenceResult.turn.providerTurnId !==
          sourceInferenceLink.providerTurnId ||
        sourceInferenceResult.failureKind !== "ContextLimitExceeded" ||
        sourceInferenceResult.turn.executionId !==
          expectedCheckpointOwnerExecutionId ||
        sourceInferenceResult.turn.sessionId !== input.execution.sessionId ||
        sourceInferenceResult.turn.contextEpoch !== sourceLink.contextEpoch
      ) {
        return yield* Effect.fail(
          failure({ _tag: "AgentLoopStepReplayBindingMismatch" }),
        );
      }
    }
    // The Native Manifest carries the exact source identity for ordinary
    // compaction; an overflow link, when present, must agree with it.
    if (!nativeCheckpointIsInherited) {
      turn = sourceStepIdentity.logicalStepNo;
      repairAttempt = sourceStepIdentity.repairAttempt;
    }
    if (options.qualificationProbe !== undefined) {
      yield* Effect.promise(
        () =>
          options.qualificationProbe?.({
            boundary: "AH19NativeCheckpointRecovery",
            stage: `NativeSourceIdentity:step=${sourceStepIdentity.logicalStepNo}:repair=${sourceStepIdentity.repairAttempt}:sourceProviderTurn=${sourceStep.providerTurnId}:overflow=${hasOverflowSource}:state=${sourceStep.state}:successor=${sourceStep.successor?.providerTurnId ?? "none"}`,
            executionId: String(input.execution.executionId),
            providerTurnId: nativeProviderTurnId,
          }) ?? Promise.resolve(),
      );
    }
    if (options.qualificationProbe !== undefined) {
      yield* Effect.promise(
        () =>
          options.qualificationProbe?.({
            boundary: "AH19NativeCheckpointRecovery",
            stage: "NativeManifestQueryStarted",
            executionId: String(input.execution.executionId),
            providerTurnId: nativeProviderTurnId,
          }) ?? Promise.resolve(),
      );
    }
    if (options.qualificationProbe !== undefined) {
      yield* Effect.promise(
        () =>
          options.qualificationProbe?.({
            boundary: "AH19NativeCheckpointRecovery",
            stage:
              nativeManifest === null
                ? "NativeManifestQueryNotFound"
                : "NativeManifestQueryFound",
            executionId: String(input.execution.executionId),
            providerTurnId: nativeProviderTurnId,
          }) ?? Promise.resolve(),
      );
    }
    if (nativeManifest === null) {
      return yield* Effect.fail(
        failure({ _tag: "AgentLoopStepReplayBindingMismatch" }),
      );
    }
    const nativeReceipt = yield* tx
      .transact(providerTurns.findSettledResult(nativeProviderTurnId))
      .pipe(Effect.mapError(failure));
    if (options.qualificationProbe !== undefined) {
      yield* Effect.promise(
        () =>
          options.qualificationProbe?.({
            boundary: "AH19NativeCheckpointRecovery",
            stage: `NativeReceiptLookup:${nativeReceipt._tag}`,
            executionId: String(input.execution.executionId),
            providerTurnId: nativeProviderTurnId,
          }) ?? Promise.resolve(),
      );
    }
    if (
      nativeManifest === null ||
      nativeReceipt._tag !== "SettledSuccess" ||
      nativeReceipt.finishReason !== "Stop" ||
      nativeReceipt.evidenceVersion !== "provider-success-v1" ||
      nativeReceipt.turn.providerTurnId !== nativeProviderTurnId ||
      nativeReceipt.turn.executionId !== expectedCheckpointOwnerExecutionId ||
      nativeReceipt.turn.sessionId !== input.execution.sessionId ||
      nativeReceipt.turn.contextEpoch !== nativeCheckpoint.fromEpoch ||
      nativeReceipt.manifestJson !== nativeManifest.manifestJson
    ) {
      return yield* Effect.fail(
        failure({ _tag: "AgentLoopStepReplayBindingMismatch" }),
      );
    }
    let nativeManifestJson: Record<string, unknown>;
    let nativeRequest: Record<string, unknown>;
    try {
      const manifestValue = JSON.parse(nativeManifest.manifestJson) as unknown;
      const requestValue = JSON.parse(
        nativeManifest.portableRequestJson,
      ) as unknown;
      if (
        typeof manifestValue !== "object" ||
        manifestValue === null ||
        Array.isArray(manifestValue) ||
        typeof requestValue !== "object" ||
        requestValue === null ||
        Array.isArray(requestValue)
      ) {
        return yield* Effect.fail(
          failure({ _tag: "AgentLoopStepReplayBindingMismatch" }),
        );
      }
      nativeManifestJson = manifestValue as Record<string, unknown>;
      nativeRequest = requestValue as Record<string, unknown>;
    } catch {
      return yield* Effect.fail(
        failure({ _tag: "AgentLoopStepReplayBindingMismatch" }),
      );
    }
    const nativeInputFrontier = nativeManifestJson.inputFrontier as
      | {
          firstSequence?: unknown;
          lastSequence?: unknown;
        }
      | undefined;
    const nativeContextRefs = nativeManifestJson.contextRefs;
    const nativeInputItems = nativeRequest.inputItems;
    const nativeContinuationRefs = nativeReceipt.canonicalEvents.filter(
      (event) => event._tag === "ContinuationState",
    );
    const validContextRefs =
      Array.isArray(nativeContextRefs) &&
      nativeContextRefs.length > 0 &&
      nativeContextRefs.every(
        (ref): ref is string => typeof ref === "string" && ref.length > 0,
      ) &&
      new Set(nativeContextRefs).size === nativeContextRefs.length;
    const emptyNativeFrontier =
      nativeInputFrontier?.firstSequence === null &&
      nativeInputFrontier.lastSequence === null;
    const nonEmptyNativeFrontier =
      typeof nativeInputFrontier?.firstSequence === "number" &&
      Number.isSafeInteger(nativeInputFrontier.firstSequence) &&
      nativeInputFrontier.firstSequence >= 0 &&
      typeof nativeInputFrontier.lastSequence === "number" &&
      Number.isSafeInteger(nativeInputFrontier.lastSequence) &&
      nativeInputFrontier.lastSequence >= nativeInputFrontier.firstSequence &&
      nativeInputFrontier.lastSequence < nativeCheckpoint.sequence;
    const validNativeFrontier = emptyNativeFrontier || nonEmptyNativeFrontier;
    const manifestSourceIdentity = nativeManifestJson.sourceAgentLoopStep;
    const sourceAgentLoopStepMatches =
      typeof manifestSourceIdentity === "object" &&
      manifestSourceIdentity !== null &&
      !Array.isArray(manifestSourceIdentity) &&
      (manifestSourceIdentity as Record<string, unknown>).executionId ===
        sourceStepIdentity.executionId &&
      (manifestSourceIdentity as Record<string, unknown>).logicalStepNo ===
        sourceStepIdentity.logicalStepNo &&
      (manifestSourceIdentity as Record<string, unknown>).repairAttempt ===
        sourceStepIdentity.repairAttempt &&
      (manifestSourceIdentity as Record<string, unknown>).providerTurnId ===
        sourceStep.providerTurnId;
    if (options.qualificationProbe !== undefined) {
      const checks = {
        providerTurn:
          nativeManifestJson.providerTurnId === nativeCheckpoint.providerTurnId,
        execution:
          nativeManifestJson.executionId === expectedCheckpointOwnerExecutionId,
        session: nativeManifestJson.sessionId === input.execution.sessionId,
        epoch: nativeManifestJson.contextEpoch === nativeCheckpoint.fromEpoch,
        operation: nativeManifestJson.operationKind === "CompactionNative",
        step:
          nativeManifestJson.logicalStepNo === sourceStepIdentity.logicalStepNo,
        sourceAgentLoopStep: sourceAgentLoopStepMatches,
        fingerprint:
          nativeManifestJson.resolvedModelBindingFingerprint ===
          nativeCheckpoint.bindingFingerprint,
        hash:
          nativeManifestJson.compiledRequestHash ===
          sha256Hex(nativeManifest.portableRequestJson),
        version: nativeRequest.requestVersion === 2,
        requestOperation: nativeRequest.operationKind === "CompactionNative",
        model: nativeRequest.modelRef === nativeManifestJson.modelRef,
        output:
          nativeRequest.outputContractRef === "provider-native-compaction-v1",
        refs: validContextRefs,
        frontier: validNativeFrontier,
        items: Array.isArray(nativeInputItems) && nativeInputItems.length > 0,
        nestedNative:
          Array.isArray(nativeInputItems) &&
          nativeInputItems.some(
            (item) =>
              typeof item === "object" &&
              item !== null &&
              "_tag" in item &&
              item._tag === "CompactionCheckpoint" &&
              "implementation" in item &&
              item.implementation === "ProviderNative",
          ),
        continuationCount: nativeContinuationRefs.length,
        continuationRef:
          nativeContinuationRefs[0]?._tag === "ContinuationState" &&
          nativeContinuationRefs[0].stateRef === nativeCheckpoint.opaqueItemRef,
      };
      yield* Effect.promise(
        () =>
          options.qualificationProbe?.({
            boundary: "AH19NativeCheckpointRecovery",
            stage: `NativeManifestChecks:${Object.entries(checks)
              .map(([key, value]) => `${key}=${String(value)}`)
              .join(",")}`,
            executionId: String(input.execution.executionId),
            providerTurnId: nativeCheckpointProviderTurnId,
          }) ?? Promise.resolve(),
      );
    }
    if (
      nativeManifestJson.providerTurnId !== nativeCheckpoint.providerTurnId ||
      nativeManifestJson.executionId !== expectedCheckpointOwnerExecutionId ||
      nativeManifestJson.sessionId !== input.execution.sessionId ||
      nativeManifestJson.contextEpoch !== nativeCheckpoint.fromEpoch ||
      nativeManifestJson.operationKind !== "CompactionNative" ||
      nativeManifestJson.logicalStepNo !== sourceStepIdentity.logicalStepNo ||
      !sourceAgentLoopStepMatches ||
      nativeManifestJson.resolvedModelBindingFingerprint !==
        nativeCheckpoint.bindingFingerprint ||
      nativeManifestJson.compiledRequestHash !==
        sha256Hex(nativeManifest.portableRequestJson) ||
      nativeRequest.requestVersion !== 2 ||
      nativeRequest.operationKind !== "CompactionNative" ||
      nativeRequest.modelRef !== nativeManifestJson.modelRef ||
      nativeRequest.outputContractRef !== "provider-native-compaction-v1" ||
      !validContextRefs ||
      !validNativeFrontier ||
      !Array.isArray(nativeInputItems) ||
      nativeInputItems.length === 0 ||
      nativeInputItems.some(
        (item) =>
          typeof item === "object" &&
          item !== null &&
          "_tag" in item &&
          item._tag === "CompactionCheckpoint" &&
          "implementation" in item &&
          item.implementation === "ProviderNative",
      ) ||
      nativeContinuationRefs.length !== 1 ||
      nativeContinuationRefs[0]?.stateRef !== nativeCheckpoint.opaqueItemRef
    ) {
      return yield* Effect.fail(
        failure({ _tag: "AgentLoopStepReplayBindingMismatch" }),
      );
    }
    if (options.qualificationProbe !== undefined) {
      yield* Effect.promise(
        () =>
          options.qualificationProbe?.({
            boundary: "AH19NativeCheckpointRecovery",
            stage: "PortableFrontierValidated",
            executionId: String(input.execution.executionId),
            providerTurnId: nativeCheckpointProviderTurnId,
          }) ?? Promise.resolve(),
      );
    }
    const postCheckpointEntries = recentSessionEntries.filter(
      (entry) => entry.sequence > nativeCheckpoint.sequence,
    );
    const postCheckpointProjection = projectSessionTimeline(
      postCheckpointEntries,
      currentBindingFingerprint,
      providerNativeSupported,
      reasoningProjectionBinding,
      reasoningAttachmentBlobs,
    );
    if (postCheckpointProjection.nativeCheckpoint !== undefined) {
      return yield* Effect.fail(
        failure({ _tag: "AgentLoopStepReplayBindingMismatch" }),
      );
    }
    const portableContextRefs = [
      ...(nativeContextRefs as ReadonlyArray<string>),
      ...postCheckpointProjection.contextRefs,
    ];
    if (
      portableContextRefs.length === 0 ||
      new Set(portableContextRefs).size !== portableContextRefs.length
    ) {
      return yield* Effect.fail(
        failure({ _tag: "AgentLoopStepReplayBindingMismatch" }),
      );
    }
    const firstSequence =
      typeof nativeInputFrontier.firstSequence === "number"
        ? nativeInputFrontier.firstSequence
        : postCheckpointProjection.frontier.firstSequence;
    const lastSequence =
      postCheckpointProjection.frontier.lastSequence ??
      (typeof nativeInputFrontier.lastSequence === "number"
        ? nativeInputFrontier.lastSequence
        : null);
    if (
      (firstSequence === null) !== (lastSequence === null) ||
      (firstSequence !== null &&
        lastSequence !== null &&
        lastSequence < firstSequence)
    ) {
      return yield* Effect.fail(
        failure({ _tag: "AgentLoopStepReplayBindingMismatch" }),
      );
    }
    const portableItems = [
      ...(nativeInputItems as ReadonlyArray<PortableInputItem>),
      ...postCheckpointProjection.inputItems,
    ];
    return {
      cursor: { turn, repairAttempt },
      sourceStepIdentity,
      sourceStep,
      sourceStepLinks,
      nativeManifestJson,
      portableContextRefs,
      firstSequence,
      lastSequence,
      portableItems,
    };
  });
};
