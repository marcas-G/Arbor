# Crash sentinel focused repairs

Date: 2026-10-14

Baseline: `52e0b477f9691fa893017c45b68f808b5f9d522a` in an independent managed
worktree. Scope was limited to the AH7 pending-intent, AH11 StepEffects, and
AH8 stale-after-restart sentinels, plus one P3 driver regression test. No
design document or migration changed.

## AH7 P4 settlement boundaries

The baseline reproduced both failures at
`agent-action-ah7-pending-intent.functional.test.ts:277`: the crash snapshot had
no Artifact at `AH7BeforeToolSettlementTransaction` and
`AH7BeforeToolSettlementCommit`. Runtime materializes this read Artifact in the
P4 observation settlement transaction, so it is not durable before that
transaction commits. The boundary table now expects no Artifact at either
pre-commit point, and one Artifact after the settlement commit. Recovery still
requires exactly one Artifact on every path; action, P4 intent/settlement,
ToolResult, Observation, identity, and provider uniqueness assertions remain.

The two real pre-settlement crash cases have a 180-second outer case budget
because one run reached 113.6 seconds and a second hit the old 120-second outer
limit; all inner deadlines and behavioral assertions are unchanged. A
test-local 90-second diagnostic records the active phase and target durable
snapshot for the commit-boundary case.

- Red baseline: both selected boundaries failed at the Artifact count assertion.
- `AH7BeforeToolSettlementTransaction`: PASS, 1/1 (113.585s).
- `AH7BeforeToolSettlementCommit`: PASS, 1/1 after the budget change (85.684s).
- Biome on the changed file: PASS.

## AH11 StepEffectsCommitted recovery

The first phase diagnostic showed the source step remained `StepEffectsCommitted`
with its read action `Applied`, P4 settlement `Success`, and Artifact durable;
the Execution had been interrupted with `ExecutableToolInvocationRejected`.
`executeAgentLoopActions` only skipped durable Applied actions while the step
was `ActionsInProgress`, so a restarted driver could dispatch the already
committed output again. The dispatcher now returns the persisted
`StepEffectsCommitted` step directly to `completeAgentLoopStep`, which advances
the same source to its successor without re-running actions.

A P3 driver regression test injects a crash after the durable step transition.
It was red with two read-handler invocations and green with one; it also checks
the source `NextStepReady`, one successor, one Applied read, one successor
action, and two ProviderTurns total.

- Unit regression: red at two read invocations; then PASS, 1/1.
- `AH11AfterStepEffectsCommit` real-process case: PASS, 1/1 (83.453s) after
  rebuilding `pnpm build` so the daemon used the changed production code.
- `AH11BeforeStepEffectsCommit`: PASS, 1/1 (79.030s) in the preceding focused
  file run; the new fast path applies only to `StepEffectsCommitted`.
- Diagnostic artifacts are written under the ignored
  `.test-results/ah11-phase-diagnostics/` directory on slow/cleanup paths.

## AH8 stale-after-restart diagnostics

Added phase breadcrumbs and a 70-second test-local diagnostic containing the
unsettled durable execution/step/action snapshot, recent provider requests,
daemon state, and daemon errors. The recovery timeout now reports only the
target execution rows and provider/daemon context. The case's 90-second outer
budget, inner waits, and qualification assertions are unchanged.

- `agent-loop-ah8-action-b-stale-after-restart.functional.test.ts`: PASS, 1/1
  (71.786s); the 70-second watchdog did not fire.

## Shared verification

- `pnpm build`: PASS.
- `pnpm exec tsc -p tsconfig.test.json --noEmit --pretty false`: PASS.
- Biome on the five changed TypeScript files: PASS.
- `git diff --check`: PASS.
- The full `crash-sentinels` profile was not rerun. Its baseline manifest had
  seven failures, including P37 additional-daemon startup, P4 live-lease
  acquisition, and P9 dense-SSE; those cases are outside this repair scope.
