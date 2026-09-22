# P11 — 07 Staleness / Attention / Invalidation (GQ4)

**Authority:** GQ4 裁决; DID §3.5 (verdict binding), v1.13 G-line "PASS never re-judged"; SD §11.5 (verification invalidation); P8 `01`/`04`.
**Status:** DRAFT.

## 1. VerificationState = Verdict × Freshness (frozen)

```ts
type VerificationFreshness = "CURRENT" | "STALE";
// effective state examples: PASS+CURRENT, PASS+STALE, FAIL+STALE, …
```

- **Freshness is a derived overlay, not a mutation**: given a concluded Verification (targetEnvironmentRevision = R) and the anchor counter (A), freshness = `R >= A ? CURRENT : STALE`… refined: STALE iff any RecordEnvironmentChange with `toRevision > R` has changedRegions overlapping the verification's bound regions (narrow rule from `06`). Pure derivation — the stored verdict row never changes (CI-5).
- Drift consequences: keep verdict; mark stale (derived); Attention row (source=EnvironmentInvalidation, severity Attention); re-verify is a human/policy decision creating a **new** Verification identity (P8 re-verification semantics).

## 2. Forbidden (verbatim from the ruling)

PASS→FAIL auto; PASS→UNKNOWN auto; auto-re-verify-and-accept.

## 3. Other stale surfaces

Ownership claims resolved at older revisions render boundary views stale-flagged (same overlay pattern). EffectiveFacts/Attention read-models surface the overlay (P10 consume; no P10 contract change needed — the overlay rides existing view inputs).

## (mapping: CI-5)
