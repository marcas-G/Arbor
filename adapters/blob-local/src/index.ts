import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BlobStorePort } from "@arbor/ports";
import { Effect, Layer, Stream } from "effect";

/** P4 `07` §2; DID v1.8 §7.8. Content-addressed local blob store. */
const root = join(tmpdir(), "arbor-blobs");

export const BlobStorePortLive: Layer.Layer<BlobStorePort> = Layer.effect(
  BlobStorePort,
  Effect.sync(() => {
    const pathFor = (ref: string): string => join(root, ref);
    return BlobStorePort.of({
      put: (bytes) =>
        Effect.sync(() => {
          mkdirSync(root, { recursive: true });
          const ref = createHash("sha256").update(bytes).digest("hex");
          writeFileSync(pathFor(ref), bytes);
          return ref;
        }),
      get: (ref) =>
        Effect.sync(() => new Uint8Array(readFileSync(pathFor(ref)))),
      stream: (ref) =>
        Stream.fromIterable([new Uint8Array(readFileSync(pathFor(ref)))]),
    });
  }),
);
