import { ProjectId, parse, type ResourceAddress } from "@arbor/domain";
import { ProjectEnvironmentPort } from "@arbor/ports";
import { Effect, Layer } from "effect";
import { describe, expect, it } from "vitest";
import { resolveRegions } from "../src/index.js";

const projectId = parse(ProjectId)("prj_018f2b3c-4d5e-7abc-8def-0123456789a1");

const environment = Layer.succeed(ProjectEnvironmentPort, {
  resolve: (_projectId, addresses) =>
    Effect.succeed({
      regions: addresses.map((address) => ({
        resourceSpaceId:
          address._tag === "DatabaseNamespace" ? "database" : "filesystem",
        normalizedRegion: address,
      })),
      observedEnvironmentRevision: "rev",
    }),
});

describe("P4 canonical resource resolution", () => {
  it("resolves addresses to canonical regions via the environment port", async () => {
    const addresses: ReadonlyArray<ResourceAddress> = [
      { _tag: "FileTree", path: "/repo/a" },
      { _tag: "DatabaseNamespace", namespace: "db1" },
    ];
    const regions = await Effect.runPromise(
      Effect.provide(resolveRegions(projectId, addresses), environment),
    );
    expect(regions.map((region) => region.resourceSpaceId)).toEqual([
      "filesystem",
      "database",
    ]);
  });

  it("returns no regions for no addresses", async () => {
    const regions = await Effect.runPromise(
      Effect.provide(resolveRegions(projectId, []), environment),
    );
    expect(regions).toHaveLength(0);
  });
});
