# F23 AH10 SelectCurrentWork / AssignWork public seed

## Scope and baseline

Worktree: `C:\Users\ThinkPad\.codex\worktrees\f23-fixture-app\Arbor`

Baseline: `1a1324ec6ea0536a116924e236382a550c4979f4`, clean and detached.
F07/AH8 source commit `68e321037400b5907dddd966e64224ba9fb4c3d6` is
patch-equivalent in `C:\Arbor` (`git cherry` marked it `-`). Only the two
requested AH10 functional test files and this result record are changed. No
production code, design docs, `production-fixture.ts`, or unrelated test was
modified.

Both tests now seed current Workspace Work through Root
`SubmitHumanMessage` → Root Agent `assign_work` → exact CAPA approval from the
Governance Inbox → public `ResolveControlApproval` → Open `current-work`.
Only after the exact approval is pending does the test grant the Workspace
Agent the scoped `core.control.assign-work` capability used by the measured
WorkspaceWork episode.

For SelectCurrentWork, the existing Agent Work still creates two runnable
candidate Works and enters its Manual wait. That wait automatically causes the
Scheduler to persist the genuine DecisionEpisode, whose candidate set excludes
the existing current Work. The AH10 test daemon/probe is present from initial
startup but gates only `select_current_work`; Root Work admission and candidate
assignment do not hit that gate. This scenario uses no `SteerWork` and has no
`probeArmed` phase. Existing gen0 FencingRejected receipt-before/after takeover
assertions, exact DecisionId, providerTurn/action identity, unique committed
SelectCurrentWork receipt and single selection Provider call remain. The
separate committed-receipt case uses the same public seed and retains
same-DecisionEpisode receipt replay.

For current-Workspace AssignWork, the measured Action still omits
`targetWorkspaceRef`, uses the exact self-target WorkspaceAgent grant, and
creates one Work in the current Workspace. Here the Root-created Work first
enters a legal Manual wait under the ordinary daemon. After confirming it is
idle at revision 0 and snapshotting the non-Failed seed ExecutionIds, the test
restarts with the AH10 probe and uses public `SteerWork` to resume the Work at
revision 1. The probed execution is distinct from every seed execution. This
keeps the seed ProviderTurn outside the measured Action. Before/after
FencingRejected receipt-commit takeover assertions and the
committed-receipt/action-Pending recovery case remain. They continue to assert
old/new owner action identity, receipt and Work uniqueness, one WorkAssigned
fact, exact Action Observation source reference, and one target action
Provider decision.

## RED / verification

- Before migration, all three SelectCurrentWork cases reached `/commands` and
  failed with HTTP 403 `authority/denied` / `UnsupportedOrigin:AssignWork`:
  the before/after generation-takeover variants (2) and committed-receipt case
  (1).
- Before migration, all three current-Workspace AssignWork cases reached
  `/commands` and failed with the same 403: before/after takeover variants
  (2) and committed-receipt case (1).
- Revised SelectCurrentWork before/after: 2/2 PASS; committed receipt: 1/1
  PASS.
- Revised AssignWork before/after: 2/2 PASS; committed receipt: 1/1 PASS.
- `pnpm typecheck`: PASS.
- Biome on both changed tests: PASS.
- Full functional suite and `pnpm check` were not run.

No design gap was discovered. This evidence covers only the six focused cases;
it does not claim AH10 or the full functional suite is closed.
