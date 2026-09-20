# P4 — 07 Blob / Artifact

**Authority:** DID v1.8 §7.8; SD v1.3 §6.6.
**Status:** DRAFT (first draft for contract review).

## 1. Separation (DID §7.8)

- `BlobStorePort` owns **content bytes** only: `put` / `get` / `stream`.
- `ArtifactMetadataRepository` owns Control-DB metadata.
- `ArtifactService` coordinates the two; no adapter cross-accesses SQLite.

## 2. BlobStorePort

```ts
interface BlobStorePortService {
  readonly put: (bytes: Uint8Array) => Effect.Effect<BlobRef, BlobStoreError>;
  readonly get: (ref: BlobRef) => Effect.Effect<Uint8Array, BlobStoreError>;
  readonly stream: (ref: BlobRef) => Stream.Stream<Uint8Array, BlobStoreError>;
}

type BlobRef = string;   // content-addressed
```

## 3. Artifact domain + metadata

```ts
interface Artifact {
  readonly artifactId: ArtifactId;
  readonly kind: string;
  readonly blobRef: BlobRef;
  readonly byteSize: number;
  readonly contentHash: string;
  readonly producedBy: { readonly invocationId: ToolInvocationId } | { readonly executionId: ExecutionId };
  readonly createdAt: string;
}

interface ArtifactMetadataRepositoryService {
  readonly insert: (artifact: Artifact) => Effect.Effect<void, ArtifactMetadataError, TransactionScope>;
  readonly findById: (artifactId: ArtifactId) => Effect.Effect<Option.Option<Artifact>, ArtifactMetadataError, TransactionScope>;
}
```

DDL:

```sql
CREATE TABLE artifacts (
  artifact_id   TEXT PRIMARY KEY,
  kind          TEXT NOT NULL,
  blob_ref      TEXT NOT NULL,
  byte_size     INTEGER NOT NULL,
  content_hash  TEXT NOT NULL,
  invocation_id TEXT,
  execution_id  TEXT,
  created_at    TEXT NOT NULL
);
```

## 4. ArtifactService

```ts
interface ArtifactServiceService {
  readonly store: (bytes: Uint8Array, kind: string, producedBy: Artifact["producedBy"]) =>
    Effect.Effect<Artifact, ArtifactError>;
  readonly load: (artifactId: ArtifactId) => Effect.Effect<Option.Option<Uint8Array>, ArtifactError>;
}
```

- `store` writes the blob then the metadata row; a crash between leaves an
  orphan blob (garbage-collectable), never a dangling metadata row.
- Tool results above the bounded-observation size use `resultRef` (`01` §4).

## 5. Bounded observation

```text
raw result bytes -> ArtifactService.store -> Artifact reference
model sees -> BoundedObservation { text, truncated }   (SD §6.6)
```

## 6. Must Not Decide

- No concrete blob backend/layout or size thresholds (implementation/empirical).
- No retention policy for artifacts (later phase).
- No projection/UI artifact views (P10).
