# P11 — 02 Environment Snapshot & Fingerprint (GQ3')

**Authority:** GQ3' 裁决; DID §3.5 (EnvironmentSnapshotRef), §11 P11 keyword; P4 blob/artifact infra (sha256 content addressing).
**Status:** DRAFT.

## 1. Snapshot blob (frozen minimal shape)

```ts
EnvironmentSnapshot = {
  projectId, revision: EnvironmentRevision,          // the counter this snapshot witnesses
  fingerprint: EnvironmentFingerprint,               // content digest of the probe results
  regions: ReadonlyArray<{ address: ResourceAddress, resolved: CanonicalResourceRegion,
                           probe: { kind: "FileTree", exists, mtime? } |
                                   { kind: "GitWorktree", exists, head?, dirty? } }>,
  capturedAt: string
}
```

- Stored as a content-addressed blob via the P4 blob store; `EnvironmentSnapshotRef` = blob ref. Each RecordEnvironmentChange binds `snapshotBlobRef` (the *next* state snapshot).
- Fingerprint = deterministic digest over the canonicalized `regions` probe results (exact recipe empirical; canonicalization order frozen: sorted by (resourceSpaceId, normalizedRegion)).

## 2. Probing granularity (empirical v1)

Existence + mtime for FileTree; existence + HEAD + dirty flag for GitWorktree. Hashing file contents is NOT v1 (cost); fingerprint collisions at this granularity are accepted and noted (counter progression still orders events).

## 3. Must Not Decide

- No content hashing of trees in v1; no snapshot retention policy beyond "all change-bound snapshots retained" (pruning is P12/ops); no snapshot as truth source (canonical state remains truth; snapshot is evidence).

## P12 TR-2 propagation (P12 `05` §5.2)

`parseSnapshotBlob` uses a **collision-free structured encoding** (length-prefixed
fields or explicit JSON fields) so ISO-8601 mtimes containing `:` round-trip
exactly; `RegionDiff` no longer degrades to the conservative full-set mode. The
`EnvironmentSnapshot` shape and fingerprint derivation above are unchanged.

## (mapping: CI-1, CI-4)
