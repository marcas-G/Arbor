import {
  conversationResponseEpisode,
  executionEpisode,
  type ExecutionSettlement,
  type ProviderTurnId,
  providerTurnInferenceId,
} from "@arbor/domain";
import { decodeTurn, type SessionTimelineProjection } from "@arbor/model-context";
import type {
  AgentLoopStepFence,
  AgentLoopStepIdentity,
  AgentLoopStepProviderTurnLink,
  AgentLoopStepRecord,
  AgentLoopStepStoreService,
  ExecutionDriverError,
  ProviderTurnStoreService,
  SessionEntryRecord,
} from "@arbor/ports";
import { sha256Hex } from "@arbor/ports";
import { Effect, Option } from "effect";
import { MAX_TURNS, type ModelDecisionOutcome } from "../../agent-loop-policy.js";
import { hasValidCompiledInferenceRequestHash } from "../../agent-loop-step-recovery.js";
import type { ModelDecisionDependencies } from "../contract.js";
import type { DecisionCursor } from "../startup-recovery.js";

type CommittedRebaseDependencies = Pick<
  ModelDecisionDependencies,
  "input" | "capability" | "tx" | "options" | "failure" | "now"
> & {
  readonly loopSteps: AgentLoopStepStoreService;
  readonly loopStepFence: AgentLoopStepFence;
  readonly providerTurns: ProviderTurnStoreService;
};

type CommittedRebaseResult =
  | { readonly _tag: "Ready" }
  | { readonly _tag: "Restart"; readonly cursor: DecisionCursor }
  | { readonly _tag: "Complete"; readonly outcome: ModelDecisionOutcome };

/** Recover a terminal response or the exact next Prepared step after a
 * native checkpoint rebase. Durable transitions remain fenced. */
export const recoverCommittedRebaseStep = (
  dependencies: CommittedRebaseDependencies,
  phase: {
    readonly turn: number;
    readonly sourceStepIdentity: AgentLoopStepIdentity;
    readonly sourceStep: AgentLoopStepRecord;
    readonly sourceStepLinks: ReadonlyArray<AgentLoopStepProviderTurnLink>;
    readonly nativeManifestJson: Record<string, unknown>;
    readonly nativeCheckpoint: NonNullable<SessionTimelineProjection["nativeCheckpoint"]>;
    readonly nativeCheckpointProviderTurnId: string;
    readonly recentSessionEntries: ReadonlyArray<SessionEntryRecord>;
    readonly decodedProviderTurnId: (value: unknown) => ProviderTurnId | null;
  },
): Effect.Effect<CommittedRebaseResult, ExecutionDriverError> => {
  const { input, capability, tx, loopSteps, loopStepFence, providerTurns, options, failure, now } = dependencies;
  const {
    turn, sourceStepIdentity, sourceStep, sourceStepLinks, nativeManifestJson,
    nativeCheckpoint, nativeCheckpointProviderTurnId, recentSessionEntries,
    decodedProviderTurnId,
  } = phase;
  return Effect.gen(function* () {
    if (sourceStep.state === "StepEffectsCommitted") {
      const terminalInboxEpisode = executionEpisode(input.execution);
      const terminalMessageId = conversationResponseEpisode(
        input.execution,
      );
      const terminalInboxEntryKey =
        terminalInboxEpisode?._tag === "InboxEpisode"
          ? terminalInboxEpisode.entryKey
          : undefined;
      if (
        terminalMessageId !== null ||
        terminalInboxEntryKey !== undefined
      ) {
        const outputSequence = sourceStep.modelOutputSessionSequence;
        const outputHash = sourceStep.decodedOutputHash;
        const outputRows = recentSessionEntries.filter(
          (entry) => entry.sequence === outputSequence,
        );
        const replacementLinks = sourceStepLinks.filter(
          (link) => link.role === "OverflowReplacement",
        );
        const outputEntry = outputRows[0];
        const outputPayload =
          typeof outputEntry?.payload === "object" &&
          outputEntry.payload !== null
            ? (outputEntry.payload as Record<string, unknown>)
            : undefined;
        const outputProviderTurnId = outputPayload?.providerTurnId;
        const outputTurnId = decodedProviderTurnId(outputProviderTurnId);
        const replacementLink = replacementLinks[0];
        if (outputTurnId === null) {
          return yield* Effect.fail(
            failure({ _tag: "AgentLoopStepReplayBindingMismatch" }),
          );
        }
        const outputIdentityChecks = {
          sequence:
            outputSequence !== undefined && outputHash !== undefined,
          oneRow: outputRows.length === 1,
          modelOutput: outputEntry?.entryKind === "ModelOutput",
          providerSource: outputEntry?.source?.kind === "ProviderTurn",
          assistantPayload: outputPayload?._tag === "AssistantMessage",
          providerId: true,
          sourceRef:
            outputEntry?.source?.ref === `${outputTurnId}:assistant`,
          contentRef:
            outputPayload?.contentRef ===
            `provider:${outputTurnId}:assistant`,
          text:
            typeof outputPayload?.text === "string" &&
            typeof outputPayload.finishReason === "string",
          noActionCursor: sourceStep.nextActionIndex === 0,
          oneReplacementLink: replacementLinks.length === 1,
          linkStep:
            replacementLink?.identity.executionId ===
              sourceStep.identity.executionId &&
            replacementLink.identity.logicalStepNo ===
              sourceStep.identity.logicalStepNo &&
            replacementLink.identity.repairAttempt ===
              sourceStep.identity.repairAttempt,
          linkOrdinal: replacementLink?.overflowOrdinal === 0,
          linkProviderTurn:
            replacementLink?.providerTurnId === outputTurnId,
          linkPredecessor:
            replacementLink?.predecessorProviderTurnId ===
            nativeCheckpointProviderTurnId,
          linkEpoch:
            Number(replacementLink?.contextEpoch) ===
            Number(nativeCheckpoint.toEpoch),
        };
        if (Object.values(outputIdentityChecks).some((valid) => !valid)) {
          if (options.qualificationProbe !== undefined) {
            yield* Effect.promise(
              () =>
                options.qualificationProbe?.({
                  boundary: "AH19NativeCheckpointRecovery",
                  stage: `NativeRebaseTerminalIdentityChecks:${Object.entries(
                    outputIdentityChecks,
                  )
                    .map(([key, value]) => `${key}=${String(value)}`)
                    .join(",")}`,
                  executionId: String(input.execution.executionId),
                  providerTurnId: nativeCheckpointProviderTurnId,
                }) ?? Promise.resolve(),
            );
          }
          return yield* Effect.fail(
            failure({ _tag: "AgentLoopStepReplayBindingMismatch" }),
          );
        }
        const [outputResult, outputManifest] = yield* Effect.all(
          [
            tx.transact(providerTurns.findSettledResult(outputTurnId)),
            tx.transact(providerTurns.findManifestByTurn(outputTurnId)),
          ],
          { concurrency: 1 },
        ).pipe(Effect.mapError(failure));
        const outputResultChecks = {
          success: outputResult._tag === "SettledSuccess",
          version:
            outputResult._tag === "SettledSuccess" &&
            outputResult.evidenceVersion === "provider-success-v1",
          finish:
            outputResult._tag === "SettledSuccess" &&
            outputResult.finishReason === outputPayload?.finishReason,
          turnId:
            outputResult._tag === "SettledSuccess" &&
            outputResult.turn.providerTurnId === outputTurnId,
          execution:
            outputResult._tag === "SettledSuccess" &&
            outputResult.turn.executionId === input.execution.executionId,
          session:
            outputResult._tag === "SettledSuccess" &&
            outputResult.turn.sessionId === input.execution.sessionId,
          epoch:
            outputResult._tag === "SettledSuccess" &&
            outputResult.turn.contextEpoch ===
              replacementLink?.contextEpoch,
          model:
            outputResult._tag === "SettledSuccess" &&
            outputResult.turn.modelRef === capability.modelRef,
          manifestId:
            outputResult._tag === "SettledSuccess" &&
            outputResult.manifestId === outputResult.turn.manifestId,
          manifestFound: outputManifest !== null,
          manifestIdMatches:
            outputManifest !== null &&
            outputResult._tag === "SettledSuccess" &&
            outputManifest.manifestId === outputResult.manifestId,
          manifestJsonMatches:
            outputManifest !== null &&
            outputResult._tag === "SettledSuccess" &&
            outputManifest.manifestJson === outputResult.manifestJson,
        };
        if (Object.values(outputResultChecks).some((valid) => !valid)) {
          if (options.qualificationProbe !== undefined) {
            yield* Effect.promise(
              () =>
                options.qualificationProbe?.({
                  boundary: "AH19NativeCheckpointRecovery",
                  stage: `NativeRebaseTerminalResultChecks:${Object.entries(
                    outputResultChecks,
                  )
                    .map(([key, value]) => `${key}=${String(value)}`)
                    .join(",")}`,
                  executionId: String(input.execution.executionId),
                  providerTurnId: nativeCheckpointProviderTurnId,
                }) ?? Promise.resolve(),
            );
          }
          return yield* Effect.fail(
            failure({ _tag: "AgentLoopStepReplayBindingMismatch" }),
          );
        }
        if (
          outputResult._tag !== "SettledSuccess" ||
          outputManifest === null
        ) {
          return yield* Effect.fail(
            failure({ _tag: "AgentLoopStepReplayBindingMismatch" }),
          );
        }
        let outputManifestJson: Record<string, unknown>;
        try {
          const parsed = JSON.parse(
            outputManifest.manifestJson,
          ) as unknown;
          if (
            typeof parsed !== "object" ||
            parsed === null ||
            Array.isArray(parsed)
          ) {
            return yield* Effect.fail(
              failure({ _tag: "AgentLoopStepReplayBindingMismatch" }),
            );
          }
          outputManifestJson = parsed as Record<string, unknown>;
        } catch {
          return yield* Effect.fail(
            failure({ _tag: "AgentLoopStepReplayBindingMismatch" }),
          );
        }
        const outputManifestChecks = {
          providerTurn:
            outputManifestJson.providerTurnId === outputProviderTurnId,
          execution:
            outputManifestJson.executionId ===
            input.execution.executionId,
          session:
            outputManifestJson.sessionId === input.execution.sessionId,
          epoch:
            outputManifestJson.contextEpoch ===
            outputResult.turn.contextEpoch,
          model: outputManifestJson.modelRef === capability.modelRef,
          operation: outputManifestJson.operationKind === "Inference",
          step:
            outputManifestJson.logicalStepNo ===
            sourceStep.identity.logicalStepNo,
          repair:
            outputManifestJson.repairAttempt ===
            sourceStep.identity.repairAttempt,
          contract:
            outputManifestJson.outputContractRef ===
            outputResult.turn.outputContractRef,
          requestHash: hasValidCompiledInferenceRequestHash(
            outputManifestJson,
            outputManifest.portableRequestJson,
          ),
          sourceBinding:
            outputManifestJson.resolvedModelBindingFingerprint ===
            nativeManifestJson.resolvedModelBindingFingerprint,
        };
        if (Object.values(outputManifestChecks).some((valid) => !valid)) {
          if (options.qualificationProbe !== undefined) {
            yield* Effect.promise(
              () =>
                options.qualificationProbe?.({
                  boundary: "AH19NativeCheckpointRecovery",
                  stage: `NativeRebaseTerminalManifestChecks:${Object.entries(
                    outputManifestChecks,
                  )
                    .map(([key, value]) => `${key}=${String(value)}`)
                    .join(",")}`,
                  executionId: String(input.execution.executionId),
                  providerTurnId: nativeCheckpointProviderTurnId,
                }) ?? Promise.resolve(),
            );
          }
          return yield* Effect.fail(
            failure({ _tag: "AgentLoopStepReplayBindingMismatch" }),
          );
        }
        const decodedOutput = decodeTurn(outputResult.canonicalEvents);
        const sourceActions = yield* tx
          .transact(loopSteps.listActions(sourceStep.identity))
          .pipe(Effect.mapError(failure));
        const decodedOutputChecks = {
          decoded: decodedOutput.ok,
          noActions: sourceActions.length === 0,
          text:
            decodedOutput.ok &&
            decodedOutput.output.text === outputPayload?.text,
          finish:
            decodedOutput.ok &&
            decodedOutput.output.finishReason ===
              outputPayload?.finishReason,
          hash:
            decodedOutput.ok &&
            sha256Hex(
              JSON.stringify({
                providerTurnId: outputProviderTurnId,
                outputContractRef: outputResult.turn.outputContractRef,
                decoderVersion: "decode-turn-v1",
                text: decodedOutput.output.text,
                finishReason: decodedOutput.output.finishReason,
                toolInvocations: decodedOutput.output.toolInvocations,
              }),
            ) === outputHash,
        };
        if (Object.values(decodedOutputChecks).some((valid) => !valid)) {
          if (options.qualificationProbe !== undefined) {
            yield* Effect.promise(
              () =>
                options.qualificationProbe?.({
                  boundary: "AH19NativeCheckpointRecovery",
                  stage: `NativeRebaseTerminalDecodeChecks:${Object.entries(
                    decodedOutputChecks,
                  )
                    .map(([key, value]) => `${key}=${String(value)}`)
                    .join(",")}`,
                  executionId: String(input.execution.executionId),
                  providerTurnId: nativeCheckpointProviderTurnId,
                }) ?? Promise.resolve(),
            );
          }
          return yield* Effect.fail(
            failure({ _tag: "AgentLoopStepReplayBindingMismatch" }),
          );
        }
        if (!decodedOutput.ok) {
          return yield* Effect.fail(
            failure({ _tag: "AgentLoopStepReplayBindingMismatch" }),
          );
        }
        if (
          decodedOutput.output.toolInvocations.length === 0 &&
          decodedOutput.output.text.trim().length > 0 &&
          (terminalMessageId !== null ||
            terminalInboxEntryKey !== undefined)
        ) {
          const settlement: ExecutionSettlement =
            terminalMessageId !== null
              ? {
                  _tag: "Completed",
                  result: {
                    _tag: "ConversationResponseProduced",
                    messageId: terminalMessageId.messageId,
                  },
                }
              : terminalInboxEntryKey !== undefined
                ? {
                    _tag: "Completed",
                    result: {
                      _tag: "InboxInputHandled",
                      entryKey: terminalInboxEntryKey,
                    },
                  }
                : {
                    _tag: "Failed",
                    failure: {
                      _tag: "ExecutionFailure",
                      reason: "terminal inbox identity missing",
                    },
                  };
          yield* tx
            .transact(
              loopSteps.transition(
                {
                  identity: sourceStep.identity,
                  expectedRevision: sourceStep.revision,
                  expectedState: "StepEffectsCommitted",
                  next: {
                    ...sourceStep,
                    state: "SettlementProposed",
                    settlement,
                    revision: sourceStep.revision + 1,
                    updatedAt: yield* now(),
                  },
                },
                loopStepFence,
              ),
            )
            .pipe(Effect.mapError(failure));
          return { _tag: "Complete" as const, outcome: { _tag: "Settle" as const, settlement } };
        }
      }
      if (
        sourceStep.successor !== undefined ||
        loopSteps === undefined ||
        loopStepFence === undefined ||
        turn + 1 >= MAX_TURNS
      ) {
        return yield* Effect.fail(
          failure({ _tag: "AgentLoopStepReplayBindingMismatch" }),
        );
      }
      const successorIdentity = {
        executionId: sourceStep.identity.executionId,
        logicalStepNo: sourceStep.identity.logicalStepNo + 1,
        repairAttempt: 0,
      } as const;
      const successorProviderTurnId = providerTurnInferenceId(
        input.execution.executionId,
        successorIdentity.logicalStepNo,
      );
      const successorUpdatedAt = yield* now();
      const predecessorUpdatedAt = yield* now();
      yield* tx
        .transact(
          Effect.gen(function* () {
            yield* loopSteps.transition(
              {
                identity: sourceStep.identity,
                expectedRevision: sourceStep.revision,
                expectedState: "StepEffectsCommitted",
                next: {
                  ...sourceStep,
                  state: "NextStepReady",
                  successor: {
                    ...successorIdentity,
                    providerTurnId: successorProviderTurnId,
                  },
                  nextStepReason: "Continue",
                  revision: sourceStep.revision + 1,
                  updatedAt: predecessorUpdatedAt,
                },
              },
              loopStepFence,
            );
            yield* loopSteps.ensureSuccessor(
              sourceStep.identity,
              {
                identity: successorIdentity,
                predecessor: sourceStep.identity,
                providerTurnId: successorProviderTurnId,
                state: "Prepared",
                nextActionIndex: 0,
                revision: 0,
                updatedAt: successorUpdatedAt,
              },
              loopStepFence,
            );
          }),
        )
        .pipe(Effect.mapError(failure));
      if (options.qualificationProbe !== undefined) {
        yield* Effect.promise(
          () =>
            options.qualificationProbe?.({
              boundary: "AH19NativeCheckpointRecovery",
              stage: `NativeRebaseCompletesStepEffectsSuccessor:from=${sourceStep.identity.logicalStepNo}:to=${successorIdentity.logicalStepNo}:providerTurn=${successorProviderTurnId}`,
              executionId: String(input.execution.executionId),
              providerTurnId: nativeCheckpointProviderTurnId,
            }) ?? Promise.resolve(),
        );
      }
      return {
        _tag: "Restart" as const,
        cursor: { turn: successorIdentity.logicalStepNo, repairAttempt: 0 },
      };
    }
    if (
      sourceStep.state === "NextStepReady" &&
      sourceStep.successor !== undefined
    ) {
      const sourceSuccessor = sourceStep.successor;
      const successorIdentity = {
        executionId: sourceSuccessor.executionId,
        logicalStepNo: sourceSuccessor.logicalStepNo,
        repairAttempt: sourceSuccessor.repairAttempt,
      };
      const successorOption = yield* tx
        .transact(loopSteps.find(successorIdentity))
        .pipe(Effect.mapError(failure));
      const successorRecord = Option.isSome(successorOption)
        ? successorOption.value
        : undefined;
      const successorChecks = {
        exists: successorRecord !== undefined,
        execution:
          successorIdentity.executionId === input.execution.executionId,
        exactNextStep:
          successorIdentity.logicalStepNo ===
          sourceStepIdentity.logicalStepNo + 1,
        initialRepair: successorIdentity.repairAttempt === 0,
        providerTurn:
          successorRecord?.providerTurnId ===
          sourceSuccessor.providerTurnId,
        predecessorExecution:
          successorRecord?.predecessor?.executionId ===
          sourceStepIdentity.executionId,
        predecessorStep:
          successorRecord?.predecessor?.logicalStepNo ===
          sourceStepIdentity.logicalStepNo,
        predecessorRepair:
          successorRecord?.predecessor?.repairAttempt ===
          sourceStepIdentity.repairAttempt,
      };
      if (options.qualificationProbe !== undefined) {
        yield* Effect.promise(
          () =>
            options.qualificationProbe?.({
              boundary: "AH19NativeCheckpointRecovery",
              stage: `NativeRebaseSuccessorChecks:${Object.entries(
                successorChecks,
              )
                .map(([key, value]) => `${key}=${String(value)}`)
                .join(",")}`,
              executionId: String(input.execution.executionId),
              providerTurnId: nativeCheckpointProviderTurnId,
            }) ?? Promise.resolve(),
        );
      }
      if (Object.values(successorChecks).some((valid) => !valid)) {
        return yield* Effect.fail(
          failure({ _tag: "AgentLoopStepReplayBindingMismatch" }),
        );
      }
      if (options.qualificationProbe !== undefined) {
        yield* Effect.promise(
          () =>
            options.qualificationProbe?.({
              boundary: "AH19NativeCheckpointRecovery",
              stage: `NativeRebaseResumesPersistedSuccessor:from=${sourceStepIdentity.logicalStepNo}:to=${successorIdentity.logicalStepNo}:providerTurn=${sourceSuccessor.providerTurnId}`,
              executionId: String(input.execution.executionId),
              providerTurnId: nativeCheckpointProviderTurnId,
            }) ?? Promise.resolve(),
        );
      }
      return {
        _tag: "Restart" as const,
        cursor: { turn: successorIdentity.logicalStepNo, repairAttempt: successorIdentity.repairAttempt },
      };
    }
    return { _tag: "Ready" as const };
  });
};
