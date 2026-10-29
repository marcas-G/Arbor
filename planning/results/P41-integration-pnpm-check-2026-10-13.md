# P41 integration full `pnpm check` run record

- Worktree: `C:\Users\ThinkPad\.codex\worktrees\full-code-convergence-release\Arbor`
- Tested HEAD: `9ac5f4644281fee40ad8f523500396f90ca2a51c`
- Command: `pnpm check`
- Exit: 1 (stopped at root Vitest; subsequent Web gates did not run)
- Biome: `Checked 1134 files in 6s. No fixes applied.`
- TypeScript: `tsc -b && tsc -p tsconfig.test.json` passed.
- Architecture: 31 files / 159 tests passed.
- Root Vitest: 391 files; 337 passed, 54 failed. Test totals: 1,987 passed,
  157 failed, 13 skipped (2,157 total); duration 437.80s.
- Not run after Vitest failure: Web typecheck, Web build, Web tests. No
  `test:functional`, deployment, or user/preserved-database migration ran.

## Failure groups observed

1. Windows P39 filesystem qualification: child PowerShell processes could not
   load `Microsoft.PowerShell.Security` / `Get-Acl` because this `pnpm check`
   invocation did not set the system Windows PowerShell module path. Failures
   report `P39_UNSUPPORTED_DEPLOYMENT` / `P39_WRITER_LOCK_UNSUPPORTED_DEPLOYMENT`.
   Affected examples include P39 migration qualification, P38 startup boundary,
   F21 CreateProject admission, P7 wake, and production-composition journeys.
2. F21 legacy test fixtures: multiple P1/P6/P7/P10/P12 tests create projects
   without the test-only `resource_source_json` column or valid source value;
   representative diagnostics are “table projects has no column named
   resource_source_json” and `ProjectRepository/decodeResourceSource`.
3. P41 service wiring in older P2/P3/P6/P9 tests: multiple legacy test layers
   do not provide `RecoveryAttentionFactStore`, although ordinary execution
   should not require P41 schema/service. Examples include P3 driver, P6
   acceptance, P2 settle/stop/recovery, and P9 worker-crash tests.
4. P40/P4 approval reentry: `p4-ah7-approval-consumption-reentry` and
   `p4-approval-reentry` contain two failures around unexpected denial and
   missing replayed approval ID.
5. Event catalog: `packages/domain/test/events.test.ts` expects the wrong event
   set after the accepted P41 `SubmittedDecisionBindingEscalated` event was
   added (the P6 blocker events are already in its expected set).

This file is a durable run summary with representative raw diagnostics, not a
byte-for-byte capture of the entire stdout. Complete tool output remains in the
task transcript; no complete raw logfile was persisted by the command runner.
