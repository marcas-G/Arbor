import { describe, expect, it } from "vitest";
import type { DomainEvent } from "../src/index.js";
import {
  Actor,
  EVENT_CATALOG,
  EventId,
  EventSequence,
  ProjectId,
  parse,
} from "../src/index.js";

const EXPECTED_EVENTS = [
  "ProjectCreated",
  "ProjectPolicyChanged",
  "ProjectClosed",
  "WorkspaceCreated",
  "ResponsibilityChanged",
  "ResourceBoundaryChanged",
  "ResourceOwnershipChanged",
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
  "DependencyDeclared",
  "DependencySatisfied",
  "DependencyWithdrawn",
  "DependencyMarkedUnfulfillable",
  "DependencyContractRevised",
  "DeadlockAttentionRequested",
  "ReconciliationEscalated",
  "WorktreeCreated",
  "WorktreeRetired",
  "DeliverableProduced",
  "MessageSent",
  "VerificationStarted",
  "VerificationConcluded",
  "WorkOutcomeAccepted",
  "ExecutionAdmitted",
  "ExecutionStopRequested",
  "ExecutionSettled",
  "PermissionChanged",
  "DecisionRecorded",
  "EnvironmentChanged",
  "HumanInterventionApplied",
].sort();

const AGGREGATE_SNAPSHOT_FIELDS = [
  "lifecycle",
  "responsibilityDefinition",
  "resourceBoundary",
  "currentWorkId",
  "primarySessionId",
  "entries",
  "artifacts",
  "state",
  "projectPolicy",
  "workspacePolicy",
  // "revision" is NOT an aggregate-snapshot field: DID §2.3 / P7 `01` freeze
  // revision *binding* as event-level change facts (targetDependencyRevision,
  // sourceWorkRevision, fromRevision/toRevision). What the ban targets is
  // whole-aggregate snapshots, not ordinal bindings.
  // "verdict" likewise (P8 / v1.11 §5.3): the concluded verdict IS the change
  // fact of VerificationConcluded — a single discriminator, not an aggregate
  // snapshot — so it is NOT banned.
];

describe("domain event catalog", () => {
  it("contains exactly the §5.3 event set", () => {
    expect(Object.keys(EVENT_CATALOG).sort()).toEqual(EXPECTED_EVENTS);
  });

  it("excludes high-frequency runtime trace records", () => {
    for (const trace of [
      "ProviderTurn",
      "ToolInvocation",
      "LeaseRenew",
      "StreamDelta",
    ]) {
      expect(Object.keys(EVENT_CATALOG)).not.toContain(trace);
    }
  });

  it("payloads carry change facts, not aggregate snapshots", () => {
    // P7 (P7 `01` events): the coordination events carry contract payload
    // fields (change facts), not aggregate snapshots.
    const payload = EVENT_CATALOG as Record<string, { fields?: object }>;
    for (const name of Object.keys(EVENT_CATALOG)) {
      const fields = Object.keys(payload[name]?.fields ?? { _tag: name });
      for (const forbidden of AGGREGATE_SNAPSHOT_FIELDS) {
        expect(fields).not.toContain(forbidden);
      }
    }
  });

  it("envelope is expressible and immutable", () => {
    const event: DomainEvent<{ _tag: "ProjectCreated" }> = {
      eventId: parse(EventId)("evt_018f2b3c-4d5e-7abc-8def-0123456789ab"),
      projectId: parse(ProjectId)("prj_018f2b3c-4d5e-7abc-8def-0123456789ab"),
      sequence: parse(EventSequence)(0),
      eventType: "ProjectCreated",
      eventVersion: 1,
      occurredAt: "2026-09-20T00:00:00.000Z",
      aggregateRef: "prj_018f2b3c-4d5e-7abc-8def-0123456789ab",
      actor: parse(Actor)("user:gaolei"),
      payload: { _tag: "ProjectCreated" },
    };
    expect(event.eventType).toBe("ProjectCreated");
    expect(event.sequence).toBe(0);
  });

  it("type-level: EventSequence is not EventId", () => {
    const sequence = parse(EventSequence)(1);
    // @ts-expect-error EventSequence is not EventId
    const wrong: EventId = sequence;
    void wrong;
  });
});
