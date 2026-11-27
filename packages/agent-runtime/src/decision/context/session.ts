import {
  type Execution,
  ProviderTurnId,
  parse,
  workEpisode,
} from "@arbor/domain";
import {
  type ControlBasis,
  decideSessionProjection,
  filterEntriesForWork,
  latestSessionInputIndex,
  projectCompressibleHistory,
  projectSessionTimeline,
  type SessionTimelineProjection,
} from "@arbor/model-context";
import type {
  AgentLoopStepRecord,
  ExecutionDriverError,
  SessionEntryRecord,
  SessionRepositoryService,
} from "@arbor/ports";
import { sha256Hex } from "@arbor/ports";
import { Effect, Option } from "effect";
import { safetyStop } from "../../agent-loop-policy.js";
import { belongsToConversationExecution } from "../../checkpoint/conversation/evidence.js";
import {
  nativeCheckpointOwnerExecutionId,
  nativeCompactionProviderTurnId,
} from "../../checkpoint/native-evidence.js";
import { makeAgentStepContext } from "../../step-context.js";
import type { ModelDecisionDependencies } from "../contract.js";
import type { ConversationDecisionContextResult } from "../conversation-context.js";
import type { DecisionSessionContextError } from "./errors.js";

type SessionContextDependencies = Pick<
  ModelDecisionDependencies,
  | "input"
  | "tx"
  | "sessions"
  | "loopSteps"
  | "loopStepFence"
  | "providerTurns"
  | "now"
>;

type ConversationInput = Pick<
  Extract<ConversationDecisionContextResult, { readonly _tag: "Ready" }>,
  | "conversationExecution"
  | "conversationOwner"
  | "conversationMessages"
  | "conversationCheckpointItems"
  | "conversationContextRefs"
>;

/** Project the exact Session frontier and repair only the existing,
 * provenance-bound dangling invocation case. No provider call is started. */
export const loadDecisionSessionContext = (
  dependencies: SessionContextDependencies,
  phase: ConversationInput & {
    readonly turn: number;
    readonly repairAttempt: number;
    readonly providerTurnId: ProviderTurnId;
    readonly loopStep: AgentLoopStepRecord | undefined;
    readonly controlBasis: ControlBasis;
    readonly currentBindingFingerprint: string;
    readonly providerNativeSupported: boolean;
    readonly reasoningProjectionBinding: Parameters<
      typeof projectSessionTimeline
    >[3];
    readonly loadReasoningAttachmentBlobs: (
      entries: ReadonlyArray<SessionEntryRecord>,
    ) => Effect.Effect<ReadonlyMap<string, Uint8Array>, ExecutionDriverError>;
    readonly readExecutionTimeline: () => ReturnType<
      SessionRepositoryService["listRecentEntries"]
    >;
  },
) => {
  const { input, tx, sessions, loopSteps, loopStepFence, providerTurns, now } =
    dependencies;
  const {
    turn,
    repairAttempt,
    providerTurnId,
    loopStep,
    controlBasis,
    currentBindingFingerprint,
    providerNativeSupported,
    reasoningProjectionBinding,
    loadReasoningAttachmentBlobs,
    readExecutionTimeline,
    conversationExecution,
    conversationOwner,
    conversationMessages,
    conversationCheckpointItems,
    conversationContextRefs,
  } = phase;
  return Effect.gen(function* () {
    // A Human Conversation has its own durable history above. The primary
    // Workspace Session is the execution timeline for non-conversation episodes and
    // may contain tool calls, observations, or a dangling invocation from a
    // completely different episode. Letting that timeline participate here
    // both leaks technical Work context into chat and can block a harmless
    // conversation on an unrelated invocation. Start from an empty Session
    // projection; answered HumanMessages + the claimed message are the sole
    // conversation continuity source.
    const recentTimeline = yield* tx.transact(readExecutionTimeline());
    const typedTimeline = yield* tx.transact(sessions.supportsTypedTimeline());
    const workBinding = workEpisode(input.execution);
    const conversationTimeline = (entries: ReadonlyArray<SessionEntryRecord>) =>
      entries.filter(
        (entry) =>
          belongsToConversationExecution(entry, input.execution.executionId) &&
          entry.entryKind !== "CheckpointReference" &&
          entry.source?.kind !== "CompactionTurn",
      );
    let recentSessionEntries = conversationExecution
      ? conversationTimeline(recentTimeline)
      : workBinding !== null && typedTimeline
        ? filterEntriesForWork(recentTimeline, {
            executionId: input.execution.executionId,
            workId: workBinding.workId,
          })
        : recentTimeline;
    let reasoningAttachmentBlobs =
      yield* loadReasoningAttachmentBlobs(recentSessionEntries);
    let projectionDecision = decideSessionProjection(
      recentSessionEntries,
      currentBindingFingerprint,
      providerNativeSupported,
      reasoningProjectionBinding,
      reasoningAttachmentBlobs,
    );
    if (
      projectionDecision._tag === "Blocked" &&
      projectionDecision.reason === "UnresolvedInvocation" &&
      loopStepFence !== undefined &&
      (yield* tx.transact(sessions.supportsTypedTimeline()))
    ) {
      const unresolved = projectionDecision.callRefs.map((callRef) => {
        const matchingEntries = recentSessionEntries.filter(
          (candidate) =>
            candidate.entryKind === "ModelOutput" &&
            candidate.source?.kind === "ProviderTurnCall" &&
            typeof candidate.payload === "object" &&
            candidate.payload !== null &&
            (candidate.payload as { readonly _tag?: unknown })._tag ===
              "ToolCall" &&
            (candidate.payload as { readonly callRef?: unknown }).callRef ===
              callRef,
        );
        // callRef is scoped to a ProviderTurn. If the typed frontier cannot
        // identify one exact originating call, fail closed rather than
        // creating a result that can be paired with another turn's call.
        if (matchingEntries.length !== 1) return undefined;
        const entry = matchingEntries[0];
        if (entry === undefined) return undefined;
        const payload = entry.payload as {
          readonly providerTurnId?: unknown;
          readonly callRef: string;
          readonly toolRef?: unknown;
        };
        if (
          typeof payload.providerTurnId !== "string" ||
          payload.providerTurnId === providerTurnId ||
          entry.source?.ref !== `${payload.providerTurnId}:${payload.callRef}`
        ) {
          return undefined;
        }
        let originatingProviderTurnId: ProviderTurnId;
        try {
          originatingProviderTurnId = parse(ProviderTurnId)(
            payload.providerTurnId,
          );
        } catch {
          return undefined;
        }
        return {
          callRef: payload.callRef,
          originatingProviderTurnId,
          toolName:
            typeof payload.toolRef === "string" ? payload.toolRef : "unknown",
        };
      });
      if (
        unresolved.length > 0 &&
        unresolved.every(
          (entry): entry is NonNullable<typeof entry> => entry !== undefined,
        )
      ) {
        const repairSession = yield* tx.transact(
          sessions.findById(input.execution.sessionId),
        );
        if (Option.isNone(repairSession)) {
          return {
            _tag: "Complete" as const,
            outcome: {
              _tag: "Settle" as const,
              settlement: safetyStop("SessionContextBlocked:SessionNotFound"),
            },
          };
        }
        for (const invocation of unresolved) {
          // Keep ownership in Runtime's durable source identity rather than
          // the provider-facing ToolResult payload. The repository admits
          // only this versioned execution/ProviderTurn-bound form; legacy
          // repairs without provenance remain fail-closed.
          const repairIdentity = sha256Hex(
            `session-frontier-repair:v1:${input.execution.sessionId}:${input.execution.executionId}:${invocation.originatingProviderTurnId}:${invocation.callRef}`,
          );
          const observationRef = `observation_${repairIdentity}`;
          const item = {
            _tag: "ToolResult" as const,
            callRef: invocation.callRef,
            toolName: invocation.toolName,
            status: "Interrupted" as const,
            observationRef,
            modelOutputRef: `result_${sha256Hex(observationRef)}`,
            outputText:
              "tool invocation interrupted when its originating execution ended",
            truncated: false,
            artifactRefs: [],
          };
          yield* tx.transact(
            sessions.appendItemIdempotent(
              input.execution.sessionId,
              {
                item,
                contextEpoch: repairSession.value.contextEpoch,
                source: {
                  kind: "SessionFrontierRepair",
                  ref: `session-frontier-repair:v1:${input.execution.executionId}:${invocation.originatingProviderTurnId}:${repairIdentity}`,
                },
                contentHash: sha256Hex(JSON.stringify(item)),
              },
              loopStepFence,
            ),
          );
        }
        recentSessionEntries = yield* tx.transact(readExecutionTimeline());
        if (conversationExecution) {
          recentSessionEntries = conversationTimeline(recentSessionEntries);
        } else if (workBinding !== null && typedTimeline) {
          recentSessionEntries = filterEntriesForWork(recentSessionEntries, {
            executionId: input.execution.executionId,
            workId: workBinding.workId,
          });
        }
        reasoningAttachmentBlobs =
          yield* loadReasoningAttachmentBlobs(recentSessionEntries);
        projectionDecision = decideSessionProjection(
          recentSessionEntries,
          currentBindingFingerprint,
          providerNativeSupported,
          reasoningProjectionBinding,
          reasoningAttachmentBlobs,
        );
      }
    }
    let sessionProjection: SessionTimelineProjection;
    if (projectionDecision._tag === "Blocked") {
      const settledForRecovery =
        loopStep !== undefined && providerTurns !== undefined
          ? yield* tx.transact(providerTurns.findSettledResult(providerTurnId))
          : undefined;
      if (settledForRecovery?._tag === "SettledSuccess") {
        const lastClosed = projectionDecision.closedFrontier.lastSequence;
        sessionProjection = projectSessionTimeline(
          lastClosed === null
            ? []
            : recentSessionEntries.filter(
                (entry) => entry.sequence <= lastClosed,
              ),
          currentBindingFingerprint,
          providerNativeSupported,
          reasoningProjectionBinding,
          reasoningAttachmentBlobs,
        );
      } else {
        const settlement = safetyStop(
          `SessionContextBlocked:${projectionDecision.reason}:${projectionDecision.callRefs.join(",")}`,
        );
        if (
          loopStep !== undefined &&
          loopSteps !== undefined &&
          loopStepFence !== undefined &&
          loopStep.state === "Prepared"
        ) {
          yield* tx.transact(
            loopSteps.transition(
              {
                identity: loopStep.identity,
                expectedRevision: loopStep.revision,
                expectedState: "Prepared",
                next: {
                  ...loopStep,
                  state: "SettlementProposed",
                  settlement,
                  revision: loopStep.revision + 1,
                  updatedAt: yield* now(),
                },
              },
              loopStepFence,
            ),
          );
        }
        return {
          _tag: "Complete" as const,
          outcome: { _tag: "Settle" as const, settlement },
        };
      }
    } else {
      sessionProjection = projectionDecision.projection;
    }
    const sessionRecord = yield* tx.transact(
      sessions.findById(input.execution.sessionId),
    );
    if (Option.isNone(sessionRecord)) {
      return yield* Effect.fail<DecisionSessionContextError>({
        _tag: "SessionContextMissing",
        sessionId: input.execution.sessionId,
      });
    }
    const stepContext = makeAgentStepContext({
      logicalStepNo: turn,
      repairAttempt,
      sessionId: input.execution.sessionId,
      contextEpoch:
        conversationOwner?.contextEpoch ?? sessionRecord.value.contextEpoch,
      controlBasis,
      bindingFingerprint: currentBindingFingerprint,
      inputFrontier: sessionProjection.frontier,
    });
    const inputItems = [
      ...conversationCheckpointItems,
      ...conversationMessages.map((message) => ({
        _tag: "Message" as const,
        role: message.role,
        text: message.text,
      })),
      ...sessionProjection.inputItems,
    ];
    const historySourceRefs = [
      ...conversationCheckpointItems.map(
        (_, index) =>
          `conversation-checkpoint:${input.execution.workspaceId}:${conversationOwner?.contextEpoch ?? 0}:${index}`,
      ),
      ...conversationMessages.map((_, index) => `conversation-input:${index}`),
      ...sessionProjection.inputItems.map(
        (_, index) =>
          sessionProjection.contextRefs[index] ??
          `session:${input.execution.sessionId}:${index}`,
      ),
    ];
    const compressibleHistoryIndexes: number[] = [];
    const sessionInputOffset =
      conversationCheckpointItems.length + conversationMessages.length;
    // Conversation checkpoint/suffix/current input remains independently
    // owned by the RootWorkspace P14 owner. Only Work's bound Session
    // frontier participates in C3 Session-history compression.
    if (!conversationExecution) {
      const latestInputIndex = latestSessionInputIndex(
        sessionProjection.inputItems,
      );
      for (
        let index = 0;
        index < sessionProjection.inputItems.length;
        index += 1
      ) {
        if (index !== latestInputIndex) {
          compressibleHistoryIndexes.push(sessionInputOffset + index);
        }
      }
    }
    const historyContext = projectCompressibleHistory({
      inputItems,
      sourceRefs: historySourceRefs,
      compressibleIndexes: compressibleHistoryIndexes,
    });
    const messageContextRefs = [
      ...conversationContextRefs,
      ...sessionProjection.contextRefs,
    ];
    const nativeCheckpoint = sessionProjection.nativeCheckpoint;
    let checkpointOwnerExecutionId: Execution["executionId"] | undefined;
    let nativeCheckpointIsInherited = false;
    if (
      nativeCheckpoint?.providerTurnId !== undefined &&
      providerTurns !== undefined
    ) {
      const nativeProviderTurnId = nativeCompactionProviderTurnId(
        nativeCheckpoint.providerTurnId,
      );
      if (nativeProviderTurnId !== null) {
        const nativeManifest = yield* tx.transact(
          providerTurns.findManifestByTurn(nativeProviderTurnId),
        );
        const ownerExecutionId =
          nativeManifest === null
            ? undefined
            : nativeCheckpointOwnerExecutionId(nativeManifest.manifestJson);
        checkpointOwnerExecutionId = ownerExecutionId;
        nativeCheckpointIsInherited =
          ownerExecutionId !== undefined &&
          ownerExecutionId !== input.execution.executionId;
      }
    }
    return {
      _tag: "Ready" as const,
      recentSessionEntries,
      reasoningAttachmentBlobs,
      sessionProjection,
      sessionRecord,
      stepContext,
      inputItems,
      historyContext,
      messageContextRefs,
      nativeCheckpoint,
      checkpointOwnerExecutionId,
      nativeCheckpointIsInherited,
    };
  });
};
