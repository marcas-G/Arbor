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
  const ownership = Layer.succeed(ResourceOwnershipRepository, {
    listActiveByWorkspace: () => Effect.succeed(claims),
    loadActiveConflicts: () => Effect.succeed([]),
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
) =>
  Effect.runPromise(
    Effect.provide(
      Effect.gen(function* () {
        const admission = yield* ResourceAdmission;
        const tx = yield* TransactionPort;
        return yield* tx.transact(
          admission.admit({
            workspaceId,
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

  void ({} as Project);
});
