import { ArtifactId, parse } from "@arbor/domain";
import {
  type Artifact,
  type ArtifactError,
  ArtifactMetadataRepository,
  ArtifactService,
  BlobStorePort,
  TransactionScope,
} from "@arbor/ports";
import { Effect, Layer, Option } from "effect";

const artifactIdFromHash = (hash: string) =>
  parse(ArtifactId)(
    `art_${hash.slice(0, 8)}-${hash.slice(8, 12)}-7${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`,
  );

/** P4 `07` §4; DID v1.8 §7.8. Coordinates blob bytes + control-DB metadata. */
export const ArtifactServiceLive: Layer.Layer<
  ArtifactService,
  never,
  BlobStorePort | ArtifactMetadataRepository
> = Layer.effect(
  ArtifactService,
  Effect.gen(function* () {
    const blobs = yield* BlobStorePort;
    const metadata = yield* ArtifactMetadataRepository;
    const failure = (cause: unknown): ArtifactError => ({
      _tag: "ArtifactError",
      cause,
    });
    return ArtifactService.of({
      store: (bytes, kind, producedBy, createdAt) =>
        Effect.gen(function* () {
          yield* TransactionScope;
          const blobRef = yield* blobs.put(bytes);
          const artifactId = artifactIdFromHash(blobRef);
          const existing = yield* metadata.findById(artifactId);
          if (Option.isSome(existing)) {
            return existing.value;
          }
          const artifact: Artifact = {
            artifactId,
            kind,
            blobRef,
            byteSize: bytes.byteLength,
            contentHash: blobRef,
            invocationId: producedBy.invocationId ?? null,
            executionId: producedBy.executionId ?? null,
            createdAt,
          };
          yield* metadata.insert(artifact);
          return artifact;
        }).pipe(Effect.mapError(failure)),
      load: (artifactId) =>
        Effect.gen(function* () {
          yield* TransactionScope;
          const found = yield* metadata.findById(artifactId);
          if (Option.isNone(found)) {
            return Option.none();
          }
          const bytes = yield* blobs.get(found.value.blobRef);
          return Option.some(bytes);
        }).pipe(Effect.mapError(failure)),
    });
  }),
);
