import { describe, expect, it } from "vitest";
import type { CommandRejection } from "../packages/application/src/rejection.js";
import {
  type InboxArrival,
  MESSAGE_KINDS,
  promoteInboxArrival,
} from "../packages/domain/src/index.js";

describe("P7-001 message kinds: four → five (Deliver)", () => {
  it("MESSAGE_KINDS is exactly the five v1.10 kinds", () => {
    expect([...MESSAGE_KINDS]).toEqual([
      "Query",
      "Reply",
      "Report",
      "DecisionRequest",
      "Deliver",
    ]);
  });

  it("Deliver promotion is empty — deliver is not satisfaction (02 §5)", () => {
    const arrival: InboxArrival = {
      recipientWorkspaceId: "ws_00000000-0000-7000-8000-000000000002" as never,
      kind: "Deliver",
    };
    expect(promoteInboxArrival(arrival)).toEqual({
      closesCorrelation: null,
      triggersReevaluation: false,
    });
  });
});

describe("P7-001 event payloads are real (7 events)", () => {
  it("dependency/deliverable/deadlock events carry their contract fields", async () => {
    const events = await import("../packages/domain/src/events.js");
    const expectFields = (schema: { fields: object }, fields: string[]) => {
      expect(Object.keys(schema.fields).sort()).toEqual(
        ["_tag", ...fields].sort(),
      );
    };
    expectFields(events.DependencyDeclared, [
      "dependencyId",
      "consumerWorkId",
      "producerBinding",
      "expectedDeliverable",
      "revision",
    ]);
    expectFields(events.DependencySatisfied, [
      "dependencyId",
      "targetDependencyRevision",
      "deliverableId",
      "satisfiedAtDependencyRevision",
    ]);
    expectFields(events.DependencyWithdrawn, [
      "dependencyId",
      "dependencyRevision",
      "reason",
    ]);
    expectFields(events.DependencyMarkedUnfulfillable, [
      "dependencyId",
      "dependencyRevision",
      "justification",
    ]);
    expectFields(events.DependencyContractRevised, [
      "dependencyId",
      "fromRevision",
      "toRevision",
    ]);
    expectFields(events.DeliverableProduced, [
      "deliverableId",
      "sourceWorkId",
      "sourceWorkRevision",
      "kind",
      "artifactRoles",
    ]);
    expectFields(events.DeadlockAttentionRequested, [
      "cycleWorkIds",
      "dependencyIds",
      "detectedAt",
    ]);
  });
});

describe("P7-001 authority exact-bound (G6)", () => {
  it("SatisfyDependencyAuthority source is exactly two-valued", async () => {
    const authority = await import("../packages/application/src/authority.js");
    const tags = authority.SATISFY_AUTHORITY_SOURCES.map(
      (entry: { _tag: string }) => entry._tag,
    );
    expect(tags).toEqual(["ConsumerExecution", "P7Coordinator"]);
  });
});

describe("P7-001 rejection enums", () => {
  it("DependencyNotFound / DeliverableNotFound exist as typed rejections", () => {
    const dep: CommandRejection = {
      _tag: "DependencyNotFound",
      dependencyId: "dep_00000000-0000-7000-8000-000000000001" as never,
    };
    const del: CommandRejection = {
      _tag: "DeliverableNotFound",
      deliverableId: "del_00000000-0000-7000-8000-000000000001" as never,
    };
    expect(dep._tag).toBe("DependencyNotFound");
    expect(del._tag).toBe("DeliverableNotFound");
  });
});
