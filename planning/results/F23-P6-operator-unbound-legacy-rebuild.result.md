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
- Full P6 operator matrix after the review fixes:
  `pnpm exec vitest run apps/single-workspace/test/p6-inbox-rebuild.test.ts
  --maxWorkers=1 --no-file-parallelism --retry=0`: PASS, 1 file / 6 tests,
  1032.68 seconds on the final code. Covers P39 report-sidecar `-journal`
  manifest alias refusal, protected empty application DB/WAL/hard-link
  identity refusal, target-equals-protected-application positive case, and
  primary/writer-lock artifact collisions. Created-only target-digest and
  full descriptor-prefix drift refuse without writes. Process crashes after
  P39 report initialization COMMIT but before its first identity readback, and
  after writer-lock DB initialization but before MaintenanceExclusive acquire,
  both leave the primary/manifest untouched and retry successfully. Prepared
  remains durably appended before the rebuild transaction as specified by the
  accepted proposal. A real two-manifest route-move interleaving proves the
  second operation moves once; the first operation's resume runs the helper
  against current state, records `noOp=1`/`moved=0`, and preserves revision and
  `updated_at` instead of attributing the other manifest's move. Schema
  47/49/pseudo-48, rollback, input/manifest tamper and permit competition also
  pass.
- Schema-upgrade operator regressions:
  `pnpm exec vitest run apps/single-workspace/test/schema-upgrade-operator.test.ts
  --maxWorkers=1 --no-file-parallelism --retry=0 -t
  "upgrades an exact disposable schema(44|47) copy|rejects hard-link identities"`:
  PASS, 3 tests; 11 unrelated tests skipped. This exercises full-prefix v48
  descriptor recording through both migration paths and path-identity checks.
- Historical dedicated sidecar crash/retry subset (before the latest
  writer-lock seam; the final integrated P6 matrix above includes both crash
  seams):
  `ARBOR_P6_SIDECAR_CRASH_ONLY=1 pnpm exec vitest run
  apps/single-workspace/test/p6-inbox-rebuild.test.ts --maxWorkers=1
  --no-file-parallelism --retry=0`: PASS, 1 file / 5 tests, 120.89 seconds.
  The independent CLI crash cases cover P39 sidecar creation,
  initialization-transaction, pre-commit and post-initialization boundaries;
  each checks primary DB and manifest remain untouched, verifies expected
  empty/pristine/initialized sidecar state, then retries the same paths and
  requires Created/Prepared/Committed. The previously observed retry failure
  did not reproduce under this serialized run.
- Read-surface scope: the P6 integration test calls the production
  `viewQueryFaceWithRetryAvailability` module and repository directly, proving
  module-level current-Parent authorization, foreign-human/Agent denial, and
  read-not-consume state. This is not an HTTP/public-route/daemon qualification.
- P39 Windows security/timeout test after these changes: PASS, 7/7. The P45
  migration/security targeted group had previously passed 11/11. Existing ACL
  checks remain enabled; no production ACL is bypassed.
- P10 retry availability targeted tests: PASS, 3/3, including current direct
  Parent visibility, foreign human and Agent denial, repeated read without
  consumption, and stable persisted state.
- Sidecar / P39 permit competition: a prior isolated run passed 1/1.
- Main-candidate `pnpm check` and schema-upgrade evidence are inherited from
  the parent candidate and are not claimed as this worktree's final gates.

## Remaining qualification boundary

P39 Windows security/timeout remains PASS 7/7, the earlier P45 migration
targeted group was PASS 11/11, and P10 retry availability module tests remain
PASS 3/3. The full suite and the entire schema-upgrade operator file were not
run in this worktree; the three filtered schema-upgrade regressions above are
the only schema-upgrade operator tests claimed. An earlier combined P6 attempt reached Vitest's original 360-second test
timeout; progress inspection showed the test was still advancing through
subprocess cases. The test deadline was raised to 1200 seconds and
`runOperatorCli` now has a per-child deadline with PID, elapsed time, stdout/
stderr diagnostics, and repeats Windows `taskkill /T /F` until taskkill
succeeds, the direct child exits, and the PID is confirmed absent before
rejecting. The subsequent complete run passed without reducing assertions.

Two disposable fixture directories and one interrupted schema-upgrade
temporary directory remain on disk because cleanup was blocked by the command
policy; they are untracked and excluded from the commit. Process inspection
found no related live test process. No temporary database is an online or
preserved database.

No HTTP/public-route/daemon read-surface qualification or phase closure is
claimed. The implementation remains subject to independent review.
