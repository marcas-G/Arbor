/**
 * TEST-ONLY fake. P12 `09` §5 (RG-12): production wires the REAL
 * `EnvironmentResolverLocalLive` projection
 * (`@arbor/environment-resolver-local`); this object-encoded
 * `ProjectEnvironmentPortLive` is retained solely as a deterministic test
 * fixture. It is imported only from `tests/**` and is not a dependency of
 * `apps/single-workspace` (removed from that manifest, B-10).
 */
import type { CanonicalResourceRegion, ResourceAddress } from "@arbor/domain";
import { ProjectEnvironmentPort, type ResolvedEnvironment } from "@arbor/ports";
import { Effect, Layer } from "effect";

const resolveAddress = (address: ResourceAddress): CanonicalResourceRegion => {
  switch (address._tag) {
    case "FileTree":
      return {
        resourceSpaceId: "filesystem",
        normalizedRegion: { kind: "FileTree", path: address.path },
      };
    case "GitWorktree":
      return {
        resourceSpaceId: "filesystem",
        normalizedRegion: { kind: "GitWorktree", path: address.path },
      };
    case "DatabaseNamespace":
      return {
        resourceSpaceId: "database",
        normalizedRegion: {
          kind: "DatabaseNamespace",
          namespace: address.namespace,
        },
      };
    case "ExternalResource":
      return {
        resourceSpaceId: "external",
        normalizedRegion: {
          kind: "ExternalResource",
          address: address.address,
        },
      };
  }
};

const hash = (input: string): string => {
  let value = 0x811c9dc5;
  for (let index = 0; index < input.length; index += 1) {
    value ^= input.charCodeAt(index);
    value = Math.imul(value, 0x01000193) >>> 0;
  }
  return value.toString(16).padStart(8, "0");
};

export const ProjectEnvironmentPortLive: Layer.Layer<ProjectEnvironmentPort> =
  Layer.succeed(ProjectEnvironmentPort, {
    resolve: (_projectId, addresses) =>
      Effect.sync((): ResolvedEnvironment => {
        const regions = addresses.map(resolveAddress);
        return {
          regions,
          observedEnvironmentRevision: `local-${hash(JSON.stringify(regions))}`,
        };
      }),
  });
