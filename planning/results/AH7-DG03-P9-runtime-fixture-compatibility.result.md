# AH7-DG-03 P9 Current-Store Fixture Compatibility

Status: **PASS for the scoped P9 runtime fixture migration assembly; no
production behavior or P9 business oracle changed.**

## Scope and provenance

- Base code SHA: `629b562df4ddd4e7ace10f0b9883cd349ee70d34` (P36 candidate).
- Test-only fix commit: `658678536115d1e2201bbbdd1f0dead5341c16b9`.
- Changed test files:
  - `tests/p9-acceptance.test.ts`
  - `tests/p9-worker-crash.test.ts`
  - `tests/p9-tool-outcome-unknown.test.ts`
- No production code, P36 migration/schema, P9 business assertions, or
  `docs/design/**` changed. No full `pnpm check`, full functional suite, or
  Playwright was run in this follow-up.

## RED diagnosis

Minimal reproduction on the unmodified P36 test tree:

```powershell
pnpm exec vitest run tests/p9-acceptance.test.ts -t "Story C"
```

Result: 1 selected test failed / 10 skipped. The current
`ToolInvocationStore` query could not prepare because the fixture had only run
the P12 migrations:

```text
PersistenceUnavailable(repository=ToolInvocationStore, operation=invocation)
SqlError: Failed to prepare statement
table tool_invocations has no column named effect_admission_state
```

P36 owns the current ToolInvocation effect-admission state used by the P4
adapter. The red therefore identified a test database stopping at a historical
schema baseline before current P4 runtime reads/writes, not a missing P36
production migration or a failure of the P9 lease/crash/OutcomeUnknown
assertions.

## Fixture correction

The tests retain their original historical schema starts and explicitly
upgrade before seeding/running the current P4 store:

| Fixture | Preserved start | Current runtime schema before P9 seed/run |
|---|---|---|
| P9 Story C and Story E | `P12_MIGRATIONS` | then `P36_MIGRATIONS` |
| P9 worker-crash `boot` | `P12_MIGRATIONS` | then `P36_MIGRATIONS` |
| P9 tool-outcome-unknown `boot` | `P8_MIGRATIONS` | then `P36_MIGRATIONS` |

This preserves the old starting points and exercises the forward migration
path rather than replacing the historical baselines with P36. The explicit
P12 durability/version assertion remains based on `P12_MIGRATIONS` (version
13); other P8/P12 migration-oracle tests and the P16 Story D setup were not
changed. P9 lease fencing, crash points, four-tier effect behavior,
OutcomeUnknown handling, and all existing assertions remain intact.

## Verification

- Story C RED above: 1 failed / 10 skipped, exact missing-column prepare error.
- After the fixture migration correction, the same Story C selection: **1/1
  PASS**.
- Targeted three-file run:

  ```powershell
  pnpm exec vitest run tests/p9-acceptance.test.ts tests/p9-worker-crash.test.ts tests/p9-tool-outcome-unknown.test.ts
  ```

  Result: **3 files / 27 tests PASS**.
- `pnpm typecheck`: PASS (`tsc -b && tsc -p tsconfig.test.json`).
- Targeted Biome: 3 files PASS; `git diff --check`: PASS.

The migration adjustment is test-fixture assembly only. This result does not
claim a full P36 gate or functional release qualification.
