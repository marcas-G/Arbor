import type { VerificationVerdict, WorkspaceId } from "@arbor/domain";

/** The frozen P8/F18 side-effect matrix for one concluded Verification. */
export interface VerificationConclusionEffectPlan {
  readonly releaseMatchingWorkWaits: true;
  readonly reevaluateOwner: boolean;
  readonly admitParentResult: boolean;
  readonly wakeParent: boolean;
}

export const deriveVerificationConclusionEffectPlan = (
  verdict: VerificationVerdict,
  parentWorkspaceId: WorkspaceId | null,
): VerificationConclusionEffectPlan => {
  const reevaluateOwner = verdict !== "Pass";
  const admitParentResult = verdict === "Pass" && parentWorkspaceId !== null;
  return {
    releaseMatchingWorkWaits: true,
    reevaluateOwner,
    admitParentResult,
    wakeParent: admitParentResult,
  };
};
