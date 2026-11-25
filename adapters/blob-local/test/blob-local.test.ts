import { createHash } from "node:crypto";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BlobStorePort } from "@arbor/ports";
import { Effect, Stream } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import { makeBlobStorePortLive } from "../src/index.js";

const directories: string[] = [];
const directory = () => {
  const path = mkdtempSync(join(tmpdir(), "arbor-blob-test-"));
  directories.push(path);
  return path;
};
afterEach(() => {
  for (const path of directories.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

const put = (root: string, bytes: Uint8Array) =>
  Effect.runPromise(
    Effect.provide(
      Effect.flatMap(BlobStorePort, (store) => store.put(bytes)),
      makeBlobStorePortLive(root),
    ),
  );
const get = (root: string, ref: string, legacyRoot?: string) =>
  Effect.runPromise(
    Effect.provide(
      Effect.flatMap(BlobStorePort, (store) => store.get(ref)),
      makeBlobStorePortLive(
        root,
        legacyRoot === undefined ? {} : { legacyRoot },
      ),
    ),
  );

describe("durable local content", () => {
  it("survives reopening and moving a complete data directory backup", async () => {
    const root = join(directory(), "blobs");
    const bytes = new TextEncoder().encode("user project evidence\n");
    const ref = await put(root, bytes);
    expect(await get(root, ref)).toEqual(bytes);
    const restored = join(directory(), "restored-blobs");
    mkdirSync(restored, { mode: 0o700 });
    cpSync(root, restored, { recursive: true });
    rmSync(root, { recursive: true });
    expect(await get(restored, ref)).toEqual(bytes);
    expect(statSync(join(restored, ref)).mode & 0o777).toBe(0o600);
  });

  it("isolates separate data directories and reports missing content as a typed error", async () => {
    const first = directory();
    const second = directory();
    const ref = await put(first, new Uint8Array([1, 2, 3]));
    const result = await Effect.runPromise(
      Effect.provide(
        Effect.flatMap(BlobStorePort, (store) => store.get(ref)).pipe(
          Effect.flip,
        ),
        makeBlobStorePortLive(second),
      ),
    );
    expect(result._tag).toBe("BlobStoreError");
  });

  it("copies verified legacy content without deleting the source and survives legacy cleanup", async () => {
    const legacy = directory();
    const durable = join(directory(), "blobs");
    const bytes = new Uint8Array([4, 5, 6]);
    const ref = await put(legacy, bytes);
    expect(await get(durable, ref, legacy)).toEqual(bytes);
    expect(new Uint8Array(readFileSync(join(legacy, ref)))).toEqual(bytes);
    rmSync(legacy, { recursive: true });
    expect(await get(durable, ref)).toEqual(bytes);
  });

  it("rejects corrupt durable data rather than hiding it with a legacy fallback", async () => {
    const legacy = directory();
    const root = directory();
    const bytes = new Uint8Array([7, 8]);
    const ref = await put(legacy, bytes);
    await put(root, bytes);
    writeFileSync(join(root, ref), "corrupted");
    await expect(get(root, ref, legacy)).rejects.toMatchObject({
      _tag: "BlobStoreError",
      cause: { message: "blob content hash mismatch" },
    });
  });

  it("rejects traversal, symlinked files and symlinked storage directories", async () => {
    const root = directory();
    await expect(get(root, "../other-user-data")).rejects.toMatchObject({
      _tag: "BlobStoreError",
      cause: { message: "invalid content-addressed blob reference" },
    });
    const bytes = new Uint8Array([9]);
    const ref = createHash("sha256").update(bytes).digest("hex");
    const source = join(directory(), "source");
    writeFileSync(source, bytes);
    symlinkSync(source, join(root, ref));
    await expect(get(root, ref)).rejects.toMatchObject({
      _tag: "BlobStoreError",
    });
    const link = join(directory(), "link");
    symlinkSync(root, link);
    await expect(put(link, bytes)).rejects.toMatchObject({
      _tag: "BlobStoreError",
      cause: {
        message: "blob directory must be private and owned by the current user",
      },
    });
  });

  it("fails a stream through the typed error channel when content is missing", async () => {
    const root = directory();
    const result = await Effect.runPromise(
      Effect.provide(
        Effect.flatMap(BlobStorePort, (store) =>
          Stream.runCollect(store.stream("0".repeat(64))),
        ).pipe(Effect.flip),
        makeBlobStorePortLive(root),
      ),
    );
    expect(result._tag).toBe("BlobStoreError");
  });

  it("does not accept an existing shared writable storage root", async () => {
    const root = join(directory(), "shared");
    mkdirSync(root, { mode: 0o755 });
    await expect(put(root, new Uint8Array([1]))).rejects.toMatchObject({
      _tag: "BlobStoreError",
      cause: {
        message: "blob directory must be private and owned by the current user",
      },
    });
  });
});
