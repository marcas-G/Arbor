import { ProjectId, parse, type ResourceAddress } from "@arbor/domain";
import { ProjectEnvironmentPort } from "@arbor/ports";
import { it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { describe, expect } from "vitest";
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

describe("canonical resource resolution", () => {
  it.effect(
    "resolves addresses to canonical regions via the environment port",
    () =>
      Effect.gen(function* () {
        const addresses: ReadonlyArray<ResourceAddress> = [
          { _tag: "FileTree", path: "/repo/a" },
          { _tag: "DatabaseNamespace", namespace: "db1" },
        ];
        const regions = yield* resolveRegions(projectId, addresses);
        expect(regions.map((region) => region.resourceSpaceId)).toEqual([
          "filesystem",
          "database",
        ]);
      }).pipe(Effect.provide(environment)),
  );

  it.effect("returns no regions for no addresses", () =>
    Effect.gen(function* () {
      const regions = yield* resolveRegions(projectId, []);
      expect(regions).toHaveLength(0);
    }).pipe(Effect.provide(environment)),
  );
});
