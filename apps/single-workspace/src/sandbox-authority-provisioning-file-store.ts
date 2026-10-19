import { randomUUID } from "node:crypto";
import {
  appendFileSync,
  closeSync,
  existsSync,
  fsyncSync,
  linkSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import type { SandboxAuthorityLoadErrorV1 } from "@arbor/domain";
import {
  moveP39ProtectedFileAtomically,
  validateP39ProtectedDirectory,
  validateP39ProtectedFile,
} from "@arbor/persistence-sqlite";
import {
  SandboxAuthorityProvisioningStore,
  type SandboxAuthorityProvisioningStoreService,
} from "@arbor/ports";
import { Effect } from "effect";

export interface SandboxAuthorityProvisioningFilePaths {
  readonly protectedRoot: string;
  readonly sourceFile: string;
  readonly highWaterFile: string;
  readonly forensicDirectory: string;
  readonly sourceIdentity: string;
}

export interface SandboxAuthorityProvisioningFileStoreError {
  readonly _tag: "SandboxAuthorityProvisioningFileStoreError";
  readonly code:
    | "ProtectedRootInvalid"
    | "SourcePathInvalid"
    | "HighWaterPathInvalid"
    | "PathOutsideProtectedRoot"
    | "SourceIdentityInvalid"
    | "ProtectedRootModeInvalid"
    | "ProtectedFileModeInvalid"
    | "ProtectedPathInvalid"
    | "CrossVolumePath"
    | "ForensicDirectoryInvalid"
    | "ForensicDirectoryModeInvalid"
    | "SourceUnreadable"
    | "HighWaterUnreadable"
    | "AtomicReplaceFailed"
    | "ForensicEvidenceConflict"
    | "ForensicEvidenceWriteFailed"
    | "AuditAppendFailed";
}

const result = <A>(effect: () => A, failure: SandboxAuthorityLoadErrorV1) =>
  Effect.try({ try: effect, catch: () => failure });

const normalizedPath = (path: string) =>
  process.platform === "win32"
    ? path.replaceAll("/", "\\").toLowerCase()
    : path;

const withinRoot = (root: string, target: string): boolean => {
  const rel = relative(root, target);
  return (
    rel === "" ||
    (!isAbsolute(rel) && !rel.startsWith(`..${sep}`) && rel !== "..")
  );
};

const hasNoReparsePath = (
  path: string,
  kind: "directory" | "file",
): boolean => {
  try {
    if (!isAbsolute(path)) return false;
    const resolved = resolve(path);
    const canonical = realpathSync.native(resolved);
    if (normalizedPath(canonical) !== normalizedPath(resolved)) return false;
    const stat = lstatSync(resolved, { bigint: true });
    return (
      !stat.isSymbolicLink() &&
      (kind === "directory" ? stat.isDirectory() : stat.isFile())
    );
  } catch {
    return false;
  }
};

const flushDirectory = (directory: string) => {
  // Windows does not expose directory fsync through Node. Its atomic path uses
  // MoveFileEx(MOVEFILE_WRITE_THROUGH); POSIX requires a directory fsync.
  if (process.platform === "win32") return;
  const descriptor = openSync(directory, "r");
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
};

const exactPosixMode = (path: string, expectedMode: 0o600 | 0o700): boolean => {
  if (process.platform === "win32") return true;
  try {
    const stat = statSync(path, { bigint: true });
    const currentUid = process.getuid?.();
    return (
      currentUid !== undefined &&
      stat.uid === BigInt(currentUid) &&
      (stat.mode & 0o777n) === BigInt(expectedMode)
    );
  } catch {
    return false;
  }
};

/** Creates a file-backed provisioning port only after validating the explicit
 * protected root, active inputs and all same-volume/path constraints. The
 * caller must not construct this adapter from daemon configuration. */
export const makeSandboxAuthorityProvisioningFileStore = (
  paths: SandboxAuthorityProvisioningFilePaths,
): Effect.Effect<
  SandboxAuthorityProvisioningStoreService,
  SandboxAuthorityProvisioningFileStoreError
> =>
  Effect.try({
    try: () => {
      const root = resolve(paths.protectedRoot);
      const source = resolve(paths.sourceFile);
      const highWater = resolve(paths.highWaterFile);
      const forensic = resolve(paths.forensicDirectory);
      if (
        !hasNoReparsePath(root, "directory") ||
        !validateP39ProtectedDirectory(root)
      )
        throw fileStoreError("ProtectedRootInvalid");
      if (
        !withinRoot(root, source) ||
        !withinRoot(root, highWater) ||
        !withinRoot(root, forensic)
      )
        throw fileStoreError("PathOutsideProtectedRoot");
      if (
        paths.sourceIdentity.trim() !== paths.sourceIdentity ||
        !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(paths.sourceIdentity)
      )
        throw fileStoreError("SourceIdentityInvalid");
      if (
        !hasNoReparsePath(source, "file") ||
        !validateP39ProtectedFile(source)
      )
        throw fileStoreError("SourcePathInvalid");
      if (
        !hasNoReparsePath(highWater, "file") ||
        !validateP39ProtectedFile(highWater)
      )
        throw fileStoreError("HighWaterPathInvalid");
      if (!exactPosixMode(root, 0o700))
        throw fileStoreError("ProtectedRootModeInvalid");
      if (!exactPosixMode(source, 0o600) || !exactPosixMode(highWater, 0o600))
        throw fileStoreError("ProtectedFileModeInvalid");
      const rootDevice = statSync(root, { bigint: true }).dev;
      const sourceStat = statSync(source, { bigint: true });
      const highWaterStat = statSync(highWater, { bigint: true });
      if (
        rootDevice === 0n ||
        sourceStat.dev !== rootDevice ||
        highWaterStat.dev !== rootDevice ||
        sourceStat.nlink !== 1n ||
        highWaterStat.nlink !== 1n
      )
        throw fileStoreError("CrossVolumePath");
      if (
        !existsSync(forensic) ||
        !hasNoReparsePath(forensic, "directory") ||
        statSync(forensic, { bigint: true }).dev !== rootDevice ||
        !validateP39ProtectedDirectory(forensic) ||
        !exactPosixMode(forensic, 0o700)
      )
        throw fileStoreError("ForensicDirectoryInvalid");
      if (!exactPosixMode(forensic, 0o700))
        throw fileStoreError("ForensicDirectoryModeInvalid");
      const auditFile = join(forensic, "authority-audit.jsonl");
      const atomicCreateOnly = (
        target: string,
        exactBytes: string,
      ): boolean => {
        if (existsSync(target)) return false;
        if (!hasNoReparsePath(dirname(target), "directory")) return false;
        const temporary = join(
          dirname(target),
          `.${basename(target)}.${process.pid}.${randomUUID()}.tmp`,
        );
        const descriptor = openSync(temporary, "wx", 0o600);
        try {
          writeFileSync(descriptor, exactBytes, "utf8");
          fsyncSync(descriptor);
        } finally {
          closeSync(descriptor);
        }
        if (
          !hasNoReparsePath(temporary, "file") ||
          statSync(temporary, { bigint: true }).dev !== rootDevice ||
          !validateP39ProtectedFile(temporary) ||
          !exactPosixMode(temporary, 0o600)
        )
          return false;
        let moved = false;
        if (process.platform === "win32") {
          moved = moveP39ProtectedFileAtomically(temporary, target, false);
        } else {
          try {
            linkSync(temporary, target);
            unlinkSync(temporary);
            flushDirectory(dirname(target));
            moved = true;
          } catch {
            moved = false;
          }
        }
        return (
          moved &&
          hasNoReparsePath(target, "file") &&
          validateP39ProtectedFile(target) &&
          exactPosixMode(target, 0o600) &&
          readFileSync(target, "utf8") === exactBytes
        );
      };
      return SandboxAuthorityProvisioningStore.of({
        readVerifiedSandboxAuthorityBundle: () =>
          result(() => {
            if (
              !hasNoReparsePath(root, "directory") ||
              !hasNoReparsePath(source, "file") ||
              !validateP39ProtectedDirectory(root) ||
              !validateP39ProtectedFile(source)
            )
              throw new Error("source protection changed");
            const canonicalJson = readFileSync(source, "utf8");
            const raw: unknown = JSON.parse(canonicalJson);
            if (
              typeof raw !== "object" ||
              raw === null ||
              !("sourceIdentity" in raw) ||
              raw.sourceIdentity !== paths.sourceIdentity
            )
              throw new Error("source identity mismatch");
            return { sourceIdentity: paths.sourceIdentity, canonicalJson };
          }, "SourceUnreadable"),
        readSandboxAuthorityHighWater: () =>
          result(() => {
            if (
              !hasNoReparsePath(root, "directory") ||
              !hasNoReparsePath(highWater, "file") ||
              !validateP39ProtectedDirectory(root) ||
              !validateP39ProtectedFile(highWater)
            )
              throw new Error("high-water protection changed");
            return readFileSync(highWater, "utf8");
          }, "HighWaterUnreadable"),
        commitSandboxAuthorityHighWater: (canonicalJson) =>
          result(
            () => atomicReplace(highWater, canonicalJson),
            "HighWaterCommitFailed",
          ),
        appendSandboxAuthorityAudit: (canonicalJson) =>
          result(() => {
            if (
              !hasNoReparsePath(forensic, "directory") ||
              !validateP39ProtectedDirectory(forensic)
            )
              throw new Error("audit directory protection changed");
            if (!existsSync(auditFile)) {
              if (!atomicCreateOnly(auditFile, ""))
                throw new Error("audit file create failed");
            }
            if (
              !hasNoReparsePath(auditFile, "file") ||
              !validateP39ProtectedFile(auditFile) ||
              !exactPosixMode(auditFile, 0o600)
            )
              throw new Error("audit file protection changed");
            const descriptor = openSync(auditFile, "a", 0o600);
            try {
              appendFileSync(descriptor, `${canonicalJson}\n`, "utf8");
              fsyncSync(descriptor);
            } finally {
              closeSync(descriptor);
            }
            flushDirectory(forensic);
            return true;
          }, "SourceUnreadable"),
        writeSandboxAuthorityBundleAtomically: (canonicalJson) =>
          result(
            () => atomicReplace(source, canonicalJson),
            "SourceUnreadable",
          ),
        preserveForensicEvidence: ({ evidenceId, exactBytes }) =>
          result(() => {
            if (!/^[a-z0-9-]{1,96}$/u.test(evidenceId))
              throw new Error("evidence id malformed");
            const filename = join(forensic, `${evidenceId}.raw`);
            if (
              !hasNoReparsePath(forensic, "directory") ||
              !validateP39ProtectedDirectory(forensic)
            )
              throw new Error("forensic directory protection changed");
            if (!existsSync(filename)) atomicCreateOnly(filename, exactBytes);
            if (
              !hasNoReparsePath(filename, "file") ||
              !validateP39ProtectedFile(filename) ||
              !exactPosixMode(filename, 0o600) ||
              readFileSync(filename, "utf8") !== exactBytes
            )
              throw new Error("forensic evidence readback mismatch");
            return true;
          }, "SourceUnreadable"),
        readForensicEvidence: (evidenceId) =>
          result(() => {
            if (!/^[a-z0-9-]{1,96}$/u.test(evidenceId))
              throw new Error("evidence id malformed");
            const filename = join(forensic, `${evidenceId}.raw`);
            if (!existsSync(filename)) return undefined;
            if (
              !hasNoReparsePath(filename, "file") ||
              !validateP39ProtectedFile(filename) ||
              !exactPosixMode(filename, 0o600)
            )
              throw new Error("forensic evidence protection changed");
            return readFileSync(filename, "utf8");
          }, "SourceUnreadable"),
      } satisfies SandboxAuthorityProvisioningStoreService);

      function atomicReplace(target: string, exactBytes: string): boolean {
        if (
          !hasNoReparsePath(root, "directory") ||
          !hasNoReparsePath(target, "file") ||
          !validateP39ProtectedDirectory(root) ||
          !validateP39ProtectedFile(target)
        )
          return false;
        const targetDevice = statSync(target, { bigint: true }).dev;
        if (targetDevice !== rootDevice) return false;
        const temporary = join(
          dirname(target),
          `.${basename(target)}.${process.pid}.${randomUUID()}.tmp`,
        );
        const descriptor = openSync(temporary, "wx", 0o600);
        try {
          writeFileSync(descriptor, exactBytes, "utf8");
          fsyncSync(descriptor);
        } finally {
          closeSync(descriptor);
        }
        if (
          !hasNoReparsePath(temporary, "file") ||
          statSync(temporary, { bigint: true }).dev !== targetDevice ||
          !validateP39ProtectedFile(temporary) ||
          !exactPosixMode(temporary, 0o600)
        ) {
          // The unique temporary has no authority and is deliberately left
          // untouched if its protection cannot be proven.
          return false;
        }
        let moved: boolean;
        if (process.platform === "win32") {
          moved = moveP39ProtectedFileAtomically(temporary, target, true);
        } else {
          renameSync(temporary, target);
          flushDirectory(dirname(target));
          moved = true;
        }
        if (!moved) return false;
        return (
          hasNoReparsePath(target, "file") &&
          validateP39ProtectedFile(target) &&
          exactPosixMode(target, 0o600) &&
          readFileSync(target, "utf8") === exactBytes
        );
      }
    },
    catch: (cause) =>
      isFileStoreError(cause) ? cause : fileStoreError("ProtectedPathInvalid"),
  });

const fileStoreError = (
  code: SandboxAuthorityProvisioningFileStoreError["code"],
): SandboxAuthorityProvisioningFileStoreError => ({
  _tag: "SandboxAuthorityProvisioningFileStoreError",
  code,
});

const isFileStoreError = (
  cause: unknown,
): cause is SandboxAuthorityProvisioningFileStoreError =>
  typeof cause === "object" &&
  cause !== null &&
  "_tag" in cause &&
  cause._tag === "SandboxAuthorityProvisioningFileStoreError";
