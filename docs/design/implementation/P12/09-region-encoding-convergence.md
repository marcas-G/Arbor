# P12 — 09 Region Encoding Convergence (P11 C2)

**Authority:** DID v1.14 P12 completion blocker #1, §1.5, §12.9 (C8); P1 `04` §3.3 (frozen encoding); P4 `03` §2 (`resourceSpaceIds` exact-match); P11 `04`/`06`/`07`; `planning/results/P11.result.md:56`.
**Status:** DRAFT.

## 1. Frozen encoding (unambiguous)

`CanonicalResourceRegion` is object-encoded:

```ts
CanonicalResourceRegion = {
  resourceSpaceId: "filesystem" | "database" | "external"
  normalizedRegion:
    | { kind: "FileTree"; path: string }
    | { kind: "GitWorktree"; path: string }
    | { kind: "DatabaseNamespace"; namespace: string }
    | { kind: "ExternalResource"; address: string }
}
```

Overlap/containment are defined on canonical regions; enforcement compares canonical backing
resources, not raw path/string (DID §1.5, §12.9).

**`resourceSpaceId` value-set basis (DF-06).** The value set
`{"filesystem","database","external"}` is **not** enumerated by a single frozen
authority line. It is the **P12 phase-contract convergence decision** derived
from:

- P1 `04` §3.3 — `canonical_region = JSON { resourceSpaceId, normalizedRegion }`
  with per-kind `normalizedRegion` (FileTree / GitWorktree / DatabaseNamespace /
  ExternalResource) and contains/overlaps defined **within the same
  resourceSpaceId** (the space token is the identity axis);
- P4 `03` §2 — `InvocationAuthority.resourceSpaceIds` participates in an
  exact-match predicate (`authority.resourceSpaceIds ⊇ resolved regions of this
  intent`);
- P11 `04` §1 — the resolver normalizes FileTree/GitWorktree aliases into one
  filesystem backing space.

Consequence: the P4 authority fixtures must be **aligned** to this value set
(`"fs"` → `"filesystem"`) so the exact-match conjunct holds against resolver
output; that fixture alignment is part of the P12 phase contract.

## 2. Defect (P11 convergence item C2)

The real resolver emits a **raw path string** with `resourceSpaceId: "fs"`:

```text
adapters/environment-resolver-local : resourceSpaceId:"fs" + raw path string
resourceRegionComparator.keyOf(non-object) → null  ⇒ regionsOverlap always false
```

Consequence: narrow invalidation (`environment-impact.ts`, `environment-staleness.ts`) is
unreachable in production; acceptance Story A hides it by re-wrapping the raw path into the
object fixture before comparing.

## 3. Correction (frozen)

```text
resolver MUST emit the frozen object encoding:
  resourceSpaceId ∈ {"filesystem","database","external"}
  normalizedRegion = { kind, ... }
resourceRegionComparator MUST operate on the object encoding (no raw-path keys)
narrow invalidation MUST be reachable end-to-end without test-side re-wrapping
```

- Fix the resolver encoding (`"fs"` → `"filesystem"` + `{kind:"FileTree", path}`).
- Acceptance must exercise the narrow path against the **resolver output**, not a re-wrapped fixture.

## 4. Canonical region stringifier (E-07)

Several keyed sites derive a string key from `normalizedRegion`. Once
`normalizedRegion` is an object, `String(...)` collapses every region to
`"[object Object]"`. The fix defines one canonical stringifier with a **fixed
key order** and requires its use at every keyed site:

```ts
// fixed key order; filesystem aliases collapse (kind is descriptive, not identity)
canonicalRegionString(region) :=
  normalizedRegion.kind ∈ {"FileTree","GitWorktree"}
    ? JSON.stringify({ resourceSpaceId, kind: "FileTree", path })
    : normalizedRegion.kind === "DatabaseNamespace"
      ? JSON.stringify({ resourceSpaceId, kind: "DatabaseNamespace", namespace })
      : JSON.stringify({ resourceSpaceId, kind: "ExternalResource", address })
```

- Required call sites:
  - `packages/application/src/environment-drift.ts` — `regionKey` (currently
    `String(region.normalizedRegion)`);
  - `packages/domain/src/snapshot-identity.ts` — `canonicalRegion` (currently
    `canonicalString(region.normalizedRegion as string)`) and `regionSortKey`;
  - the resolver's own dedup key (`adapters/environment-resolver-local`,
    `regionKey`), see §7.
- Assertion: two **distinct paths** produce two **distinct** keys. The stringifier swap is
  **not** free for the P11 fixtures — see §4.1; the suites are **migrated**, not claimed
  green unchanged.
- Coupling: `snapshot-identity`'s canonical region encoding feeds the snapshot
  blob, so `parseSnapshotBlob` must round-trip the same encoding (blob-format
  hardening is placed in `05`, P11 convergence item 3).

### 4.1 Fixture + golden-hash migration (NEW-5)

`canonicalRegionString` is defined on the **object** `normalizedRegion` (frozen §1). Two P11
suites still build regions with a **raw-string** `normalizedRegion`, so the stringifier swap
collapses them unless the fixtures are migrated first:

- `tests/p11-snapshot-fingerprint.test.ts:16-21` —
  `region(norm: string) => ({ resourceSpaceId: WS, normalizedRegion: norm as never })` feeds
  raw strings (`"/a"`, `"/b"`, `"/extra"`, …) and relies on the current
  `canonicalString(region.normalizedRegion as string)` distinguishing them. Under
  `canonicalRegionString`, `normalizedRegion.kind` is `undefined`, so every such region falls
  to the `ExternalResource` branch and collapses to one key (address `undefined`). The
  "distinct paths → distinct fingerprints" intent is only preserved after the fixtures carry
  the frozen object encoding.
- `tests/p11-drift.test.ts:37-44` — `ftEntry` also uses
  `{ resourceSpaceId: "fs", normalizedRegion: path }` (the pre-fix resolver shape). These
  fixtures must likewise move to `resourceSpaceId: "filesystem"` +
  `{ kind: "FileTree", path }`.

Therefore this convergence **includes** the fixture/encoding migration:

```text
migrate every region fixture in p11-snapshot-fingerprint + p11-drift + p11-resolver
  (tests/p11-resolver.test.ts:70-71,104-105 pins resourceSpaceId:"fs" + raw string) +
  p11-record-change from a raw string to the frozen object
  ({ resourceSpaceId: "filesystem", normalizedRegion: { kind, ... } })
remove the Story-A test-side re-wrap (tests/p11-acceptance.test.ts) so narrow invalidation
  is asserted against the RESOLVER output, not a re-wrapped fixture
re-baseline any golden fingerprint / blob bytes that embed the old string encoding
  (snapshotBlobContent / parseSnapshotBlob goldens; the blob-format change is owned by `05` §5.2)
the suites must pass against the OBJECT encoding — they are NOT claimed green under the
  old raw-string fixtures
```

This is a **recorded suite migration**, not a green claim: the P12 `09` implementation task
updates the fixtures and goldens before asserting CI-7.

## 5. Alias collapse + production wiring (RG-12)

- **Alias collapse preserved**: FileTree and GitWorktree are both
  filesystem-backed; the canonical stringifier (§4) maps both to the same
  `kind: "FileTree"` key, so a GitWorktree aliasing a filesystem subtree
  collapses onto the equivalent FileTree at the same path (`resourceSpaceId`
  remains `"filesystem"` for both).
- **Production wiring**: the real resolver
  (`EnvironmentResolverLocalLive`, `adapters/environment-resolver-local`) MUST
  become the production source. Today `apps/single-workspace/src/composition.ts`
  still wires the fake `ProjectEnvironmentPortLive`
  (`adapters/environment-local`); the composition must switch to the real
  resolver as part of this correction (the fake is retained for tests only).

## 6. Reachable vs deferred kinds (E-09)

The CI-7 assertion is scoped to the **reachable** kinds:

```text
reachable   FileTree / GitWorktree                → resourceSpaceId "filesystem", object region
deferred    DatabaseNamespace / ExternalResource  → typed CanonicalizationFailed
```

Deferred kinds must fail **typed** (`CanonicalizationFailed`), never silently
canonicalize to a wrong space. The current resolver already returns
`CanonicalizationFailed` for these (`probeAddress` default branch); that
behavior is asserted, not weakened.

## 7. All-producer assertion (E-08)

CI-7 verification enumerates **every** `CanonicalResourceRegion` producer and
asserts, per emitted region, `typeof normalizedRegion === "object"` and
`resourceSpaceId ∈ {"filesystem","database","external"}`:

```text
producer                        site
real resolver                   adapters/environment-resolver-local (observe → changedRegions/entries)
fake environment-local          adapters/environment-local (fixtures already object-encoded)
sandbox-worktree consumer       adapters/sandbox-worktree (object guard, pathOfRegion)
REC changedRegions_json         adapters/persistence-sqlite/src/environment-change.ts (JSON round-trip)
snapshot-identity               packages/domain/src/snapshot-identity.ts (parse/blob → object region)
```

No producer may emit a string `normalizedRegion` or an out-of-set
`resourceSpaceId`. (`resource_ownership.canonical_region` and
`tool_invocations.resolvedRegions` JSON round-trips are covered by the same
object-shape assertion.)

## 8. Invariants

```text
CI-7  region encoding at every producer matches the frozen object encoding
      narrow invalidation path is reachable and tested end-to-end
```

## 9. Must Not Decide

- No change to the frozen encoding; no region revision algebra (P11 fence).
- No weakening of overlap semantics.
- No region-revision counters / per-workspace environment state (P11 `06` §2).

## 10. Verification

```text
resolver output resourceSpaceId ∈ {filesystem,database,external}, normalizedRegion object
canonicalRegionString: distinct paths → distinct keys; FileTree/GitWorktree same path → same key
p11-snapshot-fingerprint + p11-drift fixtures migrated to the object encoding; suites pass
  against the object encoding after the stringifier swap (goldens re-baselined) — §4.1
every producer (§7) asserts object normalizedRegion + valid resourceSpaceId
deferred kinds (DatabaseNamespace/ExternalResource) → typed CanonicalizationFailed
regionsOverlap(resolverRegion, boundaryRegion) reflects true overlap
narrow invalidation test passes without re-wrapping
production composition wires the real resolver (not the fake)
```
