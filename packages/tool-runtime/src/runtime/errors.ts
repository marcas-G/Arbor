import type {
  BoundedObservation,
  CanonicalToolObservation,
  ExecutableApprovalRecord,
  LeaseFencingRejected,
  NoEffectDenialCode,
  ToolRuntimeError,
} from "@arbor/ports";

export const bounded = (text: string, limit = 2000): BoundedObservation => ({
  text: text.length > limit ? text.slice(0, limit) : text,
  truncated: text.length > limit,
});

export const denialReason = (reasonCode: NoEffectDenialCode): string => {
  switch (reasonCode) {
    case "InvocationAuthorityDenied":
      return "tool authority denied";
    case "ApprovalRequired":
      return "approval required";
    case "ApprovalRejected":
      return "approval rejected";
    case "ApprovalNotFound":
      return "approval not found";
    case "ApprovalMismatch":
      return "approval does not match this invocation";
    case "ApprovalExpired":
      return "approval expired";
    case "ApprovalConsumedByOtherInvocation":
      return "approval was consumed by another invocation";
    case "ResourceResolutionDenied":
      return "tool resource could not be resolved";
    case "ResourceAdmissionDenied":
      return "tool resource admission denied";
    case "ApprovalNoLongerAuthorized":
      return "approval is no longer authorized";
    case "ProcessExecutionDisabled":
      return "Process execution is disabled for this daemon; the action was not started.";
    case "NativeOsTupleUnavailable":
      return "No qualified Native OS process tuple is available; the action was not started.";
  }
};

/** Preserve an already-committed human Reject across later replay. Expiry is
 * a transition from Pending/Approved, never a reinterpretation of Rejected. */
export const executableApprovalTerminalDenial = (
  approval: Pick<ExecutableApprovalRecord, "state" | "expiresAt">,
  now: string,
): "ApprovalRejected" | "ApprovalExpired" | null => {
  if (approval.state === "Rejected") return "ApprovalRejected";
  if (approval.state === "Expired" || approval.expiresAt <= now) {
    return "ApprovalExpired";
  }
  return null;
};

export const P39_RESOURCE_RESOLUTION_STALE = {
  _tag: "P39ResourceResolutionStale",
} as const;

export const denied = (reasonCode: NoEffectDenialCode): CanonicalToolObservation => ({
  _tag: "Denied",
  reasonCode,
  reason: denialReason(reasonCode),
});

export const approvalDenialCode = (reason: string): NoEffectDenialCode => {
  if (reason === "approval already consumed") {
    return "ApprovalConsumedByOtherInvocation";
  }
  if (reason === "approval expired") return "ApprovalExpired";
  return "ApprovalMismatch";
};

export const reconciliationRetryDenialReasonCode = (
  reasonCode: NoEffectDenialCode,
): "ApprovalNoLongerAuthorized" | "AuthoritySnapshotChanged" =>
  reasonCode === "ApprovalRequired" ||
  reasonCode === "ApprovalRejected" ||
  reasonCode === "ApprovalNotFound" ||
  reasonCode === "ApprovalMismatch" ||
  reasonCode === "ApprovalExpired" ||
  reasonCode === "ApprovalConsumedByOtherInvocation" ||
  reasonCode === "ApprovalNoLongerAuthorized"
    ? "ApprovalNoLongerAuthorized"
    : "AuthoritySnapshotChanged";

export const isLeaseFencingRejected = (
  cause: unknown,
): cause is LeaseFencingRejected =>
  typeof cause === "object" &&
  cause !== null &&
  "_tag" in cause &&
  cause._tag === "LeaseFencingRejected";

export const hasCompleteExecutionFence = (fence: unknown): boolean => {
  if (typeof fence !== "object" || fence === null) return false;
  const value = fence as Record<string, unknown>;
  return (
    typeof value.executionId === "string" &&
    value.executionId.length > 0 &&
    typeof value.workerId === "string" &&
    value.workerId.length > 0 &&
    typeof value.workerIncarnationId === "string" &&
    value.workerIncarnationId.length > 0 &&
    typeof value.fencingGeneration === "number" &&
    Number.isInteger(value.fencingGeneration) &&
    value.fencingGeneration >= 0
  );
};

export const isP39ResourceResolutionStale = (
  cause: unknown,
): cause is typeof P39_RESOURCE_RESOLUTION_STALE =>
  typeof cause === "object" &&
  cause !== null &&
  "_tag" in cause &&
  cause._tag === P39_RESOURCE_RESOLUTION_STALE._tag;

export const operationalFailure =
  (
    stage: import("@arbor/ports").ToolRuntimeOperationalStage,
    invocationRef: string,
  ) =>
  (cause: unknown): ToolRuntimeError => ({
    _tag: "ToolRuntimeOperationalFailure",
    stage,
    effectDisposition:
      stage === "Executor" || stage === "SettlementJournal"
        ? "OutcomeUncertain"
        : "NotStarted",
    invocationRef,
    cause,
  });

