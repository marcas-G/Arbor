import {
  ContextEpochNumber,
  type ExecutionSettlement,
  parse,
  ProviderTurnId,
  providerTurnOverflowReplacementId as makeOverflowReplacementProviderTurnId,
} from "@arbor/domain";
import { projectSessionTimeline, type SessionTimelineProjection } from "@arbor/model-context";
import type {
  AgentLoopStepIdentity,
  AgentLoopStepRecord,
  ExecutionDriverError,
  SessionEntryRecord,
} from "@arbor/ports";
import { Effect, Option } from "effect";
import { type ModelDecisionOutcome, safetyStop } from "../../agent-loop-policy.js";
import { decodeUniqueNativePortableFrontier } from "../../checkpoint/native-evidence.js";
import { runSummaryCompaction, type SummaryCompactionInput } from "../../compaction-coordinator.js";
import type { ModelDecisionDependencies } from "../contract.js";
import type { OverflowRecoveryState } from "./overflow-state.js";

type WorkPlanRebaseDependencies = Pick<
  ModelDecisionDependencies,
  "input" | "capability" | "tx" | "sessions" | "loopSteps" |
  "loopStepFence" | "providerTurns" | "options" | "failure" | "now"
>;

type WorkPlanRebaseResult =
  | { readonly _tag: "Complete"; readonly outcome: ModelDecisionOutcome }
  | {
      readonly _tag: "Restart";
      readonly compactionAttempts: number;
      readonly overflow: OverflowRecoveryState;
    };

/** Preserve the existing local-plan binding-mismatch recovery path.
 * The caller owns the condition selecting this path and the decision loop. */
export const rebaseWorkPlanCheckpoint = (
  dependencies: WorkPlanRebaseDependencies,
  phase: {
    readonly turn: number;
    readonly loopStepIdentity: AgentLoopStepIdentity;
    readonly loopStep: AgentLoopStepRecord | undefined;
    readonly nativeCheckpoint: NonNullable<SessionTimelineProjection["nativeCheckpoint"]>;
    readonly recentSessionEntries: ReadonlyArray<SessionEntryRecord>;
    readonly currentBindingFingerprint: string;
    readonly providerNativeSupported: boolean;
    readonly reasoningProjectionBinding: Parameters<typeof projectSessionTimeline>[3];
    readonly reasoningAttachmentBlobs: ReadonlyMap<string, Uint8Array>;
    readonly compactionDependencies: Parameters<typeof runSummaryCompaction>[1];
    readonly loadWorkCompactionPinning: () => Effect.Effect<
      Pick<SummaryCompactionInput, "pinnedInstructions" | "pinnedInstructionFragments" | "controlBasis">,
      ExecutionDriverError
    >;
    readonly proposeSettlement: (
      settlement: ExecutionSettlement,
    ) => Effect.Effect<ModelDecisionOutcome, ExecutionDriverError>;
    readonly compactionAttempts: number;
    readonly overflow: OverflowRecoveryState;
  },
): Effect.Effect<WorkPlanRebaseResult, ExecutionDriverError> => {
  const {
    input, capability, tx, sessions, loopSteps, loopStepFence,
    providerTurns, options, failure, now,
  } = dependencies;
  const {
    turn, loopStepIdentity, loopStep, nativeCheckpoint, recentSessionEntries,
    currentBindingFingerprint, providerNativeSupported, reasoningProjectionBinding,
    reasoningAttachmentBlobs, compactionDependencies, loadWorkCompactionPinning,
    proposeSettlement,
  } = phase;
  return Effect.gen(function* () {
    let {
      overflowRecoveryAttempt,
      overflowReplacementProviderTurnId,
      replayPersistedContextLimit,
    } = phase.overflow;
    if (providerTurns === undefined || loopStepFence === undefined) {
      return yield* Effect.fail(
        failure({ _tag: "AgentLoopStepReplayBindingMismatch" }),
      );
    }
    let nativeProviderTurnId: ProviderTurnId;
    try {
      nativeProviderTurnId = parse(ProviderTurnId)(
        nativeCheckpoint.providerTurnId,
      );
    } catch {
      return yield* Effect.fail(
        failure({ _tag: "AgentLoopStepReplayBindingMismatch" }),
      );
    }
    const [nativeManifestRow, nativeReceipt] = yield* Effect.all(
      [
        tx.transact(
          providerTurns.findManifestByTurn(nativeProviderTurnId),
        ),
        tx.transact(
          providerTurns.findSettledResult(nativeProviderTurnId),
        ),
      ],
      { concurrency: 1 },
    ).pipe(Effect.mapError(failure));
    if (
      nativeManifestRow === null ||
      nativeReceipt._tag !== "SettledSuccess" ||
      nativeReceipt.evidenceVersion !== "provider-success-v1" ||
      nativeReceipt.finishReason !== "Stop" ||
      nativeReceipt.turn.providerTurnId !== nativeProviderTurnId ||
      nativeReceipt.turn.sessionId !== input.execution.sessionId ||
      nativeReceipt.manifestJson !== nativeManifestRow.manifestJson
    ) {
      return yield* Effect.fail(
        failure({ _tag: "AgentLoopStepReplayBindingMismatch" }),
      );
    }
    const nativeFrontier = decodeUniqueNativePortableFrontier(
      nativeManifestRow.manifestJson,
      nativeManifestRow.portableRequestJson,
    );
    const nativeManifest = nativeFrontier?.manifest;
    const nativeStateRefs = nativeReceipt.canonicalEvents.filter(
      (event) => event._tag === "ContinuationState",
    );
    if (
      nativeFrontier === null ||
      nativeManifest === undefined ||
      nativeManifest.providerTurnId !== nativeProviderTurnId ||
      nativeManifest.executionId !== nativeReceipt.turn.executionId ||
      nativeManifest.sessionId !== input.execution.sessionId ||
      nativeManifest.contextEpoch !== nativeCheckpoint.fromEpoch ||
      nativeManifest.operationKind !== "CompactionNative" ||
      nativeManifest.outputContractRef !==
        "provider-native-compaction-v1" ||
      nativeManifest.resolvedModelBindingFingerprint !==
        nativeCheckpoint.bindingFingerprint ||
      nativeReceipt.turn.contextEpoch !== nativeCheckpoint.fromEpoch ||
      nativeReceipt.turn.modelRef !== nativeManifest.modelRef ||
      nativeReceipt.turn.outputContractRef !==
        "provider-native-compaction-v1" ||
      nativeStateRefs.length !== 1 ||
      nativeStateRefs[0]?._tag !== "ContinuationState" ||
      nativeStateRefs[0].stateRef !== nativeCheckpoint.opaqueItemRef ||
      (nativeFrontier.inputFrontier.lastSequence !== null &&
        nativeFrontier.inputFrontier.lastSequence >=
          nativeCheckpoint.sequence) ||
      nativeFrontier.inputItems.some(
        (item) =>
          item._tag === "CompactionCheckpoint" &&
          item.implementation === "ProviderNative",
      )
    ) {
      return yield* Effect.fail(
        failure({ _tag: "AgentLoopStepReplayBindingMismatch" }),
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
      ...nativeFrontier.contextRefs,
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
    const rebuiltFrontier = {
      firstSequence: nativeFrontier.inputFrontier.firstSequence,
      lastSequence:
        postCheckpointProjection.frontier.lastSequence !== null
          ? postCheckpointProjection.frontier.lastSequence
          : nativeFrontier.inputFrontier.lastSequence,
    };
    if (
      rebuiltFrontier.firstSequence !== null &&
      rebuiltFrontier.lastSequence !== null &&
      rebuiltFrontier.lastSequence < rebuiltFrontier.firstSequence
    ) {
      return yield* Effect.fail(
        failure({ _tag: "AgentLoopStepReplayBindingMismatch" }),
      );
    }
    const [stepProviderLinks, sourceSession] = yield* Effect.all(
      [
        loopSteps === undefined
          ? Effect.succeed([])
          : tx.transact(
              loopSteps.listProviderTurnLinks(loopStepIdentity),
            ),
        tx.transact(sessions.findById(input.execution.sessionId)),
      ],
      { concurrency: 1 },
    ).pipe(Effect.mapError(failure));
    if (Option.isNone(sourceSession)) {
      return yield* Effect.fail(
        failure({ _tag: "AgentLoopStepReplayBindingMismatch" }),
      );
    }
    const isOverflowNativeCheckpoint = stepProviderLinks.some(
      (link) =>
        link.role === "OverflowCompaction" &&
        link.providerTurnId === nativeProviderTurnId,
    );
    const portableItems = [
      ...nativeFrontier.inputItems,
      ...postCheckpointProjection.inputItems,
    ];
    if (loopStep === undefined) {
      return yield* Effect.fail(
        failure({ _tag: "AgentLoopStepReplayBindingMismatch" }),
      );
    }
    const rebuilt = yield* runSummaryCompaction(
      {
        execution: input.execution,
        logicalStepNo: loopStepIdentity.logicalStepNo,
        sourceAgentLoopStep: {
          executionId: String(loopStepIdentity.executionId),
          logicalStepNo: loopStepIdentity.logicalStepNo,
          repairAttempt: loopStepIdentity.repairAttempt,
          providerTurnId: String(loopStep.providerTurnId),
        },
        currentEpoch: sourceSession.value.contextEpoch,
        modelRef: capability.modelRef,
        ...(options.secretRef === undefined
          ? {}
          : { secretRef: options.secretRef }),
        bindingFingerprint: currentBindingFingerprint,
        inputFrontier: rebuiltFrontier,
        contextRefs: portableContextRefs,
        inputItems: portableItems,
        ...(yield* loadWorkCompactionPinning()),
        fence: loopStepFence,
      },
      compactionDependencies,
    ).pipe(Effect.mapError(failure));
    if ("_tag" in rebuilt) {
      return {
        _tag: "Complete" as const,
        outcome: yield* proposeSettlement(safetyStop("RuntimeSafetyStop")),
      };
    }
    if (
      Number(rebuilt.newEpoch) !==
      Number(sourceSession.value.contextEpoch) + 1
    ) {
      return yield* Effect.fail(
        failure({ _tag: "AgentLoopStepReplayBindingMismatch" }),
      );
    }
    if (isOverflowNativeCheckpoint) {
      const replacementProviderTurnId =
        makeOverflowReplacementProviderTurnId(
          input.execution.executionId,
          turn,
        );
      const existingReplacement = stepProviderLinks.filter(
        (link) => link.role === "OverflowReplacement",
      );
      if (existingReplacement.length > 1) {
        return yield* Effect.fail(
          failure({ _tag: "AgentLoopStepReplayBindingMismatch" }),
        );
      }
      const priorReplacement = existingReplacement[0];
      if (priorReplacement !== undefined) {
        if (
          priorReplacement.providerTurnId !==
            replacementProviderTurnId ||
          priorReplacement.predecessorProviderTurnId !==
            nativeProviderTurnId ||
          Number(priorReplacement.contextEpoch) !==
            Number(rebuilt.newEpoch)
        ) {
          return yield* Effect.fail(
            failure({ _tag: "AgentLoopStepReplayBindingMismatch" }),
          );
        }
      } else {
        if (loopSteps === undefined) {
          return yield* Effect.fail(
            failure({ _tag: "AgentLoopStepReplayBindingMismatch" }),
          );
        }
        yield* tx
          .transact(
            loopSteps.ensureProviderTurnLink(
              {
                identity: loopStepIdentity,
                overflowOrdinal: 0,
                role: "OverflowReplacement",
                providerTurnId: replacementProviderTurnId,
                predecessorProviderTurnId: nativeProviderTurnId,
                contextEpoch: parse(ContextEpochNumber)(
                  Number(rebuilt.newEpoch),
                ),
                state: "Prepared",
                createdAt: yield* now(),
              },
              loopStepFence,
            ),
          )
          .pipe(Effect.mapError(failure));
      }
      overflowRecoveryAttempt = 1;
      overflowReplacementProviderTurnId = replacementProviderTurnId;
      replayPersistedContextLimit = false;
    }
    return {
      _tag: "Restart" as const,
      compactionAttempts: Math.max(phase.compactionAttempts, 1),
      overflow: {
        ...phase.overflow,
        overflowRecoveryAttempt,
        overflowReplacementProviderTurnId,
        replayPersistedContextLimit,
      },
    };
  });
};
