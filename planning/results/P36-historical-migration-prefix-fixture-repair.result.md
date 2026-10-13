# P36 historical migration-prefix fixture repair

Date: 2026-10-14

## Scope

Corrected the P4 adapter tests to use the complete `P36_MIGRATIONS` prefix
through P35 before applying migration 36. The AH7-DG-03 legacy approval cases
now insert their old approval at P31 and then run the real P32–P36 suffix, so
the migration converts the row into the unified `action_approvals` ledger.
Assertions now reflect that migrated history is retained but is not consumed
through the legacy P4 API. The verifier-binding race uses valid project,
workspace, work, verification, and execution parent rows.

The DDL tests now inspect the P36 `action_approvals` table and seed real parent
rows for `tool_invocations`; the malformed-settlement case now actually
violates the settled-at/settlement-kind check. Approval, artifact, and fence
tests also use `P36_MIGRATIONS`. No P39 migration was added to a generic runner,
and foreign-key enforcement was left enabled.

## Verification

- Target-file Biome check: PASS (5 files).
- `pnpm typecheck`: PASS (`tsc -b` and `tsc -p tsconfig.test.json`).
- Targeted Vitest, single worker and no file parallelism: PASS (5 files,
  14 tests).
- `git diff --check`: pending final commit preparation.

The full repository check was not rerun as part of this focused repair.
