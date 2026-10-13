# Schema-42 Slow Test Timeout Repair

Date: 2026-10-14

## Changes

- Reused suite-level trusted schema-42 templates and per-case database clones
  for the P39 reconciliation store, P4 DeniedUnbound, P41 reopen, P43 Inbox,
  and P5 yield/wake cases.
- Reused real schema-39 templates for P39 claim atomicity and P39 reality-proof
  tests. The P39 reality-proof qualification remains on schema 39 because
  applying P40 changes the constraint exercised by its ExpectedFailure case.
- Added bounded setup and case timeouts, including a 300-second bound for the
  cumulative P39–P42 migration qualification. P5 now scopes the SQLite layer
  before its idempotent fixture cleanup.
- No production code, design documents, or assertions changed.

## Verification

- `pnpm typecheck` — PASS.
- Biome on the eight changed test files — PASS.
- `git diff --check` — PASS.
- Adapter batch: 6 files passed, 34 tests passed. The P39 reality-proof file
  initially had one failure because a temporary edit ran its P39-only
  constraint case on schema 42. After restoring the real schema-39 fixture,
  that exact case passed (1 passed, 18 filtered out). The complete P39
  reality-proof file was not rerun after that fixture correction.
- P5 yield/wake file — PASS, 1 test, 51.25 seconds. An earlier P5 attempt was
  interrupted when the shared test slot was needed; its test-owned fixture
  directories and process were confirmed cleaned up before the successful run.

The adapter batch took 507.85 seconds overall, including the P39 reality-proof
file. The final targeted P39 case took 29.46 seconds including template setup.
