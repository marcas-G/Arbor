# P39 release-base integration result

## Scope

Integrated the accepted P39 V1 RecoveryBinding and DeniedUnbound behavior onto
the release code spine. The work preserves release P38, CAPA, and the release
maintenance boundary. P39 remains a separately invoked maintenance descriptor;
`CURRENT_MIGRATIONS` and `CURRENT_MIGRATION_BASELINE` remain P38. No migration
was run against a user or preserved database, and no migration was registered
as current. No deployment, daemon, or live-environment action was performed.

The integration repairs a runtime-only `RecoveryBindingV1` brand failure,
preserves required `executionFence` pass-through when optional P39 identities
are supplied, and strengthens the target SQLite/runtime tests. The atomicity
test uses a temporary file-backed SQLite database with an independent observer
connection. It verifies receipt/binding/attempt-zero/Bound commit, same-ID
replay without duplicate writes, and transaction rollback at the exercised
claim write boundaries. It also verifies that the current migration baseline
remains P38.

## Verification

- P39 targeted suite: 8 files, 53 passed, 4 skipped. The only skipped cases
  require Windows `Get-Acl`; this shell lacks `Microsoft.PowerShell.Security`
  and `Get-Acl`, so those deployment-qualification cases cannot execute here.
- SQLite claim atomicity: 1 file, 2 passed, using only a disposable temporary
  database and a second observer connection.
- Minimal TypeScript project build: `pnpm exec tsc -b
  apps/single-workspace/tsconfig.json packages/api-contracts/tsconfig.json` —
  passed.
- Biome on the 13 changed/new TypeScript files — passed.

The ACL-dependent cases were excluded by test name only; no SQLite claim,
replay, rollback, RecoveryBinding, or runtime test was skipped.
