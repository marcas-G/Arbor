# AH7-DG-02 P39 fact-store failure atomicity

Date: 2026-10-17  
Baseline: `280b8be0`  
Scope: test-only P39 fact-store failure injection and safe retry evidence.

## Result

Added a deterministic failure layer to the P4 pipeline fixture. For each of
`NotOccurred`, `Occurred`, and `StillUnknown`, the first P39 fact write fails.
The invocation returns a failure before retry admission, executor/effect,
P40 terminal candidate, or successful P4 outcome. Re-running with the same
invocation, binding, attempt, and proof succeeds through the corresponding
recovery path: `NotOccurred` permits its one retry, `Occurred` reconstructs
from the exact result Artifact and reaches P40 without executor replay, and
`StillUnknown` remains unresolved without admission or execution. The fixture
also checks that the reconciliation request is identical across the failed
attempt and recovery.

Added an adapter test using a SQLite `BEFORE INSERT` trigger with `RAISE(ABORT)`
to inject a real fact-table write failure inside the transaction. The failed
write leaves no P39 fact row; after removing the test trigger, recording the
same immutable proof succeeds and an exact duplicate returns the same fact ID.

## Verification

- `pnpm exec vitest run adapters/persistence-sqlite/test/p39-tool-reconciliation-store.test.ts --retry=0` — PASS, 1/1.
- `pnpm exec vitest run packages/tool-runtime/test/p4-pipeline.test.ts --retry=0` — PASS, 63/63.
- `pnpm typecheck` — PASS.
- Biome check on both changed test files — PASS.
- `git diff --check` — PASS.

No real daemon/process test was run; serial release is still required. The
module test models a subsequent invocation with the same persisted inputs; it
does not claim a process restart. This closes only the scoped P39 fact-store
failure atomicity case and does not close AH7 or AH7-DG-02 overall.

## P3 / executable-handler projection clarification

“No P3 projection claimed” means the failed P39 transaction cannot be
represented as a successful/applied tool fact. It does not prohibit the
required safe unresolved projection. The executable-handler integration test
injects the same P4 `SettlementJournal` / `OutcomeUncertain` error shape and
runs it through `executeAgentLoopActions`: the caller receives
`OutcomeUnknown` + `ReconciliationRequired`, the action is persisted as
`ReconciliationPending`, and the typed ToolResult is `OutcomeUnknown`. No
`Succeeded`, `Applied`, or `TerminalRejected` result is written. This does not
create a P40 terminal observation or a successful ToolResult.

- `pnpm exec vitest run apps/single-workspace/test/ah7-p39-fact-failure-p3-projection.test.ts --retry=0` — PASS, 1/1.
- `pnpm typecheck` — PASS.
- Biome on the new integration test and `git diff --check` — PASS.
