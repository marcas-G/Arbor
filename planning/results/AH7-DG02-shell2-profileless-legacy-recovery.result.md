# AH7-DG-02 historical profile-less shell@2 recovery checkpoint

Date: 2026-10-17
Baseline: `280b8be07d633c800f6b320b2cb2e0dad3829673`

## Scope and outcome

The initial checkpoint covered the accepted AH7-DG-02 plan §2.4 legacy recovery case:
an unsettled P4 `shell@2` `Reconcilable` invocation with
`effect_admission_state = MayHaveStarted` and no trusted profile, P39 binding,
or reconciliation fact. The existing P4 recovery branch returns
`OutcomeUnknown` for that shape before effect admission or reconciliation.
Repeated recovery returns the same outcome and does not mutate the legacy row.

It is now supplemented by the schema44 SQLite integration qualification below.
No production `shell@2` profile was registered. No migration or design file
was changed.

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

## 2026-10-17 schema44 SQLite integration qualification

Added `tests/p4-schema44-profileless-shell2-recovery.test.ts`. It obtains a
fresh disposable schema44 database from the existing migration-backed fixture
factory, seeds the project/workspace/execution/lease, and uses the actual
SQLite `ToolInvocationStoreLive` to persist the legacy invocation and advance
its P4 effect-admission marker to `MayHaveStarted`. The persisted row is
`LegacyBindingUnproven`, unsettled, and has no result reference; the recovery
binding, effect-attempt, and reconciliation-fact tables contain no row for it.

The SQLite-backed `ToolRuntimeLive` with an empty trusted-profile registry
returns the same `OutcomeUnknown` twice. The second recovery runs through
`executeAgentLoopActions` and the SQLite `AgentLoopStepStoreLive`, which
persists `ReconciliationPending` for the Action and `SettlementProposed` with
`OutcomeUnknown` for the step. P4 remains `MayHaveStarted` and unsettled. The
Executor, reconciliation port, fact writer, and P4 effect-admission probes
remain at zero; there is no synthesized P4 result or effect.

Evidence:

- `pnpm exec vitest run tests/p4-schema44-profileless-shell2-recovery.test.ts --maxWorkers=1 --no-file-parallelism --retry=0 --reporter=verbose` — PASS, 1/1.
- `pnpm typecheck` — PASS.
- `pnpm exec biome check tests/p4-schema44-profileless-shell2-recovery.test.ts` — PASS.

## Qualification boundary

This is schema44 SQLite integration evidence, not a daemon crash/restart
qualification. The disposable fixture is cleaned up by the test factory. AH7
remains PARTIAL / OPEN pending its other authorized qualification gaps.
