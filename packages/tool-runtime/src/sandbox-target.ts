import { existsSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { SandboxHandle, SandboxMountAccess } from "@arbor/ports";

export interface SandboxTarget {
  readonly mount: string;
  readonly path: string;
}

const escapesRoot = (relativePath: string): boolean =>
  relativePath === ".." ||
  relativePath.startsWith(`..${sep}`) ||
  isAbsolute(relativePath);

const hasControlCharacter = (value: string): boolean =>
  Array.from(value).some((character) => {
    const code = character.charCodeAt(0);
    return code <= 0x1f || code === 0x7f;
  });

const validateRelativePath = (path: string): ReadonlyArray<string> => {
  if (path === ".") return [];
  if (
    path.length === 0 ||
    path.includes("\\") ||
    path.includes(":") ||
    path.includes("\0") ||
    hasControlCharacter(path) ||
    isAbsolute(path) ||
    /^[A-Za-z]:/.test(path) ||
    path.startsWith("//")
  ) {
    throw new Error("invalid sandbox-relative path");
  }
  const segments = path.split("/");
  if (
    segments.some(
      (segment) => segment === "" || segment === "." || segment === "..",
    )
  ) {
    throw new Error("invalid sandbox-relative path segment");
  }
  return segments;
};

const findMount = (handle: SandboxHandle, ref: string) => {
  const mounts =
    handle.mounts ??
    (ref === "workspace"
      ? [
          {
            ref: "workspace",
            rootPath: handle.rootPath,
            region:
              handle.writableRegions[0] ??
              ({
                resourceSpaceId: "filesystem",
                normalizedRegion: {},
              } as const),
            access:
              handle.writableRegions.length > 0
                ? ("ReadWrite" as const)
                : ("ReadOnly" as const),
          },
        ]
      : []);
  const matches = mounts.filter((mount) => mount.ref === ref);
  if (matches.length !== 1) {
    throw new Error(
      matches.length === 0
        ? "sandbox mount not found"
        : "sandbox mount is ambiguous",
    );
  }
  return matches[0] as (typeof matches)[number];
};

export const resolveSandboxTarget = (
  handle: SandboxHandle,
  target: SandboxTarget,
  options: {
    readonly access: SandboxMountAccess;
    readonly allowMissing?: boolean;
  },
): string => {
  const mount = findMount(handle, target.mount);
  if (options.access === "ReadWrite" && mount.access !== "ReadWrite") {
    throw new Error("sandbox mount is read-only");
  }
  const segments = validateRelativePath(target.path);
  const realRoot = realpathSync(resolve(mount.rootPath));
  const lexicalTarget = resolve(realRoot, ...segments);
  if (escapesRoot(relative(realRoot, lexicalTarget))) {
    throw new Error("path escapes sandbox mount");
  }
  if (existsSync(lexicalTarget)) {
    const realTarget = realpathSync(lexicalTarget);
    if (escapesRoot(relative(realRoot, realTarget))) {
      throw new Error("path resolves outside sandbox mount");
    }
    return realTarget;
  }
  if (options.allowMissing !== true) {
    throw new Error("sandbox target does not exist");
  }
  const parent = resolve(lexicalTarget, "..");
  const realParent = realpathSync(parent);
  if (escapesRoot(relative(realRoot, realParent))) {
    throw new Error("target parent resolves outside sandbox mount");
  }
  return lexicalTarget;
};
