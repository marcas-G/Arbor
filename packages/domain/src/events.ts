import { Schema } from "effect";
import type { Actor } from "./actor.js";
import type { CommandId, EventId, ProjectId } from "./ids.js";
import type { EventSequence } from "./ordinals.js";

export const ProjectCreated = Schema.TaggedStruct("ProjectCreated", {});
export const ProjectPolicyChanged = Schema.TaggedStruct(
  "ProjectPolicyChanged",
  {},
);
export const ProjectClosed = Schema.TaggedStruct("ProjectClosed", {});
export const WorkspaceCreated = Schema.TaggedStruct("WorkspaceCreated", {});
export const ResponsibilityChanged = Schema.TaggedStruct(
  "ResponsibilityChanged",
  {},
);
export const ResourceBoundaryChanged = Schema.TaggedStruct(
  "ResourceBoundaryChanged",
  {},
);
export const ResourceOwnershipChanged = Schema.TaggedStruct(
  "ResourceOwnershipChanged",
  {},
);
export const WorkspacePolicyChanged = Schema.TaggedStruct(
  "WorkspacePolicyChanged",
  {},
);
export const WorkspaceRetired = Schema.TaggedStruct("WorkspaceRetired", {});
export const WorkspaceLineageRecorded = Schema.TaggedStruct(
  "WorkspaceLineageRecorded",
  {},
);
export const PrimarySessionReplaced = Schema.TaggedStruct(
  "PrimarySessionReplaced",
  {},
);
export const WorkAssigned = Schema.TaggedStruct("WorkAssigned", {});
export const CurrentWorkChanged = Schema.TaggedStruct("CurrentWorkChanged", {});
export const WorkRefined = Schema.TaggedStruct("WorkRefined", {});
export const WorkCompleted = Schema.TaggedStruct("WorkCompleted", {});
export const WorkCancelled = Schema.TaggedStruct("WorkCancelled", {});
export const WorkSteered = Schema.TaggedStruct("WorkSteered", {
  workId: Schema.String,
  fromRevision: Schema.Number,
  toRevision: Schema.Number,
  severity: Schema.String,
});
export const DependencyDeclared = Schema.TaggedStruct("DependencyDeclared", {
  dependencyId: Schema.String,
  consumerWorkId: Schema.String,
  producerBinding: Schema.Unknown,
  expectedDeliverable: Schema.Unknown,
  revision: Schema.Number,
});
export const DependencySatisfied = Schema.TaggedStruct("DependencySatisfied", {
  dependencyId: Schema.String,
  targetDependencyRevision: Schema.Number,
  deliverableId: Schema.String,
  satisfiedAtDependencyRevision: Schema.Number,
});
export const DependencyWithdrawn = Schema.TaggedStruct("DependencyWithdrawn", {
  dependencyId: Schema.String,
  dependencyRevision: Schema.Number,
  reason: Schema.String,
});
export const DependencyContractRevised = Schema.TaggedStruct(
  "DependencyContractRevised",
  {
    dependencyId: Schema.String,
    fromRevision: Schema.Number,
    toRevision: Schema.Number,
  },
);
export const DependencyMarkedUnfulfillable = Schema.TaggedStruct(
  "DependencyMarkedUnfulfillable",
  {
    dependencyId: Schema.String,
    dependencyRevision: Schema.Number,
    justification: Schema.String,
  },
);
export const DeliverableProduced = Schema.TaggedStruct("DeliverableProduced", {
  deliverableId: Schema.String,
  sourceWorkId: Schema.String,
  sourceWorkRevision: Schema.Number,
  kind: Schema.String,
  artifactRoles: Schema.Array(Schema.String),
});
export const ReconciliationEscalated = Schema.TaggedStruct(
  "ReconciliationEscalated",
  {
    executionId: Schema.String,
    invocationRefsFingerprint: Schema.String,
    refs: Schema.Array(Schema.Unknown),
  },
);
export const DeadlockAttentionRequested = Schema.TaggedStruct(
  "DeadlockAttentionRequested",
  {
    cycleWorkIds: Schema.Array(Schema.String),
    dependencyIds: Schema.Array(Schema.String),
    detectedAt: Schema.String,
  },
);
export const MessageSent = Schema.TaggedStruct("MessageSent", {});
export const VerificationStarted = Schema.TaggedStruct("VerificationStarted", {
  verificationId: Schema.String,
  workId: Schema.String,
  targetWorkRevision: Schema.Number,
  missionDigest: Schema.String,
});
export const VerificationConcluded = Schema.TaggedStruct(
  "VerificationConcluded",
  {
    verificationId: Schema.String,
    workId: Schema.String,
    targetWorkRevision: Schema.Number,
    verdict: Schema.String,
    conclusionReason: Schema.String,
    evidenceRefs: Schema.Array(Schema.String),
  },
);
export const WorkOutcomeAccepted = Schema.TaggedStruct("WorkOutcomeAccepted", {
  acceptanceId: Schema.String,
  workId: Schema.String,
  targetWorkRevision: Schema.Number,
  verificationId: Schema.String,
  actor: Schema.String,
});
export const ExecutionAdmitted = Schema.TaggedStruct("ExecutionAdmitted", {});
export const ExecutionStopRequested = Schema.TaggedStruct(
  "ExecutionStopRequested",
  {},
);
export const ExecutionSettled = Schema.TaggedStruct("ExecutionSettled", {
  executionId: Schema.String,
  /** v1.11 M-4: work-level resolution for the P8 consumer chain. */
  workId: Schema.String,
  workRevision: Schema.Number,
  claimRef: Schema.String,
});
export const PermissionChanged = Schema.TaggedStruct("PermissionChanged", {});
export const DecisionRecorded = Schema.TaggedStruct("DecisionRecorded", {});
export const WorktreeCreated = Schema.TaggedStruct("WorktreeCreated", {
  worktreeId: Schema.String,
  projectId: Schema.String,
  workspaceId: Schema.String,
  path: Schema.String,
  repositoryRef: Schema.String,
  branch: Schema.String,
});
export const WorktreeRetired = Schema.TaggedStruct("WorktreeRetired", {
  worktreeId: Schema.String,
  projectId: Schema.String,
});
export const EnvironmentChanged = Schema.TaggedStruct("EnvironmentChanged", {
  projectId: Schema.String,
  fromRevision: Schema.String,
  toRevision: Schema.String,
  previousFingerprint: Schema.String,
  nextFingerprint: Schema.String,
  snapshotBlobRef: Schema.String,
  changedRegions: Schema.Array(Schema.Unknown),
  cause: Schema.String,
});
export const HumanInterventionApplied = Schema.TaggedStruct(
  "HumanInterventionApplied",
  {
    actor: Schema.String,
    targetWorkspaceId: Schema.String,
    summaryRef: Schema.String,
    occurredAt: Schema.String,
    kind: Schema.String,
  },
);

export const DomainEventPayload = Schema.Union([
  ProjectCreated,
  ProjectPolicyChanged,
  ProjectClosed,
  WorkspaceCreated,
  ResponsibilityChanged,
  ResourceBoundaryChanged,
  ResourceOwnershipChanged,
  WorkspacePolicyChanged,
  WorkspaceRetired,
  WorkspaceLineageRecorded,
  PrimarySessionReplaced,
  WorkAssigned,
  CurrentWorkChanged,
  WorkRefined,
  WorkCompleted,
  WorkCancelled,
  WorkSteered,
  DependencyDeclared,
  DependencySatisfied,
  DependencyContractRevised,
  DeadlockAttentionRequested,
  ReconciliationEscalated,
  DependencyWithdrawn,
  DependencyMarkedUnfulfillable,
  DeliverableProduced,
  MessageSent,
  VerificationStarted,
  VerificationConcluded,
  WorkOutcomeAccepted,
  ExecutionAdmitted,
  ExecutionStopRequested,
  ExecutionSettled,
  PermissionChanged,
  DecisionRecorded,
  EnvironmentChanged,
  WorktreeCreated,
  WorktreeRetired,
  HumanInterventionApplied,
]);

export type DomainEventPayload = Schema.Schema.Type<typeof DomainEventPayload>;

export const EVENT_CATALOG = {
  ProjectCreated,
  ProjectPolicyChanged,
  ProjectClosed,
  WorkspaceCreated,
  ResponsibilityChanged,
  ResourceBoundaryChanged,
  ResourceOwnershipChanged,
  WorkspacePolicyChanged,
  WorkspaceRetired,
  WorkspaceLineageRecorded,
  PrimarySessionReplaced,
  WorkAssigned,
  CurrentWorkChanged,
  WorkRefined,
  WorkCompleted,
  WorkCancelled,
  WorkSteered,
  DependencyDeclared,
  DependencySatisfied,
  DependencyContractRevised,
  DependencyWithdrawn,
  DependencyMarkedUnfulfillable,
  DeadlockAttentionRequested,
  ReconciliationEscalated,
  DeliverableProduced,
  MessageSent,
  VerificationStarted,
  VerificationConcluded,
  WorkOutcomeAccepted,
  ExecutionAdmitted,
  ExecutionStopRequested,
  ExecutionSettled,
  PermissionChanged,
  DecisionRecorded,
  EnvironmentChanged,
  WorktreeCreated,
  WorktreeRetired,
  HumanInterventionApplied,
} as const;

export type EventTypeName = keyof typeof EVENT_CATALOG;

export interface DomainEvent<E> {
  readonly eventId: EventId;
  readonly projectId: ProjectId;
  readonly sequence: EventSequence;
  readonly eventType: EventTypeName;
  readonly eventVersion: number;
  readonly occurredAt: string;
  readonly aggregateRef: string;
  readonly actor: Actor;
  readonly causedByCommandId?: CommandId;
  readonly causedByEventId?: EventId;
  readonly correlationRef?: string;
  readonly payload: E;
}
