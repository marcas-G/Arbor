# AH10 SelectCurrentWork cross-generation takeover — qualification result

Date: 2026-10-08

Status: **PASS for DecisionEpisode expired-lease redispatch and the tested
SelectCurrentWork receipt boundaries; AH10 remains PARTIAL overall.**

Test: `tests/functional/process/agent-loop-ah10-select-current-work-takeover.functional.test.ts`

## Public setup and durable precondition

The test uses the production daemon, public `CreateProject`, `GrantPermission`
and `AssignWork` commands, and model-facing `assign_work` / `wait` controls.
Two runnable alternatives are assigned while the initial Work Episode is
active; that Work then records a `Manual` wait. The real Scheduler persists
one Pending `WorkSelectionDecisionRequest` with the exact two candidate Work
IDs and admits a `DecisionEpisode` at request revision 0. The provider returns
`select_current_work` for one of those candidates. The existing child-only
`AH10_GATE_ACTION_KIND` probe pauses at that action's committed intent.

Before takeover the durable state contains the settled waiting Work Episode
and one active DecisionEpisode bound to the exact Pending
WorkSelectionDecisionRequest. The two candidate Works are the only runnable
alternatives; the selected target is taken from the actual DecisionEpisode
context. No test code writes a DecisionRequest, lease, receipt or command.

## Gen0 fencing receipt boundaries

Both variants use two production daemons, the same durable database, the
existing action-kind-filtered test probe and the real 30-second lease. Gen0
pauses after the exact `select_current_work` ActionIntent; gen1 acquires the
same DecisionEpisode under generation 1 and pauses at the same intent. The two
owners retain the same ExecutionId, DecisionRequest, ProviderTurnId,
LogicalActionId and callRef.

For the **before-commit** case, the Gateway probe holds the old
FencingRejected receipt inside its transaction. An independent read-only
connection cannot see it; killing gen0 rolls it back. Gen1 then commits one
SelectCurrentWork command.

For the **after-commit** case, the old FencingRejected receipt is visible before
gen0 is killed. Gen1 reads that exact old receipt, uses its generation-scoped
CommandId and commits one canonical selection. Both cases finish with one
Submitted DecisionRequest at revision 1, the chosen candidate as
`workspace.current_work_id`, one `CurrentWorkChanged` for that candidate, one
Applied SelectCurrentWork action and its Observation, and the public
`current-work` view returning that candidate. The Decision Provider profile is
requested once; no second decision is generated. The old waiting Work remains
durably settled and unchanged.

## Contract disposition

The initial RED was an implementation gap in the existing tick/resume path,
not an unresolved AH10 semantic choice. Scheduler Noop still blocks a second
Main Execution; after that, the daemon now resumes the existing active
Workspace Execution for any exact episode binding, subject to the existing
pre-dispatch lease predicate, pending-approval gate and `runExecution` fencing.
The same DecisionEpisode/AgentLoopStep is resumed. No Scheduler decision,
Execution identity, command semantics or frozen contract changed.

## Validation

```text
pnpm build
PASS
pnpm exec vitest run --config vitest.functional.config.ts tests/functional/process/agent-loop-ah10-select-current-work-takeover.functional.test.ts
2 passed / 2; before-commit and after-commit receipt boundaries
pnpm typecheck
PASS
pnpm architecture
30 files / 155 tests PASS
pnpm exec vitest run apps/single-workspace/test/ah10-generation-command-takeover.test.ts
1 file / 22 tests PASS
pnpm exec biome check apps/single-workspace/src/main.ts tests/functional/process/agent-loop-ah10-select-current-work-takeover.functional.test.ts
2 files PASS
pnpm check
PASS (Biome 944 files, architecture 155, core 1708 passed + 3 skipped,
Web 216 tests; typecheck and Web build passed)
```

At the initial RED checkpoint the full release functional suite had not run;
see Integrated validation below for later local-source results. This result
closes only the SelectCurrentWork DecisionEpisode dispatch seam; other AH10
control actions/state combinations, AH10-DG-01 Deliver and VCS-DG-01 remain
open. No `docs/design/**` changes were made.

## Integrated validation on `5e389e8` (2026-10-08)

After a fresh `pnpm build` generated the daemon child entrypoint from the
current source, the isolated process test passed 2/2 (72.96s). The first
pre-build attempt had loaded the previous ignored `apps/single-workspace/dist`
artifact and timed out both cases; it is recorded as an invalid stale-build
attempt, not as evidence against the source change.

Additional gates on the same source/commit:

```text
AH10 primary process + SendMessage process files: 2 files / 10 tests PASS (370.93s)
pnpm check: PASS
  Biome 944 files; typecheck/build PASS
  architecture 30 files / 155 tests
  core 315 files / 1708 passed + 3 skipped
  Web typecheck/build; 31 files / 216 tests
F20 committed clean checkout: 1/1 PASS (51.97s)
pnpm test:functional: PASS
  Vitest 23 files / 55 tests (1524.14s)
  Playwright 2/2 (21.7s)
```

These runs include both SelectCurrentWork receipt sides and the P9 durable
TextDelta renewal qualification. They do not close AH10: other control
actions, additional state combinations and independent Deliver/VCS governance
gaps remain open.
