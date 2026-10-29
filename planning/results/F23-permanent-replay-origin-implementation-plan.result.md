# F23 P8/P6 Permanent Replay Origin — Implementation Plan Record

Date: 2026-10-17

Planning baseline: `58aae35b08738019749ba5bba17a26f564f0cd57`

Status: **fixed planning package; implementation authorization not yet accepted**

Plan: `planning/proposals/F23-permanent-replay-origin-implementation-plan.md`

Requested token: `AUTHORIZE_F23_P8_PERMANENT_REPLAY_ORIGIN_IMPLEMENTATION`

Plan raw SHA-256: `766E98259DB5D520B436A0D3D927484B539C75497E2294C5A42AE8AAF88579DB`

## Source contracts

- P8 permanent origin and legacy disposition: accepted DID v1.46; fixed proposal SHA `6BEEC14ED975D7322003C95D28F63D161C82F4EFA4B584ECAA99D1120BE712CA`.
- P6 UnboundLegacy mechanics and P1 atomic route move: accepted DID v1.47; fixed proposal SHA `798C2CB2782E4D8FF1064CE1065E12B09A318565997EF1160460B478CFA48FDF`.
- Planning baseline confirms `CURRENT_SCHEMA_VERSION=44` and migration 0044 requires 43. Plan therefore fixes 0045/requires44 without changing earlier versions.

## Preparation record

- Added only the fixed implementation plan and this result record.
- The plan pins the exact migration 0045 Inbox rebuild shape, `revision=1`/`updated_at=admitted_at` seed for existing entries, accepted immutable origin/disposition shape, evidence-gated atomic backfill, P1 same-transaction route moves, and offline-only qualification boundary.
- No `docs/design/**`, code, tests, migrations, CLI, database, deployment, or preserved fixture was changed or run. No implementation was performed because the separate token has not been accepted in this work item.
- No tests/build were run. Whitespace checks and the plan raw SHA are recorded after final text stabilization.

The implementation plan requests the named authorization; this record does not assert that it has been granted.
