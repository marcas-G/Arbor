# AH10 Direct-child AssignWork generation takeover

Date: 2026-10-08

Status: **PASS for the two Direct-child AssignWork FencingRejected receipt
boundaries. Committed receipt / Action-Pending recovery after a placement ref
becomes stale is OPEN as a Design Gap; AH10 remains PARTIAL.**

Test: `tests/functional/process/agent-loop-ah10-direct-child-assign-work-takeover.functional.test.ts`

The isolated process run was executed on committed source base
`021b6bf0565c632054a66057d355da84f6adaadb` using the already-built daemon
`dist`; no build was run while AH15/AH17 source edits were in flight. The
integrating agent must rebuild and rerun this file on the final integrated
source tree.

## Scenario and evidence

The test publicly creates a Project and an active direct Child Workspace with
its own independent FileTree. It assigns an open Parent Work to the Root
Workspace and scripts the real Provider first to call `list_workspaces`, then
to call `assign_work`. The assignment target is the exact `wref_...` returned
by that model-facing `list_workspaces` ControlResult; the test verifies the
same ref in its persisted `outputText` and does not calculate or invent it. A
public `workspace-detail` view confirms the Child's FileTree boundary.

The Parent/Root Workspace's default AssignWork approval mode is Ask. The Child
Workspace's own policy is not the authorization basis for this Parent action.
While gen0 is paused at the pinned AssignWork ActionIntent, the test issues public
`GrantPermission` for the exact direct-child `wref`, capability
`core.control.assign-work`, and subject the Root `WorkspaceAgent`. This exact
CAPA grant authorizes the action before any AssignWork Command is submitted;
no control approval for that target is created. The grant target matches the
same opaque `targetWorkspaceRef` used by the AssignWork authorization check.
The durable ListWorkspaces ControlResult has one `source_ref`, and that exact
ref equals the ListWorkspaces action's `observation_source_ref` before and
after recovery.

Both cases use the real two-daemon lease-expiry path. They hold gen0's
AssignWork ActionIntent, wait for its generation-0 lease to expire, and let
gen1 acquire the same Execution. The gen1 ActionIntent is the same pinned
ProviderTurn/LogicalActionId/callRef. Releasing gen0 then qualifies either
the FencingRejected Command receipt before commit (gen0 is killed and the
uncommitted receipt is absent) or after commit (the single old rejection
receipt is durable before gen0 is killed). Gen1 commits one new generation-
scoped AssignWork Command and the one canonical Work.

Final assertions require one direct-child Work with the exact model-authored
objective, `why`, constraints, completion expectation, and full
VerificationMission; Runtime-bound provenance points to the Parent Work with
the model-authored reason. The WorkAssigned event names the Child Workspace
and the one committed Command. The AssignWork ControlResult/Observation is
unique, its ProviderAttempt is one successful attempt, and list/assign are
separate unique actions: ListWorkspaces is logical Step 0; AssignWork is the
successor logical Step 1. Provider performs the list and assignment calls
once each; the pinned assignment is not re-inferred after takeover.

## Validation

```text
pnpm exec vitest run --config vitest.functional.config.ts tests/functional/process/agent-loop-ah10-direct-child-assign-work-takeover.functional.test.ts
1 file / 2 tests PASS (78.07s; before 38.72s, after 38.49s)

pnpm exec biome check tests/functional/process/agent-loop-ah10-direct-child-assign-work-takeover.functional.test.ts
PASS

pnpm exec tsc -p tsconfig.test.json --noEmit --pretty false
PASS
```

An earlier concurrent test-tree check had reported duplicate top-level bindings
and a missing `node:http` export in the in-flight AH17 file; that file was
subsequently corrected by its owner, and the final `tsc -p tsconfig.test.json`
run is green. The first strengthened run exposed a test-oracle mistake: `list_workspaces`
and `assign_work` correctly persist as two different logical Steps (0 and 1),
not two action rows in one Step. The final assertion now checks each pinned
identity independently. No product or design files, existing AssignWork tests,
shared fixtures, or databases were modified. This does not cover every AH10
action/state combination and does not close AH10.

Integration rerun after `pnpm build` at working source `021b6bf` plus this
batch: 1 file / 2 tests PASS (before/after FencingRejected receipt commit;
latest rerun 75.01s). This replaces the author's old-dist-only qualification for these two
cases. AH10 remains PARTIAL; other control actions, state combinations,
`Deliver`, and verification-control governance gaps remain open.

Final integrated `pnpm check` passes: Biome 953 files, typecheck, architecture
155, core 316 files / 1723 passed / 3 skipped, Web typecheck/build and 31 files /
216 tests. P12 restore-drill generated-field drift from the check was restored
to the committed timestamp and hash.

Committed F20 and full functional-suite results are recorded in
`planning/results/AH15-AH17-direct-child-release-validation.result.md`.

## Committed-receipt Action-Pending exact target gap (2026-10-09)

An isolated real-process case is retained at
`tests/functional/pending/ah10-direct-child-assign-work-committed-receipt-stale-ref.functional.test.ts`.
It pauses gen0 after the direct-child AssignWork handler returns and before
Observation commit. The pre-crash snapshot proves one committed AssignWork
receipt, one target Child Work and WorkAssigned event, while the pinned Action
is Pending with no Observation. After SIGKILL and lease takeover, gen1 replays
the same ProviderTurn/LogicalAction/callRef, but the committed AssignWork has
changed the placement revision and made the pinned `wref` stale. The prior
implementation returns `action/target-unavailable`; it does not create a
second Work or rerun the Provider, but it cannot mark the Action Applied or
append its Observation.

An early receipt-first bypass was explored and withdrawn. Canonical Work plus
the receipt proves the effect's WorkspaceId and Parent provenance, but there
is no durable mapping from the stale pinned `wref` to that WorkspaceId. A
same-Project direct-child check could accept child B while the action and CAPA
grant name child A. The current deterministic hash formula could support
historical-revision enumeration, but neither that algorithm nor its bounds
and assumptions are frozen. The P1 receipt-first rule and MAC-P2 / CAPA
exact-target rule need a manually governed resolution before a safe
successful replay can be implemented. Proposal:
`planning/proposals/AH10-direct-child-committed-receipt-target-binding-draft.md`.

The Design Gap case is excluded from default functional gates. Existing
FencingRejected before/after commit tests remain the only PASS cases in this
file. No `docs/design/**` changes or implementation authorization were made.
AH10 remains PARTIAL; other control actions, state combinations, Deliver, and
verification-control governance gaps also remain open.

## Final integrated review and gates (2026-10-09)

Independent integration review: **PASS; Blocking = 0 for the scoped batch.**
The review verified the direct-child test's model-facing `wref` provenance,
exact CAPA grant target, pinned ProviderTurn/LogicalAction/callRef continuity,
real lease expiry, receipt transaction boundaries, and unique Work/event/
Observation assertions. Production
`apps/single-workspace/src/control-actions.ts` has no diff; `docs/design/**`
and P12 phase/task files have no diff. The separate stale-reference pending
test is excluded from default functional discovery and remains an open Design
Gap; it is not counted as passing evidence.

Final integrated gates on the frozen working tree:

```text
pnpm check: PASS
  Biome: 965 files; one existing noNonNullAssertion warning
  TypeScript build + test typecheck: PASS
  Architecture: 31 files / 158 tests PASS
  Core: 319 files / 1746 passed / 3 skipped
  Web typecheck + build: PASS (existing chunk-size warning)
  Web tests: 31 files / 223 tests PASS

pnpm test:functional: PASS
  Vitest: 31 files / 123 tests PASS (5822.34s)
  Playwright: 3/3 PASS (42.8s)
  Direct-child FencingRejected receipt: 2/2 PASS

Author's targeted pre-integration evidence also passed: direct-child process
cases 2/2, AH10 handler suite 23/23, test typecheck, and targeted Biome.
```

The check regenerated `planning/results/P12.restore-drill.json`'s timestamp
and hash. Both fields were compared with their pre-check committed values and
restored exactly; the final P12 result file is clean. F20 also passed inside
the functional run, but its clean checkout is from the uncommitted `HEAD` and
is baseline-only evidence, not qualification of this working-tree diff.

AH10 remains PARTIAL. The direct-child Committed-receipt / Action-Pending
stale-reference outcome still requires manual governance of exact target
binding before implementation; the open proposal remains unaccepted, and no
design semantics or implementation authorization were added.
