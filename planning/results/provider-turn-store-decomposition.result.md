# ProviderTurn Store Decomposition — Result

## Status

**COMPLETE / VERIFIED — 2026-09-30.**

## Delivered

- Reduced `provider-turns.ts` from approximately 994 lines to a 45-line
  composition entry point.
- Split Turn intent/Manifest persistence, Attempt journaling, settlement
  evidence, project recovery/usage, and shared codecs into separate modules.
- Preserved the public `ProviderTurnStoreLive` and Port surface.
- Preserved every SQL statement and transaction boundary except the project
  recovery Attempt lookup, which now uses fixed batches of at most 500 Turn
  IDs.

## Invariants preserved

- Turn intent and Manifest remain atomically persisted before provider I/O.
- Attempt observations and canonical prefixes remain monotonic.
- Successful Attempt and Turn settlement remain atomic.
- Terminal settlement remains first-writer-wins.
- Recovery decisions remain append-only and transaction-scoped.
- Continuation checkpoint and success-evidence validation are unchanged.

## Evidence

- batching unit test: PASS
- provider persistence architecture test: PASS
- provider runtime/recovery focused suite: PASS (57/57)
- lint: PASS (784 files)
- typecheck: PASS
- architecture: PASS (117/117)
- core tests: PASS (1483 passed, 1 skipped)
- web typecheck/build: PASS
- web tests: PASS (211/211)
- git diff check: PASS
