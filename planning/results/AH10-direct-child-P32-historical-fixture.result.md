# AH10 direct-child P32 historical fixture qualification

Date: 2026-10-16

The `legacy-p32-upgrade` direct-child AssignWork case now constructs its
historical source through the explicit schema-42 test builder. The current
schema-44 runtime snapshot seeds a disposable P38 image using common columns;
the builder then runs the real P39 maintenance and fixed P40/P41/P42 descriptor
suffix, and verifies the source is actually `user_version=42`. It verifies the
exact committed AssignWork receipt and binding row before `createP32HistoricalTestImage`
copies the real v42 source into a P32 migration-prefix target.

The P32 copy is checked at `user_version=32`, retains the exact committed
receipt, has no `assign_work_target_bindings` table, and matches a pristine P32
schema snapshot. The functional case then uses `upgradeSchema44TestDatabase`
and asserts the resulting current runtime copy is `user_version=44`, retains
the committed receipt, and contains no fabricated binding row.

The schema-44→P38 seeding helper uses strict `INSERT` for every ordinary table.
The one migration-created `p10_attention_dispatch_state` row is handled by an
exact `singleton=1` UPDATE only, after asserting source and target both have
exactly that key. The support unit test proves another duplicate primary key
aborts and rolls back the singleton update; removing that duplicate permits the
exact copy.

## Verification

- `adapters/persistence-sqlite/test/schema42-database-fixture.test.ts` — **5/5 passed**.
- Direct-child legacy-P32 process case:
  `pnpm exec vitest run --config vitest.functional.config.ts --maxWorkers=1 --no-file-parallelism --retry=0 tests/functional/process/agent-loop-ah10-direct-child-assign-work-receipt-binding.functional.test.ts -t "legacy-p32-upgrade its command boundary"` — **1 passed / 14 skipped**.
- `pnpm typecheck` — **PASS**.
- Biome on the changed support, unit, and functional test files — **PASS**.
- `git diff --check` — **PASS**.

No full functional suite was run. Production runtime and frozen design files
were not changed.
