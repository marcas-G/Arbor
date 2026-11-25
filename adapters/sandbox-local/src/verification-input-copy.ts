import { createHash } from "node:crypto";
import { type BigIntStats, constants } from "node:fs";
import {
  chmod,
  copyFile,
  type FileHandle,
  lstat,
  mkdir,
  mkdtemp,
  open,
  opendir,
  readlink,
  realpath,
  rm,
  symlink,
} from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import {
  ExecutionId,
  ProjectId,
  parse,
  VerificationId,
  WorkId,
  WorkRevision,
  WorkspaceId,
} from "@arbor/domain";

/** Process-local input preparation, not an invocation/policy/Supported result.
 * The caller must supply already admitted roots and recheck their authority
 * before publishing a binding or executing anything. Never expose host paths
 * from the returned handle to the model or durable evidence. */
export interface VerificationInputBinding {
  readonly verificationId: VerificationId;
  readonly executionId: ExecutionId;
  readonly projectId: ProjectId;
  readonly workspaceId: WorkspaceId;
  readonly workId: WorkId;
  readonly targetWorkRevision: WorkRevision;
}

export type VerificationInputCopyFailure =
  | "UnsupportedHost"
  | "InvalidBinding"
  | "UnsafeRuntimeDirectory"
  | "OverlappingDirectories"
  | "UnsupportedEntry"
  | "EscapingSymlink"
  | "SourceChanged"
  | "InputLimitExceeded"
  | "Cancelled"
  | "InputUnavailable";

export class VerificationInputCopyError extends Error {
  constructor(readonly code: VerificationInputCopyFailure) {
    // No host paths, file contents, raw OS errors or secrets in diagnostics.
    super(`Verification input copy: ${code}`);
    this.name = "VerificationInputCopyError";
  }
}

interface InputEntry {
  readonly path: string;
  readonly kind: "directory" | "file" | "symlink";
  readonly mode: number;
  readonly size?: number;
  readonly sha256?: string;
  readonly target?: string;
}

export interface VerificationInputCopy {
  readonly binding: VerificationInputBinding;
  /** Host-only; bind this as the verifier's project, never as the producer. */
  readonly rootPath: string;
  readonly inputDigest: `sha256:${string}`;
  /** Durable evidence candidate. Contains relative entries and exact binding. */
  readonly manifestJson: string;
  readonly sourceIsCurrent: () => Promise<boolean>;
  readonly dispose: () => Promise<void>;
}

function fail(code: VerificationInputCopyFailure): never {
  throw new VerificationInputCopyError(code);
}
const fdPath = (handle: FileHandle): string => `/proc/self/fd/${handle.fd}`;
const statIdentity = (stat: BigIntStats): string =>
  [stat.dev, stat.ino, stat.mode, stat.size, stat.mtimeNs, stat.ctimeNs].join(
    ":",
  );
const contained = (parent: string, child: string): boolean => {
  const part = relative(parent, child);
  return part === "" || (part !== ".." && !part.startsWith(`..${sep}`));
};

/** Resolve links against the captured tree, not the changing host tree. In
 * particular, lexical normalization alone misses `link/../outside` escapes. */
const validateLinks = (entries: ReadonlyArray<InputEntry>): void => {
  const links = new Map(
    entries
      .filter((entry) => entry.kind === "symlink")
      .map((entry) => [entry.path, entry.target as string]),
  );
  for (const [path, target] of links) {
    const resolved: string[] = [];
    const pending = [...path.split("/").slice(0, -1), ...target.split("/")];
    let traversed = 0;
    while (pending.length !== 0) {
      const part = pending.shift() as string;
      if (part === "" || part === ".") continue;
      if (part === "..") {
        if (resolved.length === 0) fail("EscapingSymlink");
        resolved.pop();
        continue;
      }
      resolved.push(part);
      const next = links.get(resolved.join("/"));
      if (next !== undefined) {
        if (++traversed > 40) fail("UnsupportedEntry");
        resolved.pop();
        pending.unshift(...next.split("/"));
      }
    }
  }
};

/** Linux descriptor-anchored traversal: O_NOFOLLOW applies to the last path
 * component; each parent is therefore independently pinned by an open fd.
 * Replacing an ancestor with a symlink cannot redirect a read outside source.
 * Two complete content/metadata scans must agree before returning a copy.
 * This detects capture-time changes; it is not an atomic filesystem snapshot
 * or proof that the producer remains unchanged after this function returns. */
export const createVerificationInputCopy = async (input: {
  readonly sourceDirectory: string;
  readonly runtimeDirectory: string;
  readonly binding: VerificationInputBinding;
  readonly signal?: AbortSignal;
  readonly limits?: {
    readonly maxEntries: number;
    readonly maxBytes: number;
    readonly maxDepth: number;
    readonly timeoutMs: number;
  };
}): Promise<VerificationInputCopy> => {
  if (process.platform !== "linux") fail("UnsupportedHost");
  let binding: VerificationInputBinding;
  try {
    binding = Object.freeze({
      verificationId: parse(VerificationId)(input.binding.verificationId),
      executionId: parse(ExecutionId)(input.binding.executionId),
      projectId: parse(ProjectId)(input.binding.projectId),
      workspaceId: parse(WorkspaceId)(input.binding.workspaceId),
      workId: parse(WorkId)(input.binding.workId),
      targetWorkRevision: parse(WorkRevision)(input.binding.targetWorkRevision),
    });
  } catch {
    fail("InvalidBinding");
  }
  const limits = input.limits ?? {
    maxEntries: 100_000,
    maxBytes: 2 * 1024 ** 3,
    maxDepth: 128,
    timeoutMs: 120_000,
  };
  if (
    !Object.values(limits).every(
      (value) => Number.isSafeInteger(value) && value > 0,
    )
  ) {
    fail("InputLimitExceeded");
  }
  const budget = () => {
    const startedAt = performance.now();
    return () => {
      if (input.signal?.aborted === true) fail("Cancelled");
      if (performance.now() - startedAt > limits.timeoutMs)
        fail("InputLimitExceeded");
    };
  };
  const check = budget();
  let temporaryDirectory: string | undefined;
  let source: FileHandle | undefined;
  const directoryFlags =
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
  try {
    check();
    const sourcePath = await realpath(input.sourceDirectory);
    const runtimePath = resolve(input.runtimeDirectory);
    // A caller-owned private root is required. Creation is a single mkdir, not
    // recursive creation through an untrusted path; an existing symlink or
    // shared directory is never chmodded or reused.
    const parentPath = dirname(runtimePath);
    const parentStat = await lstat(parentPath);
    if (
      !parentStat.isDirectory() ||
      parentStat.isSymbolicLink() ||
      (await realpath(parentPath)) !== parentPath
    ) {
      fail("UnsafeRuntimeDirectory");
    }
    try {
      await mkdir(runtimePath, { mode: 0o700 });
    } catch (error) {
      if (
        !(
          typeof error === "object" &&
          error !== null &&
          "code" in error &&
          error.code === "EEXIST"
        )
      )
        fail("InputUnavailable");
    }
    const runtimeStat = await lstat(runtimePath);
    if (
      !runtimeStat.isDirectory() ||
      runtimeStat.isSymbolicLink() ||
      (runtimeStat.mode & 0o777) !== 0o700 ||
      runtimeStat.uid !== process.getuid?.() ||
      (await realpath(runtimePath)) !== runtimePath
    ) {
      fail("UnsafeRuntimeDirectory");
    }
    if (
      contained(sourcePath, runtimePath) ||
      contained(runtimePath, sourcePath)
    ) {
      fail("OverlappingDirectories");
    }
    source = await open(sourcePath, directoryFlags);
    temporaryDirectory = await mkdtemp(join(runtimePath, "verification-"));
    const copyRoot = join(temporaryDirectory, "project");
    await mkdir(copyRoot, { mode: 0o700 });

    const scan = async (root: FileHandle, copy: boolean, check: () => void) => {
      const entries: InputEntry[] = [];
      const identities: string[] = [];
      let totalBytes = 0;
      const walk = async (
        directory: FileHandle,
        prefix: string,
        depth: number,
      ): Promise<void> => {
        check();
        if (depth > limits.maxDepth) fail("InputLimitExceeded");
        const initial = await directory.stat({ bigint: true });
        identities.push(`${prefix}:${statIdentity(initial)}`);
        const names: string[] = [];
        for await (const entry of await opendir(fdPath(directory))) {
          check();
          if (names.length + entries.length >= limits.maxEntries) {
            fail("InputLimitExceeded");
          }
          names.push(entry.name);
        }
        names.sort();
        for (const name of names) {
          check();
          if (entries.length >= limits.maxEntries) fail("InputLimitExceeded");
          const path = prefix === "" ? name : `${prefix}/${name}`;
          const anchored = join(fdPath(directory), name);
          const stat = await lstat(anchored, { bigint: true });
          const identity = statIdentity(stat);
          const mode = Number(stat.mode & 0o777n);
          if (stat.isSymbolicLink()) {
            const target = await readlink(anchored);
            if (target.startsWith("/")) fail("EscapingSymlink");
            if (
              statIdentity(await lstat(anchored, { bigint: true })) !== identity
            ) {
              fail("SourceChanged");
            }
            entries.push({ path, kind: "symlink", mode, target });
          } else if (stat.isDirectory()) {
            const child = await open(anchored, directoryFlags);
            try {
              if (
                statIdentity(await child.stat({ bigint: true })) !== identity
              ) {
                fail("SourceChanged");
              }
              entries.push({ path, kind: "directory", mode });
              if (copy) await mkdir(join(copyRoot, path), { mode: 0o700 });
              await walk(child, path, depth + 1);
            } finally {
              await child.close();
            }
          } else if (stat.isFile()) {
            totalBytes += Number(stat.size);
            if (
              !Number.isSafeInteger(totalBytes) ||
              totalBytes > limits.maxBytes
            ) {
              fail("InputLimitExceeded");
            }
            const file = await open(
              anchored,
              constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
            );
            try {
              const opened = await file.stat({ bigint: true });
              if (!opened.isFile() || statIdentity(opened) !== identity) {
                fail("SourceChanged");
              }
              const hash = createHash("sha256");
              let bytes = 0;
              for await (const chunk of file.createReadStream({
                autoClose: false,
                start: 0,
              })) {
                check();
                bytes += chunk.length;
                if (bytes > Number(stat.size)) fail("SourceChanged");
                hash.update(chunk);
              }
              if (bytes !== Number(stat.size)) fail("SourceChanged");
              if (copy) {
                // copyFile can reflink, and its source is the pinned regular fd,
                // never a pathname that can be replaced with an external link.
                await copyFile(
                  fdPath(file),
                  join(copyRoot, path),
                  constants.COPYFILE_FICLONE,
                );
                await chmod(join(copyRoot, path), mode);
              }
              if (
                statIdentity(await file.stat({ bigint: true })) !== identity
              ) {
                fail("SourceChanged");
              }
              entries.push({
                path,
                kind: "file",
                mode,
                size: bytes,
                sha256: hash.digest("hex"),
              });
            } finally {
              await file.close();
            }
          } else {
            fail("UnsupportedEntry");
          }
          identities.push(`${path}:${identity}`);
        }
        if (
          statIdentity(await directory.stat({ bigint: true })) !==
          statIdentity(initial)
        ) {
          fail("SourceChanged");
        }
      };
      await walk(root, "", 0);
      validateLinks(entries);
      return { entries, identities };
    };
    const captured = await scan(source, true, check);
    const confirmed = await scan(source, false, check);
    if (JSON.stringify(captured) !== JSON.stringify(confirmed))
      fail("SourceChanged");
    const finalSource = await lstat(sourcePath, { bigint: true });
    if (
      statIdentity(finalSource) !==
      statIdentity(await source.stat({ bigint: true }))
    ) {
      fail("SourceChanged");
    }
    check();
    // Create links only after all file writes. No destination traversal can
    // then follow a captured symlink while populating the copy.
    for (const entry of captured.entries) {
      check();
      if (entry.kind === "symlink") {
        await symlink(entry.target as string, join(copyRoot, entry.path));
      }
    }
    check();
    const manifestJson = JSON.stringify({
      version: 1,
      kind: "IndependentVerificationInput",
      binding,
      entries: captured.entries,
    });
    const ownedDirectory = temporaryDirectory;
    // Do not memoize a failed cleanup: stop/recovery may need to retry it.
    let disposed = false;
    const dispose = () => {
      disposed = true;
      return rm(ownedDirectory, { recursive: true, force: true });
    };
    const sourceIsCurrent = async (): Promise<boolean> => {
      if (disposed) return false;
      let current: FileHandle | undefined;
      try {
        const check = budget();
        check();
        current = await open(sourcePath, directoryFlags);
        const observed = await scan(current, false, check);
        const pathStat = await lstat(sourcePath, { bigint: true });
        return (
          !disposed &&
          statIdentity(pathStat) ===
            statIdentity(await current.stat({ bigint: true })) &&
          JSON.stringify(observed) === JSON.stringify(captured)
        );
      } catch {
        return false;
      } finally {
        await current?.close();
      }
    };
    return {
      binding,
      rootPath: copyRoot,
      inputDigest: `sha256:${createHash("sha256").update(manifestJson).digest("hex")}`,
      manifestJson,
      sourceIsCurrent,
      dispose,
    };
  } catch (cause) {
    if (temporaryDirectory !== undefined) {
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
    if (cause instanceof VerificationInputCopyError) throw cause;
    if (input.signal?.aborted === true) fail("Cancelled");
    fail("InputUnavailable");
  } finally {
    await source?.close();
  }
};
