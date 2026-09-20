import {
  type CanonicalResourceRegion,
  type Project,
  parse,
  type Workspace,
  WorkspaceId,
} from "@arbor/domain";
import {
  ProjectEnvironmentPort,
  ResourceAdmission,
  type ResourceOwnershipClaimRecord,
  ResourceOwnershipRepository,
  TransactionPort,
  TransactionScope,
  WorkspaceRepository,
} from "@arbor/ports";
import { Effect, Layer, Option } from "effect";
import { describe, expect, it } from "vitest";
import { ResourceAdmissionLive } from "../src/index.js";

const workspaceId = parse(WorkspaceId)(
  "ws_018f2b3c-4d5e-7abc-8def-0123456789a1",
);

const workspace = {
  workspaceId,
  projectId: "prj_018f2b3c-4d5e-7abc-8def-0123456789a1",
  resourceBoundary: {
    basisResponsibilityRevision: 0,
    addresses: [{ _tag: "FileTree", path: "/repo" }],
  },
} as unknown as Workspace;

const region = (path: string): CanonicalResourceRegion => ({
  resourceSpaceId: "filesystem",
  normalizedRegion: { kind: "FileTree", path },
});

const claim = (path: string): ResourceOwnershipClaimRecord => ({
  claimId: "c1",
  workspaceId,
  region: region(path),
  sourceAddressSnapshot: { _tag: "FileTree", path },
  resourceBoundaryRevision: 0 as never,
  resolvedAtEnvironmentRevision: "rev",
  createdAt: "t",
  releasedAt: null,
});

const app = (claims: ReadonlyArray<ResourceOwnershipClaimRecord>) => {
  const tx = Layer.succeed(TransactionPort, {
    transact: <A, E, R>(body: Effect.Effect<A, E, R | TransactionScope>) =>
      Effect.provideService(body, TransactionScope, { session: { id: "t" } }),
  });
  const workspaces = Layer.succeed(WorkspaceRepository, {
    findById: () => Effect.succeed(Option.some(workspace)),
    create: () => Effect.void,
    changeResponsibilityIfRevision: () => Effect.void,
    updateResourceBoundaryIfRevision: () => Effect.void,
    updatePolicyIfRevision: () => Effect.void,
    selectCurrentWorkIfRevision: () => Effect.void,
    replacePrimarySessionIfRevision: () => Effect.void,
    retireIfRevision: () => Effect.void,
    countActiveChildren: () => Effect.succeed(0),
    hasOpenWork: () => Effect.succeed(false),
  } as never);
  const ownership = Layer.succeed(ResourceOwnershipRepository, {
    listActiveByWorkspace: () => Effect.succeed(claims),
    loadActiveConflicts: () => Effect.succeed([]),
    insertClaim: () => Effect.void,
    releaseClaim: () => Effect.void,
  } as never);
  const environment = Layer.succeed(ProjectEnvironmentPort, {
    resolve: (_projectId, addresses) =>
      Effect.succeed({
        regions: addresses.map((address) => ({
          resourceSpaceId: "filesystem",
          normalizedRegion: {
            kind: "FileTree",
            path: (address as { path: string }).path,
          },
        })),
        observedEnvironmentRevision: "rev",
      }),
  });
  const deps = Layer.mergeAll(tx, workspaces, ownership, environment);
  return Layer.mergeAll(deps, Layer.provide(ResourceAdmissionLive, deps));
};

const admit = (
  appLayer: Layer.Layer<any, any, any>,
  regions: ReadonlyArray<CanonicalResourceRegion>,
  write: boolean,
) =>
  Effect.runPromise(
    Effect.provide(
      Effect.gen(function* () {
        const admission = yield* ResourceAdmission;
        const tx = yield* TransactionPort;
        return yield* tx.transact(
          admission.admit({ workspaceId, regions, write }),
        );
      }),
      appLayer,
    ) as Effect.Effect<{ _tag: string }, unknown, never>,
  );

describe("P4 validate-only resource admission", () => {
  it("admits a read region inside the boundary", async () => {
    const result = await admit(app([]), [region("/repo/a")], false);
    expect(result._tag).toBe("Admitted");
  });

  it("denies a region outside the boundary", async () => {
    const result = await admit(app([]), [region("/elsewhere")], false);
    expect(result._tag).toBe("Denied");
  });

  it("requires an active ownership claim for write", async () => {
    expect((await admit(app([]), [region("/repo/a")], true))._tag).toBe(
      "Denied",
    );
    expect(
      (await admit(app([claim("/repo")]), [region("/repo/a")], true))._tag,
    ).toBe("Admitted");
  });

  void ({} as Project);
  void Option;
});
