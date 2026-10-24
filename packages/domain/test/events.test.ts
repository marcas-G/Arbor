import { describe, expect, it } from "vitest";
import type { DomainEvent } from "../src/index.js";
import {
  Actor,
  decodeSupportedEventPayload,
  EVENT_CATALOG,
  EVENT_VERSION_REGISTRY,
  EventId,
  EventSequence,
  isSupportedEventReadPair,
  isSupportedEventWritePair,
  ProjectId,
  parse,
} from "../src/index.js";

const EXPECTED_EVENTS = [
  "ControlApprovalResolved",
  "ExecutableApprovalRequested",
  "ExecutableApprovalResolved",
  "ProjectCreated",
  "ProjectPolicyChanged",
  "ProjectRenamed",
  "ProjectClosed",
  "WorkspaceCreated",
  "ResponsibilityChanged",
  "ResourceBoundaryChanged",
  "ResourceOwnershipChanged",
  "WorkspacePolicyChanged",
  "WorkspaceRetired",
  "WorkspaceLineageRecorded",
  "PrimarySessionReplaced",
  "AssignWorkTargetBindingEscalated",
  "SubmittedDecisionBindingEscalated",
  "ToolObservationReplayEvidenceEscalated",
  "WorkspaceResourceActivationChanged",
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
  "DependencyWithdrawn",
  "DependencyMarkedUnfulfillable",
  "DependencyContractRevised",
  "DeadlockAttentionRequested",
  "ReconciliationEscalated",
  "LegacyAdoptionEvidenceEscalated",
  "LegacyAdoptionEvidenceResolved",
  "DeliverReplayEscalated",
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
  "SandboxPolicyGrantIssued",
  "SandboxPolicyDecisionRecorded",
  "SandboxProviderUnavailable",
  "DecisionRecorded",
  "EnvironmentChanged",
  "HumanInterventionApplied",
  // P14 `01` §3 (DID v1.16 TR-A/G-A): independent human chat-turn event —
  // deliberately not reusing MessageSent (whose payload semantics are a
  // workspace sender).
  "HumanMessageSubmitted",
  "ConversationResponseResumed",
  "ConversationResponseCancelled",
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

  it("has explicit exact writer and reader versions for every catalog event", () => {
    expect(Object.keys(EVENT_VERSION_REGISTRY).sort()).toEqual(
      Object.keys(EVENT_CATALOG).sort(),
    );
    for (const eventType of Object.keys(EVENT_CATALOG)) {
      if (eventType === "VerificationConcluded") {
        expect(isSupportedEventWritePair(eventType, 2)).toBe(true);
        expect(isSupportedEventWritePair(eventType, 1)).toBe(false);
        expect(isSupportedEventReadPair(eventType, 1)).toBe(true);
        expect(isSupportedEventReadPair(eventType, 2)).toBe(true);
      } else {
        expect(isSupportedEventWritePair(eventType, 1)).toBe(true);
        expect(isSupportedEventWritePair(eventType, 2)).toBe(false);
        expect(isSupportedEventReadPair(eventType, 1)).toBe(true);
        expect(isSupportedEventReadPair(eventType, 2)).toBe(false);
      }
      expect(isSupportedEventReadPair(eventType, 3)).toBe(false);
    }
    expect(isSupportedEventReadPair("UnknownEvent", 1)).toBe(false);
  });

  it("strictly decodes VerificationConcluded v2 and requires explicit null reason", () => {
    const payload = {
      verificationId: "ver_018f2b3c-4d5e-7abc-8def-0123456789ab",
      workId: "wrk_018f2b3c-4d5e-7abc-8def-0123456789ab",
      targetWorkRevision: 1,
      verdict: "Pass",
      conclusionReason: null,
      evidenceRefs: ["evd_018f2b3c-4d5e-7abc-8def-0123456789ab"],
      summaryRef: "sha256:summary",
      missionSnapshot: {
        goal: "verify goal",
        criteria: [{ criterionId: "c1", requirement: "proof", required: true }],
        riskRequirements: [],
      },
      criteriaResults: [
        {
          criterionId: "c1",
          requirement: "proof",
          required: true,
          verdict: "Pass",
          evidenceRefs: ["evd_018f2b3c-4d5e-7abc-8def-0123456789ab"],
        },
      ],
      snapshotStatus: "Available",
    };
    expect(
      decodeSupportedEventPayload("VerificationConcluded", 2, payload)._tag,
    ).toBe("Decoded");
    const { conclusionReason: _reason, ...omittedReason } = payload;
    expect(
      decodeSupportedEventPayload("VerificationConcluded", 2, omittedReason)
        ._tag,
    ).toBe("MalformedPayload");
    expect(
      decodeSupportedEventPayload("VerificationConcluded", 2, {
        ...payload,
        conclusionReason: "",
      })._tag,
    ).toBe("MalformedPayload");
    expect(decodeSupportedEventPayload("WorkCompleted", 2, {})._tag).toBe(
      "UnsupportedPair",
    );
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

  it("keeps SandboxPolicyGrantIssued as the exact P1 audit/wake tuple", () => {
    const schema = EVENT_CATALOG.SandboxPolicyGrantIssued as unknown as {
      readonly fields: Readonly<Record<string, unknown>>;
    };
    expect(Object.keys(schema.fields)).toEqual([
      "_tag",
      "permissionGrantId",
      "grantPermissionCommandId",
      "executionId",
      "operatorConfigRevision",
      "operatorConfigDigest",
    ]);
  });

  it("keeps SandboxPolicyDecisionRecorded as the exact minimal P1 wake tuple", () => {
    const schema = EVENT_CATALOG.SandboxPolicyDecisionRecorded as unknown as {
      readonly fields: Readonly<Record<string, unknown>>;
    };
    expect(Object.keys(schema.fields)).toEqual([
      "_tag",
      "workspaceId",
      "executionId",
      "episodeBinding",
      "policyRevision",
      "permissionGrantId",
      "operatorConfigRevision",
      "operatorConfigDigest",
    ]);
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
