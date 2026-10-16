# P38 NonIdempotent post-effect crash oracle

Date: 2026-10-16

## Diagnosis

The only failure in `functional-58563cd8-20261016-191322` was a test-oracle
field mismatch, not a recovery gap. After a process is killed after the
NonIdempotent effect but before P4 settlement, recovery correctly leaves the
ToolInvocation `MayHaveStarted` and unsettled, retains the exact consumed
approval/RecoveryBinding/attempt-0, and settles the Execution as
`OutcomeUnknown(ReconciliationRequired([exact invocation]))`. AgentLoopStep is
`SettlementProposed` and the action is `ReconciliationPending`.

The old predicate incorrectly required `OutcomeUnknown` on the P4
ToolInvocation row. The accepted P4/P9/SD/AHT-5 behavior forbids automatic
replay after `MayHaveStarted`; ambiguity may take the existing Execution
`OutcomeUnknown` exit. That exit is the required safe terminal here, so this
case does not require a separate Attention/offset progression or a P4 terminal
settlement.

## Oracle correction

The test now waits for P2 Execution `OutcomeUnknown`, `SettlementProposed`,
`ReconciliationPending`, and the exact invocation reference in the durable
reconciliation payload. It explicitly requires the P4 invocation to remain
`MayHaveStarted` with `settlement_kind = NULL`, and verifies approval identity,
RecoveryBinding and attempt-0 remain unchanged, external effect count remains
one, and no additional Provider call occurs.

## Verification

- Targeted P38 process case, first run — **1 passed / 13 skipped**.
- Targeted P38 process case, second run — **1 passed / 13 skipped**.
- `pnpm typecheck` — **PASS**.
- Biome on the changed functional test — **PASS**.
- `git diff --check` — **PASS**.

No production source, frozen design document, timeout, retry, or side-effect
assertion was changed. No full functional suite was run.
