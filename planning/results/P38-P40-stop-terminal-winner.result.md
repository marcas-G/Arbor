# P38/P40 Stop versus committed P4 winner — follow-up qualification

Status: **PASS for the committed-terminal-winner repair; P38 remains open.**

- Implementation baseline: Wave 1 commit `96dfd9dc89eb0f4c4bb184759223fc89121feb2b`.
- Scope: preserve an already committed canonical P4 winner when a Stop-side
  Interrupted candidate races with it; ensure an authorized durable Stop keeps
  `Interrupted(StopRequested)` as the Execution cause even when the same
  no-effect P4 action is terminal Denied.
- No design, migration, or production-composition probe changes.

## Repair

`ToolObservationEvidenceStore.settleOrReadWinner` now distinguishes the
existing P4 `Denied` winner from a P40 evidence winner. Denied rows intentionally
have no P40 observation bytes, so they are surfaced as `ExistingDenied` with
their exact P4 reason rather than fabricated into a P40 record. For other
terminal outcomes, the P40 store returns the existing authenticated evidence;
ToolRuntime re-reads and decodes it through the ordinary P4/P40 replay path
instead of collapsing a boolean and losing the canonical result. The P4
settlement caller also preserves `ExistingDenied`.

At the AgentLoop boundary, a no-effect executable rejection on an Execution
whose durable `stopRequestedAt` is present selects the existing P2
`Interrupted(StopRequested)` settlement. It does not rewrite the committed P4
Denied row or claim an effect occurred. The public two-daemon qualification
commits an approval Reject/P4 Denied result, requests Stop before the handler
returns, kills the owner, expires only the exact observed lease generation
after owner exit, and proves takeover keeps the P4 Denied row and produces the
P2 Stop settlement with no effect.

## Verification

- `pnpm exec vitest run --maxWorkers=1 --no-file-parallelism --retry=0 adapters/persistence-sqlite/test/p40-observation-store-gates.test.ts -t "Stop|committed winner|final NotOccurred"` — **8 passed, 6 skipped**, 128.52 s. Covers Stop candidates racing with committed Success, ExpectedFailure, Interrupted, OutcomeUnknown, RuntimeFailure, ReconciledNoEffect, and Denied winners; each preserves the committed result/evidence.
- `pnpm exec vitest run --maxWorkers=1 --no-file-parallelism --retry=0 packages/tool-runtime/test/p4-pipeline.test.ts -t "Stop re-entry projects|canonical P4 Denied winner"` — **6 passed, 23 skipped**, 2.73 s.
- `pnpm exec vitest run --maxWorkers=1 --no-file-parallelism --retry=0 packages/agent-runtime/test/execution-driver-failure.test.ts -t "durable StopRequested"` — **1 passed, 21 skipped**, 2.71 s.
- `pnpm exec vitest run --config vitest.functional.config.ts --maxWorkers=1 --no-file-parallelism --retry=0 tests/functional/process/p38-executable-approval-public.functional.test.ts -t "P4 Denied winner committed first"` — **1 passed**, 17.4 s.
- `pnpm typecheck` — **PASS**.
- Biome on the eleven changed code/test files — **PASS**.
- `git diff --check` — **PASS**.

No full suite was run. The Wave 2 legacy migration test-source change is not
part of this follow-up and remains unstaged. This result does not close all P38
or P39 qualification rows.
