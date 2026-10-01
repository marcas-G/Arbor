import {
  ContextEpochNumber,
  type Execution,
  type ProviderTurnId,
  parse,
} from "@arbor/domain";
import type {
  PortableInputItem,
  ProviderRuntimeService,
  SessionRepositoryService,
  SessionWriteFence,
  TransactionPortService,
} from "@arbor/ports";
import { sha256Hex } from "@arbor/ports";
import { Effect } from "effect";

export interface SummaryCompactionInput {
  readonly execution: Execution;
  readonly logicalStepNo: number;
  readonly currentEpoch: ContextEpochNumber;
  readonly modelRef: string;
  readonly bindingFingerprint: string;
  readonly inputItems: ReadonlyArray<PortableInputItem>;
  readonly fence: SessionWriteFence;
}

export const runSummaryCompaction = (
  input: SummaryCompactionInput,
  deps: {
    readonly providerRuntime: ProviderRuntimeService;
    readonly sessions: SessionRepositoryService;
    readonly tx: TransactionPortService;
  },
) =>
  Effect.gen(function* () {
    const providerTurnId =
      `ptn_${input.execution.executionId}_${input.logicalStepNo}_compact_${input.currentEpoch}` as ProviderTurnId;
    const nextEpoch = parse(ContextEpochNumber)(Number(input.currentEpoch) + 1);
    const request = {
      requestVersion: 2 as const,
      operationKind: "CompactionSummary" as const,
      modelRef: input.modelRef,
      instructions: [
        {
          slotId: "compaction",
          authorityRole: "A0",
          text: "Produce a compact continuation summary preserving objective, constraints, decisions, progress, blockers, next actions, and relevant references.",
        },
      ],
      inputItems: input.inputItems,
      toolDefinitions: [],
      outputContractRef: "compaction-result-v1",
      budget: { maxOutputTokens: 2048 },
      cacheHints: [],
    };
    const manifest = {
      providerTurnId,
      executionId: input.execution.executionId,
      sessionId: input.execution.sessionId,
      contextEpoch: input.currentEpoch,
      modelRef: input.modelRef,
      outputContractRef: "compaction-result-v1",
      compiledRequestHash: sha256Hex(JSON.stringify(request)),
      operationKind: "CompactionSummary",
      logicalStepNo: input.logicalStepNo,
      resolvedModelBindingFingerprint: input.bindingFingerprint,
    };
    const result = yield* deps.providerRuntime.runTurn({
      providerTurnId,
      executionId: input.execution.executionId,
      sessionId: input.execution.sessionId,
      contextEpoch: input.currentEpoch,
      modelRef: input.modelRef,
      outputContractRef: "compaction-result-v1",
      manifestJson: JSON.stringify(manifest),
      request,
    });
    const summary = result.events
      .flatMap((event) => (event._tag === "TextDelta" ? [event.text] : []))
      .join("")
      .trim();
    if (summary.length === 0) {
      return yield* Effect.fail({
        _tag: "SummaryCompactionInvalid" as const,
        reason: "provider returned no summary text",
      });
    }
    const checkpoint = {
      _tag: "CompactionCheckpoint" as const,
      implementation: "Summary" as const,
      fromEpoch: input.currentEpoch,
      toEpoch: nextEpoch,
      retainedFrontierRef: `frontier:${input.execution.sessionId}:${input.currentEpoch}`,
      summaryRef: `summary:${sha256Hex(summary)}`,
      summaryText: summary,
      bindingFingerprint: null,
    };
    yield* deps.tx.transact(
      deps.sessions.commitCompaction(
        input.execution.sessionId,
        {
          expectedEpoch: input.currentEpoch,
          nextEpoch,
          checkpoint,
          source: { kind: "CompactionTurn", ref: providerTurnId },
          contentHash: sha256Hex(JSON.stringify(checkpoint)),
        },
        input.fence,
      ),
    );
    return { newEpoch: nextEpoch, providerTurnId, summary };
  });

export const runNativeCompaction = (
  input: SummaryCompactionInput,
  deps: {
    readonly providerRuntime: ProviderRuntimeService;
    readonly sessions: SessionRepositoryService;
    readonly tx: TransactionPortService;
  },
) =>
  Effect.gen(function* () {
    const providerTurnId =
      `ptn_${input.execution.executionId}_${input.logicalStepNo}_native_compact_${input.currentEpoch}` as ProviderTurnId;
    const nextEpoch = parse(ContextEpochNumber)(Number(input.currentEpoch) + 1);
    const request = {
      requestVersion: 2 as const,
      operationKind: "CompactionNative" as const,
      modelRef: input.modelRef,
      instructions: [],
      inputItems: input.inputItems,
      toolDefinitions: [],
      outputContractRef: "provider-native-compaction-v1",
      budget: { maxOutputTokens: 0 },
      cacheHints: [],
    };
    const manifest = {
      providerTurnId,
      executionId: input.execution.executionId,
      sessionId: input.execution.sessionId,
      contextEpoch: input.currentEpoch,
      modelRef: input.modelRef,
      outputContractRef: request.outputContractRef,
      compiledRequestHash: sha256Hex(JSON.stringify(request)),
      operationKind: request.operationKind,
      logicalStepNo: input.logicalStepNo,
      resolvedModelBindingFingerprint: input.bindingFingerprint,
    };
    const result = yield* deps.providerRuntime.runTurn({
      providerTurnId,
      executionId: input.execution.executionId,
      sessionId: input.execution.sessionId,
      contextEpoch: input.currentEpoch,
      modelRef: input.modelRef,
      outputContractRef: request.outputContractRef,
      manifestJson: JSON.stringify(manifest),
      request,
    });
    const opaqueItemRef = result.events.find(
      (event) => event._tag === "ContinuationState",
    )?.stateRef;
    if (opaqueItemRef === undefined) {
      return yield* Effect.fail({
        _tag: "NativeCompactionInvalid" as const,
        reason: "provider returned no opaque continuation item",
      });
    }
    const checkpoint = {
      _tag: "CompactionCheckpoint" as const,
      implementation: "ProviderNative" as const,
      fromEpoch: input.currentEpoch,
      toEpoch: nextEpoch,
      retainedFrontierRef: `frontier:${input.execution.sessionId}:${input.currentEpoch}`,
      opaqueItemRef,
      bindingFingerprint: input.bindingFingerprint,
    };
    yield* deps.tx.transact(
      deps.sessions.commitCompaction(
        input.execution.sessionId,
        {
          expectedEpoch: input.currentEpoch,
          nextEpoch,
          checkpoint,
          source: { kind: "CompactionTurn", ref: providerTurnId },
          contentHash: sha256Hex(JSON.stringify(checkpoint)),
        },
        input.fence,
      ),
    );
    return { newEpoch: nextEpoch, providerTurnId, opaqueItemRef };
  });

export const runCompaction = (
  input: SummaryCompactionInput & { readonly nativeSupported: boolean },
  deps: Parameters<typeof runSummaryCompaction>[1],
) =>
  Effect.gen(function* () {
    if (input.nativeSupported) {
      return yield* runNativeCompaction(input, deps);
    }
    return yield* runSummaryCompaction(input, deps);
  });
