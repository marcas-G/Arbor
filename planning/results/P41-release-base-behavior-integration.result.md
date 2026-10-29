# P41 release-base runtime behavior integration result

## Scope and provenance

Ported the accepted P41 behavior/final snapshot `81f12e95` onto the current
integration tree. The source B0 review is for that exact accepted source tree;
it is not a new review of the integrated commit. The relevant source sequence
was behavior `ec900065`, P10 restart qualification `3ceb2053`, fail-closed P10
validation `3b3ee71f`, marker storage `3bca06b9`, and final rebuild
`81f12e95`. The source storage commit `0a850d0f` was not replayed because its
P41 storage implementation was already integrated as `9003b049`/`1a9cdba5`.

Semantic overlap resolution preserves P40 replay-evidence behavior and P41
Submitted Decision behavior as distinct events, P9 fact sources, and P10
Attention rows. P10 validates each event against its own exact P9 fact,
materializes one marker, and resets by rebuilding submitted-Decision markers
from durable P9 facts before event replay. The P40 `ToolObservationReplay`
marker path remains present. The P41 event/codecs are included; no production
behavior was replaced wholesale.

`CURRENT_MIGRATIONS` remains `P38_MIGRATIONS`. Descriptor 0041 and all P41
stores/projections remain dormant until the authorized cumulative prefix is
available. P2’s non-Submitted-Decision path no longer queries P41 fact tables:
the pre-drive lookup is gated to a stopped `DecisionEpisode` and an available
0041 fact store. The P2 regression fixture retains the P38/P12 schema (no
0041); only the test-owned F21 Project Resource Source column and the normal
RecoveryAttentionFactStore service are composed.

## Verification

- P41 behavior-focused unit target: 8 files, 37 tests passed. This includes
  pinned replay, P10 readmodel, exact Submitted Decision P9/P10 cases, the
  restart/rebuild test, and P2 driver/decoder regressions.
- P41 storage/codec target: 2 files, 7 tests passed, including record/read/list
  fail-closed behavior while 0041 is absent.
- `tests/p2-driver.test.ts`: 6/6 passed with no 0041 table, confirming ordinary
  execution no longer probes an unregistered P41 table.
- Stopped DecisionEpisode with a mismatching submitted binding and P41
  readiness=false leaves the Execution Active, settles nothing, escalates the
  Execution, and performs zero P41 fact reads/writes; this direct negative
  regression passed as part of the P41 stop-source suite.
- `pnpm typecheck` — passed.
- `pnpm build` — passed.
- Biome on the P41 integration TS/TSX delta (32 files) — passed.
- `CURRENT_MIGRATIONS = P38_MIGRATIONS`; P41 0041 is not registered or run
  against any existing database.

No full `pnpm check`, functional process suite, daemon, deployment, live
environment, or preserved-database migration was run. The included P41 restart
qualification uses a temporary SQLite fixture and directly installs the
standalone equivalent schema only inside that disposable test database.
