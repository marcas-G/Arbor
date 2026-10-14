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
transaction commits. The test now encodes every boundary explicitly:

| Boundary | Action / cursor | P4 intent | ToolResult | Artifact |
|---|---|---|---:|---:|
| `AH7AfterActionIntentCommit` | Pending / 0 | absent | 0 | 0 |
| `AH7AfterToolIntentCommit` | Pending / 0 | Pending | 0 | 0 |
| `AH7BeforeToolSettlementTransaction` | Pending / 0 | Pending | 0 | 0 |
| `AH7BeforeToolSettlementCommit` | Pending / 0 | Pending (uncommitted settlement rolls back) | 0 | 0 |
| `AH7AfterToolSettlementCommit` | Pending / 0 | Success | 0 | 1 |
| `AH7BeforeActionResultCommit` | Pending / 0 | Success | 0 | 1 |
| `AH7AfterActionResultCommit` | Applied / 1 | Success | 1 | 1 |

After recovery, every boundary must converge to the same Action identity, one
P4 Success result and Artifact, one ToolResult/Observation, and one measured
provider decision. Where a P4 intent existed before the crash, its
ToolInvocationId must be preserved; a pending intent may advance to Success,
while an already committed Success row must remain identical. The two
pre-settlement cases have a 180-second outer case budget because one run reached
113.6 seconds and a second hit the old 120-second outer limit. Inner deadlines
and qualification assertions are unchanged. The per-boundary table includes
probe identity and timeout. A test-local 90-second diagnostic records phase and
durable state for the commit-boundary case.

- Initial focused red: both settlement-before-commit boundaries failed at the
  Artifact count assertion. A later first whole-file run exposed four remaining
  oracle errors: ActionIntent recovery filtered Artifact by an absent
  pre-crash invocation ID, and three pending-intent boundaries compared the
  pending P4 row to its legitimate recovered Success row.
- Final focused file: **7/7 PASS**, total Vitest wall time **577.55s**.

| Boundary | Result | Case time |
|---|---:|---:|
| `AH7AfterActionIntentCommit` | PASS | 73.796s |
| `AH7AfterToolIntentCommit` | PASS | 76.627s |
| `AH7BeforeToolSettlementTransaction` | PASS | 89.470s |
| `AH7BeforeToolSettlementCommit` | PASS | 75.300s |
| `AH7AfterToolSettlementCommit` | PASS | 86.406s |
| `AH7BeforeActionResultCommit` | PASS | 73.849s |
| `AH7AfterActionResultCommit` | PASS | 71.278s |

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

The recovery fast path now verifies all of that evidence before returning
`Completed`: the current step revision and ProviderTurn binding; the exact
settled-success manifest; the canonical ProviderTurn output and its
`decodedOutputHash`; the accepted ModelOutput's exact sequence/source/content;
the cursor equal to the decoded action count; and a unique persisted action for
every index with the exact deterministic identity, route, callRef, kind, input
hash, and `Applied` state. Missing or inconsistent evidence uses the existing
typed `AgentLoopStepReplayBindingMismatch` failure path. It cannot advance a
corrupt step as if its effects were complete.

The P3 recovery unit now covers a valid two-action crash recovery plus negative
cases for output-hash mismatch, cursor mismatch, an action-index gap, a
callRef/identity mismatch, and a nonterminal Pending action row.

- Unit regression: red at two read invocations; then PASS, 1/1.
- B2 recovery evidence unit: PASS, 7/7 (single-action, multi-action, and five
  fail-closed corruptions).
- `AH11AfterStepEffectsCommit` real-process case: PASS, 1/1 (83.453s) after
  rebuilding `pnpm build` so the daemon used the changed production code.
- `AH11BeforeStepEffectsCommit`: PASS, 1/1 (79.030s) in the preceding focused
  file run; the new fast path applies only to `StepEffectsCommitted`.
- The process cases were not rerun after the B2 verification strengthening;
  this increment was limited to unit and static checks.
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
- Biome on the changed TypeScript files: PASS.
- `git diff --check`: PASS.
- The full `crash-sentinels` profile was not rerun. Its baseline manifest had
  seven failures, including P37 additional-daemon startup, P4 live-lease
  acquisition, and P9 dense-SSE; those cases are outside this repair scope.
