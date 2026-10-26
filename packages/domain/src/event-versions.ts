import { EVENT_CATALOG, type EventTypeName } from "./events.js";

export interface EventVersionCapability {
  readonly writer: ReadonlyArray<number>;
  readonly reader: ReadonlyArray<number>;
}

const OTHER_EVENT_V1_NAMES = [
  "ProjectCreated",
  "ProjectPolicyChanged",
  "ProjectRenamed",
  "ProjectClosed",
  "WorkspaceCreated",
  "WorkspaceResourceActivationChanged",
  "ResponsibilityChanged",
  "ResourceBoundaryChanged",
  "WorkspacePolicyChanged",
  "WorkspaceRetired",
  "WorkspaceLineageRecorded",
  "PrimarySessionReplaced",
  "WorkAssigned",
  "CurrentWorkChanged",
  "WorkRefined",
  "WorkCompleted",
  "WorkCancelled",
  "WorkSteered",
  "WorkAmended",
  "WorkBlockerResolved",
  "WorkBlockerSuperseded",
  "DependencyDeclared",
  "DependencySatisfied",
  "DependencyContractRevised",
  "DependencyWithdrawn",
  "DependencyMarkedUnfulfillable",
  "DeadlockAttentionRequested",
  "ReconciliationEscalated",
  "AssignWorkTargetBindingEscalated",
  "DeliverReplayEscalated",
  "ToolObservationReplayEvidenceEscalated",
  "SubmittedDecisionBindingEscalated",
  "SandboxProviderUnavailable",
  "LegacyAdoptionEvidenceEscalated",
  "LegacyAdoptionEvidenceResolved",
  "DeliverableProduced",
  "MessageSent",
  "VerificationStarted",
  "WorkOutcomeAccepted",
  "ExecutionAdmitted",
  "ExecutionStopRequested",
  "ExecutionSettled",
  "PermissionChanged",
  "SandboxPolicyGrantIssued",
  "SandboxPolicyDecisionRecorded",
  "DecisionRecorded",
  "EnvironmentChanged",
  "WorktreeCreated",
  "WorktreeRetired",
  "HumanInterventionApplied",
  "HumanMessageSubmitted",
  "ConversationResponseResumed",
  "ConversationResponseCancelled",
  "ControlApprovalResolved",
  "ExecutableApprovalRequested",
  "ExecutableApprovalResolved",
] as const satisfies ReadonlyArray<
  Exclude<EventTypeName, "VerificationConcluded">
>;

const v1: EventVersionCapability = Object.freeze({
  writer: Object.freeze([1]),
  reader: Object.freeze([1]),
});

/** Closed P1 writer/reader capability table. This is deliberately not
 * generated from EVENT_CATALOG: a new event type has no default version and
 * must be explicitly reviewed. The domain test compares both key sets. */
export const EVENT_VERSION_REGISTRY: Partial<
  Readonly<Record<EventTypeName, EventVersionCapability>>
> = Object.freeze({
  ...Object.fromEntries(OTHER_EVENT_V1_NAMES.map((name) => [name, v1])),
  VerificationConcluded: Object.freeze({
    writer: Object.freeze([2]),
    reader: Object.freeze([1, 2]),
  }),
  ResourceOwnershipChanged: Object.freeze({
    writer: Object.freeze([2]),
    reader: Object.freeze([1, 2]),
  }),
});

const hasVersion = (
  versions: ReadonlyArray<number> | undefined,
  version: number,
): boolean => versions?.includes(version) === true;

export const isSupportedEventWritePair = (
  eventType: string,
  eventVersion: number,
): boolean =>
  Object.hasOwn(EVENT_CATALOG, eventType) &&
  hasVersion(
    EVENT_VERSION_REGISTRY[eventType as EventTypeName]?.writer,
    eventVersion,
  );

export const isSupportedEventReadPair = (
  eventType: string,
  eventVersion: number,
): boolean =>
  Object.hasOwn(EVENT_CATALOG, eventType) &&
  hasVersion(
    EVENT_VERSION_REGISTRY[eventType as EventTypeName]?.reader,
    eventVersion,
  );

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const hasExactKeys = (
  value: Record<string, unknown>,
  expected: ReadonlyArray<string>,
): boolean => {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return (
    actual.length === sortedExpected.length &&
    actual.every((key, index) => key === sortedExpected[index])
  );
};

const stringArray = (value: unknown): value is ReadonlyArray<string> =>
  Array.isArray(value) && value.every((entry) => typeof entry === "string");

const strictVerificationConcludedV2 = (value: unknown): boolean => {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "verificationId",
      "workId",
      "targetWorkRevision",
      "verdict",
      "conclusionReason",
      "evidenceRefs",
      "summaryRef",
      "missionSnapshot",
      "criteriaResults",
      "snapshotStatus",
    ])
  ) {
    return false;
  }
  if (
    typeof value.verificationId !== "string" ||
    typeof value.workId !== "string" ||
    !Number.isSafeInteger(value.targetWorkRevision) ||
    (value.verdict !== "Pass" &&
      value.verdict !== "Fail" &&
      value.verdict !== "Unknown") ||
    (value.conclusionReason !== null &&
      value.conclusionReason !== "Orphaned") ||
    !stringArray(value.evidenceRefs) ||
    typeof value.summaryRef !== "string" ||
    !isRecord(value.missionSnapshot) ||
    !hasExactKeys(value.missionSnapshot, [
      "goal",
      "criteria",
      "riskRequirements",
    ]) ||
    typeof value.missionSnapshot.goal !== "string" ||
    !stringArray(value.missionSnapshot.riskRequirements) ||
    !Array.isArray(value.missionSnapshot.criteria) ||
    !Array.isArray(value.criteriaResults) ||
    (value.snapshotStatus !== "Available" &&
      value.snapshotStatus !== "NotApplicableOrphaned")
  ) {
    return false;
  }
  const missionCriteria = value.missionSnapshot.criteria;
  const resultCriteria = value.criteriaResults;
  const conclusionEvidenceRefs = value.evidenceRefs as ReadonlyArray<string>;
  const missionIds = new Set<string>();
  const flattenedEvidence: string[] = [];
  for (const criterion of missionCriteria) {
    if (
      !isRecord(criterion) ||
      !hasExactKeys(criterion, ["criterionId", "requirement", "required"]) ||
      typeof criterion.criterionId !== "string" ||
      typeof criterion.requirement !== "string" ||
      typeof criterion.required !== "boolean"
    ) {
      return false;
    }
    if (missionIds.has(criterion.criterionId)) return false;
    missionIds.add(criterion.criterionId);
  }
  for (const [index, result] of resultCriteria.entries()) {
    const resultEvidenceRefs = isRecord(result)
      ? result.evidenceRefs
      : undefined;
    if (
      !isRecord(result) ||
      !hasExactKeys(result, [
        "criterionId",
        "requirement",
        "required",
        "verdict",
        "evidenceRefs",
      ]) ||
      typeof result.criterionId !== "string" ||
      typeof result.requirement !== "string" ||
      typeof result.required !== "boolean" ||
      (result.verdict !== "Pass" &&
        result.verdict !== "Fail" &&
        result.verdict !== "Unknown") ||
      !stringArray(resultEvidenceRefs)
    ) {
      return false;
    }
    const criterion = missionCriteria[index];
    if (
      criterion === undefined ||
      result.criterionId !== criterion.criterionId ||
      result.requirement !== criterion.requirement ||
      result.required !== criterion.required ||
      resultEvidenceRefs.length === 0 ||
      new Set(resultEvidenceRefs).size !== resultEvidenceRefs.length ||
      resultEvidenceRefs.some((evidenceId, evidenceIndex) => {
        const previousEvidence = resultEvidenceRefs[evidenceIndex - 1];
        return (
          evidenceIndex > 0 &&
          previousEvidence !== undefined &&
          previousEvidence > evidenceId
        );
      })
    ) {
      return false;
    }
    flattenedEvidence.push(...resultEvidenceRefs);
  }
  return value.conclusionReason === "Orphaned"
    ? value.verdict === "Unknown" &&
        value.snapshotStatus === "NotApplicableOrphaned" &&
        resultCriteria.length === 0 &&
        conclusionEvidenceRefs.length === 0
    : value.snapshotStatus === "Available" &&
        resultCriteria.length === missionCriteria.length &&
        flattenedEvidence.length === conclusionEvidenceRefs.length &&
        flattenedEvidence.every(
          (evidenceId, index) => conclusionEvidenceRefs[index] === evidenceId,
        );
};

const strictVerificationConcludedV1 = (value: unknown): boolean =>
  isRecord(value) &&
  hasExactKeys(value, [
    "verificationId",
    "workId",
    "targetWorkRevision",
    "verdict",
    "conclusionReason",
    "evidenceRefs",
    "summaryRef",
  ]) &&
  typeof value.verificationId === "string" &&
  typeof value.workId === "string" &&
  Number.isSafeInteger(value.targetWorkRevision) &&
  (value.verdict === "Pass" ||
    value.verdict === "Fail" ||
    value.verdict === "Unknown") &&
  typeof value.conclusionReason === "string" &&
  stringArray(value.evidenceRefs) &&
  typeof value.summaryRef === "string";

const strictOwnershipClaimV2 = (value: unknown): boolean =>
  isRecord(value) &&
  hasExactKeys(value, [
    "claimId",
    "workspaceId",
    "region",
    "sourceAddressSnapshot",
    "resourceBoundaryRevision",
    "resolvedAtEnvironmentRevision",
    "createdAt",
    "releasedAt",
    "claimRevision",
    "exclusions",
    "delegatingWorkspaceId",
    "delegationSourceId",
  ]) &&
  typeof value.claimId === "string" &&
  typeof value.workspaceId === "string" &&
  isRecord(value.region) &&
  typeof value.region.resourceSpaceId === "string" &&
  isRecord(value.region.normalizedRegion) &&
  isRecord(value.sourceAddressSnapshot) &&
  Number.isSafeInteger(value.resourceBoundaryRevision) &&
  typeof value.resolvedAtEnvironmentRevision === "string" &&
  typeof value.createdAt === "string" &&
  (value.releasedAt === null || typeof value.releasedAt === "string") &&
  Number.isSafeInteger(value.claimRevision) &&
  Array.isArray(value.exclusions) &&
  value.exclusions.every(
    (region) =>
      isRecord(region) &&
      typeof region.resourceSpaceId === "string" &&
      isRecord(region.normalizedRegion),
  ) &&
  (value.delegatingWorkspaceId === null ||
    typeof value.delegatingWorkspaceId === "string") &&
  (value.delegationSourceId === null ||
    typeof value.delegationSourceId === "string");

const strictResourceOwnershipChangedV2 = (value: unknown): boolean => {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "_tag",
      "operation",
      "delegation",
      "parentClaim",
      "childClaim",
    ]) ||
    value._tag !== "ResourceOwnershipChanged" ||
    (value.operation !== "Delegated" &&
      value.operation !== "Transferred" &&
      value.operation !== "Reclaimed") ||
    !isRecord(value.delegation) ||
    !hasExactKeys(value.delegation, [
      "delegationSourceId",
      "formationProposalId",
      "formationProposalRevision",
      "parentWorkspaceId",
      "childWorkspaceId",
      "approvedBy",
      "causedByCommandId",
    ])
  ) {
    return false;
  }
  const delegation = value.delegation;
  if (
    !strictOwnershipClaimV2(value.parentClaim) ||
    !strictOwnershipClaimV2(value.childClaim)
  ) {
    return false;
  }
  const parentClaim = value.parentClaim as Record<string, unknown>;
  const childClaim = value.childClaim as Record<string, unknown>;
  const parentRegion = parentClaim.region as
    | Record<string, unknown>
    | undefined;
  const childRegion = childClaim.region as Record<string, unknown> | undefined;
  const parentExclusions = parentClaim.exclusions as
    | ReadonlyArray<unknown>
    | undefined;
  return (
    typeof delegation.delegationSourceId === "string" &&
    typeof delegation.formationProposalId === "string" &&
    Number.isSafeInteger(delegation.formationProposalRevision) &&
    delegation.delegationSourceId ===
      `formation:${delegation.formationProposalId}:${delegation.formationProposalRevision}` &&
    typeof delegation.parentWorkspaceId === "string" &&
    typeof delegation.childWorkspaceId === "string" &&
    typeof delegation.approvedBy === "string" &&
    typeof delegation.causedByCommandId === "string" &&
    parentClaim.workspaceId === delegation.parentWorkspaceId &&
    childClaim.workspaceId === delegation.childWorkspaceId &&
    childClaim.delegatingWorkspaceId === delegation.parentWorkspaceId &&
    childClaim.delegationSourceId === delegation.delegationSourceId &&
    parentRegion !== undefined &&
    childRegion !== undefined &&
    Array.isArray(parentExclusions) &&
    (value.operation === "Delegated"
      ? parentExclusions.some((exclusion) => {
          if (!isRecord(exclusion)) return false;
          const region = childRegion as Record<string, unknown>;
          const excluded = exclusion;
          return (
            excluded.resourceSpaceId === region.resourceSpaceId &&
            JSON.stringify(excluded.normalizedRegion) ===
              JSON.stringify(region.normalizedRegion)
          );
        })
      : value.operation === "Transferred"
        ? parentClaim.releasedAt !== null &&
          parentExclusions.length === 0 &&
          parentRegion.resourceSpaceId === childRegion.resourceSpaceId &&
          JSON.stringify(parentRegion.normalizedRegion) ===
            JSON.stringify(childRegion.normalizedRegion)
        : childClaim.releasedAt !== null &&
          parentClaim.releasedAt === null &&
          (isRecord(parentRegion.normalizedRegion) &&
          parentRegion.normalizedRegion.kind === "ExternalResource"
            ? parentRegion.resourceSpaceId === childRegion.resourceSpaceId &&
              JSON.stringify(parentRegion.normalizedRegion) ===
                JSON.stringify(childRegion.normalizedRegion) &&
              parentExclusions.length === 0
            : !parentExclusions.some((exclusion) => {
                if (!isRecord(exclusion)) return false;
                return (
                  exclusion.resourceSpaceId === childRegion.resourceSpaceId &&
                  JSON.stringify(exclusion.normalizedRegion) ===
                    JSON.stringify(childRegion.normalizedRegion)
                );
              })))
  );
};

export type SupportedEventPayloadDecode =
  | { readonly _tag: "Decoded"; readonly payload: unknown }
  | { readonly _tag: "UnsupportedPair" }
  | { readonly _tag: "MalformedPayload" };

/** Strict event-pair payload gate used by every generic journal reader. */
export const decodeSupportedEventPayload = (
  eventType: string,
  eventVersion: number,
  payload: unknown,
): SupportedEventPayloadDecode => {
  if (!isSupportedEventReadPair(eventType, eventVersion)) {
    return { _tag: "UnsupportedPair" };
  }
  if (
    eventType === "VerificationConcluded" &&
    eventVersion === 2 &&
    !strictVerificationConcludedV2(payload)
  ) {
    return { _tag: "MalformedPayload" };
  }
  if (
    eventType === "ResourceOwnershipChanged" &&
    eventVersion === 2 &&
    !strictResourceOwnershipChangedV2(payload)
  ) {
    return { _tag: "MalformedPayload" };
  }
  if (
    eventType === "VerificationConcluded" &&
    eventVersion === 1 &&
    !strictVerificationConcludedV1(payload)
  ) {
    return { _tag: "MalformedPayload" };
  }
  return { _tag: "Decoded", payload };
};
