import {
  Actor,
  CommandId,
  Principal,
  ProjectId,
  parse,
  ResourceBoundaryRevision,
  Revision,
  WorkspaceId,
} from "@arbor/domain";
import type {
  ResourceOwnershipClaimRecord,
  ResourceOwnershipRepositoryService,
  WorkspaceRepositoryService,
} from "@arbor/ports";
import { TransactionScope } from "@arbor/ports";
import { Effect, Option } from "effect";
import { describe, expect, it } from "vitest";
import {
  makeUpdateResourceBoundaryHandler,
  type UpdateResourceBoundaryPayload,
} from "../src/commands/update-resource-boundary.js";

const projectId = parse(ProjectId)("prj_018f2b3c-4d5e-7abc-8def-0123456789ab");
const foreignProjectId = parse(ProjectId)(
  "prj_018f2b3c-4d5e-7abc-8def-0123456789ac",
);
const workspaceId = parse(WorkspaceId)(
  "ws_018f2b3c-4d5e-7abc-8def-0123456789ab",
);
const commandId = parse(CommandId)("cmd_018f2b3c-4d5e-7abc-8def-0123456789ab");

const targetWorkspace = {
  workspaceId,
  projectId,
  parentWorkspaceId: null,
  name: "acceptance",
  responsibilityDefinition: {
    purpose: "acceptance fixture",
    ownedResponsibilities: [],
    obligations: [],
    includes: [],
    excludes: [],
    interfaces: [],
  },
  responsibilityRevision: 3,
  resourceBoundary: {
    basisResponsibilityRevision: 3,
    addresses: [{ _tag: "FileTree", path: "C:/acceptance" }],
  },
  resourceBoundaryRevision: parse(ResourceBoundaryRevision)(0),
  agentBinding: { _tag: "ResponsibilityBoundAgentBinding", workspaceId },
  primarySessionId: "ses_018f2b3c-4d5e-7abc-8def-0123456789ab",
  currentWorkId: null,
  workspacePolicy: {},
  workspacePolicyRevision: 0,
  revision: 1,
  lifecycle: "Active",
} as never;

const claims: ReadonlyArray<ResourceOwnershipClaimRecord> = [
  {
    claimId: "claim-target-a",
    workspaceId,
    region: {
      resourceSpaceId: "local",
      normalizedRegion: { kind: "FileTree", path: "C:/acceptance" },
    },
    sourceAddressSnapshot: { _tag: "FileTree", path: "C:/acceptance" },
    resourceBoundaryRevision: parse(ResourceBoundaryRevision)(0),
    resolvedAtEnvironmentRevision: "env1",
    createdAt: "t0",
    releasedAt: null,
  },
  {
    claimId: "claim-target-b",
    workspaceId,
    region: {
      resourceSpaceId: "local",
      normalizedRegion: { kind: "GitWorktree", path: "C:/acceptance" },
    },
    sourceAddressSnapshot: { _tag: "GitWorktree", path: "C:/acceptance" },
    resourceBoundaryRevision: parse(ResourceBoundaryRevision)(0),
    resolvedAtEnvironmentRevision: "env1",
    createdAt: "t0",
    releasedAt: null,
  },
];

const payload: UpdateResourceBoundaryPayload = {
  workspaceId,
  expectedWorkspaceRevision: parse(Revision)(1),
};

const invoke = (
  payloadOverride: Partial<UpdateResourceBoundaryPayload> = {},
  projectIdOverride = projectId,
) => {
  const released: string[] = [];
  const updates: unknown[] = [];
  const workspaceRepo: WorkspaceRepositoryService = {
    findById: () => Effect.succeed(Option.some(targetWorkspace)),
    create: () => Effect.void,
    changeResponsibilityIfRevision: () => Effect.void,
    updateResourceBoundaryIfRevision: (
      ...args: Parameters<
        WorkspaceRepositoryService["updateResourceBoundaryIfRevision"]
      >
    ) => Effect.sync(() => updates.push(args)),
    updatePolicyIfRevision: () => Effect.void,
    selectCurrentWorkIfRevision: () => Effect.void,
    replacePrimarySessionIfRevision: () => Effect.void,
  } as unknown as WorkspaceRepositoryService;
  const ownership: Pick<
    ResourceOwnershipRepositoryService,
    "listActiveByWorkspace" | "releaseClaim"
  > = {
    listActiveByWorkspace: (id) =>
      Effect.succeed(id === workspaceId ? claims : []),
    releaseClaim: (claimId) =>
      Effect.sync(() => {
        released.push(claimId);
      }),
  };
  const handler = makeUpdateResourceBoundaryHandler({
    workspaces: workspaceRepo,
    ownership,
  });
  const envelope = {
    commandType: "UpdateResourceBoundary",
    commandId,
    projectId: projectIdOverride,
    actor: parse(Actor)("user:local-admin"),
    issuedAt: "2026-10-12T00:00:00.000Z",
    payload: { ...payload, ...payloadOverride },
  };
  return Effect.runPromise(
    Effect.provideService(
      handler.execute(envelope, {
        _tag: "System",
        principal: parse(Principal)("user:local-admin"),
        causationRef: "test",
      }),
      TransactionScope,
      { session: { id: "test" } } as never,
    ),
  ).then((outcome) => ({ outcome, released, updates }));
};

describe("UpdateResourceBoundary Application command", () => {
  it("shrinks only the target Workspace, CASes the boundary, and emits both events", async () => {
    const { outcome, released, updates } = await invoke();
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value.result).toEqual({
      workspaceId,
      revision: 2,
      resourceBoundaryRevision: 1,
      releasedClaimIds: ["claim-target-a", "claim-target-b"],
    });
    expect(released).toEqual(["claim-target-a", "claim-target-b"]);
    expect(updates).toEqual([
      [workspaceId, 1, { basisResponsibilityRevision: 3, addresses: [] }, 1, 2],
    ]);
    expect(outcome.value.events.map((event) => event.eventType)).toEqual([
      "ResourceBoundaryChanged",
      "ResourceOwnershipChanged",
    ]);
    expect(
      outcome.value.events.every((event) => event.projectId === projectId),
    ).toBe(true);
  });

  it("rejects stale revision without releasing a claim or writing the Workspace", async () => {
    const { outcome, released, updates } = await invoke({
      expectedWorkspaceRevision: parse(Revision)(0),
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error._tag).toBe("RevisionConflict");
    expect(released).toEqual([]);
    expect(updates).toEqual([]);
  });

  it("rejects a foreign Workspace before any ownership or boundary write", async () => {
    const { outcome, released, updates } = await invoke({}, foreignProjectId);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error._tag).toBe("AuthorityDenied");
    expect(released).toEqual([]);
    expect(updates).toEqual([]);
  });
});
