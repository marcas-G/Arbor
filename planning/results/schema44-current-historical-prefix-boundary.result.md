# Schema 44 current and historical prefix boundary repair

Date: 2026-10-16

Baseline: `9bb18be35e25821379afadf6b7c2979bf56346de`.

The reported max-worker core run had six failures, all caused by tests treating
the newly active schema 44 as schema 42. Current P5/P34/P7 composition smokes
already use the schema-44 fixture; their labels and expected versions now say
44. Historical P39–P42 qualification remains on an explicit schema-42 fixture
and fixed P40/P41/P42 descriptors. The shared
`tests/support/schema-prefix-contract.ts` pins historical suffix `[40, 41, 42]`
and current suffix `[40, 41, 42, 43, 44]`. The cumulative qualification still
proves the P38 prefix, P41 fingerprint, and P42 schema-42 result while
separately asserting P43/P44 current registration and order.

No production migration semantics changed.

## Verification

- Six reported failure files plus P44 migration and schema-44 fixture tests:
  **8 files / 21 tests PASS**.
- Offline schema-upgrade CLI: exact P43/P44 interruption/resume prefix test,
  fresh schema-44 target, and copy/read-only-reopen target: **3 passed, 7
  skipped**.
- `pnpm typecheck` — PASS.
- Biome on all 8 changed TypeScript files — PASS.
- `git diff --check` — PASS.

The full core suite was not rerun. No online or preserved database was opened
or modified.
