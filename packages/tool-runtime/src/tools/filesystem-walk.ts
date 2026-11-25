import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  opendirSync,
  openSync,
  readSync,
} from "node:fs";
import { join } from "node:path";
import type { SandboxHandle, SandboxMountAccess } from "@arbor/ports";
import { resolveSandboxTarget, type SandboxTarget } from "../sandbox-target.js";

// Linux first-release implementation. Pin each directory descriptor, never
// resolve a child through an unchecked pathname or follow a final symlink.
export const sandboxPathSegments = (path: string): string[] => {
  if (
    typeof path !== "string" ||
    path.length === 0 ||
    path.includes("\\") ||
    path.includes(":") ||
    Array.from(path).some((character) => {
      const code = character.charCodeAt(0);
      return code <= 0x1f || code === 0x7f;
    })
  )
    throw new Error("invalid sandbox path");
  if (path === ".") return [];
  const segments = path.split("/");
  if (
    segments.some(
      (segment) => segment === "" || segment === "." || segment === "..",
    )
  )
    throw new Error("invalid sandbox path");
  return segments;
};

export const withSandboxDirectory = <A>(
  sandbox: SandboxHandle,
  mount: string,
  path: string,
  access: SandboxMountAccess,
  create: boolean,
  operation: (path: string) => A,
  onDirectoryCreated?: () => void,
): A => {
  if (process.platform !== "linux")
    throw new Error("filesystem tool requires Linux descriptor support");
  const segments = sandboxPathSegments(path);
  const root = resolveSandboxTarget(sandbox, { mount, path: "." }, { access });
  const descriptors: number[] = [];
  try {
    let current = root;
    for (const segment of [null, ...segments]) {
      const next = segment === null ? current : join(current, segment);
      if (create && segment !== null) {
        try {
          mkdirSync(next);
          onDirectoryCreated?.();
          // Retain each new directory entry before descending into it.
          fsyncSync(descriptors[descriptors.length - 1] as number);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        }
      }
      const descriptor = openSync(
        next,
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
      );
      descriptors.push(descriptor);
      current = `/proc/self/fd/${descriptor}`;
    }
    return operation(current);
  } finally {
    for (const descriptor of descriptors.reverse()) closeSync(descriptor);
  }
};

export const withSandboxParent = <A>(
  sandbox: SandboxHandle,
  target: SandboxTarget,
  access: SandboxMountAccess,
  create: boolean,
  operation: (parent: string, name: string) => A,
  onDirectoryCreated?: () => void,
): A => {
  const segments = sandboxPathSegments(target.path);
  const name = segments.pop();
  if (name === undefined) throw new Error("target must be a file");
  return withSandboxDirectory(
    sandbox,
    target.mount,
    segments.join("/") || ".",
    access,
    create,
    (parent) => operation(parent, name),
    onDirectoryCreated,
  );
};

export const readRegularText = (
  path: string,
  maxBytes: number,
): string | undefined => {
  const fd = openSync(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const info = fstatSync(fd);
    if (!info.isFile() || info.size > maxBytes) return undefined;
    // Read at most the budget even if the file grows after fstat.
    const bytes = Buffer.alloc(Math.min(info.size + 1, maxBytes + 1));
    let length = 0;
    while (length < bytes.length) {
      const count = readSync(fd, bytes, length, bytes.length - length, null);
      if (count === 0) break;
      length += count;
    }
    if (length > info.size || length > maxBytes) return undefined;
    let content: string;
    try {
      content = new TextDecoder("utf-8", {
        fatal: true,
        ignoreBOM: true,
      }).decode(bytes.subarray(0, length));
    } catch {
      return undefined;
    }
    return content.includes("\0") ? undefined : content;
  } finally {
    closeSync(fd);
  }
};

export interface WalkedFile {
  readonly path: string;
  readonly mountRelativePath: string;
  readonly byteSize: number;
}

// Entry budget includes directories and non-files, so empty trees and special
// files cannot turn a bounded file search into an unbounded traversal.
export const visitRegularFiles = (
  sandbox: SandboxHandle,
  target: SandboxTarget,
  maxDepth: number,
  visit: (file: WalkedFile) => boolean,
): boolean => {
  let entries = 0;
  let truncated = false;
  const walk = (directory: string, prefix: string, depth: number): boolean => {
    const stream = opendirSync(directory);
    try {
      for (
        let entry = stream.readSync();
        entry !== null;
        entry = stream.readSync()
      ) {
        if (++entries > 10_000) {
          truncated = true;
          return false;
        }
        const path = join(directory, entry.name);
        const info = lstatSync(path);
        if (info.isSymbolicLink()) continue;
        const mountRelativePath =
          prefix === "." ? entry.name : `${prefix}/${entry.name}`;
        if (info.isDirectory()) {
          if (depth >= maxDepth) {
            truncated = true;
            continue;
          }
          const fd = openSync(
            path,
            constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
          );
          try {
            if (!walk(`/proc/self/fd/${fd}`, mountRelativePath, depth + 1))
              return false;
          } finally {
            closeSync(fd);
          }
        } else if (
          info.isFile() &&
          !visit({ path, mountRelativePath, byteSize: info.size })
        ) {
          truncated = true;
          return false;
        }
      }
      return true;
    } finally {
      stream.closeSync();
    }
  };
  withSandboxDirectory(
    sandbox,
    target.mount,
    target.path,
    "ReadOnly",
    false,
    (start) => walk(start, target.path, 0),
  );
  return truncated;
};

export const searchLimit = (
  value: number | undefined,
  fallback: number,
): number => {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 1 || value > fallback)
    throw new Error("invalid search limit");
  return value;
};

export const searchDepth = (value: number | undefined): number => {
  if (value === undefined) return 32;
  if (!Number.isSafeInteger(value) || value < 0 || value > 32)
    throw new Error("invalid search depth");
  return value;
};

// Bound complete JSON rows, rather than slicing through a quoted string.
export const searchObservation = <A>(
  rows: ReadonlyArray<A>,
  truncated: boolean,
) => {
  const matches: A[] = [];
  for (const row of rows) {
    if (
      JSON.stringify({ matches: [...matches, row], truncated: true }).length >
      1900
    ) {
      truncated = true;
      break;
    }
    matches.push(row);
  }
  return { text: JSON.stringify({ matches, truncated }), truncated };
};
