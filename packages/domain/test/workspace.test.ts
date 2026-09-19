import { describe, expect, it } from "vitest";
import type { IncomingDependencyFact, Workspace } from "../src/index.js";
import * as domain from "../src/index.js";
import {
  changeResponsibility,
  createChildWorkspace,
  createWorkspace,
  ExecutionId,
  makeWorkspacePolicy,
  ProjectId,
  parse,
  ResourceBoundaryRevision,
  ResponsibilityRevision,
  Revision,
  replacePrimarySession,
  responsibilityBound,
  retireWorkspace,
  SessionId,
  selectCurrentWork,
  updateResourceBoundary,
  updateWorkspacePolicy,
  WorkId,
  WorkspaceId,
  workBound,
  workspaceBound,
} from "../src/index.js";

const projectId = parse(ProjectId)("prj_018f2b3c-4d5e-7abc-8def-0123456789ab");
const workspaceId = parse(WorkspaceId)(
  "ws_018f2b3c-4d5e-7abc-8def-0123456789ab",
);
const otherWorkspaceId = parse(WorkspaceId)(
  "ws_018f2b3c-4d5e-7abc-8def-0123456789ac",
);
const sessionId = parse(SessionId)("ses_018f2b3c-4d5e-7abc-8def-0123456789ab");
const otherSessionId = parse(SessionId)(
  "ses_018f2b3c-4d5e-7abc-8def-0123456789ac",
);
const workId = parse(WorkId)("wrk_018f2b3c-4d5e-7abc-8def-0123456789ab");

const responsibilityDefinition = {
  purpose: "own arbor domain",
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

const workspace = (revision = 0): Workspace =>
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
    revision: parse(Revision)(revision),
  });

const expectError = (
  result: ReturnType<typeof changeResponsibility>,
  tag: string,
) => {
  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.error._tag).toBe(tag);
  }
};

describe("workspace structural transitions", () => {
  it("creates a child in the same project with an immutable parent", () => {
    const child = createChildWorkspace(workspace(), {
      workspaceId: otherWorkspaceId,
      name: "child",
      responsibilityDefinition,
      responsibilityRevision: parse(ResponsibilityRevision)(0),
      resourceBoundary,
      resourceBoundaryRevision: parse(ResourceBoundaryRevision)(0),
      agentBinding: responsibilityBound(otherWorkspaceId),
      primarySessionId: otherSessionId,
      workspacePolicy: makeWorkspacePolicy(),
      workspacePolicyRevision: parse(Revision)(0),
      revision: parse(Revision)(0),
      authorized: true,
    });
    expect(child.ok).toBe(true);
    if (child.ok) {
      expect(child.value.projectId).toBe(projectId);
      expect(child.value.parentWorkspaceId).toBe(workspaceId);
      expect(child.value.lifecycle).toBe("Active");
    }
  });

  it("ChangeResponsibility increments responsibility and aggregate revision", () => {
    const result = changeResponsibility(workspace(2), {
      authorized: true,
      expectedRevision: parse(Revision)(2),
      responsibilityDefinition: { ...responsibilityDefinition, purpose: "new" },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.responsibilityRevision).toBe(1);
      expect(result.value.revision).toBe(3);
    }
  });

  it("UpdateResourceBoundary increments boundary revision and rejects overlap", () => {
    const updated = updateResourceBoundary(workspace(2), {
      authorized: true,
      expectedRevision: parse(Revision)(2),
      resourceBoundary,
      ownershipOverlapDetected: false,
    });
    expect(updated.ok).toBe(true);
    if (updated.ok) {
      expect(updated.value.resourceBoundaryRevision).toBe(1);
      expect(updated.value.revision).toBe(3);
    }
    const overlap = updateResourceBoundary(workspace(2), {
      authorized: true,
      expectedRevision: parse(Revision)(2),
      resourceBoundary,
      ownershipOverlapDetected: true,
    });
    expectError(overlap, "AuthorityDenied");
  });

  it("UpdateWorkspacePolicy increments revision and workspacePolicyRevision", () => {
    const result = updateWorkspacePolicy(workspace(2), {
      authorized: true,
      expectedRevision: parse(Revision)(2),
      workspacePolicy: makeWorkspacePolicy({ ceiling: "strict" }),
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.revision).toBe(3);
      expect(result.value.workspacePolicyRevision).toBe(1);
    }
  });

  it("SelectCurrentWork validates candidate and active-main focus", () => {
    const selected = selectCurrentWork(workspace(2), {
      authorized: true,
      expectedRevision: parse(Revision)(2),
      candidate: { workId, workspaceId, lifecycle: "Open" },
      activeMainFocus: null,
    });
    expect(selected.ok).toBe(true);
    if (selected.ok) {
      expect(selected.value.currentWorkId).toBe(workId);
    }

    const notOpen = selectCurrentWork(workspace(2), {
      authorized: true,
      expectedRevision: parse(Revision)(2),
      candidate: { workId, workspaceId, lifecycle: "Completed" },
      activeMainFocus: null,
    });
    expectError(notOpen, "WorkNotOpen");

    const foreign = selectCurrentWork(workspace(2), {
      authorized: true,
      expectedRevision: parse(Revision)(2),
      candidate: { workId, workspaceId: otherWorkspaceId, lifecycle: "Open" },
      activeMainFocus: null,
    });
    expectError(foreign, "AuthorityDenied");

    const current = selected.ok ? selected.value : workspace();
    const conflict = selectCurrentWork(current, {
      authorized: true,
      expectedRevision: current.revision,
      candidate: { workId, workspaceId, lifecycle: "Open" },
      activeMainFocus: { kind: "Work", workId },
    });
    expectError(conflict, "ActiveExecutionConflict");

    const coordination = selectCurrentWork(current, {
      authorized: true,
      expectedRevision: current.revision,
      candidate: { workId, workspaceId, lifecycle: "Open" },
      activeMainFocus: { kind: "Coordination", workId: null },
    });
    expect(coordination.ok).toBe(true);
  });

  it("ReplacePrimarySession requires a WorkspacePrimary target and no active main", () => {
    const replaced = replacePrimarySession(workspace(2), {
      authorized: true,
      expectedRevision: parse(Revision)(2),
      targetSessionId: otherSessionId,
      targetBinding: { _tag: "WorkspacePrimary", workspaceId },
      hasActiveMainExecution: false,
    });
    expect(replaced.ok).toBe(true);
    if (replaced.ok) {
      expect(replaced.value.primarySessionId).toBe(otherSessionId);
    }
    expectError(
      replacePrimarySession(workspace(2), {
        authorized: true,
        expectedRevision: parse(Revision)(2),
        targetSessionId: otherSessionId,
        targetBinding: {
          _tag: "ExecutionScoped",
          executionId: parse(ExecutionId)(
            "exe_018f2b3c-4d5e-7abc-8def-0123456789ab",
          ),
        },
        hasActiveMainExecution: false,
      }),
      "AuthorityDenied",
    );
    expectError(
      replacePrimarySession(workspace(2), {
        authorized: true,
        expectedRevision: parse(Revision)(2),
        targetSessionId: otherSessionId,
        targetBinding: { _tag: "WorkspacePrimary", workspaceId },
        hasActiveMainExecution: true,
      }),
      "ActiveExecutionConflict",
    );
  });

  it("RetireWorkspace enforces every precondition", () => {
    const clear: IncomingDependencyFact[] = [];
    const retired = retireWorkspace(workspace(2), {
      authorized: true,
      expectedRevision: parse(Revision)(2),
      isRoot: false,
      hasActiveMainExecution: false,
      hasOpenWork: false,
      hasActiveChildWorkspace: false,
      hasActiveResourceOwnershipClaim: false,
      incomingDependencies: clear,
    });
    expect(retired.ok).toBe(true);
    if (retired.ok) {
      expect(retired.value.lifecycle).toBe("Retired");
    }

    const blocked = retireWorkspace(workspace(2), {
      authorized: true,
      expectedRevision: parse(Revision)(2),
      isRoot: true,
      hasActiveMainExecution: true,
      hasOpenWork: true,
      hasActiveChildWorkspace: true,
      hasActiveResourceOwnershipClaim: true,
      incomingDependencies: [],
    });
    expectError(blocked, "RetirePreconditionFailed");

    const unresolvedWorkspace = retireWorkspace(workspace(2), {
      authorized: true,
      expectedRevision: parse(Revision)(2),
      isRoot: false,
      hasActiveMainExecution: false,
      hasOpenWork: false,
      hasActiveChildWorkspace: false,
      hasActiveResourceOwnershipClaim: false,
      incomingDependencies: [
        {
          producerBinding: workspaceBound(workspaceId),
          producerWorkWorkspaceId: null,
          unresolved: true,
          resolvedOrReplacedInSameGovernanceChange: false,
        },
      ],
    });
    expectError(unresolvedWorkspace, "RetirePreconditionFailed");

    const unresolvedWork = retireWorkspace(workspace(2), {
      authorized: true,
      expectedRevision: parse(Revision)(2),
      isRoot: false,
      hasActiveMainExecution: false,
      hasOpenWork: false,
      hasActiveChildWorkspace: false,
      hasActiveResourceOwnershipClaim: false,
      incomingDependencies: [
        {
          producerBinding: workBound(workId),
          producerWorkWorkspaceId: workspaceId,
          unresolved: true,
          resolvedOrReplacedInSameGovernanceChange: false,
        },
      ],
    });
    expectError(unresolvedWork, "RetirePreconditionFailed");

    const resolved = retireWorkspace(workspace(2), {
      authorized: true,
      expectedRevision: parse(Revision)(2),
      isRoot: false,
      hasActiveMainExecution: false,
      hasOpenWork: false,
      hasActiveChildWorkspace: false,
      hasActiveResourceOwnershipClaim: false,
      incomingDependencies: [
        {
          producerBinding: workspaceBound(workspaceId),
          producerWorkWorkspaceId: null,
          unresolved: true,
          resolvedOrReplacedInSameGovernanceChange: true,
        },
        {
          producerBinding: { _tag: "AnyProducer" },
          producerWorkWorkspaceId: null,
          unresolved: true,
          resolvedOrReplacedInSameGovernanceChange: false,
        },
      ],
    });
    expect(resolved.ok).toBe(true);
  });

  it("Retired workspaces reject structural mutations", () => {
    const retired = retireWorkspace(workspace(2), {
      authorized: true,
      expectedRevision: parse(Revision)(2),
      isRoot: false,
      hasActiveMainExecution: false,
      hasOpenWork: false,
      hasActiveChildWorkspace: false,
      hasActiveResourceOwnershipClaim: false,
      incomingDependencies: [],
    });
    expect(retired.ok).toBe(true);
    if (!retired.ok) {
      throw new Error("expected retire");
    }
    expectError(
      changeResponsibility(retired.value, {
        authorized: true,
        expectedRevision: retired.value.revision,
        responsibilityDefinition,
      }),
      "TerminalLifecycleMutation",
    );
  });

  it("does not define reparent / move / reactivate operations", () => {
    expect("ReparentWorkspace" in domain).toBe(false);
    expect("MoveWorkspace" in domain).toBe(false);
    expect("ReactivateRetiredWorkspace" in domain).toBe(false);
  });
});
