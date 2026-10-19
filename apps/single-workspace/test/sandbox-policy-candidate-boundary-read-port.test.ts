import type { ProjectId, Workspace, WorkspaceId } from "@arbor/domain";
import { canonicalRegionString } from "@arbor/domain";
import type { WorktreeRecord } from "@arbor/ports";
import {
  EnvironmentResolverPort,
  ResourceOwnershipRepository,
  SandboxPolicyCandidateBoundaryReadPort,
  TransactionScope,
  WorkspaceRepository,
  WorktreeStore,
} from "@arbor/ports";
import { Effect, Layer, Option } from "effect";
import { describe, expect, it } from "vitest";
import { SandboxPolicyCandidateBoundaryReadPortLive } from "../src/sandbox-policy-candidate-boundary-read-port.js";

const projectId = "prj_candidate_boundary" as ProjectId;
const workspaceId = "ws_candidate_boundary" as WorkspaceId;
const address = { _tag: "GitWorktree" as const, path: "/repo/workspace" };
const primaryRegion = {
  resourceSpaceId: "filesystem",
  normalizedRegion: { kind: "GitWorktree", path: "/repo/workspace" },
};
const workspace = {
  projectId,
  workspaceId,
  lifecycle: "Active",
  responsibilityRevision: 4,
  resourceBoundary: {
    basisResponsibilityRevision: 4,
    addresses: [address],
  },
  resourceBoundaryRevision: 2,
  revision: 9,
} as Workspace;
const worktree = {
  worktreeId: "wt_primary",
  projectId,
  workspaceId,
  address,
  state: "Active",
  createdAt: "2026-10-19T00:00:00.000Z",
} satisfies WorktreeRecord;
const observation = {
  projectId,
  observedRevision: "env-1",
  fingerprint: "fingerprint",
  snapshotBlobRef: `blob:sha256:${"a".repeat(64)}`,
  entries: [{ address, resolved: primaryRegion, probe: { exists: true } }],
  changedRegions: [primaryRegion],
};

const read = (input: {
  readonly workspace?: Workspace | null;
  readonly claims?: ReadonlyArray<unknown>;
  readonly worktrees?: ReadonlyArray<WorktreeRecord>;
  readonly regions?: typeof observation.changedRegions;
  readonly entries?: typeof observation.entries;
}) => {
  let observationCalls = 0;
  const deps = Layer.mergeAll(
    Layer.succeed(WorkspaceRepository, {
      findById: () =>
        Effect.succeed(
          input.workspace === null
            ? Option.none()
            : Option.some(input.workspace ?? workspace),
        ),
    } as never),
    Layer.succeed(ResourceOwnershipRepository, {
      listByWorkspace: () => Effect.succeed(input.claims ?? []),
    } as never),
    Layer.succeed(WorktreeStore, {
      findByWorkspace: () => Effect.succeed(input.worktrees ?? [worktree]),
    } as never),
    Layer.succeed(EnvironmentResolverPort, {
      observe: () => {
        observationCalls += 1;
        return Effect.succeed({
          ...observation,
          entries: input.entries ?? observation.entries,
          changedRegions: input.regions ?? observation.changedRegions,
        });
      },
    }),
  );
  const service = Layer.provide(
    SandboxPolicyCandidateBoundaryReadPortLive,
    deps,
  );
  const program = Effect.gen(function* () {
    const port = yield* SandboxPolicyCandidateBoundaryReadPort;
    const result = yield* Effect.exit(
      port.readCurrentForWorkspace({ projectId, workspaceId }),
    );
    return { result, observationCalls };
  });
  return Effect.runPromise(
    Effect.provide(
      program,
      Layer.mergeAll(
        service,
        Layer.succeed(TransactionScope, { session: { id: "test" } }),
      ),
    ),
  );
};

describe("V6 complete P11 candidate boundary read", () => {
  it("pins one complete observation, exact ownership records and primary worktree", async () => {
    const claims = [
      {
        claimId: "claim-released",
        workspaceId,
        region: primaryRegion,
        sourceAddressSnapshot: address,
        resourceBoundaryRevision: 1,
        resolvedAtEnvironmentRevision: "env-old",
        createdAt: "t1",
        releasedAt: "t2",
      },
    ];
    const result = await read({ claims });
    expect(result.result._tag).toBe("Success");
    if (result.result._tag !== "Success") return;
    expect(result.result.value).toMatchObject({
      workspace: { workspaceId, responsibilityRevision: 4 },
      ownershipClaims: claims,
      worktrees: [worktree],
      resolvedRegions: [primaryRegion],
      primaryManagedGitWorktreeRegion: primaryRegion,
    });
    expect(result.observationCalls).toBe(1);
  });

  it("uses the authoritative GitWorktree binding when P11 collapses a FileTree alias", async () => {
    const fileTreeAddress = {
      _tag: "FileTree" as const,
      path: address.path,
    };
    const fileTreeRegion = {
      resourceSpaceId: "filesystem",
      normalizedRegion: { kind: "FileTree", path: address.path },
    };
    const aliasWorkspace = {
      ...workspace,
      resourceBoundary: {
        ...workspace.resourceBoundary,
        addresses: [fileTreeAddress, address],
      },
    } as Workspace;
    const result = await read({
      workspace: aliasWorkspace,
      entries: [
        {
          address: fileTreeAddress,
          resolved: fileTreeRegion,
          probe: { exists: true },
        },
      ],
      regions: [fileTreeRegion],
    });
    expect(result.result._tag).toBe("Success");
    if (result.result._tag !== "Success") return;
    expect(
      result.result.value.primaryManagedGitWorktreeRegion.normalizedRegion,
    ).toEqual({ kind: "GitWorktree", path: address.path });
    expect(
      canonicalRegionString(
        result.result.value.primaryManagedGitWorktreeRegion,
      ),
    ).toBe(canonicalRegionString(fileTreeRegion));
  });

  it.each([
    {
      name: "missing primary",
      input: { worktrees: [] },
      reason: "PrimaryWorktreeMissingOrAmbiguous",
    },
    {
      name: "duplicate active primary",
      input: { worktrees: [worktree, { ...worktree, worktreeId: "wt_dup" }] },
      reason: "PrimaryWorktreeMissingOrAmbiguous",
    },
    {
      name: "retired primary",
      input: { worktrees: [{ ...worktree, state: "Retired" as const }] },
      reason: "PrimaryWorktreeMissingOrAmbiguous",
    },
    {
      name: "stale primary absent from boundary",
      input: {
        worktrees: [
          { ...worktree, address: { ...address, path: "/repo/old" } },
        ],
      },
      reason: "PrimaryWorktreeNotInBoundary",
    },
    {
      name: "resolved-set mismatch",
      input: { regions: [] },
      reason: "EnvironmentObservationInconsistent",
    },
    {
      name: "primary canonical key absent from resolved set",
      input: {
        regions: [
          {
            resourceSpaceId: "filesystem",
            normalizedRegion: { kind: "FileTree", path: "/other/path" },
          },
        ],
        entries: [
          {
            address,
            resolved: {
              resourceSpaceId: "filesystem",
              normalizedRegion: { kind: "FileTree", path: "/other/path" },
            },
            probe: { exists: true },
          },
        ],
      },
      reason: "PrimaryWorktreeNotResolvedAsGitWorktree",
    },
    {
      name: "responsibility revision drift",
      input: {
        workspace: {
          ...workspace,
          responsibilityRevision: 5,
        } as Workspace,
      },
      reason: "ResponsibilityRevisionMismatch",
    },
  ] as const)("fails closed for $name", async ({ input, reason }) => {
    const result = await read(input);
    expect(result.result._tag).toBe("Failure");
    if (result.result._tag !== "Failure") return;
    expect(JSON.stringify(result.result.cause)).toContain(reason);
  });
});
