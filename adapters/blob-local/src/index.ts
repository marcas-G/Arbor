import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { type BlobStoreError, BlobStorePort } from "@arbor/ports";
import { Effect, Layer, Stream } from "effect";

/** Compatibility default for standalone compositions. Production selects a
 * database-specific directory with makeBlobStorePortLive instead. */
export const defaultBlobRoot = (): string => {
  const xdg = process.env.XDG_DATA_HOME;
  return join(
    xdg !== undefined && isAbsolute(xdg)
      ? xdg
      : join(homedir(), ".local", "share"),
    "Arbor",
    "blobs",
  );
};

const digest = (bytes: Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex");
const failure = (cause: unknown): BlobStoreError => ({
  _tag: "BlobStoreError",
  cause,
});

/** P4 `07`: durable content bytes, independent of SQLite metadata. */
export const makeBlobStorePortLive = (
  directory: string,
  options: { readonly legacyRoot?: string } = {},
): Layer.Layer<BlobStorePort> => {
  const root = resolve(directory);
  return Layer.sync(BlobStorePort, () => {
    const pathFor = (ref: string): string => {
      if (!/^[a-f0-9]{64}$/u.test(ref)) {
        throw new Error("invalid content-addressed blob reference");
      }
      return join(root, ref);
    };
    const readVerified = (filename: string, ref: string): Uint8Array => {
      const fd = openSync(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const stat = fstatSync(fd);
        if (
          !stat.isFile() ||
          (process.getuid !== undefined && stat.uid !== process.getuid())
        ) {
          throw new Error(
            "blob is not a regular file owned by the current user",
          );
        }
        const bytes = readFileSync(fd);
        if (digest(bytes) !== ref)
          throw new Error("blob content hash mismatch");
        return new Uint8Array(bytes);
      } finally {
        closeSync(fd);
      }
    };
    const validateRoot = (): void => {
      const directoryStat = lstatSync(root);
      if (
        !directoryStat.isDirectory() ||
        (process.getuid !== undefined &&
          directoryStat.uid !== process.getuid()) ||
        (process.platform !== "win32" && (directoryStat.mode & 0o077) !== 0)
      ) {
        throw new Error(
          "blob directory must be private and owned by the current user",
        );
      }
    };
    const put = (bytes: Uint8Array): string => {
      mkdirSync(root, { recursive: true, mode: 0o700 });
      validateRoot();
      const ref = digest(bytes);
      const target = pathFor(ref);
      const temporary = join(root, `.pending-${randomUUID()}`);
      const fd = openSync(temporary, "wx", 0o600);
      try {
        writeFileSync(fd, bytes);
        fsyncSync(fd);
      } catch (error) {
        closeSync(fd);
        unlinkSync(temporary);
        throw error;
      }
      closeSync(fd);
      try {
        renameSync(temporary, target);
        // On Linux, persisting the file alone does not persist its directory entry.
        if (process.platform !== "win32") {
          const parent = openSync(
            root,
            constants.O_RDONLY | constants.O_DIRECTORY,
          );
          try {
            fsyncSync(parent);
          } finally {
            closeSync(parent);
          }
        }
      } finally {
        try {
          unlinkSync(temporary);
        } catch {
          // Best-effort cleanup must not hide a failed durable write. A crash
          // can likewise leave an unreferenced .pending file.
        }
      }
      return ref;
    };
    const get = (ref: string): Uint8Array => {
      const target = pathFor(ref);
      try {
        validateRoot();
        return readVerified(target, ref);
      } catch (error) {
        if (
          (error as NodeJS.ErrnoException).code !== "ENOENT" ||
          options.legacyRoot === undefined
        )
          throw error;
        // Existing installations referenced the shared temporary store. Copy only
        // the requested, owned, hash-verified content; never remove the source.
        const legacy = lstatSync(options.legacyRoot);
        if (
          !legacy.isDirectory() ||
          (process.getuid !== undefined && legacy.uid !== process.getuid())
        )
          throw new Error("invalid legacy blob directory");
        const bytes = readVerified(join(options.legacyRoot, ref), ref);
        put(bytes);
        return bytes;
      }
    };
    return BlobStorePort.of({
      put: (bytes) => Effect.try({ try: () => put(bytes), catch: failure }),
      get: (ref) => Effect.try({ try: () => get(ref), catch: failure }),
      stream: (ref) =>
        Stream.fromEffect(Effect.try({ try: () => get(ref), catch: failure })),
    });
  });
};

export const BlobStorePortLive: Layer.Layer<BlobStorePort> =
  makeBlobStorePortLive(defaultBlobRoot());
