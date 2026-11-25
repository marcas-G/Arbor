import {
  ContextEpochNumber,
  providerTurnOverflowReplacementId as makeOverflowReplacementProviderTurnId,
  type ProviderTurnId,
  parse,
  providerTurnNativeCompactionId,
  providerTurnSummaryCompactionId,
} from "@arbor/domain";
import type {
  AgentLoopStepIdentity,
  AgentLoopStepRecord,
  ExecutionDriverError,
  PortableModelRequestV2,
  SessionRepositoryService,
} from "@arbor/ports";
import { sha256Hex } from "@arbor/ports";
import { Effect, Option } from "effect";
import { type ModelDecisionOutcome, safetyStop } from "../agent-loop-policy.js";
import {
  decodeExhaustedRepairDisposition,
  isValidOverflowCompactionLinkPair,
} from "../agent-loop-step-recovery.js";
import {
  decodeUniqueNativePortableFrontier,
  portableRequestHasNativeCheckpoint,
} from "../checkpoint/native-evidence.js";
import {
  commitRecoveredNativeCompaction,
  commitRecoveredSummaryCompaction,
  runSummaryCompaction,
  type SummaryCompactionInput,
} from "../compaction-coordinator.js";
import type { ModelDecisionDependencies } from "./contract.js";

type StepRecoveryDependencies = Pick<
  ModelDecisionDependencies,
  | "input"
  | "capability"
  | "tx"
  | "loopSteps"
  | "loopStepFence"
  | "providerTurns"
  | "sessions"
  | "options"
  | "failure"
  | "now"
  | "conversationCheckpoints"
>;

/** Process-local continuation only; durable Step/ProviderTurn state remains
 * owned by the existing stores and fenced transactions. */
export interface OverflowRecoveryState {
  readonly overflowRecoveryAttempt: number;
  readonly replayPersistedContextLimit: boolean;
  readonly resumeOverflowCompactionProviderTurnId: ProviderTurnId | undefined;
  readonly resumeOverflowNativeCompaction: boolean;
  readonly resumeOverflowNativeCompactionInput:
    | {
        readonly manifestJson: string;
        readonly request: PortableModelRequestV2;
      }
    | undefined;
  readonly overflowReplacementProviderTurnId: ProviderTurnId | undefined;
}

export type StepRecoveryResult =
  | {
      readonly _tag: "Ready";
      readonly loopStep: AgentLoopStepRecord | undefined;
      readonly overflow: OverflowRecoveryState;
    }
  | { readonly _tag: "Restart"; readonly overflow: OverflowRecoveryState }
  | { readonly _tag: "Complete"; readonly outcome: ModelDecisionOutcome };

export const recoverDecisionStep = (
  dependencies: StepRecoveryDependencies,
  phase: {
    readonly turn: number;
    readonly repairAttempt: number;
    readonly providerTurnId: ProviderTurnId;
    readonly loopStepIdentity: AgentLoopStepIdentity;
    readonly overflow: OverflowRecoveryState;
    readonly isConversationResponseExecution: boolean;
    readonly currentBindingFingerprint: string;
    readonly providerNativeSupported: boolean;
    readonly compactionDependencies: Parameters<typeof runSummaryCompaction>[1];
    readonly readExecutionTimeline: () => ReturnType<
      SessionRepositoryService["listRecentEntries"]
    >;
    readonly loadWorkCompactionPinning: () => Effect.Effect<
      Pick<
        SummaryCompactionInput,
        "pinnedInstructions" | "pinnedInstructionFragments" | "controlBasis"
      >,
      ExecutionDriverError
    >;
  },
): Effect.Effect<StepRecoveryResult, ExecutionDriverError> => {
  const {
    input,
    capability,
    tx,
    loopSteps,
    loopStepFence,
    providerTurns,
    sessions,
    options,
    failure,
    now,
  } = dependencies;
  const {
    turn,
    repairAttempt,
    providerTurnId,
    loopStepIdentity,
    isConversationResponseExecution,
    currentBindingFingerprint,
    providerNativeSupported,
    compactionDependencies,
    readExecutionTimeline,
    loadWorkCompactionPinning,
  } = phase;
  return Effect.gen(function* () {
    let {
      overflowRecoveryAttempt,
      replayPersistedContextLimit,
      resumeOverflowCompactionProviderTurnId,
      resumeOverflowNativeCompaction,
      resumeOverflowNativeCompactionInput,
      overflowReplacementProviderTurnId,
    } = phase.overflow;
    const recoveryState = (): OverflowRecoveryState => ({
      overflowRecoveryAttempt,
      replayPersistedContextLimit,
      resumeOverflowCompactionProviderTurnId,
      resumeOverflowNativeCompaction,
      resumeOverflowNativeCompactionInput,
      overflowReplacementProviderTurnId,
    });
    let loopStep: AgentLoopStepRecord | undefined;
    if (loopSteps !== undefined && loopStepFence !== undefined) {
      loopStep = yield* tx
        .transact(
          Effect.gen(function* () {
            const existing = yield* loopSteps.find(loopStepIdentity);
            if (Option.isSome(existing)) return existing.value;
            return yield* loopSteps.createPrepared(
              {
                identity: loopStepIdentity,
                providerTurnId,
                state: "Prepared",
                nextActionIndex: 0,
                revision: 0,
                updatedAt: yield* now(),
              },
              loopStepFence,
            );
          }),
        )
        .pipe(Effect.mapError(failure));
      if (loopStep.state === "OutputRejected") {
        const settlement = decodeExhaustedRepairDisposition(
          loopStep.repairDisposition,
        );
        if (
          settlement === undefined ||
          loopStep.successor !== undefined ||
          loopStep.providerTurnId !== providerTurnId ||
          loopStep.identity.logicalStepNo !== turn ||
          loopStep.identity.repairAttempt !== repairAttempt
        ) {
          return yield* Effect.fail(
            failure({ _tag: "AgentLoopStepReplayBindingMismatch" }),
          );
        }
        const exhaustedStep = loopStep;
        loopStep = yield* tx
          .transact(
            loopSteps.transition(
              {
                identity: exhaustedStep.identity,
                expectedRevision: exhaustedStep.revision,
                expectedState: "OutputRejected",
                next: {
                  ...exhaustedStep,
                  state: "SettlementProposed",
                  settlement,
                  revision: exhaustedStep.revision + 1,
                  updatedAt: yield* now(),
                },
              },
              loopStepFence,
            ),
          )
          .pipe(Effect.mapError(failure));
        return { _tag: "Complete" as const, outcome: { _tag: "Settle" as const, settlement } };
      }
      if (
        overflowRecoveryAttempt === 0 &&
        loopStep.state === "Prepared" &&
        providerTurns !== undefined &&
        resumeOverflowCompactionProviderTurnId === undefined
      ) {
        const activeLoopStep = loopStep;
        // Overflow recovery is relevant only when the original inference
        // already has durable ContextLimitExceeded failure evidence. This
        // keeps ordinary Prepared steps from requiring the v1.23 chain
        // table, while a real overflow with missing chain storage still
        // fails closed when the chain read below is attempted.
        const originalInference = yield* tx
          .transact(providerTurns.findSettledResult(loopStep.providerTurnId))
          .pipe(Effect.mapError(failure));
        if (
          originalInference._tag === "SettledFailure" &&
          originalInference.failureKind === "ContextLimitExceeded"
        ) {
          const providerTurnLinks = yield* tx
            .transact(loopSteps.listProviderTurnLinks(loopStepIdentity))
            .pipe(Effect.mapError(failure));
          const inferenceLinks = providerTurnLinks.filter(
            (link) => link.role === "Inference",
          );
          const compactionLinks = providerTurnLinks.filter(
            (link) => link.role === "OverflowCompaction",
          );
          const replacementLinks = providerTurnLinks.filter(
            (link) => link.role === "OverflowReplacement",
          );
          if (isConversationResponseExecution) {
            if (
              dependencies.conversationCheckpoints === undefined ||
              loopStepFence === undefined
            ) {
              return yield* Effect.fail(
                failure({
                  _tag: "ConversationCheckpointRuntimeUnavailable",
                }),
              );
            }
            const ownerOption = yield* tx
              .transact(
                dependencies.conversationCheckpoints.findOwner(
                  input.execution.workspaceId,
                ),
              )
              .pipe(Effect.mapError(failure));
            const owner = Option.isSome(ownerOption)
              ? ownerOption.value
              : undefined;
            const ownerEpoch = Number(owner?.contextEpoch ?? 0);
            const inference = originalInference.turn;
            if (
              inference.providerTurnId !== loopStep.providerTurnId ||
              inference.executionId !== input.execution.executionId ||
              inference.sessionId !== input.execution.sessionId ||
              inference.modelRef !== capability.modelRef ||
              ownerEpoch < Number(inference.contextEpoch) ||
              ownerEpoch > Number(inference.contextEpoch) + 1
            ) {
              return yield* Effect.fail(
                failure({ _tag: "AgentLoopStepReplayBindingMismatch" }),
              );
            }
            const nativeSupported =
              capability.portableRequestCompatibility?.operationKinds.includes(
                "CompactionNative",
              ) === true;
            let linkedCompactionProviderTurnId: ProviderTurnId;
            if (providerTurnLinks.length === 0) {
              if (ownerEpoch !== Number(inference.contextEpoch)) {
                return yield* Effect.fail(
                  failure({ _tag: "AgentLoopStepReplayBindingMismatch" }),
                );
              }
              const compactionProviderTurnId = nativeSupported
                ? providerTurnNativeCompactionId(
                    input.execution.executionId,
                    turn,
                    inference.contextEpoch,
                  )
                : providerTurnSummaryCompactionId(
                    input.execution.executionId,
                    turn,
                    inference.contextEpoch,
                  );
              const [compactionReceipt, replacementReceipt] =
                yield* Effect.all(
                  [
                    tx.transact(
                      providerTurns.findSettledResult(
                        compactionProviderTurnId,
                      ),
                    ),
                    tx.transact(
                      providerTurns.findSettledResult(
                        makeOverflowReplacementProviderTurnId(
                          input.execution.executionId,
                          turn,
                        ),
                      ),
                    ),
                  ],
                  { concurrency: 1 },
                ).pipe(Effect.mapError(failure));
              if (
                compactionReceipt._tag !== "NotFound" ||
                replacementReceipt._tag !== "NotFound"
              ) {
                return yield* Effect.fail(
                  failure({ _tag: "AgentLoopStepReplayBindingMismatch" }),
                );
              }
              linkedCompactionProviderTurnId = compactionProviderTurnId;
              yield* tx
                .transact(
                  Effect.gen(function* () {
                    const createdAt = yield* now();
                    yield* loopSteps.ensureProviderTurnLink(
                      {
                        identity: loopStepIdentity,
                        overflowOrdinal: 0,
                        role: "Inference",
                        providerTurnId: activeLoopStep.providerTurnId,
                        contextEpoch: inference.contextEpoch,
                        state: "SettledFailure",
                        createdAt,
                      },
                      loopStepFence,
                    );
                    yield* loopSteps.ensureProviderTurnLink(
                      {
                        identity: loopStepIdentity,
                        overflowOrdinal: 0,
                        role: "OverflowCompaction",
                        providerTurnId: compactionProviderTurnId,
                        predecessorProviderTurnId:
                          activeLoopStep.providerTurnId,
                        contextEpoch: inference.contextEpoch,
                        state: "Prepared",
                        createdAt,
                      },
                      loopStepFence,
                    );
                  }),
                )
                .pipe(Effect.mapError(failure));
            } else {
              const inferenceLink = inferenceLinks[0];
              const compactionLink = compactionLinks[0];
              if (
                (providerTurnLinks.length !== 2 &&
                  providerTurnLinks.length !== 3) ||
                replacementLinks.length > 1 ||
                inferenceLinks.length !== 1 ||
                compactionLinks.length !== 1 ||
                inferenceLink === undefined ||
                compactionLink === undefined ||
                !isValidOverflowCompactionLinkPair(
                  providerTurnLinks,
                  loopStep.providerTurnId,
                  [
                    providerTurnSummaryCompactionId(
                      input.execution.executionId,
                      turn,
                      inference.contextEpoch,
                    ),
                    providerTurnNativeCompactionId(
                      input.execution.executionId,
                      turn,
                      inference.contextEpoch,
                    ),
                  ],
                ) ||
                Number(compactionLink.contextEpoch) !==
                  Number(inference.contextEpoch)
              ) {
                return yield* Effect.fail(
                  failure({ _tag: "AgentLoopStepReplayBindingMismatch" }),
                );
              }
              linkedCompactionProviderTurnId = compactionLink.providerTurnId;
            }
            if (ownerEpoch === Number(inference.contextEpoch) + 1) {
              if (
                owner?.producerProviderTurnId !==
                  linkedCompactionProviderTurnId ||
                owner.producerExecutionId !== input.execution.executionId
              ) {
                return yield* Effect.fail(
                  failure({ _tag: "AgentLoopStepReplayBindingMismatch" }),
                );
              }
              const replacementProviderTurnId =
                makeOverflowReplacementProviderTurnId(
                  input.execution.executionId,
                  turn,
                );
              const existingReplacement = replacementLinks[0];
              if (
                existingReplacement !== undefined &&
                (existingReplacement.providerTurnId !==
                  replacementProviderTurnId ||
                  existingReplacement.predecessorProviderTurnId !==
                    linkedCompactionProviderTurnId ||
                  Number(existingReplacement.contextEpoch) !== ownerEpoch)
              ) {
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
                      predecessorProviderTurnId:
                        linkedCompactionProviderTurnId,
                      contextEpoch: owner.contextEpoch,
                      state: "Prepared",
                      createdAt: yield* now(),
                    },
                    loopStepFence,
                  ),
                )
                .pipe(Effect.mapError(failure));
              overflowReplacementProviderTurnId = replacementProviderTurnId;
              overflowRecoveryAttempt = 1;
              return { _tag: "Restart" as const, overflow: recoveryState() };
            }
            if (ownerEpoch !== Number(inference.contextEpoch)) {
              return yield* Effect.fail(
                failure({ _tag: "AgentLoopStepReplayBindingMismatch" }),
              );
            }
            if (replacementLinks.length !== 0) {
              return yield* Effect.fail(
                failure({ _tag: "AgentLoopStepReplayBindingMismatch" }),
              );
            }
            const compactionManifest = yield* tx
              .transact(
                providerTurns.findManifestByTurn(
                  linkedCompactionProviderTurnId,
                ),
              )
              .pipe(Effect.mapError(failure));
            const compactionReceipt = yield* tx
              .transact(
                providerTurns.findSettledResult(
                  linkedCompactionProviderTurnId,
                ),
              )
              .pipe(Effect.mapError(failure));
            const existingContract =
              compactionReceipt._tag === "Unsettled" ||
              compactionReceipt._tag === "SettledSuccess" ||
              compactionReceipt._tag === "SettledFailure"
                ? compactionReceipt.turn.outputContractRef
                : undefined;
            if (
              compactionManifest !== null &&
              compactionReceipt._tag === "NotFound"
            ) {
              return yield* Effect.fail(
                failure({ _tag: "AgentLoopStepReplayBindingMismatch" }),
              );
            }
            resumeOverflowNativeCompaction =
              existingContract === "provider-native-compaction-v1" ||
              (existingContract === undefined && nativeSupported);
            resumeOverflowCompactionProviderTurnId =
              linkedCompactionProviderTurnId;
            replayPersistedContextLimit = true;
            return { _tag: "Restart" as const, overflow: recoveryState() };
          }
          if (providerTurnLinks.length === 0) {
            const inference = originalInference.turn;
            const nativeSupported =
              capability.portableRequestCompatibility?.operationKinds.includes(
                "CompactionNative",
              ) === true;
            const compactionProviderTurnId = nativeSupported
              ? providerTurnNativeCompactionId(
                  input.execution.executionId,
                  turn,
                  inference.contextEpoch,
                )
              : providerTurnSummaryCompactionId(
                  input.execution.executionId,
                  turn,
                  inference.contextEpoch,
                );
            const replacementProviderTurnId =
              makeOverflowReplacementProviderTurnId(
                input.execution.executionId,
                turn,
              );
            const currentSession = yield* tx
              .transact(sessions.findById(input.execution.sessionId))
              .pipe(Effect.mapError(failure));
            if (
              inference.providerTurnId !== loopStep.providerTurnId ||
              inference.executionId !== input.execution.executionId ||
              inference.sessionId !== input.execution.sessionId ||
              inference.modelRef !== capability.modelRef ||
              Option.isNone(currentSession) ||
              currentSession.value.contextEpoch !== inference.contextEpoch
            ) {
              return yield* Effect.fail(
                failure({ _tag: "AgentLoopStepReplayBindingMismatch" }),
              );
            }
            const [compactionReceipt, replacementReceipt] = yield* Effect.all(
              [
                tx.transact(
                  providerTurns.findSettledResult(compactionProviderTurnId),
                ),
                tx.transact(
                  providerTurns.findSettledResult(replacementProviderTurnId),
                ),
              ],
              { concurrency: 1 },
            ).pipe(Effect.mapError(failure));
            if (
              compactionReceipt._tag !== "NotFound" ||
              replacementReceipt._tag !== "NotFound"
            ) {
              return yield* Effect.fail(
                failure({ _tag: "AgentLoopStepReplayBindingMismatch" }),
              );
            }
            yield* tx
              .transact(
                Effect.gen(function* () {
                  const createdAt = yield* now();
                  yield* loopSteps.ensureProviderTurnLink(
                    {
                      identity: loopStepIdentity,
                      overflowOrdinal: 0,
                      role: "Inference",
                      providerTurnId: activeLoopStep.providerTurnId,
                      contextEpoch: inference.contextEpoch,
                      state: "SettledFailure",
                      createdAt,
                    },
                    loopStepFence,
                  );
                  yield* loopSteps.ensureProviderTurnLink(
                    {
                      identity: loopStepIdentity,
                      overflowOrdinal: 0,
                      role: "OverflowCompaction",
                      providerTurnId: compactionProviderTurnId,
                      predecessorProviderTurnId:
                        activeLoopStep.providerTurnId,
                      contextEpoch: inference.contextEpoch,
                      state: "Prepared",
                      createdAt,
                    },
                    loopStepFence,
                  );
                }),
              )
              .pipe(Effect.mapError(failure));
            replayPersistedContextLimit = true;
          } else {
            if (inferenceLinks.length > 0 || compactionLinks.length > 0) {
              const inferenceLink = inferenceLinks[0];
              const compactionLink = compactionLinks[0];
              if (
                inferenceLink === undefined ||
                compactionLink === undefined ||
                !isValidOverflowCompactionLinkPair(
                  providerTurnLinks,
                  loopStep.providerTurnId,
                  [
                    providerTurnSummaryCompactionId(
                      input.execution.executionId,
                      turn,
                      compactionLink.contextEpoch,
                    ),
                    providerTurnNativeCompactionId(
                      input.execution.executionId,
                      turn,
                      compactionLink.contextEpoch,
                    ),
                  ],
                )
              ) {
                return yield* Effect.fail(
                  failure({ _tag: "AgentLoopStepReplayBindingMismatch" }),
                );
              }
              const [
                inferenceReceipt,
                compactionReceipt,
                compactionManifest,
              ] = yield* Effect.all(
                [
                  tx.transact(
                    providerTurns.findSettledResult(
                      inferenceLink.providerTurnId,
                    ),
                  ),
                  tx.transact(
                    providerTurns.findSettledResult(
                      compactionLink.providerTurnId,
                    ),
                  ),
                  tx.transact(
                    providerTurns.findManifestByTurn(
                      compactionLink.providerTurnId,
                    ),
                  ),
                ],
                { concurrency: 1 },
              ).pipe(Effect.mapError(failure));
              if (
                inferenceReceipt._tag !== "SettledFailure" ||
                inferenceReceipt.failureKind !== "ContextLimitExceeded" ||
                inferenceReceipt.turn.executionId !==
                  input.execution.executionId ||
                inferenceReceipt.turn.sessionId !==
                  input.execution.sessionId ||
                inferenceReceipt.turn.contextEpoch !==
                  inferenceLink.contextEpoch
              ) {
                return yield* Effect.fail(
                  failure({ _tag: "AgentLoopStepReplayBindingMismatch" }),
                );
              }
              if (
                compactionReceipt._tag === "NotFound" ||
                compactionReceipt._tag === "Unsettled"
              ) {
                const existingCompactionTurn =
                  compactionReceipt._tag === "Unsettled"
                    ? compactionReceipt.turn
                    : undefined;
                const existingNativeCompaction =
                  existingCompactionTurn?.outputContractRef ===
                  "provider-native-compaction-v1";
                const currentSession = yield* tx
                  .transact(sessions.findById(input.execution.sessionId))
                  .pipe(Effect.mapError(failure));
                if (
                  (compactionReceipt._tag === "NotFound" &&
                    compactionManifest !== null) ||
                  (existingCompactionTurn !== undefined &&
                    (existingCompactionTurn.providerTurnId !==
                      compactionLink.providerTurnId ||
                      existingCompactionTurn.executionId !==
                        input.execution.executionId ||
                      existingCompactionTurn.sessionId !==
                        input.execution.sessionId ||
                      existingCompactionTurn.contextEpoch !==
                        compactionLink.contextEpoch ||
                      existingCompactionTurn.modelRef !==
                        capability.modelRef ||
                      existingCompactionTurn.outputContractRef !==
                        (existingNativeCompaction
                          ? "provider-native-compaction-v1"
                          : "compaction-result-v1") ||
                      compactionManifest === null)) ||
                  Option.isNone(currentSession) ||
                  Number(currentSession.value.contextEpoch) !==
                    Number(compactionLink.contextEpoch)
                ) {
                  return yield* Effect.fail(
                    failure({ _tag: "AgentLoopStepReplayBindingMismatch" }),
                  );
                }
                if (existingNativeCompaction) {
                  const nativeFrontier =
                    compactionManifest === null
                      ? null
                      : decodeUniqueNativePortableFrontier(
                          compactionManifest.manifestJson,
                          compactionManifest.portableRequestJson,
                        );
                  const nativeManifest = nativeFrontier?.manifest;
                  if (
                    nativeFrontier === null ||
                    nativeManifest === undefined ||
                    compactionReceipt._tag !== "Unsettled" ||
                    compactionManifest === null ||
                    nativeManifest.providerTurnId !==
                      compactionLink.providerTurnId ||
                    nativeManifest.executionId !==
                      input.execution.executionId ||
                    nativeManifest.sessionId !== input.execution.sessionId ||
                    nativeManifest.contextEpoch !==
                      compactionLink.contextEpoch ||
                    nativeManifest.operationKind !== "CompactionNative" ||
                    nativeManifest.logicalStepNo !== turn ||
                    nativeManifest.modelRef !== capability.modelRef ||
                    nativeManifest.outputContractRef !==
                      "provider-native-compaction-v1" ||
                    nativeManifest.resolvedModelBindingFingerprint !==
                      currentBindingFingerprint ||
                    nativeFrontier.request.modelRef !== capability.modelRef
                  ) {
                    return yield* Effect.fail(
                      failure({
                        _tag: "AgentLoopStepReplayBindingMismatch",
                      }),
                    );
                  }
                  resumeOverflowNativeCompaction = true;
                  resumeOverflowNativeCompactionInput = {
                    manifestJson: compactionManifest.manifestJson,
                    request: nativeFrontier.request,
                  };
                }
                // The committed link pins the exact Summary ProviderTurn.
                // Rebuild the same canonical input later in this model
                // decision, after the projection and step context exist.
                resumeOverflowCompactionProviderTurnId =
                  compactionLink.providerTurnId;
              } else if (
                compactionReceipt._tag === "SettledSuccess" &&
                compactionReceipt.turn.outputContractRef ===
                  "provider-native-compaction-v1"
              ) {
                if (
                  compactionReceipt.evidenceVersion !==
                    "provider-success-v1" ||
                  compactionReceipt.finishReason !== "Stop" ||
                  compactionReceipt.turn.providerTurnId !==
                    compactionLink.providerTurnId ||
                  compactionReceipt.turn.executionId !==
                    input.execution.executionId ||
                  compactionReceipt.turn.sessionId !==
                    input.execution.sessionId ||
                  compactionReceipt.turn.contextEpoch !==
                    compactionLink.contextEpoch ||
                  compactionManifest === null ||
                  compactionManifest.manifestJson !==
                    compactionReceipt.manifestJson
                ) {
                  return yield* Effect.fail(
                    failure({ _tag: "AgentLoopStepReplayBindingMismatch" }),
                  );
                }
                let nativeManifest: Record<string, unknown>;
                try {
                  const manifest = JSON.parse(
                    compactionManifest.manifestJson,
                  ) as unknown;
                  if (
                    typeof manifest !== "object" ||
                    manifest === null ||
                    Array.isArray(manifest)
                  ) {
                    return yield* Effect.fail(
                      failure({ _tag: "AgentLoopStepReplayBindingMismatch" }),
                    );
                  }
                  nativeManifest = manifest as Record<string, unknown>;
                } catch {
                  return yield* Effect.fail(
                    failure({ _tag: "AgentLoopStepReplayBindingMismatch" }),
                  );
                }
                const nativeFrontier = decodeUniqueNativePortableFrontier(
                  compactionManifest.manifestJson,
                  compactionManifest.portableRequestJson,
                );
                if (
                  nativeFrontier === null &&
                  portableRequestHasNativeCheckpoint(
                    compactionManifest.portableRequestJson,
                  ) &&
                  options.qualificationProbe !== undefined
                ) {
                  yield* Effect.promise(
                    () =>
                      options.qualificationProbe?.({
                        boundary: "AH19NativeCheckpointRecovery",
                        stage: "NestedNativeFrontierRejected",
                        executionId: String(input.execution.executionId),
                        providerTurnId: String(compactionLink.providerTurnId),
                      }) ?? Promise.resolve(),
                  );
                }
                const nativeContinuationStates =
                  compactionReceipt.canonicalEvents.filter(
                    (event) => event._tag === "ContinuationState",
                  );
                if (
                  nativeFrontier === null ||
                  nativeManifest.providerTurnId !==
                    compactionLink.providerTurnId ||
                  nativeManifest.executionId !==
                    input.execution.executionId ||
                  nativeManifest.sessionId !== input.execution.sessionId ||
                  nativeManifest.contextEpoch !==
                    compactionLink.contextEpoch ||
                  nativeManifest.operationKind !== "CompactionNative" ||
                  nativeManifest.logicalStepNo !== turn ||
                  typeof nativeManifest.modelRef !== "string" ||
                  typeof nativeManifest.resolvedModelBindingFingerprint !==
                    "string" ||
                  !/^p16fp_[0-9a-f]{64}$/u.test(
                    nativeManifest.resolvedModelBindingFingerprint,
                  ) ||
                  nativeFrontier.request.modelRef !==
                    nativeManifest.modelRef ||
                  nativeContinuationStates.length !== 1 ||
                  nativeContinuationStates[0]?._tag !== "ContinuationState"
                ) {
                  return yield* Effect.fail(
                    failure({ _tag: "AgentLoopStepReplayBindingMismatch" }),
                  );
                }
                const nativeStateRef = nativeContinuationStates[0].stateRef;
                const currentSession = yield* tx
                  .transact(sessions.findById(input.execution.sessionId))
                  .pipe(Effect.mapError(failure));
                if (Option.isNone(currentSession)) {
                  return yield* Effect.fail(
                    failure({ _tag: "AgentLoopStepReplayBindingMismatch" }),
                  );
                }
                const currentEpoch = Number(
                  currentSession.value.contextEpoch,
                );
                const compactionEpoch = Number(compactionLink.contextEpoch);
                if (
                  currentEpoch !== compactionEpoch &&
                  currentEpoch !== compactionEpoch + 1
                ) {
                  return yield* Effect.fail(
                    failure({ _tag: "AgentLoopStepReplayBindingMismatch" }),
                  );
                }
                const recentEntries = yield* tx
                  .transact(readExecutionTimeline())
                  .pipe(Effect.mapError(failure));
                const nativeCheckpointEntries = recentEntries.filter(
                  (entry) =>
                    entry.source?.kind === "CompactionTurn" &&
                    entry.source.ref === compactionLink.providerTurnId &&
                    typeof entry.payload === "object" &&
                    entry.payload !== null &&
                    (entry.payload as { readonly _tag?: unknown })._tag ===
                      "CompactionCheckpoint" &&
                    (entry.payload as { readonly implementation?: unknown })
                      .implementation === "ProviderNative",
                );
                if (
                  (currentEpoch === compactionEpoch &&
                    nativeCheckpointEntries.length !== 0) ||
                  (currentEpoch === compactionEpoch + 1 &&
                    (nativeCheckpointEntries.length !== 1 ||
                      (
                        nativeCheckpointEntries[0]?.payload as
                          | Record<string, unknown>
                          | undefined
                      )?.opaqueItemRef !== nativeStateRef ||
                      (
                        nativeCheckpointEntries[0]?.payload as
                          | Record<string, unknown>
                          | undefined
                      )?.bindingFingerprint !==
                        nativeManifest.resolvedModelBindingFingerprint))
                ) {
                  return yield* Effect.fail(
                    failure({ _tag: "AgentLoopStepReplayBindingMismatch" }),
                  );
                }
                const bindingMatches =
                  providerNativeSupported &&
                  nativeManifest.resolvedModelBindingFingerprint ===
                    currentBindingFingerprint;
                if (
                  !bindingMatches &&
                  options.qualificationProbe !== undefined
                ) {
                  yield* Effect.promise(
                    () =>
                      options.qualificationProbe?.({
                        boundary: "AH19NativeCheckpointRecovery",
                        stage: "SettledNativeReceiptBindingMismatch",
                        executionId: String(input.execution.executionId),
                        providerTurnId: String(compactionLink.providerTurnId),
                      }) ?? Promise.resolve(),
                  );
                }
                const replacementProviderTurnId =
                  makeOverflowReplacementProviderTurnId(
                    input.execution.executionId,
                    turn,
                  );
                let replacementEpoch: number;
                if (bindingMatches) {
                  if (currentEpoch === compactionEpoch) {
                    const committed = yield* commitRecoveredNativeCompaction(
                      {
                        execution: input.execution,
                        providerTurnId: compactionLink.providerTurnId,
                        expectedEpoch: compactionLink.contextEpoch,
                        bindingFingerprint: currentBindingFingerprint,
                        opaqueItemRef: nativeStateRef,
                        fence: loopStepFence,
                      },
                      {
                        sessions,
                        tx,
                        ...(options.qualificationProbe === undefined
                          ? {}
                          : {
                              qualificationProbe: options.qualificationProbe,
                            }),
                      },
                    ).pipe(Effect.mapError(failure));
                    replacementEpoch = Number(committed.newEpoch);
                  } else {
                    replacementEpoch = compactionEpoch + 1;
                  }
                } else if (currentEpoch === compactionEpoch) {
                  const compacted = yield* runSummaryCompaction(
                    {
                      execution: input.execution,
                      logicalStepNo: compactionLink.identity.logicalStepNo,
                      sourceAgentLoopStep: {
                        executionId: String(
                          compactionLink.identity.executionId,
                        ),
                        logicalStepNo: compactionLink.identity.logicalStepNo,
                        repairAttempt: compactionLink.identity.repairAttempt,
                        providerTurnId: String(
                          compactionLink.predecessorProviderTurnId,
                        ),
                      },
                      currentEpoch: compactionLink.contextEpoch,
                      modelRef: capability.modelRef,
                      ...(options.secretRef === undefined
                        ? {}
                        : { secretRef: options.secretRef }),
                      bindingFingerprint: currentBindingFingerprint,
                      inputFrontier: nativeFrontier.inputFrontier,
                      contextRefs: nativeFrontier.contextRefs,
                      inputItems: nativeFrontier.inputItems,
                      ...(yield* loadWorkCompactionPinning()),
                      fence: loopStepFence,
                    },
                    compactionDependencies,
                  ).pipe(Effect.mapError(failure));
                  if ("_tag" in compacted) {
                    return {
                      _tag: "Complete" as const,
                      outcome: { _tag: "Settle" as const, settlement: safetyStop("RuntimeSafetyStop") },
                    };
                  }
                  replacementEpoch = Number(compacted.newEpoch);
                } else {
                  // The checkpoint already committed in the prior
                  // deployment. The Session projector below reconstructs
                  // the exact portable frontier and commits the rebase.
                  replacementEpoch = Number.NaN;
                }
                if (Number.isFinite(replacementEpoch)) {
                  if (
                    replacementEpoch !==
                    currentEpoch + (currentEpoch === compactionEpoch ? 1 : 0)
                  ) {
                    return yield* Effect.fail(
                      failure({ _tag: "AgentLoopStepReplayBindingMismatch" }),
                    );
                  }
                  const existingReplacement = providerTurnLinks.filter(
                    (link) => link.role === "OverflowReplacement",
                  );
                  if (existingReplacement.length > 1) {
                    return yield* Effect.fail(
                      failure({ _tag: "AgentLoopStepReplayBindingMismatch" }),
                    );
                  }
                  const existingReplacementLink = existingReplacement[0];
                  if (existingReplacementLink !== undefined) {
                    if (
                      existingReplacementLink.providerTurnId !==
                        replacementProviderTurnId ||
                      existingReplacementLink.predecessorProviderTurnId !==
                        compactionLink.providerTurnId ||
                      Number(existingReplacementLink.contextEpoch) !==
                        replacementEpoch
                    ) {
                      return yield* Effect.fail(
                        failure({
                          _tag: "AgentLoopStepReplayBindingMismatch",
                        }),
                      );
                    }
                  } else {
                    yield* tx
                      .transact(
                        loopSteps.ensureProviderTurnLink(
                          {
                            identity: loopStepIdentity,
                            overflowOrdinal: 0,
                            role: "OverflowReplacement",
                            providerTurnId: replacementProviderTurnId,
                            predecessorProviderTurnId:
                              compactionLink.providerTurnId,
                            contextEpoch:
                              parse(ContextEpochNumber)(replacementEpoch),
                            state: "Prepared",
                            createdAt: yield* now(),
                          },
                          loopStepFence,
                        ),
                      )
                      .pipe(Effect.mapError(failure));
                  }
                  overflowRecoveryAttempt = 1;
                  overflowReplacementProviderTurnId =
                    replacementProviderTurnId;
                  return { _tag: "Restart" as const, overflow: recoveryState() };
                }
              } else if (compactionReceipt._tag === "SettledSuccess") {
                if (
                  compactionReceipt.evidenceVersion !==
                    "provider-success-v1" ||
                  compactionReceipt.finishReason !== "Stop" ||
                  compactionReceipt.turn.providerTurnId !==
                    compactionLink.providerTurnId ||
                  compactionReceipt.turn.executionId !==
                    input.execution.executionId ||
                  compactionReceipt.turn.sessionId !==
                    input.execution.sessionId ||
                  compactionReceipt.turn.contextEpoch !==
                    compactionLink.contextEpoch ||
                  compactionReceipt.turn.modelRef !== capability.modelRef ||
                  compactionReceipt.turn.outputContractRef !==
                    "compaction-result-v1" ||
                  compactionManifest === null ||
                  compactionManifest.manifestJson !==
                    compactionReceipt.manifestJson
                ) {
                  return yield* Effect.fail(
                    failure({ _tag: "AgentLoopStepReplayBindingMismatch" }),
                  );
                }
                let persistedManifest: Record<string, unknown>;
                let persistedRequest: Record<string, unknown>;
                try {
                  const manifest = JSON.parse(
                    compactionManifest.manifestJson,
                  ) as unknown;
                  const request = JSON.parse(
                    compactionManifest.portableRequestJson,
                  ) as unknown;
                  if (
                    typeof manifest !== "object" ||
                    manifest === null ||
                    Array.isArray(manifest) ||
                    typeof request !== "object" ||
                    request === null ||
                    Array.isArray(request)
                  ) {
                    return yield* Effect.fail(
                      failure({ _tag: "AgentLoopStepReplayBindingMismatch" }),
                    );
                  }
                  persistedManifest = manifest as Record<string, unknown>;
                  persistedRequest = request as Record<string, unknown>;
                } catch {
                  return yield* Effect.fail(
                    failure({ _tag: "AgentLoopStepReplayBindingMismatch" }),
                  );
                }
                const recoveryBindingFingerprint = currentBindingFingerprint;
                if (
                  persistedManifest.providerTurnId !==
                    compactionLink.providerTurnId ||
                  persistedManifest.executionId !==
                    input.execution.executionId ||
                  persistedManifest.sessionId !== input.execution.sessionId ||
                  persistedManifest.contextEpoch !==
                    compactionLink.contextEpoch ||
                  persistedManifest.modelRef !== capability.modelRef ||
                  persistedManifest.outputContractRef !==
                    "compaction-result-v1" ||
                  persistedManifest.operationKind !== "CompactionSummary" ||
                  persistedManifest.logicalStepNo !== turn ||
                  persistedManifest.resolvedModelBindingFingerprint !==
                    recoveryBindingFingerprint ||
                  persistedManifest.compiledRequestHash !==
                    sha256Hex(compactionManifest.portableRequestJson) ||
                  persistedRequest.operationKind !== "CompactionSummary" ||
                  persistedRequest.modelRef !== capability.modelRef ||
                  persistedRequest.outputContractRef !==
                    "compaction-result-v1"
                ) {
                  return yield* Effect.fail(
                    failure({ _tag: "AgentLoopStepReplayBindingMismatch" }),
                  );
                }
                const summary = compactionReceipt.canonicalEvents
                  .flatMap((event) =>
                    event._tag === "TextDelta" ? [event.text] : [],
                  )
                  .join("")
                  .trim();
                if (summary.length === 0) {
                  return yield* Effect.fail(
                    failure({ _tag: "AgentLoopStepReplayBindingMismatch" }),
                  );
                }
                const currentSession = yield* tx
                  .transact(sessions.findById(input.execution.sessionId))
                  .pipe(Effect.mapError(failure));
                if (
                  Option.isNone(currentSession) ||
                  (currentSession.value.contextEpoch !==
                    compactionLink.contextEpoch &&
                    Number(currentSession.value.contextEpoch) !==
                      Number(compactionLink.contextEpoch) + 1)
                ) {
                  return yield* Effect.fail(
                    failure({ _tag: "AgentLoopStepReplayBindingMismatch" }),
                  );
                }
                yield* commitRecoveredSummaryCompaction(
                  {
                    execution: input.execution,
                    providerTurnId: compactionLink.providerTurnId,
                    expectedEpoch: compactionLink.contextEpoch,
                    bindingFingerprint: recoveryBindingFingerprint,
                    summary,
                    fence: loopStepFence,
                  },
                  {
                    sessions,
                    tx,
                    ...(options.qualificationProbe === undefined
                      ? {}
                      : { qualificationProbe: options.qualificationProbe }),
                  },
                ).pipe(Effect.mapError(failure));
                const replacementLinks = providerTurnLinks.filter(
                  (link) => link.role === "OverflowReplacement",
                );
                const replacementProviderTurnId =
                  makeOverflowReplacementProviderTurnId(
                    input.execution.executionId,
                    turn,
                  );
                if (replacementLinks.length > 1) {
                  return yield* Effect.fail(
                    failure({ _tag: "AgentLoopStepReplayBindingMismatch" }),
                  );
                }
                const existingReplacement = replacementLinks[0];
                if (existingReplacement !== undefined) {
                  if (
                    existingReplacement.providerTurnId !==
                      replacementProviderTurnId ||
                    existingReplacement.predecessorProviderTurnId !==
                      compactionLink.providerTurnId ||
                    Number(existingReplacement.contextEpoch) !==
                      Number(compactionLink.contextEpoch) + 1
                  ) {
                    return yield* Effect.fail(
                      failure({ _tag: "AgentLoopStepReplayBindingMismatch" }),
                    );
                  }
                } else {
                  yield* tx
                    .transact(
                      loopSteps.ensureProviderTurnLink(
                        {
                          identity: loopStepIdentity,
                          overflowOrdinal: 0,
                          role: "OverflowReplacement",
                          providerTurnId: replacementProviderTurnId,
                          predecessorProviderTurnId:
                            compactionLink.providerTurnId,
                          contextEpoch: parse(ContextEpochNumber)(
                            Number(compactionLink.contextEpoch) + 1,
                          ),
                          state: "Prepared",
                          createdAt: yield* now(),
                        },
                        loopStepFence,
                      ),
                    )
                    .pipe(Effect.mapError(failure));
                }
                // The settled Summary receipt has been promoted to the exact
                // replacement checkpoint. The next loop iteration is pinned
                // to that replacement ProviderTurn, not the failed Inference.
                overflowRecoveryAttempt = 1;
                overflowReplacementProviderTurnId = replacementProviderTurnId;
                return { _tag: "Restart" as const, overflow: recoveryState() };
              } else {
                return yield* Effect.fail(
                  failure({ _tag: "AgentLoopStepReplayBindingMismatch" }),
                );
              }
            }
          }
        }
      }
      if (
        loopStep.state === "SettlementProposed" &&
        loopStep.settlement !== undefined
      ) {
        return {
          _tag: "Complete" as const,
          outcome: { _tag: "Settle" as const, settlement: loopStep.settlement },
        };
      }
    }
    return { _tag: "Ready" as const, loopStep, overflow: recoveryState() };
  });
};
