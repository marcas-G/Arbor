import { type Execution, ProviderTurnId, parse } from "@arbor/domain";
import type {
  ConversationCheckpointOwner,
  ExecutionDriverError,
  ProviderTurnStoreService,
  SessionEntryRecord,
  TransactionPortService,
} from "@arbor/ports";
import { sha256Hex } from "@arbor/ports";
import { Effect } from "effect";

/** Root conversation shares the Workspace primary Session with Work episodes.
 * Only timeline items causally written by the exact conversation execution may
 * re-enter its next turn; all historical Work/tool traffic stays excluded. */
export const belongsToConversationExecution = (
  entry: SessionEntryRecord,
  executionId: string,
): boolean => {
  const source = entry.source;
  if (source === undefined) return false;
  const providerTurnPrefix = `ptn_${executionId}_`;
  if (
    (source.kind === "ProviderTurn" ||
      source.kind === "ProviderTurnCall" ||
      source.kind === "CompactionTurn") &&
    (() => {
      const [providerTurnRef, ...sourceSuffix] = source.ref.split(":");
      if (
        providerTurnRef === undefined ||
        !providerTurnRef.startsWith(providerTurnPrefix)
      ) {
        return false;
      }
      try {
        parse(ProviderTurnId)(providerTurnRef);
      } catch {
        return false;
      }
      switch (source.kind) {
        case "ProviderTurn":
          return (
            sourceSuffix.length === 0 ||
            (sourceSuffix.length === 1 && sourceSuffix[0] === "assistant")
          );
        case "ProviderTurnCall":
          return (
            sourceSuffix.length === 1 &&
            sourceSuffix[0] !== undefined &&
            sourceSuffix[0].length > 0
          );
        case "CompactionTurn":
          return sourceSuffix.length === 0;
      }
    })()
  ) {
    return true;
  }
  return (
    source.kind === "AgentLoopAction" &&
    source.ref.startsWith(`observation_${executionId}_`)
  );
};

export const validateConversationCheckpointReceipt = (input: {
  readonly owner: ConversationCheckpointOwner;
  readonly execution: Execution;
  readonly providerTurns: ProviderTurnStoreService | undefined;
  readonly tx: TransactionPortService;
  readonly failure: (cause: unknown) => ExecutionDriverError;
}): Effect.Effect<void, ExecutionDriverError> =>
  Effect.gen(function* () {
    const { owner, execution, providerTurns, tx, failure } = input;
    if (
      owner.checkpointKind === null ||
      owner.producerProviderTurnId === null ||
      owner.producerExecutionId === null ||
      owner.sourceManifestJson === null ||
      owner.checkpointRef === null ||
      providerTurns === undefined
    ) {
      return yield* Effect.fail(
        failure({ _tag: "ConversationCheckpointEvidenceMissing" }),
      );
    }
    let sourceManifest: Record<string, unknown>;
    try {
      const value = JSON.parse(owner.sourceManifestJson) as unknown;
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new Error("source manifest is not an object");
      }
      sourceManifest = value as Record<string, unknown>;
    } catch {
      return yield* Effect.fail(
        failure({ _tag: "ConversationCheckpointEvidenceInvalid" }),
      );
    }
    const [storedManifest, settled] = yield* Effect.all(
      [
        tx.transact(
          providerTurns.findManifestByTurn(owner.producerProviderTurnId),
        ),
        tx.transact(
          providerTurns.findSettledResult(owner.producerProviderTurnId),
        ),
      ],
      { concurrency: 1 },
    ).pipe(Effect.mapError(failure));
    if (
      storedManifest === null ||
      settled._tag !== "SettledSuccess" ||
      settled.evidenceVersion !== "provider-success-v1" ||
      settled.finishReason !== "Stop" ||
      settled.manifestId !== storedManifest.manifestId ||
      sourceManifest.producerManifestId !== storedManifest.manifestId ||
      settled.manifestJson !== storedManifest.manifestJson ||
      settled.turn.providerTurnId !== owner.producerProviderTurnId ||
      settled.turn.executionId !== owner.producerExecutionId ||
      settled.turn.sessionId !== execution.sessionId ||
      Number(settled.turn.contextEpoch) !== Number(sourceManifest.fromEpoch) ||
      Number(sourceManifest.toEpoch) !== Number(owner.contextEpoch) ||
      sourceManifest.producerProviderTurnId !== owner.producerProviderTurnId ||
      sourceManifest.producerExecutionId !== owner.producerExecutionId
    ) {
      return yield* Effect.fail(
        failure({ _tag: "ConversationCheckpointEvidenceInvalid" }),
      );
    }
    let manifest: Record<string, unknown>;
    let request: Record<string, unknown>;
    try {
      const parsedManifest = JSON.parse(storedManifest.manifestJson) as unknown;
      const parsedRequest = JSON.parse(
        storedManifest.portableRequestJson,
      ) as unknown;
      if (
        typeof parsedManifest !== "object" ||
        parsedManifest === null ||
        Array.isArray(parsedManifest) ||
        typeof parsedRequest !== "object" ||
        parsedRequest === null ||
        Array.isArray(parsedRequest)
      ) {
        throw new Error("provider manifest/request shape invalid");
      }
      manifest = parsedManifest as Record<string, unknown>;
      request = parsedRequest as Record<string, unknown>;
    } catch {
      return yield* Effect.fail(
        failure({ _tag: "ConversationCheckpointEvidenceInvalid" }),
      );
    }
    const expectedOperation =
      owner.checkpointKind === "Summary"
        ? "CompactionSummary"
        : "CompactionNative";
    const expectedContract =
      owner.checkpointKind === "Summary"
        ? "compaction-result-v1"
        : "provider-native-compaction-v1";
    if (
      manifest.providerTurnId !== owner.producerProviderTurnId ||
      manifest.executionId !== owner.producerExecutionId ||
      manifest.sessionId !== execution.sessionId ||
      manifest.modelRef !== settled.turn.modelRef ||
      Number(manifest.contextEpoch) !== Number(sourceManifest.fromEpoch) ||
      manifest.operationKind !== expectedOperation ||
      manifest.outputContractRef !== expectedContract ||
      request.operationKind !== expectedOperation ||
      request.outputContractRef !== expectedContract ||
      typeof manifest.compiledRequestHash !== "string" ||
      manifest.compiledRequestHash !== sha256Hex(JSON.stringify(request)) ||
      manifest.resolvedModelBindingFingerprint === undefined ||
      typeof manifest.resolvedModelBindingFingerprint !== "string" ||
      manifest.resolvedModelBindingFingerprint.length === 0 ||
      (owner.checkpointKind === "ProviderNative" &&
        manifest.resolvedModelBindingFingerprint !== owner.bindingFingerprint)
    ) {
      return yield* Effect.fail(
        failure({ _tag: "ConversationCheckpointEvidenceInvalid" }),
      );
    }
    const nested = manifest.conversationCheckpoint;
    if (
      typeof nested !== "object" ||
      nested === null ||
      Array.isArray(nested) ||
      JSON.stringify(nested) !==
        JSON.stringify({
          rootWorkspaceId: sourceManifest.rootWorkspaceId,
          fromEpoch: sourceManifest.fromEpoch,
          toEpoch: sourceManifest.toEpoch,
          fromFrontier: sourceManifest.fromFrontier,
          coveredThrough: sourceManifest.coveredThrough,
          coveredSources: sourceManifest.coveredSources,
          currentMessageId: sourceManifest.currentMessageId,
          currentRunningJobRevision: sourceManifest.currentRunningJobRevision,
          currentRunningAttemptNo: sourceManifest.currentRunningAttemptNo,
          currentAdmissionJobRevision:
            sourceManifest.currentAdmissionJobRevision,
        })
    ) {
      return yield* Effect.fail(
        failure({ _tag: "ConversationCheckpointEvidenceInvalid" }),
      );
    }
    if (owner.checkpointKind === "ProviderNative") {
      const continuationStates = settled.canonicalEvents.filter(
        (event) => event._tag === "ContinuationState",
      );
      if (
        continuationStates.length !== 1 ||
        continuationStates[0]?._tag !== "ContinuationState" ||
        continuationStates[0].stateRef !== owner.checkpointRef
      ) {
        return yield* Effect.fail(
          failure({ _tag: "ConversationCheckpointEvidenceInvalid" }),
        );
      }
    }
  });
