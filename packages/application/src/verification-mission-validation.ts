import type { VerificationMission } from "@arbor/domain";

/** Shared P8/S2 completeness rules for persisted VerificationMission values. */
export const invalidVerificationMissionReason = (
  mission: VerificationMission,
): string | null => {
  if (typeof mission.goal !== "string" || mission.goal.length === 0) {
    return "mission goal must be a non-empty string";
  }
  if (!Array.isArray(mission.criteria)) {
    return "mission criteria must be an array";
  }
  if (mission.criteria.length === 0) {
    return "mission requires at least one criterion";
  }
  for (const criterion of mission.criteria) {
    if (
      typeof criterion.criterionId !== "string" ||
      criterion.criterionId.length === 0
    ) {
      return "every criterion requires a non-empty criterionId";
    }
    if (
      typeof criterion.requirement !== "string" ||
      criterion.requirement.length === 0
    ) {
      return "every criterion requires requirement text";
    }
    if (typeof criterion.required !== "boolean") {
      return "every criterion carries the required flag";
    }
  }
  if (!mission.criteria.some((criterion) => criterion.required)) {
    return "mission requires at least one required criterion";
  }
  if (!Array.isArray(mission.riskRequirements)) {
    return "mission riskRequirements must be an array";
  }
  return null;
};
