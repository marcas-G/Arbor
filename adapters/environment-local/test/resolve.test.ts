import { ProjectId, parse } from "@arbor/domain";
import { ProjectEnvironmentPort } from "@arbor/ports";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { ProjectEnvironmentPortLive } from "../src/index.js";

const projectId = parse(ProjectId)("prj_018f2b3c-4d5e-7abc-8def-0123456789ab");

const program = Effect.gen(function* () {
  const environment = yield* ProjectEnvironmentPort;
  return yield* environment.resolve(projectId, [
    { _tag: "FileTree", path: "/repo/a" },
    { _tag: "GitWorktree", path: "/repo/b" },
    { _tag: "DatabaseNamespace", namespace: "db1" },
    { _tag: "ExternalResource", address: "https://example.test" },
  ]);
});

describe("local project environment resolver", () => {
  it("maps addresses to canonical regions and a deterministic revision", async () => {
    const first = await Effect.runPromise(
      Effect.provide(program, ProjectEnvironmentPortLive),
    );
    const second = await Effect.runPromise(
      Effect.provide(program, ProjectEnvironmentPortLive),
    );
    expect(first.regions.map((region) => region.resourceSpaceId)).toEqual([
      "filesystem",
      "filesystem",
      "database",
      "external",
    ]);
    expect(first.regions[0]?.normalizedRegion).toEqual({
      kind: "FileTree",
      path: "/repo/a",
    });
    expect(first.regions[2]?.normalizedRegion).toEqual({
      kind: "DatabaseNamespace",
      namespace: "db1",
    });
    expect(first.observedEnvironmentRevision).toMatch(/^local-/);
    expect(first.observedEnvironmentRevision).toBe(
      second.observedEnvironmentRevision,
    );
  });
});
