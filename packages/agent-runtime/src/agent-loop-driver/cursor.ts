import type { Execution } from "@arbor/domain";
import type { AgentLoopStepRecord } from "@arbor/ports";
import {
  decodeExhaustedRepairDisposition,
  retryDispositionMatchesSuccessor,
} from "../agent-loop-step-recovery.js";

export interface AgentLoopStepCursor {
  readonly logicalStepNo: number;
  readonly repairAttempt: number;
}

const sameStepIdentity = (
  left: AgentLoopStepRecord["identity"],
  right: AgentLoopStepRecord["identity"],
): boolean =>
  left.executionId === right.executionId &&
  left.logicalStepNo === right.logicalStepNo &&
  left.repairAttempt === right.repairAttempt;

const compareStepIdentity = (
  left: AgentLoopStepRecord,
  right: AgentLoopStepRecord,
): number =>
  left.identity.logicalStepNo - right.identity.logicalStepNo ||
  left.identity.repairAttempt - right.identity.repairAttempt;

/** Validate the entire durable predecessor/successor chain before choosing its
 * only resumable frontier. A valid history has one exact root, consecutive
 * repairs/steps, and every earlier row durably closed into the next row. */
export const selectInitialAgentLoopStepCursor = (
  steps: ReadonlyArray<AgentLoopStepRecord>,
): AgentLoopStepCursor | undefined => {
  if (steps.length === 0) return { logicalStepNo: 0, repairAttempt: 0 };

  const ordered = [...steps].sort(compareStepIdentity);
  const root = ordered[0];
  if (
    root === undefined ||
    root.identity.logicalStepNo !== 0 ||
    root.identity.repairAttempt !== 0 ||
    root.predecessor !== undefined
  ) {
    return undefined;
  }

  const identities = new Set<string>();
  for (let index = 0; index < ordered.length; index += 1) {
    const current = ordered[index];
    if (
      current === undefined ||
      current.identity.executionId !== root.identity.executionId ||
      !Number.isSafeInteger(current.identity.logicalStepNo) ||
      current.identity.logicalStepNo < 0 ||
      !Number.isSafeInteger(current.identity.repairAttempt) ||
      current.identity.repairAttempt < 0 ||
      current.providerTurnId.length === 0
    ) {
      return undefined;
    }
    const key = `${current.identity.executionId}:${current.identity.logicalStepNo}:${current.identity.repairAttempt}`;
    if (identities.has(key)) return undefined;
    identities.add(key);

    if (index === 0) continue;
    const previous = ordered[index - 1];
    if (
      previous === undefined ||
      current.predecessor === undefined ||
      !sameStepIdentity(current.predecessor, previous.identity) ||
      previous.successor === undefined ||
      !sameStepIdentity(previous.successor, current.identity) ||
      previous.successor.providerTurnId !== current.providerTurnId
    ) {
      return undefined;
    }
    const isRepairSuccessor =
      current.identity.logicalStepNo === previous.identity.logicalStepNo &&
      current.identity.repairAttempt === previous.identity.repairAttempt + 1;
    const isNextStepSuccessor =
      current.identity.logicalStepNo === previous.identity.logicalStepNo + 1 &&
      current.identity.repairAttempt === 0;
    if (
      (previous.state === "OutputRejected" && !isRepairSuccessor) ||
      (previous.state === "NextStepReady" && !isNextStepSuccessor) ||
      (previous.state !== "OutputRejected" &&
        previous.state !== "NextStepReady")
    ) {
      return undefined;
    }
    if (
      previous.state === "OutputRejected" &&
      !retryDispositionMatchesSuccessor(previous, current)
    ) {
      return undefined;
    }
  }

  const current = ordered.at(-1);
  if (
    current === undefined ||
    current.successor !== undefined ||
    current.state === "NextStepReady" ||
    (current.state === "OutputRejected" &&
      decodeExhaustedRepairDisposition(current.repairDisposition) === undefined)
  ) {
    return undefined;
  }
  return {
    logicalStepNo: current.identity.logicalStepNo,
    repairAttempt: current.identity.repairAttempt,
  };
};

/** A Prepared row is still bound to the ProviderTurn manifest allocated for
 * that exact Execution/session/cursor; recovery must not trust the row state
 * to skip this binding check. */
export const isAgentLoopStepManifestBound = (
  step: AgentLoopStepRecord,
  executionId: Execution["executionId"],
  sessionId: Execution["sessionId"],
  persistedManifest: {
    readonly manifestId: string;
    readonly manifestJson: string;
  } | null,
): boolean => {
  if (persistedManifest === null || step.providerTurnId.length === 0) {
    return false;
  }
  let manifest: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(persistedManifest.manifestJson);
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      return false;
    }
    manifest = parsed as Record<string, unknown>;
  } catch {
    return false;
  }
  return (
    manifest.providerTurnId === step.providerTurnId &&
    manifest.executionId === executionId &&
    manifest.sessionId === sessionId &&
    manifest.logicalStepNo === step.identity.logicalStepNo &&
    manifest.repairAttempt === step.identity.repairAttempt &&
    (step.manifestId === undefined ||
      step.manifestId === persistedManifest.manifestId)
  );
};

/** A durable Prepared step is created before model-context preparation. In
 * particular, Native compaction can be the first ProviderTurn operation for
 * that step, so a crash before its owner/session commit may leave only the
 * Native manifest while the ordinary inference turn has not been manifested
 * yet. Defer the inference-manifest check only for that exact pre-provider
 * state; model-decision recovery validates any Native source manifest before
 * it resumes, and ProviderRuntime binds the eventual inference request. */
export const isPreparedStepAwaitingInitialManifest = (
  step: AgentLoopStepRecord,
  persistedManifest: {
    readonly manifestId: string;
    readonly manifestJson: string;
  } | null,
): boolean =>
  step.state === "Prepared" &&
  step.manifestId === undefined &&
  persistedManifest === null;

