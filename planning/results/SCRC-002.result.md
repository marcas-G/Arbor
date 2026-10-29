# SCRC-002 — Migration 0019, Session Store, Durable Input Promotion Result

## Status

**COMPLETE / VERIFIED — 2026-10-01.**

## Delivered

- Added forward-only migration `0019_session_context_runtime_convergence` and
  advanced the production composition/health baseline to user_version 19.
- Rebuilt `session_entries` as a versioned Timeline carrier with item type,
  schema version and context epoch while byte-preserving legacy payload/source
  evidence.
- Legacy rows become explicit `Legacy*` items with null epoch; migration never
  derives callRef from text.
- Added durable `SessionItem` ADT, sourced typed write records, frontier reads,
  full-fence idempotent append and atomic checkpoint/epoch CAS.
- Preserved pre-0019 append/idempotent APIs through explicit legacy writes.
- Added `InboxProjectionStore.findByKey` and Application
  `InputPromotionService`.
- Promotion writes one sourced UserMessage and marks the Inbox entry consumed
  inside one TransactionPort scope; exact replay returns the original sequence.
- Production composition exposes InputPromotionService.

## TDD evidence

Initial failures:

- migration suite failed because `P19_MIGRATIONS` did not exist;
- Session store suite failed because typed append/frontier/checkpoint methods
  did not exist;
- promotion suite failed because InputPromotionService did not exist.

Final evidence:

```text
Focused migration/store/promotion regression: 6 files / 19 tests passed
Production composition regression: 5 files / 10 tests passed
Architecture: 20 files / 121 tests passed
Full root tests: 255 files / 1503 passed / 1 skipped
Web tests: 31 files / 211 tests passed
Web build: PASS (existing chunk-size warning only)
pnpm check: PASS
git diff --check: PASS
```

## Acceptance mapping

| Row | Evidence |
|---|---|
| T04 | v18 fixture upgrades to v19 with every legacy payload retained |
| T05 | second migration run applies zero migrations and preserves rows |
| T06 | suggestive legacy Observation text stays LegacyObservation with no source/callRef inference |
| T07 | exact typed source/hash replay returns the original sequence |
| T08 | same source with changed hash returns SessionSourceConflict |
| T09 | SQLite trigger aborts Inbox consume; Session append rolls back; retry produces exactly one item |

## Scope guards

- Migrations 0001–0018 unchanged.
- No Agent driver input-drain change (owned by SCRC-003).
- No ToolCall/Result production writeback (owned by SCRC-004).
- No ContextProjector or Compaction execution.
- No Domain/Work/Verification/authority change.

Next tasks now unblocked by the DAG: **SCRC-003** and **SCRC-004**.
