import { resolve } from "node:path";

/** A stable, valid FileTree boundary for tests that exercise resource-aware
 * Runtime paths without depending on a host-specific project profile. */
export const fileTreeBoundaryAddress = (path = ".") => ({
  _tag: "FileTree" as const,
  path: resolve(path),
});

export const fileTreeBoundaryJson = (path = ".") =>
  JSON.stringify({
    basisResponsibilityRevision: 0,
    addresses: [fileTreeBoundaryAddress(path)],
  });

export const fileTreeCanonicalRegion = (path: string) => ({
  resourceSpaceId: "filesystem",
  normalizedRegion: { kind: "FileTree", path: resolve(path) },
});

export const resolveFileTreeBoundaryAddresses = (
  addresses: ReadonlyArray<{ readonly _tag: string; readonly path?: string }>,
) =>
  addresses.map((address) => {
    if (address._tag !== "FileTree" || address.path === undefined) {
      throw new Error("Fixture expected a FileTree resource address");
    }
    return fileTreeCanonicalRegion(address.path);
  });
