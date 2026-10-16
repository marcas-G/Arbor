# AH7-DG-02 historical profile-less shell@2 recovery checkpoint

Date: 2026-10-17  
Baseline: `280b8be07d633c800f6b320b2cb2e0dad3829673`

## Scope and outcome

This checkpoint covers the accepted AH7-DG-02 plan §2.4 legacy recovery case:
an unsettled P4 `shell@2` `Reconcilable` invocation with
`effect_admission_state = MayHaveStarted` and no trusted profile, P39 binding,
or reconciliation fact. The existing P4 recovery branch returns
`OutcomeUnknown` for that shape before effect admission or reconciliation.
Repeated recovery returns the same outcome and does not mutate the legacy row.

No production `shell@2` profile was registered. The test is an in-memory P4
pipeline fixture for the canonical persisted invocation shape; it does not
claim schema44 migration or real-daemon restart qualification. No production
runtime, migration, or design file was changed. The complementary P3 test
confirms `OutcomeUnknown` leaves the action `ReconciliationPending`, not
Applied.

## Evidence

- `pnpm build` — PASS.
- `pnpm exec vitest run packages/tool-runtime/test/p4-pipeline.test.ts -t "historical profile-less shell@2" --maxWorkers=1 --no-file-parallelism --retry=0 --reporter=verbose` — PASS, 1/1 targeted; the other 60 cases were skipped.
- `pnpm exec vitest run tests/p3-driver.test.ts -t "OutcomeUnknown action pending reconciliation" --maxWorkers=1 --no-file-parallelism --retry=0 --reporter=verbose` — PASS, 1/1 targeted; the other 47 cases were skipped.
- `pnpm typecheck` — PASS.
- `pnpm exec biome check packages/tool-runtime/test/p4-pipeline.test.ts` — PASS.

The P4 assertions record zero Executor calls, reconciliation calls, fact writes,
P39 binding calls, effect admissions, intent writes, and no-effect denials.
The original `MayHaveStarted` row remains unsettled, with no result reference;
there is no synthesized fact or result. Two invocations of the same recovery
path return the identical `OutcomeUnknown` receipt.

## Qualification boundary

This is unit/static evidence only. It does not claim a schema44 fixture or a
process crash/restart result. AH7 remains PARTIAL / OPEN pending its other
authorized qualification gaps.
