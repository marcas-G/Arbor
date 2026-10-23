interface WaitCondition {
  readonly _tag: string;
  readonly workId?: string;
  readonly targetWorkRevision?: number;
  readonly approvalId?: string;
  readonly dependencyId?: string;
}

export interface CapturedWaitArguments {
  readonly disposition?: string;
  readonly waitSpec?: {
    readonly mode?: string;
    readonly conditions?: ReadonlyArray<WaitCondition>;
  };
}

/**
 * A narrow S1 oracle for a WorkEpisode waiting on a Verification that only
 * its own not-yet-issued CompletionClaim can start. Other WaitSpec conditions
 * (including real approval/dependency waits) remain valid and are not failed.
 */
export const isPrematureCurrentWorkVerificationWait = (input: {
  readonly wait: CapturedWaitArguments;
  readonly workId: string;
  readonly workRevision: number;
  readonly completionClaimRequested: boolean;
  readonly proofExists: boolean;
  readonly verificationExists: boolean;
}): boolean => {
  const conditions = input.wait.waitSpec?.conditions;
  if (
    input.wait.disposition !== "Yielded" ||
    input.wait.waitSpec?.mode !== "Any" ||
    conditions === undefined ||
    conditions.length === 0 ||
    input.completionClaimRequested ||
    input.proofExists ||
    input.verificationExists
  ) {
    return false;
  }
  return conditions.every(
    (condition) =>
      condition._tag === "VerificationChanged" &&
      condition.workId === input.workId &&
      condition.targetWorkRevision !== undefined &&
      condition.targetWorkRevision >= input.workRevision,
  );
};
