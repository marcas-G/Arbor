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
export const WorkSteered = Schema.TaggedStruct("WorkSteered", {});
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
export const DeadlockAttentionRequested = Schema.TaggedStruct(
  "DeadlockAttentionRequested",
  {
    cycleWorkIds: Schema.Array(Schema.String),
    dependencyIds: Schema.Array(Schema.String),
    detectedAt: Schema.String,
  },
);
export const MessageSent = Schema.TaggedStruct("MessageSent", {});
export const VerificationStarted = Schema.TaggedStruct(
  "VerificationStarted",
  {},
);
export const VerificationConcluded = Schema.TaggedStruct(
  "VerificationConcluded",
  {},
);
export const WorkOutcomeAccepted = Schema.TaggedStruct(
  "WorkOutcomeAccepted",
  {},
);
export const ExecutionAdmitted = Schema.TaggedStruct("ExecutionAdmitted", {});
export const ExecutionStopRequested = Schema.TaggedStruct(
  "ExecutionStopRequested",
  {},
);
export const ExecutionSettled = Schema.TaggedStruct("ExecutionSettled", {});
export const PermissionChanged = Schema.TaggedStruct("PermissionChanged", {});
export const DecisionRecorded = Schema.TaggedStruct("DecisionRecorded", {});
export const EnvironmentChanged = Schema.TaggedStruct("EnvironmentChanged", {});
export const HumanInterventionApplied = Schema.TaggedStruct(
  "HumanInterventionApplied",
  {},
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
