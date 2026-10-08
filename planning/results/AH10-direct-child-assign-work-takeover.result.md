# AH10 Direct-child AssignWork generation takeover

Date: 2026-10-08

Status: **PASS for the two tested Direct-child AssignWork FencingRejected
receipt boundaries; AH10 remains PARTIAL.**

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
