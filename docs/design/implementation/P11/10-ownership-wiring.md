# P11 — 10 Ownership Claim/Release Wiring (GQ1b — scope-fenced)

**Authority:** GQ1(b) 裁决 (scope fence verbatim); P1 `02` §3 (OwnershipWriteService frozen), v1.8 G4 (validate-only admission unchanged).
**Status:** DRAFT.

## 1. Minimal wiring (IN scope)

- **Real claim call sites**: workspace boundary activation (CreateChildWorkspace / UpdateResourceBoundary paths) resolves and writes claims via OwnershipWriteService (the P1 CAS sequence becomes live).
- **Real release call sites**: boundary shrink; **RetireWorkspace enforces the frozen §1.4A precondition** (`no active ResourceOwnershipClaim`, DID:653/:4217) — the typed rejection points operators at the release paths (boundary shrink / worktree retirement) first; retirement itself never auto-releases claims (B1 fix: no silent §1.4A semantics change).
- **Worktree↔ownership consistency**: worktree retirement requires released claims (`09` §3).
- **Idempotency/atomicity**: claim/release are command-receipt-idempotent; failure atomicity is the P1 single-transaction sequence (stale → bounded re-resolve per `04` §2).

## 2. Scope fence (verbatim, OUT of scope)

Ownership protocol redesign; lease/TTL/preemption; multi-owner; distributed locking; arbitration extensions.

## 3. Unchanged neighbors

P4 admission remains validate-only (`ResourceOwnership ⊆ ResourceBoundary`); ownership changes remain governance commands (v1.8 G4).

## (mapping: CI-3)
