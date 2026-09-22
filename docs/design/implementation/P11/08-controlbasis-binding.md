# P11 — 08 ControlBasis environmentRevision Binding (GQ4b)

**Authority:** GQ4 裁决; DID §8.19 (DecisionStale/FreshnessRequirement), SD §6.2/No.56; P3 `freshness.ts` (environmentRevision listed), driver.ts hardcode.
**Status:** DRAFT.

## 1. Service-internal read (frozen)

- `prepareTurn`/driver freshness gate reads `EnvironmentRevisionStore.current(projectId)` **inside the service** (via the injected port) — callers never pass a revision (no stale/0 leakage; CI-2).
- The current hardcoded `environmentRevision: "env"` in the driver path is removed; ControlBasis.environmentRevision = the real counter at decision time; DecisionStale fires per DID §8.19 when it moved.

## 2. Weak vs strong freshness (per §8.19)

Read-only actions keep weak freshness; write/governance-bound directives validate the revision captured at prepare time — unchanged semantics, now with a real value.

## (mapping: CI-2)
