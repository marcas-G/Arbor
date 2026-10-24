# S2 P52 Schema-52 Convergence — Independent Review

Date: 2026-10-24  
Reviewed HEAD: `21d71287183e2298391f6b25b6aa50fff02c7779`  
Disposition: **PASS — Blocking = 0** for the requested schema-52 convergence
scope.

## Scope and authority

This is a source/test review plus the focused disposable tests listed below.
It does not claim production migration activation, process/release qualification
for S2, or real-Provider qualification. No current/preserved database was
opened or changed, no real Provider was called, and no `docs/design/**` file was
modified. The P52 migration/operator fixtures use private disposable databases.

S2-RDG-01 is manually accepted and conditionally implementation-authorized
under the acceptance/landing record; the review condition is satisfied by the
recorded independent landing review. The authorization still excludes
existing/preserved database access, migration activation and real-Provider
qualification. See `planning/results/S2-steer-work-revision-acceptance-and-landing.record.md`.

## Findings

- **Current runtime target and P39 ordering converge at 52.** `CURRENT_SCHEMA_VERSION`
  and `CURRENT_MIGRATION_BASELINE` are 52 and `CURRENT_MIGRATIONS` ends with
  P52 (`adapters/persistence-sqlite/src/migrations.ts:2582-2599`). Ordinary
  startup/readiness compare against that shared constant
  (`apps/single-workspace/src/composition.ts:1345-1349`,
  `apps/single-workspace/src/health.ts:63-72`). P39 remains outside the
  ordinary registry. Its maintenance continuation permits a committed prefix
  through 52, only treats exactly 52 as already complete, and performs the
  final closed/read-only no-op check at 52
  (`adapters/persistence-sqlite/src/p39-maintenance-adapter.ts:357-418`).
  `schema-upgrade.ts` routes through `runP40ToP52` while holding the same P39
  maintenance continuation (`apps/single-workspace/src/schema-upgrade.ts:1719-1748,2164-2174`).

- **Offline 51→52, descriptor/source pins, and P52 backfill are aligned.** The
  offline descriptor map includes P52; the validator checks the P52 SQL
  fingerprint and pins the migration source that owns its backfill
  (`apps/single-workspace/src/schema-upgrade.ts:1230-1238,1317-1337`). The
  migration requires user version 51, is `offlineOnly`, and its shared
  `makeLegacyCurrentWorkContractRevision` helper canonicalizes the exact
  current Work row; both the normal migration and offline preview use it
  (`adapters/persistence-sqlite/src/p52-work-contract-revision-migration.ts:14-57,111-124`,
  `apps/single-workspace/src/schema-upgrade.ts:1553-1592`). P52 is applied
  inside the active `withTransaction`, including `onApply` and the
  `user_version` update; the offline path runs `foreign_key_check` after the
  transaction (`adapters/persistence-sqlite/src/migrate.ts:154-185`,
  `apps/single-workspace/src/schema-upgrade.ts:1837-1873`). The final target
  rechecks version 52, current Work/history consistency, foreign keys, P51 F18
  high-water facts, and manifest final provenance
  (`apps/single-workspace/src/schema-upgrade.ts:1915-2020`).

- **Manifest resume, P52 no-op, and schema-52 source copy are covered.** The
  focused offline operator case stops before and after P52 commit, resumes the
  exact prepared `0052` step, reopens/validates the closed target read-only,
  confirms the schema-51 source remains unchanged, checks the P52 backfill,
  reruns as a no-op, and then copies an exact schema-52 source without creating
  prepared migration steps (`apps/single-workspace/test/schema-upgrade-operator.test.ts:1273-1391`).
  `assertSourcePrefix` separately accepts a schema-52 source only with its
  pinned signature and P52 state validation
  (`apps/single-workspace/src/schema-upgrade.ts:613-639`).

- **P52 migration/FK rollback oracle is adequate.** The P52 migration test
  checks the exact predecessor/fingerprint, current-only legacy snapshot,
  idempotent re-run, immutable triggers, `foreign_key_check`, and a failure
  injected after `onApply` has written rows; failure leaves user version 51
  with no table/trigger/backfill (`adapters/persistence-sqlite/test/p52-work-contract-revision-migration.test.ts:102-235`).

- **Runtime/readiness and composition positive controls are 52-aware.** The
  P38 boundary suite refuses 38–51, admits schema 52 with a production-migration
  no-op, refuses 53, and asserts readiness only at 52
  (`apps/single-workspace/test/p38-runtime-schema-boundary.test.ts:107-200,239-325`).
  P5 composition uses the current schema-52 fixture and expects version 52
  (`apps/single-workspace/test/p5-composition.test.ts:20-79`). The MAC-P4
  architecture guard requires schema 52 and P52 at the end of the registry
  (`tests/architecture/mac-p4-convergence.test.ts:44-49,63-70`).

- **Functional bootstrap and AH10 historical projection account for P52.**
  `cloneFunctionalCurrentSchemaDatabase` now applies P51 and P52, then verifies
  user version 52 plus `foreign_key_check`
  (`tests/functional/support/schema44-bootstrap.ts:137-139,229-269`). The AH10
  historical fixture explicitly projects a schema-52 source to frozen schema
  44; it asserts the P52 ledger is present in the source and absent from the
  schema-44 destination, rather than silently copying or fabricating it
  (`tests/functional/process/agent-loop-ah10-direct-child-assign-work-receipt-binding.functional.test.ts:319-368`).
  The recovery branch upgrades the projected image to current schema 52 and
  checks its version before restart/takeover
  (`tests/functional/process/agent-loop-ah10-direct-child-assign-work-receipt-binding.functional.test.ts:2295-2327,2366-2370`).

One non-blocking wording nit remains: the AH10 helper comment at line 320 says
“real current-v51 fixture” although the helper now requires schema 52 and
explicitly validates the P52 ledger. The executable guard/projection and
focused test are schema-52 correct.

## Focused verification

- `pnpm exec vitest run adapters/persistence-sqlite/test/p52-work-contract-revision-migration.test.ts --maxWorkers=1 --retry=0 --bail=0 --reporter=verbose` — **3/3 PASS** (27.99s), including onApply rollback and FK check.
- `pnpm exec vitest run apps/single-workspace/test/schema-upgrade-operator.test.ts --maxWorkers=1 --retry=0 --bail=0 --reporter=verbose -t "upgrades an exact schema-51 source through P52 backfill and accepts schema-52 exact no-op"` — **1/1 PASS** (176.66s); includes schema-52 source copy/no-op.
- `pnpm exec vitest run apps/single-workspace/test/p38-runtime-schema-boundary.test.ts --maxWorkers=1 --retry=0 --bail=0 --reporter=verbose -t "marks readiness only when user_version exactly matches schema 52"` — **1/1 PASS** (9.55s).
- `pnpm exec vitest run apps/single-workspace/test/p38-runtime-schema-boundary.test.ts --maxWorkers=1 --retry=0 --bail=0 --reporter=verbose -t "admits exactly schema 52 and makes the production migration hook a no-op|completes a real --once daemon startup and Web bind from the schema-52 fixture"` — **2/2 PASS** (44.21s).
- `pnpm exec vitest run apps/single-workspace/test/p5-composition.test.ts --maxWorkers=1 --retry=0 --bail=0 --reporter=verbose` — **1/1 PASS** (26.21s).
- `pnpm exec vitest run --config vitest.architecture.config.ts tests/architecture/mac-p4-convergence.test.ts --maxWorkers=1 --retry=0 --bail=0 --reporter=verbose` — **3/3 PASS** (0.58s). The same command without the architecture config was excluded by the default config and found no test files; the configured architecture run above is authoritative.
- `pnpm --filter @arbor/web build` — **PASS**, used only to supply the functional fixture's static Web assets. The first AH10 attempt stopped at fixture readiness (503, `web dist not built`) before the scenario; after the build, the exact `legacy-p32-upgrade` case passed.
- `pnpm exec vitest run --config vitest.functional.config.ts tests/functional/process/agent-loop-ah10-direct-child-assign-work-receipt-binding.functional.test.ts --maxWorkers=1 --retry=0 --bail=0 --reporter=verbose -t "legacy-p32-upgrade"` — **1/1 PASS** (87.88s). No real Provider was called.

No full functional suite, full architecture suite, or real-Provider suite was
run. All test-created P39 fixture roots were cleaned; no matching daemon/test
process remained at review close.
