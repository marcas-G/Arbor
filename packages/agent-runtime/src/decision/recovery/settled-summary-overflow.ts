import {
  ContextEpochNumber,
  parse,
  providerTurnOverflowReplacementId as makeOverflowReplacementProviderTurnId,
} from "@arbor/domain";
import type {
  AgentLoopStepFence,
  AgentLoopStepIdentity,
  AgentLoopStepProviderTurnLink,
  AgentLoopStepStoreService,
  ExecutionDriverError,
  SettledProviderTurnResult,
} from "@arbor/ports";
import { sha256Hex } from "@arbor/ports";
import { Effect, Option } from "effect";
import { commitRecoveredSummaryCompaction } from "../../compaction-coordinator.js";
import type { ModelDecisionDependencies } from "../contract.js";
import type { OverflowRecoveryState } from "./overflow-state.js";

type SummaryRecoveryDependencies = Pick<
  ModelDecisionDependencies,
  "input" | "capability" | "tx" | "sessions" | "options" | "failure" | "now"
> & {
  readonly loopSteps: AgentLoopStepStoreService;
  readonly loopStepFence: AgentLoopStepFence;
};

/** Validate the settled summary receipt, promote its exact checkpoint and
 * recover the linked replacement turn. The caller owns the restart. */
export const recoverSettledSummaryOverflow = (
  dependencies: SummaryRecoveryDependencies,
  phase: {
    readonly turn: number;
    readonly loopStepIdentity: AgentLoopStepIdentity;
    readonly providerTurnLinks: ReadonlyArray<AgentLoopStepProviderTurnLink>;
    readonly compactionLink: AgentLoopStepProviderTurnLink;
    readonly compactionReceipt: Extract<
      SettledProviderTurnResult,
      { readonly _tag: "SettledSuccess" }
    >;
    readonly compactionManifest: {
      readonly manifestJson: string;
      readonly portableRequestJson: string;
    } | null;
    readonly currentBindingFingerprint: string;
    readonly overflow: OverflowRecoveryState;
  },
): Effect.Effect<
  { readonly _tag: "Restart"; readonly overflow: OverflowRecoveryState },
  ExecutionDriverError
> => {
  const { input, capability, tx, sessions, options, failure, now, loopSteps, loopStepFence } =
    dependencies;
  const {
    turn,
    loopStepIdentity,
    providerTurnLinks,
    compactionLink,
    compactionReceipt,
    compactionManifest,
    currentBindingFingerprint,
  } = phase;
  return Effect.gen(function* () {
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
    return {
      _tag: "Restart" as const,
      overflow: {
        ...phase.overflow,
        overflowRecoveryAttempt: 1,
        overflowReplacementProviderTurnId: replacementProviderTurnId,
      },
    };
  });
};
