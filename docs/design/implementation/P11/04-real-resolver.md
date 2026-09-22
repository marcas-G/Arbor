# P11 — 04 Real Environment Resolver (GQ2/GQ3')

**Authority:** GQ2/GQ3' 裁决; DID §1.5 (C8: alias/overlap), P1 `02` (ProjectEnvironmentPort), §12.9.
**Status:** DRAFT.

## 1. Port semantics (observation-only)

`ProjectEnvironmentPort.resolve(addresses)` returns:

```ts
{ regions: CanonicalResourceRegion[], observedRevision: EnvironmentRevision,
  currentFingerprint: EnvironmentFingerprint }
```

- FileTree → stat probe (existence/mtime); GitWorktree → worktree metadata (existence/HEAD/dirty). Aliases normalize per C8 (worktree→filesystem subtree under the same backing space). Overlap algebra unchanged (P0 domain functions).
- **Observation-only**: reads the anchor counter; never advances it (CI-1). The returned fingerprint is derived from the *probe of the requested addresses*; the project-global fingerprint (for drift) comes from a full-region capture (`02` snapshot), not from a caller-subset.

## 2. ResourceResolutionStale (real, finally)

With real probing the ownership CAS sequence can genuinely observe counter movement mid-write → `ResourceResolutionStale` → bounded re-resolve (`10` wiring). Retryable operational error, per P1.

## 3. Must Not Decide

- No caller-subset fingerprint as project fingerprint (multi-workspace interleaving hazard); no cache (fresh probe each resolve; caching empirical later); no network resources in v1 (ExternalResource resolves to itself).

## (mapping: CI-1, CI-2)
