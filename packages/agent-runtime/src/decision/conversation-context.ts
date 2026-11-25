import {
  ContextEpochNumber,
  conversationResponseEpisode,
  type Execution,
  type ExecutionSettlement,
  executionEpisode,
  parse,
} from "@arbor/domain";
import { decodeTurn } from "@arbor/model-context";
import type {
  AgentLoopStepRecord,
  ConversationCheckpointOwner,
  ConversationResponseJob,
  ExecutionDriverError,
  PortableInputItem,
  SessionRepositoryService,
} from "@arbor/ports";
import { isValidConversationCheckpointBinding, sha256Hex } from "@arbor/ports";
import { Effect, Option } from "effect";
import { type ModelDecisionOutcome, safetyStop } from "../agent-loop-policy.js";
import {
  isP20OverflowReplacementManifestBound,
  resolveP20OverflowReplacementChain,
} from "../agent-loop-step-recovery.js";
import { conversationCheckpointBindingUse } from "../checkpoint/conversation/binding.js";
import { runConversationCheckpointCompaction } from "../checkpoint/conversation/compaction.js";
import {
  belongsToConversationExecution,
  validateConversationCheckpointReceipt,
} from "../checkpoint/conversation/evidence.js";
import {
  type ConversationCheckpointProjection,
  projectConversationCheckpointHistory,
} from "../checkpoint/conversation/projection.js";
import type { ModelDecisionDependencies } from "./contract.js";

type ConversationDecisionDependencies = Pick<
  ModelDecisionDependencies,
  | "input"
  | "capability"
  | "tx"
  | "loopSteps"
  | "loopStepFence"
  | "providerTurns"
  | "humanMessages"
  | "conversationCheckpoints"
  | "responseJobs"
  | "responseAttempts"
  | "executions"
  | "blobs"
  | "options"
  | "failure"
  | "now"
>;

export type ConversationDecisionContextResult =
  | {
      readonly _tag: "Ready";
      readonly conversationMessages: ReadonlyArray<{
        readonly role: "user" | "assistant";
        readonly text: string;
      }>;
      readonly conversationContextRefs: ReadonlyArray<string>;
      readonly conversationCheckpointItems: ReadonlyArray<PortableInputItem>;
      readonly exactConversation: ReturnType<typeof conversationResponseEpisode>;
      readonly conversationExecution: boolean;
      readonly conversationOwner: ConversationCheckpointOwner | undefined;
      readonly conversationProjection: ConversationCheckpointProjection | undefined;
      readonly conversationCurrentJob: ConversationResponseJob | undefined;
      readonly placementExecution: boolean;
    }
  | { readonly _tag: "Restart" }
  | { readonly _tag: "Complete"; readonly outcome: ModelDecisionOutcome };

/** Load the exact ConversationResponseEpisode context. A native binding
 * rebase restarts the caller's existing decision loop; terminal recovery
 * returns its existing outcome. No new turn or settlement authority is added. */
export const loadConversationDecisionContext = (
  dependencies: ConversationDecisionDependencies,
  phase: {
    readonly turn: number;
    readonly loopStep: AgentLoopStepRecord | undefined;
    readonly currentBindingFingerprint: string;
    readonly providerNativeSupported: boolean;
    readonly compactionDependencies: Pick<
      Parameters<typeof runConversationCheckpointCompaction>[1],
      "providerRuntime" | "admitProviderTurn" | "completeProviderTurn" | "tx"
    >;
    readonly readExecutionTimeline: () => ReturnType<
      SessionRepositoryService["listRecentEntries"]
    >;
    readonly proposeSettlement: (
      settlement: ExecutionSettlement,
    ) => Effect.Effect<ModelDecisionOutcome, ExecutionDriverError>;
  },
): Effect.Effect<ConversationDecisionContextResult, ExecutionDriverError> => {
  const {
    input,
    capability,
    tx,
    loopSteps,
    loopStepFence,
    providerTurns,
    humanMessages,
    responseJobs,
    options,
    failure,
    now,
  } = dependencies;
  const {
    turn,
    loopStep,
    currentBindingFingerprint,
    providerNativeSupported,
    compactionDependencies,
    readExecutionTimeline,
    proposeSettlement,
  } = phase;
  return Effect.gen(function* () {
    // EGP: only an exact ConversationResponseEpisode can open conversation
    // history. A generic Workspace execution never implies conversation.
    const conversationMessages: Array<{
      readonly role: "user" | "assistant";
      readonly text: string;
    }> = [];
    const conversationContextRefs: Array<string> = [];
    const conversationCheckpointItems: PortableInputItem[] = [];
    const exactConversation = conversationResponseEpisode(input.execution);
    const conversationExecution = exactConversation !== null;
    let conversationOwner: ConversationCheckpointOwner | undefined;
    let conversationProjection: ConversationCheckpointProjection | undefined;
    let conversationCurrentJob: ConversationResponseJob | undefined;
    const history = conversationExecution
      ? yield* tx
          .transact(
            humanMessages.listForWorkspace(input.execution.workspaceId),
          )
          .pipe(Effect.mapError(failure))
      : [];
    let claimed = undefined as (typeof history)[number] | undefined;
    const placementExecution =
      conversationExecution ||
      executionEpisode(input.execution)?._tag === "InboxEpisode";
    if (conversationExecution) {
      if (
        dependencies.conversationCheckpoints === undefined ||
        responseJobs === undefined ||
        loopStepFence === undefined
      ) {
        return yield* Effect.fail(
          failure({
            _tag: "ConversationCheckpointStoreUnavailable",
            executionId: input.execution.executionId,
          }),
        );
      }
      const existingOwner = yield* tx
        .transact(
          dependencies.conversationCheckpoints.findOwner(
            input.execution.workspaceId,
          ),
        )
        .pipe(Effect.mapError(failure));
      conversationOwner = Option.isSome(existingOwner)
        ? existingOwner.value
        : yield* tx
            .transact(
              dependencies.conversationCheckpoints.initializeIfAbsent({
                rootWorkspaceId: input.execution.workspaceId,
                initializedAt: yield* now(),
                fence: loopStepFence,
              }),
            )
            .pipe(Effect.mapError(failure));
      const responseJobRows = yield* tx
        .transact(responseJobs.listForWorkspace(input.execution.workspaceId))
        .pipe(Effect.mapError(failure));
      const currentResponseJob = responseJobRows.find(
        (job) => String(job.messageId) === exactConversation.messageId,
      );
      if (
        currentResponseJob === undefined ||
        currentResponseJob.state._tag !== "Running" ||
        currentResponseJob.state.executionId !== input.execution.executionId
      ) {
        return yield* Effect.fail(
          failure({
            _tag: "ConversationResponseJobNotCurrent",
            messageId: exactConversation.messageId,
            executionId: input.execution.executionId,
          }),
        );
      }
      if (
        dependencies.responseAttempts === undefined ||
        dependencies.executions === undefined
      ) {
        return yield* Effect.fail(
          failure({ _tag: "ConversationCheckpointEvidenceStoreUnavailable" }),
        );
      }
      const conversationAttempts: import("@arbor/ports").ConversationAttempt[] =
        [];
      const conversationExecutions: Execution[] = [input.execution];
      const seenExecutionIds = new Set<string>([
        String(input.execution.executionId),
      ]);
      for (const job of responseJobRows) {
        if (job.state._tag !== "Answered" && job.state._tag !== "Running") {
          continue;
        }
        const attempts = yield* tx
          .transact(dependencies.responseAttempts.list(job.messageId))
          .pipe(Effect.mapError(failure));
        conversationAttempts.push(...attempts);
        const wantedExecutionId = job.state.executionId;
        const wantedAttemptNo =
          job.state._tag === "Answered"
            ? job.nextAttemptNo - 1
            : job.state.attemptNo;
        const exactAttempt = attempts.find(
          (attempt) =>
            attempt.attemptNo === wantedAttemptNo &&
            attempt.executionId === wantedExecutionId,
        );
        if (
          exactAttempt !== undefined &&
          !seenExecutionIds.has(String(exactAttempt.executionId))
        ) {
          const found = yield* tx
            .transact(
              dependencies.executions.findById(exactAttempt.executionId),
            )
            .pipe(Effect.mapError(failure));
          if (Option.isSome(found)) {
            conversationExecutions.push(found.value);
          }
          seenExecutionIds.add(String(exactAttempt.executionId));
        }
      }
      conversationCurrentJob = currentResponseJob;
      const historyProjection = projectConversationCheckpointHistory({
        owner: conversationOwner,
        messages: history,
        responseJobs: responseJobRows,
        attempts: conversationAttempts,
        executions: conversationExecutions,
        currentMessageId: exactConversation.messageId,
        currentExecution: input.execution,
      });
      if (historyProjection._tag === "Blocked") {
        return yield* Effect.fail(
          failure({
            _tag: "ConversationCheckpointProjectionBlocked",
            reason: historyProjection.reason,
            messageId: exactConversation.messageId,
          }),
        );
      }
      conversationProjection = historyProjection.projection;
      claimed =
        conversationProjection.currentMessage as (typeof history)[number];
      const checkpoint = conversationProjection.checkpoint;
      if (
        checkpoint.checkpointKind !== null &&
        !isValidConversationCheckpointBinding(
          checkpoint.checkpointKind,
          checkpoint.checkpointRef,
          checkpoint.bindingFingerprint,
        )
      ) {
        return yield* Effect.fail(
          failure({ _tag: "ConversationCheckpointEvidenceInvalid" }),
        );
      }
      if (checkpoint.checkpointKind !== null) {
        yield* validateConversationCheckpointReceipt({
          owner: conversationOwner,
          execution: input.execution,
          providerTurns,
          tx,
          failure,
        });
      }
      if (checkpoint.checkpointKind === "Summary") {
        if (
          dependencies.blobs === undefined ||
          checkpoint.checkpointRef === null
        ) {
          return yield* Effect.fail(
            failure({ _tag: "ConversationCheckpointBlobStoreUnavailable" }),
          );
        }
        const bytes = yield* dependencies.blobs
          .get(checkpoint.checkpointRef)
          .pipe(Effect.mapError(failure));
        let summary: string;
        try {
          summary = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
        } catch {
          return yield* Effect.fail(
            failure({ _tag: "ConversationCheckpointBlobInvalid" }),
          );
        }
        if (summary.trim().length === 0) {
          return yield* Effect.fail(
            failure({ _tag: "ConversationCheckpointBlobInvalid" }),
          );
        }
        const summaryReceipt =
          providerTurns === undefined ||
          conversationOwner?.producerProviderTurnId === null ||
          conversationOwner?.producerProviderTurnId === undefined
            ? undefined
            : yield* tx
                .transact(
                  providerTurns.findSettledResult(
                    conversationOwner.producerProviderTurnId,
                  ),
                )
                .pipe(Effect.mapError(failure));
        const providerSummary =
          summaryReceipt?._tag === "SettledSuccess"
            ? summaryReceipt.canonicalEvents
                .flatMap((event) =>
                  event._tag === "TextDelta" ? [event.text] : [],
                )
                .join("")
                .trim()
            : "";
        if (
          providerSummary.length === 0 ||
          providerSummary !== summary.trim()
        ) {
          return yield* Effect.fail(
            failure({ _tag: "ConversationCheckpointBlobMismatch" }),
          );
        }
        conversationCheckpointItems.push({
          _tag: "ContextUpdate",
          sourceRef: `conversation-checkpoint:${input.execution.workspaceId}:${checkpoint.contextEpoch}`,
          revision: Number(checkpoint.contextEpoch),
          updateKind: "Full",
          text: summary,
        });
        conversationContextRefs.push(
          `conversation-checkpoint:${input.execution.workspaceId}:${checkpoint.contextEpoch}`,
        );
      } else if (checkpoint.checkpointKind === "ProviderNative") {
        if (
          checkpoint.checkpointRef === null ||
          checkpoint.bindingFingerprint === null
        ) {
          return yield* Effect.fail(
            failure({ _tag: "ConversationCheckpointNativeBindingInvalid" }),
          );
        }
        const bindingUse = conversationCheckpointBindingUse({
          checkpointKind: checkpoint.checkpointKind,
          checkpointRef: checkpoint.checkpointRef,
          sourceBindingFingerprint: checkpoint.bindingFingerprint,
          currentBindingFingerprint,
          providerNativeSupported,
        });
        if (bindingUse._tag === "ProviderNative") {
          conversationCheckpointItems.push({
            _tag: "CompactionCheckpoint",
            implementation: "ProviderNative",
            fromEpoch: parse(ContextEpochNumber)(
              Number(checkpoint.contextEpoch) - 1,
            ),
            toEpoch: checkpoint.contextEpoch,
            retainedFrontierRef: `conversation-frontier:${input.execution.workspaceId}:${checkpoint.contextEpoch}`,
            opaqueItemRef: bindingUse.opaqueItemRef,
            bindingFingerprint: bindingUse.bindingFingerprint,
          });
          conversationContextRefs.push(
            `conversation-checkpoint:${input.execution.workspaceId}:${checkpoint.contextEpoch}`,
          );
        } else {
          const compacted = yield* runConversationCheckpointCompaction(
            {
              execution: input.execution,
              logicalStepNo: loopStep?.identity.logicalStepNo ?? turn,
              owner: conversationOwner,
              sources: [
                ...conversationProjection.coveredAnswered,
                ...conversationProjection.uncoveredAnswered,
              ],
              coveredThrough: (() => {
                const source = [
                  ...conversationProjection.coveredAnswered,
                  ...conversationProjection.uncoveredAnswered,
                ].at(-1);
                return source === undefined
                  ? checkpoint.coveredThrough
                  : {
                      createdAt: source.message.createdAt,
                      messageId: source.message.messageId,
                    };
              })(),
              currentMessageId: exactConversation.messageId,
              currentResponseJob,
              checkpointKind: "Summary",
              bindingFingerprint: currentBindingFingerprint,
              modelRef: capability.modelRef,
              ...(options.secretRef === undefined
                ? {}
                : { secretRef: options.secretRef }),
              fence: loopStepFence,
              updatedAt: yield* now(),
              ...(options.qualificationProbe === undefined
                ? {}
                : { qualificationProbe: options.qualificationProbe }),
            },
            {
              ...compactionDependencies,
              checkpointStore: dependencies.conversationCheckpoints,
              providerTurns:
                providerTurns ??
                (yield* Effect.fail(
                  failure({ _tag: "ProviderTurnStoreUnavailable" }),
                )),
              blobs:
                dependencies.blobs ??
                (yield* Effect.fail(
                  failure({
                    _tag: "ConversationCheckpointBlobStoreUnavailable",
                  }),
                )),
              tx,
            },
          ).pipe(Effect.mapError(failure));
          if ("_tag" in compacted) {
            return {
            _tag: "Complete" as const,
            outcome: yield* proposeSettlement(safetyStop("RuntimeSafetyStop")),
          };
          }
          if (
            compacted.checkpointKind !== "Summary" ||
            compacted.newEpoch !==
              parse(ContextEpochNumber)(Number(checkpoint.contextEpoch) + 1)
          ) {
            return yield* Effect.fail(
              failure({ _tag: "ConversationCheckpointRebaseMismatch" }),
            );
          }
          return { _tag: "Restart" as const };
        }
      } else if (checkpoint.checkpointKind !== null) {
        return yield* Effect.fail(
          failure({ _tag: "ConversationCheckpointEvidenceInvalid" }),
        );
      }
      for (const answered of conversationProjection.uncoveredAnswered) {
        conversationMessages.push(
          { role: "user", text: answered.message.bodyRef },
          { role: "assistant", text: answered.responseBody },
        );
        conversationContextRefs.push(
          `human-input:${answered.message.messageId}`,
          `human-response:${answered.message.messageId}`,
        );
      }
      conversationMessages.push({ role: "user", text: claimed.bodyRef });
      conversationContextRefs.push(`human-input:${claimed.messageId}`);
      if (
        loopStep?.state === "StepEffectsCommitted" &&
        loopStep.successor === undefined &&
        loopStepFence !== undefined &&
        loopSteps !== undefined &&
        providerTurns !== undefined &&
        conversationCurrentJob.state._tag === "Running" &&
        conversationCurrentJob.state.executionId ===
          input.execution.executionId &&
        conversationCurrentJob.messageId === exactConversation.messageId
      ) {
        if (loopStep === undefined) {
          return yield* Effect.fail(
            failure({ _tag: "AgentLoopStepReplayBindingMismatch" }),
          );
        }
        const pinnedStep = loopStep;
        const p20Links = yield* tx
          .transact(loopSteps.listProviderTurnLinks(pinnedStep.identity))
          .pipe(Effect.mapError(failure));
        const p20Chain = resolveP20OverflowReplacementChain(
          p20Links,
          pinnedStep.identity,
          String(pinnedStep.providerTurnId),
        );
        if (p20Chain !== undefined) {
          const [replacementManifest, replacementReceipt] = yield* Effect.all(
            [
              tx.transact(
                providerTurns.findManifestByTurn(
                  p20Chain.replacement.providerTurnId,
                ),
              ),
              tx.transact(
                providerTurns.findSettledResult(
                  p20Chain.replacement.providerTurnId,
                ),
              ),
            ],
            { concurrency: 1 },
          ).pipe(Effect.mapError(failure));
          if (
            !isP20OverflowReplacementManifestBound({
              step: pinnedStep,
              sessionId: String(input.execution.sessionId),
              chain: p20Chain,
              manifest: replacementManifest,
              settled: replacementReceipt,
            }) ||
            replacementReceipt._tag !== "SettledSuccess"
          ) {
            return yield* Effect.fail(
              failure({ _tag: "AgentLoopStepReplayBindingMismatch" }),
            );
          }
          const timeline = yield* tx
            .transact(readExecutionTimeline())
            .pipe(Effect.mapError(failure));
          const outputRows = timeline.filter(
            (entry) =>
              entry.sequence === pinnedStep.modelOutputSessionSequence &&
              belongsToConversationExecution(
                entry,
                String(input.execution.executionId),
              ),
          );
          const outputEntry = outputRows[0];
          const outputPayload =
            typeof outputEntry?.payload === "object" &&
            outputEntry.payload !== null
              ? (outputEntry.payload as Record<string, unknown>)
              : undefined;
          if (
            pinnedStep.modelOutputSessionSequence === undefined ||
            pinnedStep.decodedOutputHash === undefined ||
            pinnedStep.nextActionIndex !== 0 ||
            outputRows.length !== 1 ||
            outputEntry?.entryKind !== "ModelOutput" ||
            outputEntry.source?.kind !== "ProviderTurn" ||
            outputEntry.source.ref !==
              `${p20Chain.replacement.providerTurnId}:assistant` ||
            outputPayload?._tag !== "AssistantMessage" ||
            outputPayload.providerTurnId !==
              p20Chain.replacement.providerTurnId ||
            outputPayload.contentRef !==
              `provider:${p20Chain.replacement.providerTurnId}:assistant` ||
            typeof outputPayload.text !== "string" ||
            typeof outputPayload.finishReason !== "string"
          ) {
            return yield* Effect.fail(
              failure({ _tag: "AgentLoopStepReplayBindingMismatch" }),
            );
          }
          const decodedOutput = decodeTurn(
            replacementReceipt.canonicalEvents,
          );
          if (
            !decodedOutput.ok ||
            decodedOutput.output.toolInvocations.length !== 0 ||
            decodedOutput.output.text !== outputPayload.text ||
            decodedOutput.output.finishReason !==
              outputPayload.finishReason ||
            sha256Hex(
              JSON.stringify({
                providerTurnId: p20Chain.replacement.providerTurnId,
                outputContractRef: replacementReceipt.turn.outputContractRef,
                decoderVersion: "decode-turn-v1",
                text: decodedOutput.output.text,
                finishReason: decodedOutput.output.finishReason,
                toolInvocations: decodedOutput.output.toolInvocations,
              }),
            ) !== pinnedStep.decodedOutputHash
          ) {
            return yield* Effect.fail(
              failure({ _tag: "AgentLoopStepReplayBindingMismatch" }),
            );
          }
          const settlement: ExecutionSettlement = {
            _tag: "Completed",
            result: {
              _tag: "ConversationResponseProduced",
              messageId: exactConversation.messageId,
            },
          };
          const terminalStep = pinnedStep;
          yield* tx
            .transact(
              loopSteps.transition(
                {
                  identity: terminalStep.identity,
                  expectedRevision: terminalStep.revision,
                  expectedState: "StepEffectsCommitted",
                  next: {
                    ...terminalStep,
                    state: "SettlementProposed",
                    settlement,
                    revision: terminalStep.revision + 1,
                    updatedAt: yield* now(),
                  },
                },
                loopStepFence,
              ),
            )
            .pipe(Effect.mapError(failure));
          if (options.qualificationProbe !== undefined) {
            yield* Effect.promise(
              () =>
                options.qualificationProbe?.({
                  boundary: "AH19NativeCheckpointRecovery",
                  stage: `P48TerminalSettledFromPinnedReplacement:step=${terminalStep.identity.logicalStepNo}:providerTurn=${p20Chain.replacement.providerTurnId}`,
                  executionId: String(input.execution.executionId),
                  providerTurnId: String(p20Chain.replacement.providerTurnId),
                }) ?? Promise.resolve(),
            );
          }
          return {
            _tag: "Complete" as const,
            outcome: { _tag: "Settle" as const, settlement },
          };
        }
      }
    }
    return {
      _tag: "Ready" as const,
      conversationMessages,
      conversationContextRefs,
      conversationCheckpointItems,
      exactConversation,
      conversationExecution,
      conversationOwner,
      conversationProjection,
      conversationCurrentJob,
      placementExecution,
    };
  });
};
