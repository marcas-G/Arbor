# F23 P6 Operator UnboundLegacy Inbox Rebuild — Implementation Result

Status: **implementation in progress; release/phase closure not claimed**

## Authorization and scope

Implemented against accepted proposal SHA-256
`B6A542973768D1C0D7C8ACB644988D1C957B7020F73206C335D73FF7FE0C833E` and the
landed F23/P6 contracts. This work is limited to the operator-only offline
projection rebuild and its qualification. It does not modify `docs/design/**`,
touch an online or preserved database, deploy, or release.

The new command is `pnpm --filter @arbor/single-workspace p6:inbox-rebuild --
--database <absolute-path> --p39-sidecar <absolute-path> --manifest
<absolute-path> [--resume]`. It requires the exact current schema-48 signature,
uses the P39 MaintenanceExclusive callback and its primary `SqlClient`, adapts
that same client to the existing `TransactionPort`, and calls
`rebuildUnboundLegacyInboxProjections` in one transaction. A logical digest of
canonical facts is checked before and after. The JSONL manifest records
Created/Prepared/Committed in a validated hash chain and supports safe resume
after the SQLite commit but before the Committed record.

## Verification evidence

- P39 persistence adapter build: PASS.
- Single-workspace build (`pnpm --filter @arbor/single-workspace build`): PASS
  after the final implementation edits.
- Test TypeScript (`pnpm exec tsc -p tsconfig.test.json --noEmit`): PASS.
- Targeted Biome check over every changed source/test/result file: PASS (10
  files; no fixes needed after formatting).
- `git diff --check`: PASS.
- Sidecar crash/retry qualification:
  `ARBOR_P6_SIDECAR_CRASH_ONLY=1 pnpm exec vitest run
  apps/single-workspace/test/p6-inbox-rebuild.test.ts --maxWorkers=1
  --no-file-parallelism --retry=0`: PASS, 1 file / 5 tests, 120.89 seconds.
  The independent CLI crash cases cover P39 sidecar creation,
  initialization-transaction, pre-commit and post-initialization boundaries;
  each checks primary DB and manifest remain untouched, verifies expected
  empty/pristine/initialized sidecar state, then retries the same paths and
  requires Created/Prepared/Committed. The previously observed retry failure
  did not reproduce under this serialized run.
- P6 operator module tests, including path/options, exact schema signature,
  manifest-chain parsing, ordinary run/resume, failure rollback, canonical
  digest immutability, invalid schema 47/49/pseudo-48, manifest/input drift,
  and public current-human versus foreign-human/Agent read behavior: a prior
  targeted matrix passed 5/5 before the final sidecar crash additions; it has
  not been rerun as one combined matrix.
- P39 security timeout and P45 migration targeted tests: PASS, 11/11 after the
  Windows ACL probe adjustment. Existing ACL checks remain enabled; no
  production ACL is bypassed.
- P10 retry availability targeted tests: PASS, 3/3, including current direct
  Parent visibility, foreign human and Agent denial, repeated read without
  consumption, and stable persisted state.
- Sidecar / P39 permit competition: a prior isolated run passed 1/1.
- Main-candidate `pnpm check` and schema-upgrade evidence are inherited from
  the parent candidate and are not claimed as this worktree's final gates.

## Remaining qualification boundary

The combined P6 module/process matrix above has not been rerun as one batch
after the final sidecar crash additions; its earlier 5/5 run is recorded as
prior evidence only. P39 security/P45 migration tests remain PASS 11/11, and
P10 retry availability remains PASS 3/3, as recorded above. The full suite and
schema-upgrade operator suite were not run in this worktree. Host resource
pressure produced an earlier child-process OOM; the serialized sidecar test
subsequently passed without reducing assertions.

Two disposable fixture directories and one interrupted schema-upgrade
temporary directory remain on disk because cleanup was blocked by the command
policy; they are untracked and excluded from the commit. Process inspection
found no related live test process. No temporary database is an online or
preserved database.

No phase closure is claimed until the remaining combined qualification gates
pass and the implementation is independently reviewed.
