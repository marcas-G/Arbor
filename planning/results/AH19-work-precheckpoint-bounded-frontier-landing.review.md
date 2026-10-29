# AH19 Work pre-checkpoint bounded frontier — post-landing review

Review date: 2026-10-17
Landing baseline: `4eea9e363c6ee9cf86b257e53f3cf8aa90a8aeaa`
Result: **PASS — Work package landed within accepted scope; implementation remains unauthorized.**

## Provenance

- Token: `ACCEPT_AH19_WORK_PRECHECKPOINT_BOUNDED_FRONTIER_V1`.
- Proposal raw SHA-256 independently recomputed:
  `4692895A2C9CF92DB1308507F29ED288FD3149F944AAC4F3D8BAE23635F5D663`.
- Decision/landing record:
  `planning/results/AH19-work-precheckpoint-bounded-frontier-acceptance-and-landing.record.md`.
- DID v1.50 and System Design v1.18 record the accepted policy and keep the
  Conversation package separately identified.

## Consistency checks

- The pre-first-checkpoint Work row window is exactly the latest 64 persisted
  rows by Session-local sequence. Current input and C0/C1 pinned facts are
  outside the cap; P3 filters do not backfill from older rows.
- The existing P2 `SessionItem` union and existing P3 projector conditions
  remain enumerated. Unsupported rows gain no new fallback; skipped rows emit
  no context/source ref and are not treated as represented.
- `inputFrontier` identifies the considered row range, not coverage.
  `retainedFrontier` can cover only content actually represented by the
  existing projector. Durable Timeline rows are not deleted.
- After a typed checkpoint, the active frontier is the exact checkpoint plus
  all unsummarized typed entries, with no pre-checkpoint numeric cap.
- The required restart/filtered-row/real-checkpoint and >64 post-checkpoint
  cases appear in P9's recovery matrix. Hard pinned C0/C1 inputs are listed
  separately, including source/revision binding.
- No physical Work schema, new projector type/filter, migration, code or test
  was introduced. No Scenario or Problem & Goals change was needed.

`git diff --check` passes. No tests or builds were run for this design-only
landing.
