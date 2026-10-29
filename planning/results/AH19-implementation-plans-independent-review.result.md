# AH19 implementation plans — independent review

Review date: 2026-10-17

Reviewed baseline: `453e9727f25fa76d1c5f99a6f75b53fa38456c0a`
Result: **PASS — Blocking = 0, B1 = 0, B2 = 0 for both plans.**

## Reviewed plan identities

- Work plan: `planning/proposals/AH19-work-precheckpoint-bounded-frontier-implementation-plan.md`
  - Raw SHA-256: `C4A0775DA83AE9623D46639E760A4A45E372B5A380AF44B5FE699E068D374957`
  - Result record: `planning/results/AH19-work-precheckpoint-bounded-frontier-implementation-plan.result.md`
- Conversation plan: `planning/proposals/AH19-conversation-checkpoint-owner-implementation-plan.md`
  - Raw SHA-256: `C642BB4F5F9F61F5A4FEF51107213CE6FD3331C7BF39B7AFE884BF0DBC1BE681`
  - Result record: `planning/results/AH19-conversation-checkpoint-owner-implementation-plan.result.md`

Both plan hashes were independently recomputed and match their result records.

## Basis and disposition

Compared both plans with System Design v1.18, DID v1.50, and the applicable
P2, P3, P9, and P14 contracts. The plans preserve the accepted governance
semantics and separate implementation authorization from design acceptance.
No unresolved semantic or physical-storage choice, TBD, scope expansion, or
exclusion conflict was found.

The Work plan fixes the pre-checkpoint latest-64 persisted-row window, existing
P3 filtering without older-row refill, hard C0/C1 facts and current input
outside the cap, represented-content-only checkpoint coverage, post-checkpoint
uncapped frontier, and append-only Timeline. Its code-delta and qualification
scope match the identified causal backfill defect. The causal-boundary test now
pins the exact `Blocked/ContradictoryTimeline` result, orphaned `callRef`, and
nullable `closedFrontier`, excluding `Ready` or an alternate projection. No
migration is required or included.

The Conversation plan fixes the separate `RootWorkspaceId` owner table and P14
port, frozen `(created_at, message_id)` order, contiguous authoritative
`Answered` frontier, owner/epoch/frontier lease-fenced CAS, source/producer
manifest, immutable Blob and binding-bound Native reference handling, and
retention. It prohibits legacy Session-checkpoint backfill and Work/Conversation
cross-ownership. Its P9 matrix covers same-episode checkpoint/restart and
non-contiguous-frontier recovery. The latter is parameterized over Pending,
Claimed, RetryScheduled, Declined, NeedsAttention, missing ResponseJob, and
malformed ResponseJob evidence.

Migration 0048 is additive with `requiresUserVersion: 47`, ordered after
45 F23/P6, 46 VCS, and 47 AH14. The plan explicitly gates implementation on
that prefix and limits migration qualification to fresh databases and
disposable schema-47 copies via offline CLI; live/preserved database upgrades,
deployment, and release are excluded. The reviewed baseline is schema 44, so
this prerequisite is not yet satisfied in this checkout.

## Authorization and verification boundary

The requested implementation tokens may be requested separately:

- `AUTHORIZE_AH19_WORK_PRECHECKPOINT_BOUNDED_FRONTIER_IMPLEMENTATION`
- `AUTHORIZE_AH19_CONVERSATION_CHECKPOINT_OWNER_IMPLEMENTATION`

Token requestability does not authorize implementation by itself. Work has no
migration prerequisite. Conversation implementation of the owner or migration
0048 must wait until migrations 45–47 are present in the stated global order.

This review was read-only. No tests, builds, migrations, or database operations
were run. The only intended repository change for this review is this record.
