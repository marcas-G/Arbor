# F23 AH9 / AH11 functional public Work seed

## Scope and baseline

Worktree: `C:\Users\ThinkPad\.codex\worktrees\f23-internal-validation\Arbor`

Baseline: `ae24027c22234b9bcc5f55099cedf6fefa20df33`, detached and clean after
confirming the F23 Wave 3 source commits are patch-equivalent in the shared
branch. Only these files changed:

- `tests/functional/process/agent-loop-ah9-terminal-action-recovery.functional.test.ts`
- `tests/functional/process/agent-loop-ah11-step-effects-crash.functional.test.ts`
- this result record

No production code, `docs/design/**`, shared fixture helper, or unrelated test
was changed.

## Change

Both fixtures replace external `/commands` `AssignWork` setup with the public
process path: Root `SubmitHumanMessage` → Root `assign_work` → exact Governance
Inbox approval → `ResolveControlApproval(Approve)` → Open `current-work`.
The seed Work turn enters a legal Manual wait. It is verified idle and its seed
execution IDs are captured before the ordinary daemon is killed. Only then is
the daemon restarted with the selected crash probe and public `SteerWork`
resumes the Work at revision 0. The hit execution must not appear in the seed
execution set, so Root admission, CAPA approval, and the harmless seed wait do
not satisfy or trigger the measured AH9/AH11 boundaries.

AH9 retains both crash-boundary assertions. Before terminal-action commit the
target execution has a pending Wait action and zero target-execution
ControlResults. After commit, Wait is Applied, the following `assign_work` is
`SkippedEarlySettlement`, and exactly two target-execution ControlResults are
present. Correlation is by each target Action's exact `call_ref` and
`observation_source_ref`: `session_entries.source_ref` and the parsed
ControlResult `observationRef` must both equal the Action ref, the after-boundary
ref set must equal both target Action refs, and duplicate refs/results fail.
Seed Root/Manual-wait results are excluded by the target call refs. The target
execution has no P4 ToolInvocation; its action ledger is exactly the expected
one or two actions. Recovery settles the same execution, preserves the skip,
and leaves exactly one Work (revision 1 after the seed SteerWork) and one Work
wait. The measured Work provider call count is exactly one.

AH11 retains both `Observation → StepEffectsCommitted` kill boundaries. The
measured read is Applied with its exact result and Observation refs; the target
execution has exactly one ToolInvocation, ToolResult and Artifact at the kill
boundary. Recovery leaves the target action, invocation, ToolResult and
Artifact rows unchanged and advances to the next step. Exactly one measured
pre-effect Work provider call is asserted, so recovery does not replay the
Provider decision.

## RED / verification

- After rebuilding the isolated worktree's TypeScript project outputs, the
  original AH9 setup reproduced HTTP 403
  `authority/denied` / `UnsupportedOrigin:AssignWork` for both boundaries.
- The original AH11 setup reproduced the same 403 for both boundaries.
- An earlier AH9 run against stale generated daemon output passed 2/2; that
  output predated the current origin policy and is explicitly excluded from
  evidence.
- Revised AH9 focused run: 2/2 PASS (both terminal-action boundaries).
- Revised AH11 focused run: 2/2 PASS (both StepEffectsCommitted boundaries).
- `pnpm typecheck`: PASS.
- Biome on both changed test files: PASS.
- `git diff --check`: PASS.
- Full `pnpm check` and `pnpm test:functional` were not run.

The work only changes test setup and keeps the accepted external-origin policy
unchanged; no design gap was found.
