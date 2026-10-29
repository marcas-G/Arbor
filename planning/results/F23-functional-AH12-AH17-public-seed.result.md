# F23 AH12 / AH17 public Work seed

Date: 2026-10-10
Worktree: `C:\Users\ThinkPad\.codex\worktrees\f23-fixture-app\Arbor`
Base: `f4319d2f30cb25551f0e8a81afc2e11b8fbbee10`

## Scope

Changed only:

- `tests/functional/process/agent-loop-ah12-settlement-command-crash.functional.test.ts`
- `tests/functional/process/ah17-checkpoint-epoch-crash.functional.test.ts`
- this result record

No production code, `docs/design/**`, shared `production-fixture.ts`, or other
test files were changed.

Both scenarios now create the target Work through public Root conversation:
`SubmitHumanMessage` → Root `assign_work` → exact CAPA Governance Inbox entry →
`ResolveControlApproval(Approve)`. The test observes the one Open Work at
revision 0 and waits until its seed execution has legally settled at Manual
wait with no active execution. Only after that does it crash the ordinary
daemon, arm the boundary probe, restart the instrumented daemon, and issue
public `SteerWork`. The measured execution is asserted absent from the seed
execution set.

AH12 explicitly asserts that SteerWork commits and advances the target Work
from revision 0 to revision 1. The CompletionClaimed proposal, SettleExecution
receipt/event, Verification target, and Work row are then asserted against the
same target execution and revision 1. Seed execution events/actions and the
legal seed provider call remain present as background facts, but are excluded
from target-uniqueness counts rather than treated as failures.

AH17's local provider now serves the public Root assignment and the seed Manual
wait before the probe is armed. It injects the context-overflow response only
for the resumed target Work after SteerWork. The existing checkpoint payload,
epoch advance, provider native/canonical history, ProviderTurn identities and
ordering, replacement turn, and before/after crash assertions remain in place;
target overflow/summary/wait counts are distinguished from the public seed
requests. This test does not make a new content-hash or decoded-output-hash
claim.

## RED / verification

- Baseline RED: AH12 `AH12BeforeSettleExecutionCommit` failed at public
  `/commands` with `403 authority/denied`, `UnsupportedOrigin:AssignWork`.
- Baseline RED: AH17 before-commit case failed at public `/commands` with the
  same `403 authority/denied`, `UnsupportedOrigin:AssignWork`.
- AH12 full target file after migration: 3/3 PASS — before Gateway submission,
  before SettleExecution commit, and after settle-command commit.
- AH17 full target file after migration: 2/2 PASS — checkpoint/epoch commit
  before and after process kill.
- `pnpm typecheck`: PASS.
- Biome on both changed test files: PASS.
- `git diff --check`: PASS.
- Full `pnpm check` and full `pnpm test:functional` were not run.

This evidence is limited to the two named AH12/AH17 functional files; it does
not claim broader AH12, AH17, or F23 closure.
