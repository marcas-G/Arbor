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
import { it } from "@effect/vitest";
import { Effect, Stream } from "effect";
import { afterEach, describe, expect } from "vitest";
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
  Effect.flatMap(BlobStorePort, (store) => store.put(bytes)).pipe(
    Effect.provide(makeBlobStorePortLive(root)),
  );
const get = (root: string, ref: string, legacyRoot?: string) =>
  Effect.flatMap(BlobStorePort, (store) => store.get(ref)).pipe(
    Effect.provide(
      makeBlobStorePortLive(
        root,
        legacyRoot === undefined ? {} : { legacyRoot },
      ),
    ),
  );

describe("durable local content", () => {
  it.effect(
    "survives reopening and moving a complete data directory backup",
    () =>
      Effect.gen(function* () {
        const root = join(directory(), "blobs");
        const bytes = new TextEncoder().encode("user project evidence\n");
        const ref = yield* put(root, bytes);
        expect(yield* get(root, ref)).toEqual(bytes);
        const restored = join(directory(), "restored-blobs");
        mkdirSync(restored, { mode: 0o700 });
        cpSync(root, restored, { recursive: true });
        rmSync(root, { recursive: true });
        expect(yield* get(restored, ref)).toEqual(bytes);
        expect(statSync(join(restored, ref)).mode & 0o777).toBe(0o600);
      }),
  );

  it.effect(
    "isolates separate data directories and reports missing content as a typed error",
    () =>
      Effect.gen(function* () {
        const first = directory();
        const second = directory();
        const ref = yield* put(first, new Uint8Array([1, 2, 3]));
        const result = yield* Effect.flip(get(second, ref));
        expect(result._tag).toBe("BlobStoreError");
      }),
  );

  it.effect(
    "copies verified legacy content without deleting the source and survives legacy cleanup",
    () =>
      Effect.gen(function* () {
        const legacy = directory();
        const durable = join(directory(), "blobs");
        const bytes = new Uint8Array([4, 5, 6]);
        const ref = yield* put(legacy, bytes);
        expect(yield* get(durable, ref, legacy)).toEqual(bytes);
        expect(new Uint8Array(readFileSync(join(legacy, ref)))).toEqual(bytes);
        rmSync(legacy, { recursive: true });
        expect(yield* get(durable, ref)).toEqual(bytes);
      }),
  );

  it.effect(
    "rejects corrupt durable data rather than hiding it with a legacy fallback",
    () =>
      Effect.gen(function* () {
        const legacy = directory();
        const root = directory();
        const bytes = new Uint8Array([7, 8]);
        const ref = yield* put(legacy, bytes);
        yield* put(root, bytes);
        writeFileSync(join(root, ref), "corrupted");
        expect(yield* Effect.flip(get(root, ref, legacy))).toMatchObject({
          _tag: "BlobStoreError",
          cause: { message: "blob content hash mismatch" },
        });
      }),
  );

  it.effect(
    "rejects traversal, symlinked files and symlinked storage directories",
    () =>
      Effect.gen(function* () {
        const root = directory();
        expect(
          yield* Effect.flip(get(root, "../other-user-data")),
        ).toMatchObject({
          _tag: "BlobStoreError",
          cause: { message: "invalid content-addressed blob reference" },
        });
        const bytes = new Uint8Array([9]);
        const ref = createHash("sha256").update(bytes).digest("hex");
        const source = join(directory(), "source");
        writeFileSync(source, bytes);
        symlinkSync(source, join(root, ref));
        expect(yield* Effect.flip(get(root, ref))).toMatchObject({
          _tag: "BlobStoreError",
        });
        const link = join(directory(), "link");
        symlinkSync(root, link);
        expect(yield* Effect.flip(put(link, bytes))).toMatchObject({
          _tag: "BlobStoreError",
          cause: {
            message:
              "blob directory must be private and owned by the current user",
          },
        });
      }),
  );

  it.effect(
    "fails a stream through the typed error channel when content is missing",
    () =>
      Effect.gen(function* () {
        const root = directory();
        const result = yield* Effect.flip(
          Effect.flatMap(BlobStorePort, (store) =>
            Stream.runCollect(store.stream("0".repeat(64))),
          ).pipe(Effect.provide(makeBlobStorePortLive(root))),
        );
        expect(result._tag).toBe("BlobStoreError");
      }),
  );

  it.effect("does not accept an existing shared writable storage root", () =>
    Effect.gen(function* () {
      const root = join(directory(), "shared");
      mkdirSync(root, { mode: 0o755 });
      expect(yield* Effect.flip(put(root, new Uint8Array([1])))).toMatchObject({
        _tag: "BlobStoreError",
        cause: {
          message:
            "blob directory must be private and owned by the current user",
        },
      });
    }),
  );
});
