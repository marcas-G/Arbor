# P11 — 01 Environment Revision Algebra (GQ3')

**Authority:** GQ3' 裁决; DID §1.5, §8.16 (WakeCondition), §12.10; P1 `02`/`04` (store/CAS); P7 wake-sink (numeric comparison precedent).
**Status:** DRAFT.

## 1. The two identities (frozen, fully separated)

```ts
EnvironmentRevision    = per-project monotonic counter (string-encoded, e.g. "1","2",…)
EnvironmentFingerprint = environment content identity (content-addressed digest)
```

- **Revision** is the *only* ordering/wake currency: `fromRevision < toRevision`; WakeCondition `EnvironmentChanged(environmentRef, observedRevision)` compares counters numerically.
- **Fingerprint** is the *only* equality currency: drift = fingerprint inequality at probe time. **Ordering comparisons on fingerprints are forbidden** (type-level + lint-level ban; CI-audit hook in `03`).
- Project-global scope: one counter per project (P1 store shape unchanged — the stored string becomes the counter).
- ABA: A→B→A content still advances the counter — detected by progression, immune to fingerprint equality.

## 2. Anchor rules (CI-1)

```text
anchor revision advances ONLY via RecordEnvironmentChange (03)
resolver / drift probe / snapshot-diff OBSERVE (read fingerprint, propose);
they never advance the anchor
lazy-init follows the frozen P1 `04` §3.3 (P1-DG-08) semantics: **the first
successful ownership write** records the observed revision as the initial
anchor (counter starts at "1"; initialization, not an environment change —
no event, no wake, no Attention). This is the sole lazy write point; the
resolver's counter read is defined from that moment (B2 fix: single,
frozen trigger).
```

## 3. Store mapping

`environment_revisions.revision` stores the counter; the fingerprint and snapshotBlobRef live on the change record (and the latest snapshot pointer) — P1 DDL extended additively (migration; declared surface).

## 4. Must Not Decide

- No region-scoped revisions (GQ5); no fingerprint ordering; no caller-side advance; no second counter.

## P12 TR-1 propagation (P12 `05` §5.1)

`EnvironmentRevisionStore.advanceAnchor` is **removed from the public `ports`
surface**; advancement remains reachable **only** through the
`RecordEnvironmentChange` command path via an internal, non-exported capability,
so no observation-side code can import or invoke it. The CI-1 anchor rule above
is unchanged; this is the P12 narrowing of the recorded P11 residual
(`planning/results/P11.result.md:55`).

## (mapping: CI-1)
