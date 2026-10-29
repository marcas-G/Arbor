import {
  type CanonicalResourceRegion,
  CommandId,
  createWorkspace,
  makeWorkspacePolicy,
  Principal,
  ProjectId,
  parse,
  ResourceBoundaryRevision,
  ResponsibilityRevision,
  Revision,
  responsibilityBound,
  SessionId,
  WorkspaceId,
} from "@arbor/domain";
import type { ResourceOwnershipClaimRecord } from "@arbor/ports";
import { Effect, Option } from "effect";
import { describe, expect, it } from "vitest";
import {
  makeRetireWorkspaceApplicationService,
  type RetireWorkspaceApplicationDependencies,
} from "../src/ownership-wiring.js";

const projectId = parse(ProjectId)("prj_018f2b3c-4d5e-7abc-8def-0123456789e1");
const parentId = parse(WorkspaceId)("ws_018f2b3c-4d5e-7abc-8def-0123456789e1");
const childId = parse(WorkspaceId)("ws_018f2b3c-4d5e-7abc-8def-0123456789e2");
const principal = parse(Principal)("user:operator");
const commandId = parse(CommandId)("cmd_018f2b3c-4d5e-7abc-8def-0123456789e1");

const parent = createWorkspace({
  workspaceId: parentId,
  projectId,
  parentWorkspaceId: null,
  name: "parent",
  responsibilityDefinition: {
    purpose: "parent",
    ownedResponsibilities: [],
    obligations: [],
    includes: [],
    excludes: [],
    interfaces: [],
  },
  responsibilityRevision: parse(ResponsibilityRevision)(1),
  resourceBoundary: {
    basisResponsibilityRevision: parse(ResponsibilityRevision)(1),
    addresses: [{ _tag: "FileTree", path: "/repo" }],
  },
  resourceBoundaryRevision: parse(ResourceBoundaryRevision)(1),
  agentBinding: responsibilityBound(parentId),
  primarySessionId: parse(SessionId)(
    "ses_018f2b3c-4d5e-7abc-8def-0123456789e1",
  ),
  workspacePolicy: makeWorkspacePolicy(),
  workspacePolicyRevision: parse(Revision)(0),
  revision: parse(Revision)(4),
});

const child = createWorkspace({
  workspaceId: childId,
  projectId,
  parentWorkspaceId: parentId,
  name: "child",
  responsibilityDefinition: {
    purpose: "child",
    ownedResponsibilities: [],
    obligations: [],
    includes: [],
    excludes: [],
    interfaces: [],
  },
  responsibilityRevision: parse(ResponsibilityRevision)(1),
  resourceBoundary: {
    basisResponsibilityRevision: parse(ResponsibilityRevision)(1),
    addresses: [{ _tag: "FileTree", path: "/repo/child" }],
  },
  resourceBoundaryRevision: parse(ResourceBoundaryRevision)(1),
  agentBinding: responsibilityBound(childId),
  primarySessionId: parse(SessionId)(
    "ses_018f2b3c-4d5e-7abc-8def-0123456789e2",
  ),
  workspacePolicy: makeWorkspacePolicy(),
  workspacePolicyRevision: parse(Revision)(0),
  revision: parse(Revision)(7),
});

const delegatedRegion: CanonicalResourceRegion = {
  resourceSpaceId: "filesystem",
  normalizedRegion: { kind: "FileTree", path: "/repo/child" },
};
const parentRegion: CanonicalResourceRegion = {
  resourceSpaceId: "filesystem",
  normalizedRegion: { kind: "FileTree", path: "/repo" },
};

const makeClaims = (withProvenance = true) => {
  const childClaim: ResourceOwnershipClaimRecord = {
    claimId: "claim-child",
    workspaceId: childId,
    region: delegatedRegion,
    sourceAddressSnapshot: { _tag: "FileTree", path: "/repo/child" },
    resourceBoundaryRevision: parse(ResourceBoundaryRevision)(1),
    resolvedAtEnvironmentRevision: "env-3",
    createdAt: "t0",
    releasedAt: null,
    exclusions: [],
    delegatingWorkspaceId: withProvenance ? parentId : null,
    delegationSourceId: withProvenance ? "formation:proposal-1:2" : null,
    claimRevision: 3,
  };
  const parentClaim: ResourceOwnershipClaimRecord = {
    claimId: "claim-parent",
    workspaceId: parentId,
    region: parentRegion,
    sourceAddressSnapshot: { _tag: "FileTree", path: "/repo" },
    resourceBoundaryRevision: parse(ResourceBoundaryRevision)(1),
    resolvedAtEnvironmentRevision: "env-3",
    createdAt: "t0",
    releasedAt: null,
    exclusions: [delegatedRegion],
    delegatingWorkspaceId: null,
    delegationSourceId: null,
    claimRevision: 8,
  };
  return { childClaim, parentClaim };
};

const makeHarness = (
  options: { withProvenance?: boolean; unresolvedEffects?: boolean } = {},
) => {
  const { childClaim, parentClaim } = makeClaims(
    options.withProvenance !== false,
  );
  const calls: unknown[] = [];
  const deps = {
    workspaces: {
      findById: (id: WorkspaceId) =>
        Effect.succeed(
          id === childId ? Option.some(child) : Option.some(parent),
        ),
      hasOpenWork: () => Effect.succeed(false),
      countActiveChildren: () => Effect.succeed(0),
    },
    works: { findById: () => Effect.succeed(Option.none()) },
    executions: {
      findActiveMainByWorkspace: () => Effect.succeed(Option.none()),
      findUnsettledExecutions: () =>
        Effect.succeed(
          options.unresolvedEffects
            ? [{ executionId: "ex_1", workspaceId: childId }]
            : [],
        ),
    },
    dependencies: { listUnsatisfiedByProject: () => Effect.succeed([]) },
    invocations: {
      findUnsettled: () =>
        Effect.succeed(
          options.unresolvedEffects ? [{ invocationId: "inv_1" }] : [],
        ),
    },
    ownership: {
      listActiveByWorkspace: (id: WorkspaceId) =>
        Effect.succeed(id === childId ? [childClaim] : [parentClaim]),
      listByWorkspace: () => Effect.succeed([parentClaim]),
    },
    ownershipWrite: {
      reclaimDelegatedOwnership: (input: unknown) => {
        calls.push(input);
        return Effect.succeed({
          _tag: "Reclaimed" as const,
          parentClaim,
          childClaim,
          childRetired: true,
        });
      },
    },
    tx: {
      transact: (program: Effect.Effect<unknown, unknown, never>) => program,
    },
    isAuthorizedHuman: () => true,
  } as unknown as RetireWorkspaceApplicationDependencies;
  return {
    service: makeRetireWorkspaceApplicationService(deps),
    calls,
  };
};

describe("RetireWorkspace application service", () => {
  it("reaches the atomic reclaim path using exact persisted provenance and revisions", async () => {
    const { service, calls } = makeHarness();
    const outcome = await Effect.runPromise(
      service.retire({
        projectId,
        workspaceId: childId,
        expectedRevision: child.revision,
        principal,
        commandId,
      }),
    );
    expect(outcome._tag).toBe("Retired");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      projectId,
      childWorkspaceId: childId,
      delegationSourceId: "formation:proposal-1:2",
      expectedParentWorkspaceRevision: parent.revision,
      expectedChildWorkspaceRevision: child.revision,
      expectedParentBoundaryRevision: parent.resourceBoundaryRevision,
      expectedChildBoundaryRevision: child.resourceBoundaryRevision,
      expectedParentClaimRevision: 8,
      expectedChildClaimRevision: 3,
      causedByCommandId: commandId,
      retireChild: true,
      quiescence: {
        noUnresolvedEffects: true,
        noActiveExecution: true,
        noOpenWork: true,
        noActiveChildren: true,
        noUnresolvedIncomingDependencies: true,
      },
    });
  });

  it("fails closed for an active Child claim without exact delegation provenance", async () => {
    const { service, calls } = makeHarness({ withProvenance: false });
    const outcome = await Effect.runPromise(
      service.retire({
        projectId,
        workspaceId: childId,
        expectedRevision: child.revision,
        principal,
        commandId,
      }),
    );
    expect(outcome).toEqual({
      _tag: "Refused",
      reason: "NoExactDelegatedClaim",
    });
    expect(calls).toHaveLength(0);
  });

  it("refuses while a durable Execution remains unsettled", async () => {
    const { service, calls } = makeHarness({ unresolvedEffects: true });
    const outcome = await Effect.runPromise(
      service.retire({
        projectId,
        workspaceId: childId,
        expectedRevision: child.revision,
        principal,
        commandId,
      }),
    );
    expect(outcome).toMatchObject({
      _tag: "Refused",
      reason: "RetirePreconditionFailed",
      detail: "active execution remains bound to the Child",
    });
    expect(calls).toHaveLength(0);
  });
});
