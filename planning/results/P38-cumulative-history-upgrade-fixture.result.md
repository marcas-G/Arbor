# P38 cumulative history upgrade fixture checkpoint

**Status:** The initial positive fixture run passed; its migration-source oracle
is being strengthened before this is treated as qualification evidence.

## Baseline and source

- v19 baseline: `ed5fba00ee60e169cadf0df12395179862abd1e8`
- Initial test-only fixture commit: `55712ddcb035ca603fd431cf0d81b2f5c7b4256f`
- Fixture: `adapters/persistence-sqlite/test/p38-cumulative-history-upgrade.test.ts`
- No migration source or `docs/design/**` file was modified.

## Initial run

The isolated disposable SQLite fixture applied `P37_MIGRATIONS`, inserted a
legacy Expired Control approval and a legacy Consumed Executable approval, and
ran `P38_MIGRATIONS` once. The test asserted a single migration was applied,
user_version 38, approval identity/state preservation, the 0033 composite FK
metadata, an empty `foreign_key_check`, restored FK enforcement, the P38 index
set, and a no-op second application.

```text
pnpm exec vitest run --retry=0 --maxWorkers=1 --no-file-parallelism adapters/persistence-sqlite/test/p38-cumulative-history-upgrade.test.ts
```

Result: **1 file / 1 test PASS**, 2.16 seconds. Raw Vitest output is preserved at
`planning/results/P38-cumulative-history-upgrade.raw.txt`.

Preparation also passed `pnpm build` and `pnpm typecheck` on this worktree.
Dependency installation used the frozen lockfile and downloaded zero packages.

## Qualification limit and follow-up

The PASS conflicts with the earlier static expectation that P38's source
`SELECT` refers to cancellation columns absent from the 0037 schema. The initial
fixture did not snapshot the source table's columns and migration high-water
before applying 0038. A follow-up test-only change now asserts the exact 0037
version and column set, the P38 descriptor identity/source table, and the
post-0038 target columns. That follow-up has **not been run** and is not covered
by the PASS above. Do not claim a proven RED or P38 migration qualification
until the discrepancy has been resolved with that oracle.

The preserved dogfood database was not read or modified. No daemon, browser,
full-suite, or other migration test was run in this checkpoint.
