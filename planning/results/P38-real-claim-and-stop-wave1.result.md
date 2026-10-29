# P38 real claim and Stop qualification — Wave 1

Status: **PASS for Wave 1 claim and Stop qualification; P38 remains open.**

- Baseline: `8fb07a4aed4dbae77a6267e861ff8d4c39d2bc9c`.
- Scope: same-Step real-daemon P38/P4/P39 claim transaction before/after
  commit, and public Stop before/after approval resolution. No design files or
  migration descriptors changed.
- The historical pending unit fixture
  `tests/functional/pending/p38-stop-cancellation.functional.test.ts` remains
  untouched.

## Claim transaction boundaries

A test-only P39 store probe pauses after the exact P38 approval consume, P4
ToolInvocation intent, P39 RecoveryBinding, and P39 attempt-0 writes, while
still inside their shared transaction. Killing the old daemon there rolls
back all claim facts. After the owner exits, the qualification CAS expires only
the exact observed lease generation/expiry; a second daemon acquires the same
Step, then commits one approval consume, RecoveryBinding/attempt-0 claim,
ToolInvocation and effect. The committed-side case uses the existing
post-transaction `AH7AfterToolIntentCommit` probe and confirms exact claim
reuse after owner takeover. Both cases retain the ProviderTurn, LogicalAction,
ToolInvocation and one-effect identity.

## Public Stop matrix and discovered repair

The schema-44 public process cases exercise Stop on both sides of
ResolveExecutableApproval. In both, they drive Stop through the public command,
kill the exact old owner, expire its exact observed lease only after confirmed
exit, and recover on a second daemon. They assert same Execution/action,
`Interrupted(StopRequested)`, a single Stop event and approval-resolution wake,
the exact Inbox item consumed once, and no external effect. The after-resolution
case also confirms the exact P38 consumed approval and P39 bound claim remain
attached to the same NotAdmitted P4 invocation until Stop settlement.

The first after-resolution RED exposed a real P40/P38 implementation defect:
P4 correctly detected `ExecutionStopping`, but then used the legacy bare
`recordNoEffectInterruption` row update. Under schema 44, P40 requires canonical
Interrupted observation bytes/hash on every terminal ToolInvocation, so that
update failed with `PersistenceConstraintViolation`; AgentLoop then selected
`ControlledInterruption(ExecutableToolInvocationRejected)` instead of the
durable Stop proposal. P4 now persists the Interrupted result through the
existing `ToolObservationEvidenceStore.settleOrReadWinner` path whenever P40 is
present, retaining the no-P40 legacy fallback. The store-level regression
proves `admitEffect` returns `ExecutionStopping`, one canonical NotAdmitted
Interrupted observation is applied/read, exact repeated settlement returns
the committed winner, and no effect is admitted.

## Verification

- `pnpm exec vitest run --config vitest.functional.config.ts --maxWorkers=1 --no-file-parallelism --retry=0 tests/functional/process/p38-executable-approval-public.functional.test.ts -t "claim|Stop"` — **4 passed, 5 skipped**, 127.41 s.
- `pnpm exec vitest run --maxWorkers=1 --no-file-parallelism --retry=0 adapters/persistence-sqlite/test/p40-observation-store-gates.test.ts -t "Stop-winning NotAdmitted"` — **1 passed**, 18.40 s.
- `pnpm typecheck` — **PASS**.
- Biome on the five changed implementation/test files — **PASS**.
- `git diff --check` — **PASS**.

No full suite was run. Wave 2 (browser Reject/expiry, unauthorized/stale
resolution, P39 freshness matrix, and legacy Control migration negative) is
not covered by this result. This evidence does not close P38 or P39.
