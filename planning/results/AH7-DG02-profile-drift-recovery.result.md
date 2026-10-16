# AH7-DG-02 trusted profile drift recovery qualification

Date: 2026-10-17
Baseline: `94149611`
Authorization: `AUTHORIZE_AH7_DG02_RECONCILIATION_RUNTIME_AND_SHELL_V3_IMPLEMENTATION`
Scope: P4 recovery classification plus test-only process child/configuration
and qualification. No production profile registration, schema, migration, or
design document changes.

## Implemented cases

The AH7 Reconcilable process fixture now supports restart-time mutation of the
trusted test profile in three independent ways:

- profile version changes while profile hash and effect-key policy remain
  unchanged;
- profile hash changes while profile version and effect-key policy remain
  unchanged;
- effect-key policy changes while profile version and hash remain unchanged.

Each scenario first persists profile A's RecoveryBinding and P39 attempt 0 at
`MayHaveStarted`, then restarts with the modified profile. The process test
asserts fail-closed `OutcomeUnknown` / `ReconciliationPending`, no selected or
rewritten P39 binding, no new attempt, no reconciliation source call, no
executor effect, and no P4 settlement or result. It does not restart with the
original profile in the same fixture: after the mismatch pass the Execution is
unresolved, and an automatic continuation is not part of this qualification.
The existing exact-profile NotOccurred/Occurred/StillUnknown process cases
remain the positive recovery evidence.

P4 now separates persisted-binding integrity from current profile compatibility.
It first verifies canonical RecoveryBinding bytes/hash, P3 identity, recorded
regions digest, and agreement between the binding and latest admitted P39
attempt. Only after those checks, a current registry version/hash/effect-key
mismatch returns `OutcomeUnknown` before reconciliation or execution. Corrupt
binding/P3 identity/regions evidence remains a typed operational failure for
the existing Attention route. Unit cases assert both classifications.

## Verification

- Changed-file Biome check — PASS.
- `pnpm typecheck` — PASS.
- `pnpm exec vitest run packages/tool-runtime/test/p4-pipeline.test.ts packages/ports/test/tool-reconciliation-profile-registry.test.ts --maxWorkers=1 --no-file-parallelism --retry=0` — PASS, 2 files / 62 tests.
- `git diff --check` — PASS.

### Real daemon profile-drift qualification — PASS

`pnpm build` and `pnpm --filter @arbor/web build` both passed. The three cases
ran serially with `--maxWorkers=1 --no-file-parallelism --retry=0`:

```powershell
pnpm exec vitest run --config vitest.functional.config.ts tests/functional/process/agent-action-ah7-reconcilable.functional.test.ts -t "fails closed on trusted profile" --maxWorkers=1 --no-file-parallelism --retry=0 --reporter=verbose
```

Result: 1 file passed; version drift 45.515s, hash drift 44.780s, effect-key
drift 44.711s; 3 passed / 18 skipped. Each mismatch restart remained
`OutcomeUnknown` / `ReconciliationPending`, retained the original binding and
attempt 0, wrote no P39 fact, made zero reconciliation-source calls, produced
no external effect, and left P4 unsettled.

This closes only the scoped profile-version/hash/effect-key drift qualification.
It does not close AH7 or claim release readiness.
