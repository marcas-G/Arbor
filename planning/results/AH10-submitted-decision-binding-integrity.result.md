# Submitted DecisionEpisode binding integrity — pending RED

Date: 2026-10-08

Status: **RED / governance decision required for terminal disposition; no
production change made.**

Test:
`tests/functional/pending/ah10-submitted-decision-binding-integrity.functional.test.ts`

## Fixture boundary

Each case begins with real public Project/Work setup and the real Scheduler
forming a DecisionEpisode. At the old daemon's `AH9BeforeTerminalActionCommit`
test gate, a read-only snapshot confirms that the original SelectCurrentWork
Command is Committed; its DecisionRequest is Submitted(B), revision 1; the
Workspace current Work is B; the Step is ActionsInProgress at cursor 0; and
the action is Pending with no Observation.

The isolated fixture then makes exactly one deliberate corruption in its
temporary database and proves the other relevant rows remain unchanged:

- Workspace binding case: changes `work_selection_decision_requests.workspace_id`
  to a second real Workspace created through public `CreateChildWorkspace`.
- Manifest binding case: changes the exact Step's `manifest_id` to another
  real `model_context_manifests.manifest_id` from the same database.

The old daemon is killed; the test waits for the actual gen0 lease expiry, then
starts an ordinary gen1 daemon. No lease, receipt, Command, Step or Action is
directly inserted or repaired.

## RED result

Command:

```text
pnpm exec vitest run --config vitest.pending-functional.config.ts tests/functional/pending/ah10-submitted-decision-binding-integrity.functional.test.ts
```

Result: **2 failed / 0 passed**, 94.00s. Both mismatch cases stop replay of the
pinned SelectCurrentWork ProviderTurn (its successful Attempt count stays
unchanged), issue no second SelectCurrentWork Command, and add no
CurrentWorkChanged event or target-Execution Observation. Gen1 does submit a
failed SettleExecution receipt. Both cases then reproduce the same terminal
orphan:

```text
Execution: settled_at set, settlement_kind = Failed
Step: logical_step_no=0 / repair_attempt=0 / original ProviderTurn,
      ActionsInProgress, revision=3, next_action_index=0,
      settlement_json=NULL
Action: action_index=0 / select_current_work / Pending,
        observation_source_ref=NULL
Observations for target Execution: []
```

The pre-crash snapshot and post-kill snapshot both show the valid original
Committed receipt, Submitted DecisionRequest and selected Work; only the test's
single binding field differs afterward. Gen1 obtains generation 1. No new
ActionIntent is observed for the pinned action; the failure path commits
`SettleExecution(Failed)` before leaving the Step/Action orphaned.

## Disposition

The new exact Workspace and Manifest guard is fail-closed and remains intact.
The uncovered defect is that `proposeSettlement(Failed)` persists a
`SettlementProposed` transition only for a `Prepared` Step, not an
`ActionsInProgress` Step. P3 `08`/P9 `07` prohibit returning from a live step
without coherent durable handoff, but the exact failure Action disposition or
Attention projection for a deliberately corrupted active binding is not
uniquely specified. See
`planning/proposals/agent-loop-submitted-binding-rejection-terminalization-draft.md`.

The tests remain under `tests/functional/pending/`; do not count this expected
failure as default functional coverage or claim a green release batch. No
production or `docs/design/**` files were changed.

## Independent integration verification (2026-10-08)

```text
pnpm exec vitest run --config vitest.pending-functional.config.ts tests/functional/pending/ah10-submitted-decision-binding-integrity.functional.test.ts
2 failed / 0 passed (92.73s; both failures are the expected orphan-state assertion)
```

The Workspace and Manifest cases independently reproduce the same persisted
state described above. The test is intentionally excluded from
`vitest.functional.config.ts` and the root Vitest config; it remains pending
manual disposition and is not a passing qualification.
