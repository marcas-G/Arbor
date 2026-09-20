import type { ArtifactId, ExecutionId, ToolInvocationId } from "@arbor/domain";
import {
  type Artifact,
  type ArtifactMetadataError,
  ArtifactMetadataRepository,
  TransactionScope,
} from "@arbor/ports";
import { Effect, Layer, Option } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";

interface Row {
  readonly artifact_id: string;
  readonly kind: string;
  readonly blob_ref: string;
  readonly byte_size: number;
  readonly content_hash: string;
  readonly invocation_id: string | null;
  readonly execution_id: string | null;
  readonly created_at: string;
}

const toArtifact = (row: Row): Artifact => ({
  artifactId: row.artifact_id as ArtifactId,
  kind: row.kind,
  blobRef: row.blob_ref,
  byteSize: Number(row.byte_size),
  contentHash: row.content_hash,
  invocationId: row.invocation_id as ToolInvocationId | null,
  executionId: row.execution_id as ExecutionId | null,
  createdAt: row.created_at,
});

export const ArtifactMetadataRepositoryLive: Layer.Layer<
  ArtifactMetadataRepository,
  never,
  SqlClient
> = Layer.effect(
  ArtifactMetadataRepository,
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    const failure = (cause: unknown): ArtifactMetadataError => ({
      _tag: "ArtifactMetadataError",
      cause,
    });
    const run = <A>(effect: Effect.Effect<A, SqlError>) =>
      effect.pipe(Effect.mapError(failure));
    return ArtifactMetadataRepository.of({
      insert: (artifact) =>
        Effect.gen(function* () {
          yield* TransactionScope;
          yield* run(
            sql.unsafe(
              "INSERT INTO artifacts (artifact_id, kind, blob_ref, byte_size, content_hash, invocation_id, execution_id, created_at) VALUES (?,?,?,?,?,?,?,?)",
              [
                artifact.artifactId,
                artifact.kind,
                artifact.blobRef,
                artifact.byteSize,
                artifact.contentHash,
                artifact.invocationId,
                artifact.executionId,
                artifact.createdAt,
              ],
            ),
          );
        }),
      findById: (artifactId) =>
        Effect.gen(function* () {
          yield* TransactionScope;
          const rows = yield* run(
            sql.unsafe<Row>("SELECT * FROM artifacts WHERE artifact_id = ?", [
              artifactId,
            ]),
          );
          const row = rows[0];
          return row === undefined
            ? Option.none()
            : Option.some(toArtifact(row));
        }),
    });
  }),
);
