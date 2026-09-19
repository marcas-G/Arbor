import { describe, expect, it } from "vitest";
import * as domain from "../src/index.js";
import {
  Actor,
  ArtifactRole,
  assignWork,
  CommandId,
  cancelWork,
  completeWork,
  concludeVerification,
  createAcceptance,
  createWorkspace,
  DeliverableId,
  DeliverableKind,
  DependencyId,
  DependencyRevision,
  declareDependency,
  makeWorkspacePolicy,
  markUnfulfillableOnProducerLoss,
  ProjectId,
  parse,
  ResourceBoundaryRevision,
  ResponsibilityRevision,
  Revision,
  replacePrimarySession,
  resolveIdempotency,
  responsibilityBound,
  retireWorkspace,
  SessionId,
  semanticRequestFingerprint,
  startVerification,
  VerificationId,
  WorkId,
  WorkRevision,
  WorkspaceId,
  withdrawDependenciesOnWorkCancel,
  workBound,
} from "../src/index.js";

const projectId = parse(ProjectId)("prj_018f2b3c-4d5e-7abc-8def-0123456789ab");
const workspaceId = parse(WorkspaceId)(
  "ws_018f2b3c-4d5e-7abc-8def-0123456789ab",
);
const workId = parse(WorkId)("wrk_018f2b3c-4d5e-7abc-8def-0123456789ab");
const sessionId = parse(SessionId)("ses_018f2b3c-4d5e-7abc-8def-0123456789ab");
const verificationId = parse(VerificationId)(
  "ver_018f2b3c-4d5e-7abc-8def-0123456789ab",
);
const actor = parse(Actor)("user:gaolei");

const mission = { goal: "g", criteria: [], riskRequirements: [] };
const responsibilityDefinition = {
  purpose: "p",
  ownedResponsibilities: [],
  obligations: [],
  includes: [],
  excludes: [],
  interfaces: [],
};
const resourceBoundary = {
  basisResponsibilityRevision: parse(ResponsibilityRevision)(0),
  addresses: [],
};

const work = () => {
  const result = assignWork({
    workId,
    projectId,
    workspaceId,
    objective: "ship",
    why: "P0",
    constraints: [],
    completionExpectation: "green",
    verificationMission: mission,
    provenance: { predecessorWorkId: null, reason: "initial" },
    revision: parse(WorkRevision)(2),
    authorized: true,
    workspaceAcceptsWork: true,
  });
  if (!result.ok) {
    throw new Error("expected assign");
  }
  return result.value;
};

const workspace = () =>
  createWorkspace({
    workspaceId,
    projectId,
    parentWorkspaceId: null,
    name: "root",
    responsibilityDefinition,
    responsibilityRevision: parse(ResponsibilityRevision)(0),
    resourceBoundary,
    resourceBoundaryRevision: parse(ResourceBoundaryRevision)(0),
    agentBinding: responsibilityBound(workspaceId),
    primarySessionId: sessionId,
    workspacePolicy: makeWorkspacePolicy(),
    workspacePolicyRevision: parse(Revision)(0),
    revision: parse(Revision)(0),
  });

describe("cross-aggregate invariants", () => {
  it("CompleteWork binds Work + Verification + Acceptance revisions", () => {
    const w = work();
    const started = startVerification({
      verificationId,
      workId,
      targetWorkRevision: w.revision,
      missionSnapshot: mission,
    });
    const concluded = concludeVerification(started, "Pass");
    if (!concluded.ok) {
      throw new Error("expected conclude");
    }
    const acceptance = createAcceptance({
      workId,
      targetWorkRevision: w.revision,
      verificationId,
      actor,
      acceptedAt: "2026-09-20T00:00:00.000Z",
    });
    const completed = completeWork(w, concluded.value, acceptance);
    expect(completed.ok).toBe(true);
    if (completed.ok) {
      expect(completed.value.lifecycle).toBe("Completed");
    }
  });

  it("CancelWork drives dependency withdrawal", () => {
    const dependency = declareDependency({
      dependencyId: parse(DependencyId)(
        "dep_018f2b3c-4d5e-7abc-8def-0123456789ab",
      ),
      consumerWorkId: workId,
      producerBinding: workBound(workId),
      revision: parse(DependencyRevision)(1),
      expectedDeliverable: {
        kind: parse(DeliverableKind)("code"),
        requiredArtifactRoles: [parse(ArtifactRole)("src")],
      },
    });
    const cancelled = cancelWork(work(), { authorized: true });
    expect(cancelled.ok).toBe(true);
    const after = withdrawDependenciesOnWorkCancel(workId, [dependency]);
    expect(after[0]?.state).toBe("Withdrawn");
  });

  it("producer loss marks affected dependencies Unfulfillable", () => {
    const dependency = declareDependency({
      dependencyId: parse(DependencyId)(
        "dep_018f2b3c-4d5e-7abc-8def-0123456789ab",
      ),
      consumerWorkId: parse(WorkId)("wrk_018f2b3c-4d5e-7abc-8def-0123456789ac"),
      producerBinding: workBound(workId),
      revision: parse(DependencyRevision)(1),
      expectedDeliverable: {
        kind: parse(DeliverableKind)("code"),
        requiredArtifactRoles: [parse(ArtifactRole)("src")],
      },
    });
    const after = markUnfulfillableOnProducerLoss(
      [
        {
          binding: workBound(workId),
          lost: { _tag: "WorkCancelled", workId },
          replacedInSameGovernanceChange: false,
        },
      ],
      [dependency],
    );
    expect(after[0]?.state).toBe("Unfulfillable");
  });

  it("RetireWorkspace enforces the full precondition set", () => {
    const clear = retireWorkspace(workspace(), {
      authorized: true,
      expectedRevision: parse(Revision)(0),
      isRoot: false,
      hasActiveMainExecution: false,
      hasOpenWork: false,
      hasActiveChildWorkspace: false,
      hasActiveResourceOwnershipClaim: false,
      incomingDependencies: [],
    });
    expect(clear.ok).toBe(true);
    if (clear.ok) {
      expect(clear.value.lifecycle).toBe("Retired");
    }
    const blocked = retireWorkspace(workspace(), {
      authorized: true,
      expectedRevision: parse(Revision)(0),
      isRoot: true,
      hasActiveMainExecution: false,
      hasOpenWork: false,
      hasActiveChildWorkspace: false,
      hasActiveResourceOwnershipClaim: false,
      incomingDependencies: [],
    });
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) {
      expect(blocked.error._tag).toBe("RetirePreconditionFailed");
    }
    expect(replacePrimarySession).toBeDefined();
  });

  it("keeps typed ids non-interchangeable and no AgentId", () => {
    const id = parse(WorkspaceId)("ws_018f2b3c-4d5e-7abc-8def-0123456789ab");
    // @ts-expect-error WorkspaceId is not WorkId
    const wrong: WorkId = id;
    void wrong;
    expect("AgentId" in domain).toBe(false);
  });

  it("rejects command same-id different-fingerprint", () => {
    const commandId = parse(CommandId)(
      "cmd_018f2b3c-4d5e-7abc-8def-0123456789ab",
    );
    const fp = (payload: unknown) =>
      semanticRequestFingerprint({
        commandType: "CreateProject",
        projectId,
        actor,
        schemaVersion: "1",
        payload,
      });
    const existing = { commandId, fingerprint: fp({ a: 1 }) };
    const conflict = resolveIdempotency(existing, {
      commandId,
      fingerprint: fp({ a: 2 }),
    });
    expect(conflict.ok).toBe(false);
    if (!conflict.ok) {
      expect(conflict.error._tag).toBe("IdempotencyConflict");
    }
  });
});
