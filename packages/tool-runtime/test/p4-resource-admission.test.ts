import {
  type CanonicalResourceRegion,
  type Project,
  parse,
  WorkspaceId,
} from "@arbor/domain";
import {
  ResourceAdmission,
  type ResourceOwnershipClaimRecord,
  ResourceOwnershipRepository,
  TransactionPort,
  TransactionScope,
} from "@arbor/ports";
import { Effect, Layer } from "effect";
import { describe, expect, it } from "vitest";
import { ResourceAdmissionLive } from "../src/index.js";

const workspaceId = parse(WorkspaceId)(
  "ws_018f2b3c-4d5e-7abc-8def-0123456789a1",
);
const childWorkspaceId = parse(WorkspaceId)(
  "ws_018f2b3c-4d5e-7abc-8def-0123456789a2",
);

const region = (path: string): CanonicalResourceRegion => ({
  resourceSpaceId: "filesystem",
  normalizedRegion: { kind: "FileTree", path },
});

const claim = (
  path: string,
  owner = workspaceId,
  claimId = "c1",
  exclusions: ReadonlyArray<CanonicalResourceRegion> = [],
): ResourceOwnershipClaimRecord => ({
  claimId,
  workspaceId: owner,
  region: region(path),
  sourceAddressSnapshot: { _tag: "FileTree", path },
  resourceBoundaryRevision: 0 as never,
  resolvedAtEnvironmentRevision: "rev",
  createdAt: "t",
  releasedAt: null,
  exclusions,
});

const app = (claims: ReadonlyArray<ResourceOwnershipClaimRecord>) => {
  const tx = Layer.succeed(TransactionPort, {
    transact: <A, E, R>(body: Effect.Effect<A, E, R | TransactionScope>) =>
      Effect.provideService(body, TransactionScope, { session: { id: "t" } }),
  });
  const ownership = Layer.succeed(ResourceOwnershipRepository, {
    listActiveByWorkspace: () => Effect.succeed(claims),
    loadActiveConflicts: () => Effect.succeed(claims),
    insertClaim: () => Effect.void,
    releaseClaim: () => Effect.void,
  } as never);
  const deps = Layer.mergeAll(tx, ownership);
  return Layer.mergeAll(deps, Layer.provide(ResourceAdmissionLive, deps));
};

const admit = (
  // biome-ignore lint/suspicious/noExplicitAny: test helper erases the app layer type
  appLayer: Layer.Layer<any, any, any>,
  regions: ReadonlyArray<CanonicalResourceRegion>,
  write: boolean,
  owner = workspaceId,
) =>
  Effect.runPromise(
    Effect.provide(
      Effect.gen(function* () {
        const admission = yield* ResourceAdmission;
        const tx = yield* TransactionPort;
        return yield* tx.transact(
          admission.admit({
            workspaceId: owner,
            regions,
            resolvedBoundaryRegions: [region("/repo")],
            write,
          }),
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

  it("keeps the Child unowned when formation has no ownership delegation", async () => {
    const parent = claim("/repo", workspaceId, "parent");
    // The Child's ResourceBoundary may include the requested path, but without
    // an activated delegation there is no Child claim. P4 validates ownership
    // independently from any fs:write permission grant.
    expect(
      (
        await admit(
          app([parent]),
          [region("/repo/child/file")],
          true,
          childWorkspaceId,
        )
      )._tag,
    ).toBe("Denied");
    expect(
      (await admit(app([parent]), [region("/repo/child/file")], true))._tag,
    ).toBe("Admitted");
  });

  it("enforces the activated ownership split: Parent remainder and Child carve-out are disjoint", async () => {
    const parent = claim("/repo", workspaceId, "parent", [
      region("/repo/child"),
    ]);
    const child = claim("/repo/child", childWorkspaceId, "child");
    expect(
      (await admit(app([parent, child]), [region("/repo/child/file")], true))
        ._tag,
    ).toBe("Denied");
    expect(
      (await admit(app([parent, child]), [region("/repo/other/file")], true))
        ._tag,
    ).toBe("Admitted");
    const childResult = await admit(
      app([parent, child]),
      [region("/repo/child/file")],
      true,
      childWorkspaceId,
    );
    expect(childResult._tag).toBe("Admitted");
    expect(
      (
        await admit(
          app([parent, child]),
          [region("/repo/other/file")],
          true,
          childWorkspaceId,
        )
      )._tag,
    ).toBe("Denied");
  });

  it("fails closed when a partial carve-out leaves global effective claims overlapping", async () => {
    const parent = claim("/repo", workspaceId, "parent", [
      region("/repo/child/subtree"),
    ]);
    const child = claim("/repo/child", childWorkspaceId, "child");
    const result = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const admission = yield* ResourceAdmission;
          const tx = yield* TransactionPort;
          return yield* tx.transact(
            admission.admit({
              workspaceId,
              regions: [region("/repo/other/file")],
              resolvedBoundaryRegions: [region("/repo")],
              write: true,
            }),
          );
        }),
        app([parent, child]),
      ),
    );
    expect(result).toMatchObject({
      _tag: "Denied",
      reason: "active effective ownership claims overlap",
    });
  });

  void ({} as Project);
});
