import {
  parse,
  produceSandboxBoundaryV1,
  type ResourceAddress,
  type ResourceBoundary,
  WorkspaceId,
} from "@arbor/domain";
import { EnvironmentResolverLocalLive } from "@arbor/environment-resolver-local";
import { layer } from "@arbor/persistence-sqlite";
import { EnvironmentResolverPort, sha256Hex } from "@arbor/ports";
import { Effect, Layer } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { describe, expect, it } from "vitest";

const workspaceId = parse(WorkspaceId)(
  "ws_018f2b3c-4d5e-7abc-8def-0123456789a1",
);

describe("P11 resolver → complete sandbox boundary integration", () => {
  it("uses resolver-normalized alias sets for relative and dot-segment paths", async () => {
    const base = layer({ filename: ":memory:" });
    const resolver = Layer.provide(EnvironmentResolverLocalLive, base);
    const app = Layer.mergeAll(base, resolver);
    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.provide(
          Effect.gen(function* () {
            const sql = yield* SqlClient;
            yield* sql.unsafe(
              "CREATE TABLE environment_revisions (project_id TEXT PRIMARY KEY, revision TEXT NOT NULL)",
            );
            const p11 = yield* EnvironmentResolverPort;
            const fileAddress: ResourceAddress = {
              _tag: "FileTree",
              path: "./packages/./domain",
            };
            const managedAddress: ResourceAddress = {
              _tag: "GitWorktree",
              path: "packages/domain",
            };
            const boundary = {
              basisResponsibilityRevision: 0,
              addresses: [managedAddress, fileAddress],
            } as ResourceBoundary;
            const observation = yield* p11.observe(
              "prj_018f2b3c-4d5e-7abc-8def-0123456789a1" as never,
              boundary.addresses,
            );
            const primaryObservation = yield* p11.observe(
              "prj_018f2b3c-4d5e-7abc-8def-0123456789a1" as never,
              [managedAddress],
            );
            expect(observation.entries).toHaveLength(1);
            expect(observation.entries[0]?.address._tag).toBe("FileTree");
            expect(
              observation.entries[0]?.resolved.normalizedRegion,
            ).toMatchObject({
              kind: "FileTree",
              path: expect.not.stringContaining("./"),
            });
            const primaryEntry = primaryObservation.entries[0];
            expect(primaryEntry).toBeDefined();
            if (primaryEntry === undefined)
              throw new Error("missing primary observation");
            const produced = produceSandboxBoundaryV1(
              {
                workspaceId,
                resourceBoundaryRevision: 0,
                responsibilityRevision: 0,
                boundary,
                resolvedRegions: observation.entries.map(
                  (entry) => entry.resolved,
                ),
                primaryManagedGitWorktreeRegion: primaryEntry.resolved,
                ownershipClaims: [],
                policyKind: "TrustedLocalUnconfinedV1",
                profile: "FullAccess",
              },
              sha256Hex,
            );
            expect(produced?.mounts).toHaveLength(1);
            expect(produced?.mounts[0]?.mountId).toBe("workspace");
            expect(produced?.mounts[0]?.targetRef.resourceSpace).toBe(
              "filesystem",
            );
            expect(JSON.stringify(produced)).not.toContain("packages");
            return produced;
          }),
          app,
        ),
      ),
    );
    expect(result).toBeDefined();
  });
});
