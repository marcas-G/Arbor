# SCRC-007 — ProviderNative / Budget / Overflow Result

## Status

**COMPLETE / VERIFIED — 2026-10-01。**

- Added ProviderNative compaction through existing ContinuationState.
- Opaque checkpoints bind exact deployment/model/protocol fingerprint.
- Added provider/model/adapter/fallback budget evidence selection.
- Added bounded overflow decision: one recovery before durable output/effect.
- DID v1.23 ordinal-0 chain preserves immutable original Manifest and creates
  stable Compaction/Replacement ProviderTurns without consuming repairAttempt.
- Replacement overflow is terminal; no second chain.

Evidence: focused 5 files / 28 tests; full counts recorded in SCRC final result.
