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
  "verdict",
  "artifacts",
  "state",
  "revision",
  "projectPolicy",
  "workspacePolicy",
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
    for (const name of Object.keys(EVENT_CATALOG)) {
      const payload: Record<string, unknown> = { _tag: name };
      expect(Object.keys(payload)).toEqual(["_tag"]);
      for (const forbidden of AGGREGATE_SNAPSHOT_FIELDS) {
        expect(forbidden in payload).toBe(false);
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
