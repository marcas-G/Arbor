# P41 release-base storage integration result

## Scope and boundary

Ported the accepted P41 0041 physical storage implementation (`83fea00c`)
onto the current integration tree as `9003b049`. Its migration descriptor
remains standalone and absent from `CURRENT_MIGRATIONS` and all runnable
migration lists; `CURRENT_MIGRATIONS` remains P38. No migration was executed
against a user or preserved database. Test-owned equivalent schemas use only
in-memory or temporary SQLite databases.

The storage adapter continues to own only caller-bound persistence, exact
identity idempotence, read/list, and typed fail-closed behavior when the
standalone table is absent. It does not append a business event, create
Attention, decide recovery, or activate P41 behavior. Current P39/P40/F21/P43
code and migration boundaries were preserved.

I added absent-schema checks for record and project-list operations to the
existing fail-closed test; they assert the same `P41MigrationNotRegistered`
error as the absent-table lookup check.

## Verification

- P41 storage + codec target: 2 files, 7/7 tests passed. This covers
  not-null key rejection, positive insertion, idempotence/conflict handling,
  foreign keys, immutability, reopen read/list, and absent-table record/read/
  list behavior.
- `pnpm typecheck` — passed.
- Biome on the 7 P41 storage/codec TypeScript files — passed.
- `git diff --check` — passed.

No P41 behavior implementation, 0041 registration, full `pnpm check`, daemon,
deployment, release, or live-database qualification was performed.
