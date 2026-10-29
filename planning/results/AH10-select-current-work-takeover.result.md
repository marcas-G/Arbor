# AH10 SelectCurrentWork cross-generation takeover — qualification result

Date: 2026-10-08

Status: **PASS for DecisionEpisode expired-lease redispatch, both
`FencingRejected` receipt boundaries, and Committed-receipt pre-Observation
recovery; AH10 remains PARTIAL overall.**

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

## Committed receipt before Action settlement — PASS (2026-10-08)

The isolated third case uses the existing `AH9BeforeTerminalActionCommit`
qualification boundary. At the old-generation probe, the SelectCurrentWork
Command receipt is Committed, the same DecisionRequest is `Submitted` for B at
revision 1, and the Workspace current Work is B at the corresponding new
revision. The target action remains Pending with no Observation; its original
Step is `ActionsInProgress` at cursor 0, before `SettlementProposed`. After
killing gen0, these facts remain durable while the real generation-0 lease
expires.

Gen1 acquires the same DecisionEpisode Execution at generation 1 and resumes
the pinned SelectCurrentWork action. The old Committed receipt is reused under
its original CommandId; there is no second Command or CurrentWorkChanged event.
The one DecisionRequest remains Submitted(B) at revision 1, the Workspace
remains selected on B at the same revision, and the original Action advances
Pending→Applied with one Observation. The Provider decision is not requested
again. The narrowly guarded recovery path accepts a Submitted request only
when the same Step is `ActionsInProgress`, its pinned ProviderTurn has settled
success, its next action is the exact Pending `select_current_work`, and the
Submitted request belongs to the Execution Workspace, its selected candidate
matches the canonical Workspace selection/revision, and the settled Provider
result's `manifestId` exactly matches the Step's pinned Manifest. New or
unproven DecisionEpisodes still fail closed unless Pending at the pinned
request revision.

The first red run supplied the counterexample: gen1 acquired generation 1 but
returned `DecisionRequestMissingOrSettled` before re-entering the action,
leaving Step cursor 0 and Action Pending. This exposed an implementation-order
defect against the existing P9 `07` §2 pinned-action replay contract, not a new
semantic choice. The fix reorders only the proof needed for recovery; no
`docs/design/**` changes or new fencing/approval exceptions were introduced.

Validation:

```text
pnpm --filter @arbor/single-workspace build: PASS
pnpm exec vitest run --config vitest.functional.config.ts tests/functional/process/agent-loop-ah10-select-current-work-takeover.functional.test.ts -t "reuses the Committed SelectCurrentWork receipt": 1/1 PASS (47.47s)
pnpm exec vitest run --config vitest.functional.config.ts tests/functional/process/agent-loop-ah10-select-current-work-takeover.functional.test.ts: 3/3 PASS (126.51s)
pnpm typecheck: PASS
pnpm architecture: 30 files / 155 tests PASS
pnpm exec vitest run tests/p3-driver.test.ts tests/p3-integration.test.ts tests/p11-controlbasis.test.ts apps/single-workspace/test/ah10-generation-command-takeover.test.ts: 54/54 PASS
```

The committed third case remains in the formal process file and does not add a
pending failure to the default functional gate. The integration run below
subsequently executed the complete `pnpm check`; full `pnpm test:functional`
has not yet run on this change.

## Submitted replay binding regressions (2026-10-08)

Added `packages/agent-runtime/test/model-decision-pinned-replay.test.ts` for
the guard's exact Workspace and Manifest bindings. The first red run passed the
valid pinned replay case but failed both negative cases: a Submitted
DecisionRequest from another Workspace and a settled Provider result whose
Manifest differed from the AgentLoopStep were incorrectly accepted by the
replay guard. The guard now requires
`request.workspaceId === execution.workspaceId` and
`providerResult.manifestId === step.manifestId`; all three cases pass. The
helper remains a module-internal export and is not re-exported from the
`@arbor/agent-runtime` package root. The downstream SelectCurrentWork handler
also validates the old receipt's Workspace binding; the manifest-to-Step
binding was not present in the generic replay comparison.

Additional validation:

```text
pnpm exec vitest run packages/agent-runtime/test/model-decision-pinned-replay.test.ts: 3/3 PASS
pnpm exec vitest run packages/agent-runtime/test/model-decision-pinned-replay.test.ts tests/p3-driver.test.ts tests/p3-integration.test.ts tests/p11-controlbasis.test.ts apps/single-workspace/test/ah10-generation-command-takeover.test.ts: 57/57 PASS
pnpm typecheck: PASS
pnpm architecture: 30 files / 155 tests PASS
Biome on model-decision, focused test, SelectCurrentWork process test and AH10 child: PASS
git diff --check: PASS
```

Follow-up risk (not exercised by this batch): the negative guard tests prove
the replay predicate rejects a mismatched Workspace/Manifest, but do not run a
daemon-level recovery from that malformed `ActionsInProgress` state through
`proposeSettlement(Failed)`. Because that path may leave the pending Step/action
without a terminal Step transition, record a focused fail-closed settlement
test before treating mismatched-replay recovery as covered. This does not affect
the valid Committed-receipt recovery case above and is not asserted here as a
confirmed production defect.

## Integration verification (2026-10-08)

Independent integration reruns on the working tree:

```text
pnpm exec vitest run --config vitest.functional.config.ts tests/functional/process/agent-loop-ah10-select-current-work-takeover.functional.test.ts: 1 file / 3 tests PASS (122.88s)
pnpm exec vitest run packages/agent-runtime/test/model-decision-pinned-replay.test.ts tests/p3-driver.test.ts tests/p3-integration.test.ts tests/p11-controlbasis.test.ts apps/single-workspace/test/ah10-generation-command-takeover.test.ts: 5 files / 57 tests PASS
pnpm check: PASS (Biome 947 files; architecture 155; core 316 files / 1711 passed + 3 skipped; Web 31 files / 216 passed; TypeScript, Web typecheck and build passed)
```

The AH10 main real-process file independently passed 9/9 in 336.69s. On
committed HEAD `4558ec65280ee25eb5817ce15fdf1f8df84209e0`, the F20 clean
checkout test passed 1/1 (46.94s), and the complete `pnpm test:functional`
passed: Vitest 25/25 files, 64/64 tests; Playwright 2/2. This broad green batch
does not close AH10 or its open governance/state-combination gaps.
