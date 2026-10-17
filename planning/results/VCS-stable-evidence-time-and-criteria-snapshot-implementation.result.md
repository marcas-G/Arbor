# VCS Stable Evidence Time and Criteria Snapshot — Implementation Result

Status: **implementation checkpoint committed; independent review pending**

Implementation plan: `planning/proposals/VCS-stable-evidence-time-and-criteria-snapshot-implementation-plan.md`

Plan raw SHA-256: `BC6BF6C6CD34FFFA1B4DAD707E8EBC388A002E7C9CF19D1E07969CAD5FFB291F`

Authorization: `AUTHORIZE_VCS_STABLE_EVIDENCE_TIME_AND_CRITERIA_SNAPSHOT_IMPLEMENTATION`

Code checkpoint: `8b39ce6e` (`feat: snapshot verification evidence criteria at schema 46`).

## Implemented

- Added offline migration 0046 (`requiresUserVersion: 45`), its pinned descriptor, and runtime schema target 46. Open verification rows are read-only preflighted against the exact strict mission snapshot, verification/work/revision identity, and associated `VerificationStarted` event before DDL. Existing concluded rows become `UnavailableLegacy`; no historical criteria are inferred. The migration adds snapshot status/criteria columns and insert/update row-shape guards.
- Verification persistence and commands now preserve complete ordered criteria snapshots and the four authorized status shapes. Ordinary conclusions write v2 row/event/result snapshots; strict v1 decoding remains supported. G5 orphan conclusions use `Unknown`, `Orphaned`, `NotApplicableOrphaned`, and `[]` while keeping the outer RetryVerification receipt v1.
- Evidence `recordedAt` is bound to the persisted first-intent ActionIntent timestamp after strict step/action identity checks. Receipt-first replay validates the exact canonical evidence or row/event binding before returning prior receipts; missing or conflicting facts fail closed.
- Extended offline schema-upgrade support and disposable schema-45 fixtures through 46; runtime boundary fixtures now use target 46. No `docs/design/**`, preserved/live database, deployment, or release artifacts were changed.

## Focused verification

- `pnpm typecheck` — PASS.
- `pnpm exec biome check .` — PASS (1,203 files).
- `git diff --check` — PASS.
- `pnpm exec vitest run --config vitest.config.ts adapters/persistence-sqlite/test/p46-verification-evidence-snapshot-migration.test.ts tests/p8-conclude.test.ts tests/p8-acceptance.test.ts tests/p8-domain.test.ts packages/application/test/p1-gateway.test.ts packages/application/test/retry-verification-replay-binding.test.ts --reporter=dot` — PASS (5 files, 37 tests).
- `pnpm exec vitest run --config vitest.config.ts adapters/persistence-sqlite/test/p39-42-cumulative-prefix-qualification.test.ts -t "rolls back/restarts each exact descriptor" --reporter=dot` — PASS (1 selected test; 1 sibling skipped).
- `pnpm exec vitest run --config vitest.config.ts apps/single-workspace/test/schema-upgrade-operator.test.ts -t "exact disposable schema45 copy through offline migration 0046" --reporter=verbose` — PASS (1 selected test; 11 skipped), exact disposable 45→46 copy, source immutability, FK/shape guards, and final manifest record.
- `pnpm exec vitest run --config vitest.pending-functional.config.ts tests/functional/pending/ah10-verification-recorded-at-fingerprint.functional.test.ts tests/functional/pending/p8-conclusion-criteria-snapshot.functional.test.ts --reporter=dot` — PASS (2/2 original pending RED reproductions).
- `pnpm exec vitest run --config vitest.pending-functional.config.ts tests/functional/pending/f23-exact-tuple-receipt-integrity.functional.test.ts --reporter=dot` — PASS (9/9 public-process replay cases, including G5 receipt replay).

The first combined P39/runtime/replay run reported 47 passing tests and one failure because the historical P39 cumulative-prefix helper still hard-coded `CURRENT_MIGRATIONS.at(-1) === 45`. The helper now asserts the registered target 46 while preserving the historical schema-45 suffix list; its descriptor rollback/restart qualification was rerun and passed. The initial CLI attempt also failed in the P39 manifest-validation phase; after tracing the 45→46 path, the focused exact disposable schema-45 CLI case passed. These were implementation/test-fixture expectation corrections, not relaxed prefix or signature checks.

## Gates not run

- Full `pnpm check`, full core test suite, full `pnpm test:functional`, and release validation were not run, per the scoped execution direction and resource constraints. No broad gate or release readiness is claimed.
- No real-provider, preserved database, online migration, deployment, or publication qualification was run.

## Temporary artifacts and disposition

Schema-upgrade qualification used disposable directories and removes them in fixture cleanup. The Web build output used to enable isolated public-process tests is ignored/generated and is not part of the commit. No temporary Vitest config was retained. The code checkpoint is `8b39ce6e`; this result record is committed separately and pins that checkpoint.
