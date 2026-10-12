# P38 cumulative history upgrade fixture

**Status: PASS — disposable cumulative 0037→0038 schema upgrade, approval
identity preservation, FK integrity, and migration re-entry.** This is focused
adapter evidence; it does not qualify P38 runtime journeys or authorize any
preserved database migration.

## Baseline and test source

- v19 baseline: `ed5fba00ee60e169cadf0df12395179862abd1e8`
- Initial fixture: `55712ddcb035ca603fd431cf0d81b2f5c7b4256f`
- Schema/source assertions: `6dd6f90f28d21e8ee72e6c50aab17bfed07d29ec`
- Redacted observation logging: `cf47d1f471c30bb2d8abdb1849121abd0deb3456`
- P38 migration descriptor module Git blob: `9cda42d7fe824498a640b8b751bb7b9671db672d`
- Cumulative migration registry Git blob: `9c9ec1c96dba4c7a89cd52275707b0405a5a3866`
- Test: `adapters/persistence-sqlite/test/p38-cumulative-history-upgrade.test.ts`
- No migration source or `docs/design/**` file was modified.

## Qualification run

`pnpm install --frozen-lockfile` succeeded with zero downloaded packages.
`pnpm build` and `pnpm typecheck` passed before the first run. The final
observation-logging-only test amendment was followed by another `pnpm build`
pass and targeted Biome check.
After that test-source amendment, `pnpm typecheck` also passed; no test was
repeated.

The enhanced fixture was run once with no retries:

```text
pnpm exec vitest run --retry=0 --maxWorkers=1 --no-file-parallelism adapters/persistence-sqlite/test/p38-cumulative-history-upgrade.test.ts
```

Result: **1 file / 1 test PASS**, 3.50 seconds, on test commit
`cf47d1f471c30bb2d8abdb1849121abd0deb3456`. Raw runner output:
`planning/results/P38-cumulative-history-upgrade-enhanced.raw.txt`.

The assertions establish:

- the real `P37_MIGRATIONS` prefix ends at and leaves `PRAGMA user_version = 37`;
- the generated 0037 `action_approvals` table lacks
  `cancelled_at`, `cancelled_by`, and `cancellation_reason`;
- descriptor 0038 reads the historical `action_approvals` table, applies once,
  and advances to version 38;
- the new table contains the three cancellation columns and preserves the
  seeded historical Control and Executable approval IDs, states, revisions,
  source states, and consumption binding;
- the 0033 `assign_work_target_bindings` composite FK still targets
  `action_approvals(approval_id, project_id)`; `foreign_key_check` is empty and
  foreign-key enforcement is restored;
- all four expected 0038 indexes exist; a second run applies zero migrations.

The 0037 source schema is generated from migrations 0001–0037, then seeded with
two disposable rows. Its 25 approval columns are the P32 definition (through
`source_state`); there are no cancellation columns. Migration 0038 has
cancellation columns in its destination-column list but selects three literal
`NULL`s for these new historical fields before selecting from the old table.
That mapping is compatible with the real old schema. My earlier static
`no such column` suspicion was incorrect: it confused destination columns with
source expressions, and is withdrawn.

The test emits a redacted observation line with versions, schema column names,
descriptor SQL hash, migration counts, FK metadata, and index names. Vitest
suppresses `console.info` for passing tests, so the preserved raw log contains
only the runner summary; the exact values above are established by assertions,
not printed as a raw observation. No persistent SQLite file was created: the
fixture uses `:memory:`. The old row payloads were not emitted.

## Safety boundaries

- The preserved dogfood database was not accessed.
- No daemon, browser, full suite, or additional migration test was run in this
  qualification window.
- P9 AH14 legacy adoption remains separately partial: evidence-insufficient
  legacy Provider success still lacks the accepted AH14-DG-01 Attention
  contract. This migration test does not claim that case is safely adoptable.
- Candidate migrations 0039–0041 are not part of this qualified prefix.
