# AH19 Work pre-checkpoint bounded frontier — independent post-landing review

Review date: 2026-10-17
Reviewed commit: `f7432a0353f607f945d2634e3c49ac107a3002bc`
Parent baseline: `4eea9e363c6ee9cf86b257e53f3cf8aa90a8aeaa`
Result: **PASS — Blocking = 0, B1 = 0, B2 = 0; accepted design package formally landed.**

## Provenance

- Acceptance token: `ACCEPT_AH19_WORK_PRECHECKPOINT_BOUNDED_FRONTIER_V1`.
- Accepted proposal: `planning/proposals/AH19-work-precheckpoint-bounded-frontier-v1-fixed-package.md`.
- Raw SHA-256 independently recomputed from the proposal blob in the reviewed commit: `4692895A2C9CF92DB1308507F29ED288FD3149F944AAC4F3D8BAE23635F5D663`.
- Landing baseline and owner revisions: DID v1.49 / SD v1.17 to DID v1.50 / SD v1.18.
- Acceptance and landing record: `planning/results/AH19-work-precheckpoint-bounded-frontier-acceptance-and-landing.record.md`.

## Owner and invariant review

- P2 selects exactly the latest 64 persisted Work Session Timeline rows by Session-local sequence before the first typed checkpoint. Current input and canonical Work/control facts are separate from the row cap. P3 filters the selected window using existing projector branches and does not refill skipped rows from older history.
- The eligible SessionItem set and existing typed projection checks are carried forward without inventing a fallback. Skipped rows produce no context item or source reference. `inputFrontier` describes the considered window; `retainedFrontier` can claim only content represented by the projector. Older and skipped rows remain durable and uncovered.
- The hard pinned C0/C1 Work/control fragments are separately identified and bound to their existing source/revision; the row window cannot evict them. After a typed checkpoint, the active frontier is that exact checkpoint plus every unsummarized typed entry after it, with no 64-row cap.
- P9 `02`/`07` distinguish restart before and after checkpoint commit, filtered-row compaction/restart, and the post-checkpoint frontier beyond 64 entries. The combined AH19 recovery matrix also covers Conversation cases without conflating its owner.
- The Work landing changes no physical schema, projector type/filter, migration, code, or tests. DID v1.50 and SD v1.18 carry the accepted token/hash and link the separate Work and Conversation records/reviews. Problem & Goals and Scenarios were not changed.

## Authorization and boundary

This is a design-only landing. The fixed 64-row policy is accepted, but changing the bound, eligible types, frontier calculation, projector behavior, or checkpoint coverage requires a separately reviewed implementation package and authorization. No migration is required or reserved by this package; no implementation or qualification authorization is implied.

The reviewed commit has parent `4eea9e363c6ee9cf86b257e53f3cf8aa90a8aeaa`. `git show --check` is clean. No tests or builds were run for this design-only review.
