# VCS Stable Evidence Time and Criteria Snapshot — Implementation Result

Status: **implementation and B1 review corrections committed; follow-up review pending**

Implementation plan: `planning/proposals/VCS-stable-evidence-time-and-criteria-snapshot-implementation-plan.md`

Plan raw SHA-256: `BC6BF6C6CD34FFFA1B4DAD707E8EBC388A002E7C9CF19D1E07969CAD5FFB291F`

Authorization: `AUTHORIZE_VCS_STABLE_EVIDENCE_TIME_AND_CRITERIA_SNAPSHOT_IMPLEMENTATION`

Code checkpoint: `8b39ce6e` (`feat: snapshot verification evidence criteria at schema 46`).

B1 review-correction checkpoint: `8b882958115b6823b2c009df49c32aaca9509811`.

## Implemented

- Added offline migration 0046 (`requiresUserVersion: 45`), its pinned descriptor, and runtime schema target 46. Open verification rows are read-only preflighted against the exact strict mission snapshot, verification/work/revision identity, and associated `VerificationStarted` event before DDL. Existing concluded rows become `UnavailableLegacy`; no historical criteria are inferred. The migration adds snapshot status/criteria columns and insert/update row-shape guards.
- Verification persistence and commands now preserve complete ordered criteria snapshots and the four authorized status shapes. Ordinary conclusions write v2 row/event/result snapshots; strict v1 decoding remains supported. G5 orphan conclusions use `Unknown`, `Orphaned`, `NotApplicableOrphaned`, and `[]` while keeping the outer RetryVerification receipt v1.
- Evidence `recordedAt` is bound to the persisted first-intent ActionIntent timestamp after strict step/action identity checks. Receipt-first replay validates the exact canonical evidence or row/event binding before returning prior receipts; missing or conflicting facts fail closed.
- Extended offline schema-upgrade support and disposable schema-45 fixtures through 46; runtime boundary fixtures now use target 46. No `docs/design/**`, preserved/live database, deployment, or release artifacts were changed.

## Focused verification

- `pnpm typecheck` — PASS.
- `pnpm exec biome check .` — PASS (1,203 files).
- `git diff --check` — PASS.
- `pnpm exec vitest run --config vitest.config.ts adapters/persistence-sqlite/test/p46-verification-evidence-snapshot-migration.test.ts tests/p8-conclude.test.ts tests/p8-acceptance.test.ts tests/p8-domain.test.ts packages/application/test/p1-gateway.test.ts packages/application/test/retry-verification-replay-binding.test.ts --reporter=verbose` — PASS (6 files, 60 tests; rerun after B1 status-guard and domain API corrections).
- `pnpm exec vitest run --config vitest.config.ts adapters/persistence-sqlite/test/p39-42-cumulative-prefix-qualification.test.ts -t "rolls back/restarts each exact descriptor" --reporter=dot` — PASS (1 selected test; 1 sibling skipped).
- `pnpm exec vitest run --config vitest.config.ts apps/single-workspace/test/schema-upgrade-operator.test.ts -t "exact disposable schema45 copy through offline migration 0046" --reporter=verbose` — PASS (1 selected test; 11 skipped), exact disposable 45→46 copy, source immutability, FK/shape guards, and final manifest record.
- `pnpm exec vitest run --config vitest.pending-functional.config.ts tests/functional/pending/ah10-verification-recorded-at-fingerprint.functional.test.ts tests/functional/pending/p8-conclusion-criteria-snapshot.functional.test.ts --reporter=dot` — PASS (2/2 original pending RED reproductions).
- `pnpm exec vitest run --config vitest.pending-functional.config.ts tests/functional/pending/f23-exact-tuple-receipt-integrity.functional.test.ts --reporter=dot` — PASS (9/9 public-process replay cases, including G5 receipt replay).

### B1 independent-review corrections

- Current-schema assertions and registries now target 46 in `tests/architecture/mac-p4-convergence.test.ts`, `adapters/persistence-sqlite/test/p39-claim-atomicity.test.ts`, and the AH7 runtime fixture. Actual 45-prefix assertions remain where they qualify the v45 boundary/source, including the schema-45→46 disposable-copy test and the migration-45 interruption boundary.
- Schema-upgrade concurrent recovery now truncates at `Prepared 0046`, the actual final-schema commit boundary, and proves two competing resumes leave user_version 46 with exactly one `Committed 0046` record. Recovery from Prepared/Committed 0045 remains separately qualified.
- `concludeVerification` no longer defaults to nullable criteria results; callers must pass an explicit criteria-result array and explicit conclusion reason/undefined. The domain unit test proves an ordinary conclusion stores its supplied snapshot as `Available`. The P8 application handler retains the complete mission/order/evidence/aggregation checks.
- Added the missing SQL rejection case for `Available` + `Orphaned`.
- `pnpm exec vitest run --config vitest.architecture.config.ts tests/architecture/mac-p4-convergence.test.ts --reporter=dot` — PASS (1 file, 3 tests).
- `pnpm exec vitest run --config vitest.config.ts adapters/persistence-sqlite/test/p39-claim-atomicity.test.ts adapters/persistence-sqlite/test/p46-verification-evidence-snapshot-migration.test.ts packages/domain/test/verification.test.ts packages/domain/test/work.test.ts packages/domain/test/invariants.test.ts tests/p8-domain.test.ts tests/p8-ddl.test.ts --reporter=dot` — PASS (7 files, 41 tests).
- `pnpm exec vitest run --config vitest.config.ts tests/p11-staleness.test.ts tests/p11-acceptance.test.ts --reporter=dot` — PASS (2 files, 14 tests).
- `pnpm exec vitest run --config vitest.config.ts apps/single-workspace/test/schema-upgrade-operator.test.ts -t "serializes two competing CLI resume processes through final schema 46|exact disposable schema45 copy through offline migration 0046" --reporter=dot` — PASS (2 selected tests, 10 skipped).
- `pnpm exec vitest run --config vitest.pending-functional.config.ts tests/functional/pending/f23-retry-verification-permanent-replay.functional.test.ts --reporter=dot` — PASS (1/1).
- `pnpm exec vitest run --config vitest.functional.config.ts tests/functional/process/agent-action-ah7-pending-intent.functional.test.ts -t "replays the committed P40 ExpectedFailure observation after process crash" --reporter=dot` — PASS (1 selected test, 7 skipped).

The first combined P39/runtime/replay run reported 47 passing tests and one failure because the historical P39 cumulative-prefix helper still hard-coded `CURRENT_MIGRATIONS.at(-1) === 45`. The helper now asserts the registered target 46 while preserving the historical schema-45 suffix list; its descriptor rollback/restart qualification was rerun and passed. The initial CLI attempt also failed in the P39 manifest-validation phase; after tracing the 45→46 path, the focused exact disposable schema-45 CLI case passed. The first B1 concurrency-test rerun deliberately truncated at Prepared 0045 after the database had reached 46; recovery correctly rejected that inconsistent manifest/database pair. The test now races recovery at Prepared 0046 and passes. These were implementation/test-fixture expectation corrections, not relaxed prefix or signature checks.

## Gates not run

- Full `pnpm check`, full core test suite, full `pnpm test:functional`, and release validation were not run, per the scoped execution direction and resource constraints. No broad gate or release readiness is claimed.
- No real-provider, preserved database, online migration, deployment, or publication qualification was run.

## Temporary artifacts and disposition

Schema-upgrade qualification used disposable directories and removes them in fixture cleanup. The Web build output used to enable isolated public-process tests is ignored/generated and is not part of the commit. No temporary Vitest config was retained. The code checkpoint is `8b39ce6e` with B1 corrections in `8b882958115b6823b2c009df49c32aaca9509811`; this result record pins both.
