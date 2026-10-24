import {
  ContextEpochNumber,
  type Execution,
  ExecutionId,
  executionEpisode,
  type ProviderTurnId,
  parse,
  providerTurnConversationNativeCompactionId,
  providerTurnConversationSummaryCompactionId,
} from "@arbor/domain";
import type {
  BlobStorePortService,
  ConversationCheckpointOwner,
  ConversationCheckpointSourceManifestV1,
  ConversationCheckpointStoreService,
  ConversationResponseJob,
  ExecutionActivity,
  PortableModelRequestV2,
  PortableOperationKind,
  ProviderRunResult,
  ProviderRuntimeService,
  ProviderTurnStoreService,
  SessionWriteFence,
  TransactionPortService,
} from "@arbor/ports";
import { sha256Hex } from "@arbor/ports";
import { Effect } from "effect";
import type { ConversationAnsweredSource } from "./conversation-checkpoint-projection.js";
import type { AgentLoopQualificationProbe } from "./qualification-probe.js";

export const conversationCheckpointProviderTurnId = (
  executionId: string,
  logicalStepNo: number,
  checkpointKind: "Summary" | "ProviderNative",
  contextEpoch: number,
): ProviderTurnId => {
  const exactExecutionId = parse(ExecutionId)(executionId);
  return checkpointKind === "Summary"
    ? providerTurnConversationSummaryCompactionId(
        exactExecutionId,
        logicalStepNo,
        contextEpoch,
      )
    : providerTurnConversationNativeCompactionId(
        exactExecutionId,
        logicalStepNo,
        contextEpoch,
      );
};

export const runConversationCheckpointCompaction = (
  input: {
    readonly execution: Execution;
    readonly logicalStepNo: number;
    readonly providerTurnId?: ProviderTurnId;
    readonly owner: ConversationCheckpointOwner;
    readonly sources: ReadonlyArray<ConversationAnsweredSource>;
    readonly coveredThrough: ConversationCheckpointOwner["coveredThrough"];
    readonly currentMessageId: string;
    readonly currentResponseJob: ConversationResponseJob;
    readonly checkpointKind: "Summary" | "ProviderNative";
    readonly bindingFingerprint: string;
    readonly modelRef: string;
    readonly secretRef?: import("@arbor/ports").SecretRef;
    readonly fence: SessionWriteFence;
    readonly updatedAt: string;
    readonly qualificationProbe?: AgentLoopQualificationProbe;
  },
  deps: {
    readonly providerRuntime: ProviderRuntimeService;
    readonly admitProviderTurn?: (
      operationKind: PortableOperationKind,
      compiledRequestHash: string,
    ) => Effect.Effect<{
      readonly activity: ExecutionActivity;
      readonly decision: "Continue" | "Stop";
    }>;
    readonly completeProviderTurn?: (
      activity: ExecutionActivity,
      attemptNo: number,
    ) => Effect.Effect<"Continue" | "Stop">;
    readonly checkpointStore: ConversationCheckpointStoreService;
    readonly providerTurns: ProviderTurnStoreService;
    readonly blobs: Pick<BlobStorePortService, "put">;
    readonly tx: TransactionPortService;
  },
) =>
  Effect.gen(function* () {
    if (
      input.currentResponseJob.state._tag !== "Running" ||
      input.currentResponseJob.state.executionId !==
        input.execution.executionId ||
      String(input.currentResponseJob.messageId) !== input.currentMessageId ||
      input.currentResponseJob.projectId !== input.execution.projectId ||
      input.currentResponseJob.rootWorkspaceId !==
        input.execution.workspaceId ||
      input.sources.length === 0
    ) {
      return yield* Effect.fail({
        _tag: "ConversationCompactionSourceInvalid" as const,
      });
    }
    for (let index = 1; index < input.sources.length; index += 1) {
      const previous = input.sources[index - 1]?.message;
      const current = input.sources[index]?.message;
      if (
        previous === undefined ||
        current === undefined ||
        previous.createdAt > current.createdAt ||
        (previous.createdAt === current.createdAt &&
          previous.messageId >= current.messageId)
      ) {
        return yield* Effect.fail({
          _tag: "ConversationCompactionSourceInvalid" as const,
        });
      }
    }
    const lastSource = input.sources.at(-1);
    if (
      lastSource === undefined ||
      input.coveredThrough?.createdAt !== lastSource.message.createdAt ||
      input.coveredThrough.messageId !== lastSource.message.messageId
    ) {
      return yield* Effect.fail({
        _tag: "ConversationCompactionSourceInvalid" as const,
      });
    }
    const currentEpoch = input.owner.contextEpoch;
    const nextEpoch = parse(ContextEpochNumber)(Number(currentEpoch) + 1);
    const providerTurnId =
      input.providerTurnId ??
      conversationCheckpointProviderTurnId(
        String(input.execution.executionId),
        input.logicalStepNo,
        input.checkpointKind,
        Number(currentEpoch),
      );
    const outputContractRef =
      input.checkpointKind === "Summary"
        ? "compaction-result-v1"
        : "provider-native-compaction-v1";
    const operationKind: PortableOperationKind =
      input.checkpointKind === "Summary"
        ? "CompactionSummary"
        : "CompactionNative";
    const contextRefs = input.sources.map(
      (source) => `human-input:${source.message.messageId}`,
    );
    const currentEpisode = executionEpisode(input.execution);
    if (currentEpisode?._tag !== "ConversationResponseEpisode") {
      return yield* Effect.fail({
        _tag: "ConversationCompactionSourceInvalid" as const,
      });
    }
    const inputItems = input.sources.flatMap((source) => [
      {
        _tag: "Message" as const,
        role: "user" as const,
        text: source.message.bodyRef,
      },
      {
        _tag: "Message" as const,
        role: "assistant" as const,
        text: source.responseBody,
      },
    ]);
    const request: PortableModelRequestV2 = {
      requestVersion: 2 as const,
      operationKind,
      modelRef: input.modelRef,
      instructions:
        input.checkpointKind === "Summary"
          ? [
              {
                slotId: "compaction",
                authorityRole: "A0" as const,
                text: "Produce a compact continuation summary preserving the human conversation objective, constraints, decisions, progress, blockers, next actions, and relevant references.",
              },
            ]
          : [],
      inputItems,
      toolDefinitions: [],
      outputContractRef,
      budget: {
        maxOutputTokens: input.checkpointKind === "Summary" ? 2048 : 0,
      },
      cacheHints: [],
    };
    const manifest = {
      providerTurnId,
      executionId: input.execution.executionId,
      sessionId: input.execution.sessionId,
      contextEpoch: currentEpoch,
      modelRef: input.modelRef,
      outputContractRef,
      compiledRequestHash: sha256Hex(JSON.stringify(request)),
      operationKind,
      logicalStepNo: input.logicalStepNo,
      resolvedModelBindingFingerprint: input.bindingFingerprint,
      contextRefs,
      conversationCheckpoint: {
        rootWorkspaceId: input.execution.workspaceId,
        fromEpoch: currentEpoch,
        toEpoch: nextEpoch,
        fromFrontier: input.owner.coveredThrough,
        coveredThrough: input.coveredThrough,
        coveredSources: input.sources.map((source) => source.manifestSource),
        currentMessageId: input.currentMessageId,
        currentRunningJobRevision: input.currentResponseJob.revision,
        currentRunningAttemptNo:
          input.currentResponseJob.state._tag === "Running"
            ? input.currentResponseJob.state.attemptNo
            : -1,
        currentAdmissionJobRevision: currentEpisode.responseJobRevision,
      },
    };
    const manifestJson = JSON.stringify(manifest);
    const portableRequestJson = JSON.stringify(request);
    const [existingManifest, settledReceipt] = yield* Effect.all([
      deps.tx.transact(deps.providerTurns.findManifestByTurn(providerTurnId)),
      deps.tx.transact(deps.providerTurns.findSettledResult(providerTurnId)),
    ]);
    let result: ProviderRunResult;
    if (settledReceipt._tag === "SettledSuccess") {
      if (
        existingManifest === null ||
        existingManifest.manifestId !== settledReceipt.manifestId ||
        existingManifest.manifestJson !== manifestJson ||
        existingManifest.portableRequestJson !== portableRequestJson ||
        settledReceipt.manifestJson !== manifestJson ||
        settledReceipt.turn.providerTurnId !== providerTurnId ||
        settledReceipt.turn.executionId !== input.execution.executionId ||
        settledReceipt.turn.sessionId !== input.execution.sessionId ||
        settledReceipt.turn.contextEpoch !== currentEpoch ||
        settledReceipt.turn.modelRef !== input.modelRef ||
        settledReceipt.turn.outputContractRef !== outputContractRef
      ) {
        return yield* Effect.fail({
          _tag: "ConversationCompactionReceiptMismatch" as const,
        });
      }
      result = {
        events: settledReceipt.canonicalEvents,
        attemptNo: settledReceipt.attemptNo,
        retryDecisions: [],
      };
    } else if (
      settledReceipt._tag === "NotFound" ||
      settledReceipt._tag === "Unsettled"
    ) {
      if (
        existingManifest !== null &&
        (existingManifest.manifestJson !== manifestJson ||
          existingManifest.portableRequestJson !== portableRequestJson)
      ) {
        return yield* Effect.fail({
          _tag: "ConversationCompactionReceiptMismatch" as const,
        });
      }
      const providerAdmission =
        deps.admitProviderTurn === undefined
          ? undefined
          : yield* deps.admitProviderTurn(
              manifest.operationKind,
              manifest.compiledRequestHash,
            );
      if (providerAdmission?.decision === "Stop") {
        return { _tag: "SafetyStop" as const };
      }
      result = yield* deps.providerRuntime.runTurn({
        providerTurnId,
        executionId: input.execution.executionId,
        sessionId: input.execution.sessionId,
        contextEpoch: currentEpoch,
        modelRef: input.modelRef,
        ...(input.secretRef === undefined
          ? {}
          : { secretRef: input.secretRef }),
        outputContractRef,
        manifestJson,
        request,
      });
      if (
        providerAdmission !== undefined &&
        deps.completeProviderTurn !== undefined &&
        (yield* deps.completeProviderTurn(
          providerAdmission.activity,
          result.attemptNo,
        )) === "Stop"
      ) {
        return { _tag: "SafetyStop" as const };
      }
    } else {
      return yield* Effect.fail({
        _tag: "ConversationCompactionReceiptNotReplayable" as const,
        reason: settledReceipt._tag,
      });
    }
    let checkpointRef: string;
    if (input.checkpointKind === "Summary") {
      const summary = result.events
        .flatMap((event) => (event._tag === "TextDelta" ? [event.text] : []))
        .join("")
        .trim();
      if (summary.length === 0) {
        return yield* Effect.fail({
          _tag: "ConversationSummaryCompactionInvalid" as const,
          reason: "provider returned no summary text",
        });
      }
      checkpointRef = yield* deps.blobs.put(new TextEncoder().encode(summary));
    } else {
      const stateRef = result.events.find(
        (event) => event._tag === "ContinuationState",
      )?.stateRef;
      if (stateRef === undefined) {
        return yield* Effect.fail({
          _tag: "ConversationNativeCompactionInvalid" as const,
          reason: "provider returned no opaque continuation item",
        });
      }
      checkpointRef = stateRef;
    }
    const persistedManifest =
      existingManifest ??
      (yield* deps.tx.transact(
        deps.providerTurns.findManifestByTurn(providerTurnId),
      ));
    if (persistedManifest === null) {
      return yield* Effect.fail({
        _tag: "ConversationCompactionManifestMissing" as const,
      });
    }
    const sourceManifest: ConversationCheckpointSourceManifestV1 = {
      version: 1,
      rootWorkspaceId: input.execution.workspaceId,
      fromEpoch: currentEpoch,
      toEpoch: nextEpoch,
      fromFrontier: input.owner.coveredThrough,
      coveredThrough: input.coveredThrough,
      coveredSources: input.sources.map((source) => source.manifestSource),
      currentMessageId: input.currentMessageId,
      currentRunningJobRevision: input.currentResponseJob.revision,
      currentRunningAttemptNo:
        input.currentResponseJob.state._tag === "Running"
          ? input.currentResponseJob.state.attemptNo
          : -1,
      currentAdmissionJobRevision: currentEpisode.responseJobRevision,
      checkpointKind: input.checkpointKind,
      producerExecutionId: input.execution.executionId,
      producerProviderTurnId: providerTurnId,
      producerManifestId: persistedManifest.manifestId,
    };
    const probeIdentity = {
      executionId: String(input.execution.executionId),
      providerTurnId: String(providerTurnId),
    };
    if (input.qualificationProbe !== undefined) {
      yield* Effect.promise(
        () =>
          input.qualificationProbe?.({
            boundary: "AH19BeforeConversationCheckpointOwnerCommit",
            ...probeIdentity,
          }) ?? Promise.resolve(),
      );
    }
    const updatedOwner = yield* deps.tx.transact(
      deps.checkpointStore.commit({
        rootWorkspaceId: input.execution.workspaceId,
        expectedContextEpoch: currentEpoch,
        expectedCoveredThrough: input.owner.coveredThrough,
        nextContextEpoch: nextEpoch,
        coveredThrough: input.coveredThrough,
        checkpointKind: input.checkpointKind,
        checkpointRef,
        bindingFingerprint:
          input.checkpointKind === "ProviderNative"
            ? input.bindingFingerprint
            : null,
        sourceManifest,
        producerExecutionId: input.execution.executionId,
        producerProviderTurnId: providerTurnId,
        updatedAt: input.updatedAt,
        fence: input.fence,
      }),
    );
    if (input.qualificationProbe !== undefined) {
      yield* Effect.promise(
        () =>
          input.qualificationProbe?.({
            boundary: "AH19AfterConversationCheckpointOwnerCommit",
            ...probeIdentity,
          }) ?? Promise.resolve(),
      );
    }
    return {
      newEpoch: updatedOwner.contextEpoch,
      providerTurnId,
      checkpointRef,
      checkpointKind: input.checkpointKind,
      owner: updatedOwner,
    };
  });
