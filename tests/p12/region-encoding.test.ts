import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { Effect, Layer } from "effect";
import type { SqlClient } from "effect/unstable/sql/SqlClient";
import { describe, expect, it } from "vitest";
import { EnvironmentResolverLocalLive } from "../../adapters/environment-resolver-local/src/index.js";
import {
  layer,
  P11_MIGRATIONS,
  runMigrations,
} from "../../adapters/persistence-sqlite/src/index.js";
import { evaluateEnvironmentImpact } from "../../packages/application/src/environment-impact.js";
import { verificationFreshness } from "../../packages/application/src/environment-staleness.js";
import {
  type CanonicalResourceRegion,
  canonicalRegionString,
  ProjectId,
  parse,
  WorkspaceId,
} from "../../packages/domain/dist/index.js";
import { EnvironmentResolverPort } from "../../packages/ports/src/index.js";
import { suiteTmp } from "./support.js";

// ---------------------------------------------------------------------------
// story 10 (`09`): region-encoding convergence + narrow invalidation
// ---------------------------------------------------------------------------

const regionProject = parse(ProjectId)(
  "prj_018f2b3c-4d5e-7abc-8def-0123456789e1",
);
const RESOURCE_SPACE_IDS: ReadonlySet<string> = new Set([
  "filesystem",
  "database",
  "external",
]);
const assertProducerRegion = (
  region: CanonicalResourceRegion,
  label: string,
): void => {
  expect(
    RESOURCE_SPACE_IDS.has(region.resourceSpaceId),
    `${label}: resourceSpaceId`,
  ).toBe(true);
  expect(typeof region.normalizedRegion, `${label}: normalizedRegion`).toBe(
    "object",
  );
};

const runRegionResolver = <A, E>(
  program: Effect.Effect<A, E, EnvironmentResolverPort | SqlClient>,
): Promise<A> =>
  Effect.runPromise(
    Effect.scoped(
      Effect.provide(
        program,
        Layer.provideMerge(
          EnvironmentResolverLocalLive,
          layer({ filename: ":memory:" }),
        ),
      ),
    ),
  );

describe("p12-acceptance story 10 — region-encoding convergence", () => {
  it("story 10: resolver output is the frozen object encoding and narrow invalidation is reachable", async () => {
    const dir = join(suiteTmp, "region-tree");
    await mkdir(dir, { recursive: true });
    await runRegionResolver(
      Effect.gen(function* () {
        yield* runMigrations(P11_MIGRATIONS);
        const resolver = yield* EnvironmentResolverPort;
        const observation = yield* resolver.observe(regionProject, [
          { _tag: "FileTree", path: dir },
        ]);
        for (const entry of observation.entries) {
          assertProducerRegion(entry.resolved, "resolver entry");
        }
        for (const region of observation.changedRegions) {
          assertProducerRegion(region, "resolver changedRegions");
        }
        const changed = observation.changedRegions[0];
        if (changed === undefined) {
          throw new Error("resolver emitted no changed region");
        }
        const normalized = changed.normalizedRegion as { path: string };
        const boundInside: CanonicalResourceRegion = {
          resourceSpaceId: changed.resourceSpaceId,
          normalizedRegion: {
            kind: "FileTree",
            path: join(normalized.path, "module-1"),
          },
        };
        expect(
          verificationFreshness(
            { targetEnvironmentRevision: "1", boundRegions: [boundInside] },
            [{ toRevision: "2", changedRegions: observation.changedRegions }],
          ),
        ).toBe("STALE");
        expect(
          verificationFreshness(
            {
              targetEnvironmentRevision: "1",
              boundRegions: [
                {
                  resourceSpaceId: "filesystem",
                  normalizedRegion: {
                    kind: "FileTree",
                    path: join(suiteTmp, "unrelated"),
                  },
                },
              ],
            },
            [{ toRevision: "2", changedRegions: observation.changedRegions }],
          ),
        ).toBe("CURRENT");
        const impact = evaluateEnvironmentImpact({
          changedRegions: observation.changedRegions,
          workspaces: [
            {
              workspaceId: parse(WorkspaceId)(
                "ws_018f2b3c-4d5e-7abc-8def-0123456789e1",
              ),
              boundaryRegions: [boundInside],
            },
          ],
          works: [],
          activeClaims: [],
        });
        expect(impact.affectedWorkspaceIds).toHaveLength(1);
      }),
    );

    expect(
      canonicalRegionString({
        resourceSpaceId: "filesystem",
        normalizedRegion: { kind: "FileTree", path: "/a" },
      }),
    ).not.toBe(
      canonicalRegionString({
        resourceSpaceId: "filesystem",
        normalizedRegion: { kind: "FileTree", path: "/b" },
      }),
    );
  });
});
