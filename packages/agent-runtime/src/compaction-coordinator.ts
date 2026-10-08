import {
  ContextEpochNumber,
  type Execution,
  type ProviderTurnId,
  parse,
} from "@arbor/domain";
import type {
  PortableInputItem,
  ProviderRuntimeService,
  SecretRef,
  SessionCompactionCommit,
  SessionRepositoryService,
  SessionWriteFence,
  TransactionPortService,
} from "@arbor/ports";
import { sha256Hex } from "@arbor/ports";
import { Effect } from "effect";
import type { AgentLoopQualificationProbe } from "./qualification-probe.js";

export interface SummaryCompactionInput {
  readonly execution: Execution;
  readonly logicalStepNo: number;
  readonly currentEpoch: ContextEpochNumber;
  readonly modelRef: string;
  readonly secretRef?: SecretRef;
  readonly bindingFingerprint: string;
  readonly inputItems: ReadonlyArray<PortableInputItem>;
  readonly fence: SessionWriteFence;
}

interface CompactionDependencies {
  readonly providerRuntime: ProviderRuntimeService;
  readonly sessions: SessionRepositoryService;
  readonly tx: TransactionPortService;
  /** Explicit test-only crash boundary; absent in production. */
  readonly qualificationProbe?: AgentLoopQualificationProbe;
}

const commitCheckpointEpoch = (
  input: {
    readonly execution: Execution;
    readonly providerTurnId: ProviderTurnId;
    readonly expectedEpoch: ContextEpochNumber;
    readonly nextEpoch: ContextEpochNumber;
    readonly checkpoint: SessionCompactionCommit["checkpoint"];
    readonly fence: SessionWriteFence;
  },
  deps: Pick<CompactionDependencies, "sessions" | "tx" | "qualificationProbe">,
) =>
  Effect.gen(function* () {
    const probe = deps.qualificationProbe;
    const probeIdentity = {
      executionId: String(input.execution.executionId),
      providerTurnId: String(input.providerTurnId),
    };
    if (probe !== undefined) {
      yield* Effect.promise(() =>
        probe({
          boundary: "AH17BeforeCheckpointEpochCommit",
          ...probeIdentity,
        }),
      );
    }
    const committed = yield* deps.tx.transact(
      deps.sessions.commitCompaction(
        input.execution.sessionId,
        {
          expectedEpoch: input.expectedEpoch,
          nextEpoch: input.nextEpoch,
          checkpoint: input.checkpoint,
          source: { kind: "CompactionTurn", ref: input.providerTurnId },
          contentHash: sha256Hex(JSON.stringify(input.checkpoint)),
        },
        input.fence,
      ),
    );
    if (probe !== undefined) {
      yield* Effect.promise(() =>
        probe({
          boundary: "AH17AfterCheckpointEpochCommit",
          ...probeIdentity,
        }),
      );
    }
    return committed;
  });

export const runSummaryCompaction = (
  input: SummaryCompactionInput,
  deps: CompactionDependencies,
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
      ...(input.secretRef === undefined ? {} : { secretRef: input.secretRef }),
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
    yield* commitCheckpointEpoch(
      {
        execution: input.execution,
        providerTurnId,
        expectedEpoch: input.currentEpoch,
        nextEpoch,
        checkpoint,
        fence: input.fence,
      },
      deps,
    );
    return { newEpoch: nextEpoch, providerTurnId, summary };
  });

export const runNativeCompaction = (
  input: SummaryCompactionInput,
  deps: CompactionDependencies,
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
      ...(input.secretRef === undefined ? {} : { secretRef: input.secretRef }),
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
    yield* commitCheckpointEpoch(
      {
        execution: input.execution,
        providerTurnId,
        expectedEpoch: input.currentEpoch,
        nextEpoch,
        checkpoint,
        fence: input.fence,
      },
      deps,
    );
    return { newEpoch: nextEpoch, providerTurnId, opaqueItemRef };
  });

export interface RecoveredSummaryCompactionInput {
  readonly execution: Execution;
  readonly providerTurnId: ProviderTurnId;
  readonly expectedEpoch: ContextEpochNumber;
  readonly bindingFingerprint: string;
  readonly summary: string;
  readonly fence: SessionWriteFence;
}

/** Commit a summary already durably returned by the same compaction ProviderTurn.
 * Recovery uses this after validating the persisted ProviderTurn manifest and
 * success receipt; it never issues another provider request. */
export const commitRecoveredSummaryCompaction = (
  input: RecoveredSummaryCompactionInput,
  deps: Pick<CompactionDependencies, "sessions" | "tx" | "qualificationProbe">,
) =>
  Effect.gen(function* () {
    const summary = input.summary.trim();
    if (summary.length === 0) {
      return yield* Effect.fail({
        _tag: "SummaryCompactionInvalid" as const,
        reason: "persisted provider receipt contained no summary",
      });
    }
    const nextEpoch = parse(ContextEpochNumber)(
      Number(input.expectedEpoch) + 1,
    );
    const checkpoint = {
      _tag: "CompactionCheckpoint" as const,
      implementation: "Summary" as const,
      fromEpoch: input.expectedEpoch,
      toEpoch: nextEpoch,
      retainedFrontierRef: `frontier:${input.execution.sessionId}:${input.expectedEpoch}`,
      summaryRef: `summary:${sha256Hex(summary)}`,
      summaryText: summary,
      bindingFingerprint: null,
    };
    yield* commitCheckpointEpoch(
      {
        execution: input.execution,
        providerTurnId: input.providerTurnId,
        expectedEpoch: input.expectedEpoch,
        nextEpoch,
        checkpoint,
        fence: input.fence,
      },
      deps,
    );
    return { newEpoch: nextEpoch, providerTurnId: input.providerTurnId };
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
