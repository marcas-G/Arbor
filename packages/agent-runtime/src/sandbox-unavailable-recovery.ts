import {
  type Execution,
  encodeExecutionEpisodeBinding,
  executionEpisode,
} from "@arbor/domain";
import type {
  AgentLoopStepActionRecord,
  AgentLoopStepRecord,
  SandboxPolicyDecisionStoreService,
  SandboxProviderUnavailableStoreService,
} from "@arbor/ports";
import { Effect, Option } from "effect";

const sandboxUnavailableDisposition = (value: unknown) => {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return undefined;
  const row = value as Record<string, unknown>;
  const keys = [
    "_tag",
    "attentionFactId",
    "invocationId",
    "policyRevision",
    "policyDigest",
    "profile",
    "providerId",
    "providerVersion",
    "capabilityRevision",
    "probeEvidenceRef",
    "failureCode",
  ];
  if (
    Object.keys(row).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(row, key)) ||
    row._tag !== "SandboxUnavailableV1" ||
    typeof row.attentionFactId !== "string" ||
    row.attentionFactId.length === 0 ||
    typeof row.invocationId !== "string" ||
    row.invocationId.length === 0 ||
    !Number.isSafeInteger(row.policyRevision) ||
    (row.policyRevision as number) < 1 ||
    typeof row.policyDigest !== "string" ||
    !/^[0-9a-f]{64}$/u.test(row.policyDigest) ||
    !["ReadOnly", "WorkspaceWrite"].includes(String(row.profile)) ||
    typeof row.providerId !== "string" ||
    row.providerId.length === 0 ||
    typeof row.providerVersion !== "string" ||
    row.providerVersion.length === 0 ||
    typeof row.capabilityRevision !== "string" ||
    row.capabilityRevision.length === 0 ||
    (row.probeEvidenceRef !== null &&
      (typeof row.probeEvidenceRef !== "string" ||
        row.probeEvidenceRef.length === 0)) ||
    typeof row.failureCode !== "string" ||
    row.failureCode.length === 0
  ) {
    return undefined;
  }
  return {
    attentionFactId: row.attentionFactId,
    invocationId: row.invocationId,
    policyRevision: row.policyRevision as number,
    policyDigest: row.policyDigest,
    profile: row.profile as "ReadOnly" | "WorkspaceWrite",
    providerId: row.providerId,
    providerVersion: row.providerVersion,
    capabilityRevision: row.capabilityRevision,
    probeEvidenceRef: row.probeEvidenceRef as string | null,
    failureCode: row.failureCode,
  };
};

/** A P9 SandboxUnavailableV1 action is the sole TerminalRejected shape which
 * may close an otherwise effects-committed Step. It is resumable only after
 * the immutable fact remains exact and a strictly higher, current P1 decision
 * is joined to its canonical committed result for the same Episode. */
export const verifySandboxUnavailableStepActionResume = (input: {
  readonly execution: Execution;
  readonly step: AgentLoopStepRecord;
  readonly action: AgentLoopStepActionRecord;
  readonly facts: SandboxProviderUnavailableStoreService;
  readonly decisions: SandboxPolicyDecisionStoreService;
  readonly now: string;
}): Effect.Effect<boolean, unknown, import("@arbor/ports").TransactionScope> =>
  Effect.gen(function* () {
    const disposition = sandboxUnavailableDisposition(input.action.disposition);
    const episode = executionEpisode(input.execution);
    if (
      disposition === undefined ||
      episode === undefined ||
      input.action.state !== "TerminalRejected" ||
      input.action.resultRef !== disposition.attentionFactId ||
      input.action.observationSourceRef !== undefined ||
      input.action.actionIndex + 1 !== input.step.nextActionIndex ||
      input.step.state !== "StepEffectsCommitted" ||
      !Number.isFinite(Date.parse(input.now))
    ) {
      return false;
    }
    const fact = yield* input.facts.findByExecutionAndRevision(
      input.execution.executionId,
      disposition.policyRevision,
    );
    const current = yield* input.decisions.findCurrentForExecution(
      input.execution.projectId,
      input.execution.workspaceId,
      input.execution.executionId,
    );
    if (fact === undefined || Option.isNone(current)) return false;
    const { decision, result } = current.value;
    const snapshot = result.effectivePolicySnapshot;
    const episodeJson = encodeExecutionEpisodeBinding(episode);
    const effectivePolicyIsAllowed =
      snapshot.kind === "OsEnforced"
        ? snapshot.profile === decision.profile &&
          snapshot.providerId === decision.providerId
        : snapshot.kind === "TrustedLocalUnconfinedV1" &&
          snapshot.trustedRuntimeIdentity === "TrustedLocal" &&
          snapshot.trustedRuntimeVersion === "builtin-v1" &&
          snapshot.profile === "FullAccess" &&
          snapshot.networkBoundary === "Unconfined" &&
          decision.profile === "FullAccess";
    return (
      fact.attentionFactId === disposition.attentionFactId &&
      fact.executionId === input.execution.executionId &&
      fact.projectId === input.execution.projectId &&
      fact.workspaceId === input.execution.workspaceId &&
      encodeExecutionEpisodeBinding(fact.episodeBinding) ===
        encodeExecutionEpisodeBinding(episode) &&
      encodeExecutionEpisodeBinding(decision.episodeBinding) === episodeJson &&
      fact.policyRevision === disposition.policyRevision &&
      fact.policyDigest === disposition.policyDigest &&
      fact.policyRevision < decision.policyRevision &&
      result.projectId === input.execution.projectId &&
      result.workspaceId === input.execution.workspaceId &&
      result.executionId === input.execution.executionId &&
      result.policyRevision === decision.policyRevision &&
      result.policyDigest === decision.policyDigest &&
      encodeExecutionEpisodeBinding(result.episodeBinding) === episodeJson &&
      effectivePolicyIsAllowed &&
      snapshot.policyRevision === decision.policyRevision &&
      snapshot.expiresAt === decision.expiresAt &&
      snapshot.projectId === input.execution.projectId &&
      snapshot.workspaceId === input.execution.workspaceId &&
      snapshot.executionId === input.execution.executionId &&
      encodeExecutionEpisodeBinding(snapshot.episodeBinding) ===
        encodeExecutionEpisodeBinding(episode) &&
      fact.profileId === disposition.profile &&
      fact.providerId === disposition.providerId &&
      fact.providerVersion === disposition.providerVersion &&
      fact.probeEvidenceRef === disposition.probeEvidenceRef &&
      fact.failureCode === disposition.failureCode &&
      Date.parse(decision.expiresAt) > Date.parse(input.now)
    );
  });
