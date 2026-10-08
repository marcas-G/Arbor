# AH19 ordinary ProviderNative source-step recovery — scoped qualification

Date: 2026-10-09

Status: **ordinary Work Native source identity and selected restart branches
PASS; AH19 remains open.** This qualifies public Work history only. It does not
close the wider AH15–AH19 or SCRC recovery matrices.

## Contract and implementation

P3-02 §9 supplies `logicalStepNo` and `repairAttempt` on the compaction
request; P3-08/P9-07 require durable step identity and replay from durable
evidence. The Native ProviderTurn manifest now persists
`sourceAgentLoopStep = { executionId, logicalStepNo, repairAttempt,
providerTurnId }`. ProviderTurnStore can enumerate Native compaction manifests
for the exact Session/context epoch. The Runtime requires a unique candidate,
validates the complete source identity against the persisted AgentLoopStep,
and validates the ProviderTurn, Manifest, portable request hash, epoch and
Native receipt before recovery.

After a crash before checkpoint commit, the Runtime finds the settled Native
receipt through that persisted source identity and commits the original
checkpoint without a second Native request. After checkpoint commit, it
recovers the same source Step from the checkpoint's ProviderTurn manifest.
When the binding changes, it rebuilds from the recorded portable frontier with
Summary and continues the same source Step; the old opaque item is not sent to
the new binding. This path does not create or use a P20 `OverflowCompaction`
link for ordinary compaction.

## Process evidence

Isolated public Work fixtures used AssignWork and SteerWork to create the
history. They did not use SQL to create positive history. The real daemon was
killed at each checkpoint boundary; the tests waited for lease expiry before
starting the next generation.

- Native checkpoint commit **before** restart, same binding: **1/1 PASS**.
  Epoch 0 and no checkpoint were present at the kill point. The next generation
  reused the exact settled ProviderTurn and Manifest, committed one checkpoint,
  resumed the manifest's source Step, and issued no second Native request.
- Native checkpoint commit **after** restart, same binding: **1/1 PASS**.
  Epoch 1 and one checkpoint were present at the kill point. The next generation
  resumed the exact source Step without another Native request.
- Checkpoint committed under binding A, restart under binding B: **1/1 PASS**.
  Binding B received one portable Summary request with the source frontier and
  context refs from the Native manifest, then continued the exact source Step.
  B received no ProviderNative opaque item; the Native ProviderTurn occurred
  once.
- Independent single-field manifest corruption, each after a real restart:
  **5/5 fail-closed** for `logicalStepNo`, `repairAttempt`, source
  `providerTurnId`, source `executionId`, and binding fingerprint. Each left
  the checkpoint/epoch unchanged, kept the Execution active, and issued no B
  Provider request.
- P20 ownership crossover with a settled overflow-linked Native receipt before
  checkpoint commit, then restart under binding B: **1/1 PASS**. P20 retains
  the exact `OverflowCompaction` owner link, rebases its frontier through
  portable Summary, and creates the exact `OverflowReplacement`. No B request
  contains the old opaque item.
- `NextStepReady` source with no successor, via both Work startup-owner and
  common checkpoint-recovery routes: **2/2 fail-closed** after real restarts.
  Both leave the committed checkpoint and epoch unchanged and issue no Provider
  request. The valid AH11 `StepEffectsCommitted` without successor branch
  remains accepted; its exact successor recovery passed **1/1**.

There is no real-process negative in this batch for duplicate Native manifests
at one Session/epoch. The Runtime returns `AgentLoopStepReplayBindingMismatch`
when the query finds more than one; that branch remains unqualified here.
Request-hash and epoch mismatch checks are implemented but are not included in
the five corruption cases above. Existing AH19 overflow-linked cases remain
separate evidence.

The portable-frontier decoder accepts the contract's empty ConversationResponse
Session frontier `(null, null)`. No dedicated half-null frontier process case
was run in this batch; the decoder rejects a half-null pair by its static
predicate.

Existing overflow-linked AH19 process regressions rerun on the integrated tree:
same-binding settled-receipt recovery **1/1 PASS** after the P20 ownership
guard. The changed-binding portable Summary branch is covered by the new P20
crossover case below.

## P20 ownership crossover follow-up

The ordinary Session/epoch scan now reads the ProviderTurn's exact P20 link
before treating a Native manifest as ordinary. A persisted
`OverflowCompaction` link leaves recovery to P20; an unexpected non-overflow
link fails closed. No ProviderTurn ID parsing is used for ownership.

The real-process RED used a settled Native success at the P20
`OverflowCompaction` receipt boundary, before checkpoint commit, then killed
the daemon and restarted with binding B. Before the fix, the startup scan
committed an ordinary Summary checkpoint for epoch 0→1 before P20 recovery,
then the daemon failed with `AgentLoopStepReplayBindingMismatch`; the P20 link
still pointed to the original Native receipt. After the fix, the same fixture
passes: P20 retains the original overflow link, creates the portable Summary
rebase and exact `OverflowReplacement`, and binding B receives no opaque A
item. **1/1 PASS.**

The ordinary Native P20-ownership tests, five manifest corruption tests, two
missing-successor tests, and AH11 successor recovery all passed together in the
final AH19 process file: **31/31 PASS**. The independent P2 review distinguished
the invalid `NextStepReady`-without-successor state from the valid AH11
`StepEffectsCommitted` crash window; the latter remains accepted.

## Final integration evidence

The first integrated full-file attempt contained 29 cases and ended **25/29
PASS, 4 FAIL**. The regressions were:

- `fails closed rather than sending an older Native opaque checkpoint to a
  changed binding` timed out after the changed-binding restart reached a later
  Native compaction and reported `AgentLoopStepReplayBindingMismatch`.
- `fails closed when the persisted NextStepReady successor does not point back
  to its source` timed out waiting for the public recovery result.
- `settles a terminal ConversationResponse from its pinned
  StepEffectsCommitted output after Native rebase` failed to reach the AH11
  checkpoint boundary; the child reported `AgentLoopStepReplayBindingMismatch`
  after Native compaction.
- `fails closed on a corrupted compiled hash for the pinned terminal output
  before Summary` failed at the same AH11 boundary with
  `AgentLoopStepReplayBindingMismatch`.

The final qualification added explicit Work-startup and common
ConversationResponse checkpoint-owner coverage, tied source-step recovery to
the complete persisted Native manifest identity, and retained the valid AH11
`StepEffectsCommitted` recovery branch. The four regression scenarios were
rerun in the final tree and passed. The complete final AH19 process file is
**31/31 PASS**; no production retry or weakened assertion was used to convert
the earlier failures into passes.

Independent final review: **Blocking = 0**. Duplicate Native manifests at one
Session/epoch still lack a real-process negative qualification; Runtime
fail-closed behavior is implemented, but that branch remains open below.

## Gates and scope

`pnpm check`: **PASS**. Biome checked 964 files (one existing
`noNonNullAssertion` warning in `model-decision.ts`); typecheck passed;
architecture passed 158/158; core Vitest passed 319 files / 1745 tests with 3
skipped; Web typecheck/build passed; Web Vitest passed 31 files / 223 tests.
The check rewrote the generated P12 restore-drill timestamp/hash; both fields
were restored to their exact pre-run values. Post-gate and post-functional
checks confirmed `planning/results/P12.restore-drill.json` has no diff and
matches its pre-run values.

Full `pnpm test:functional`: **PASS**. Vitest passed 31 files / 115 tests in
4512.54 seconds; Playwright passed 3/3 tests in 34.0 seconds. The F20
clean-checkout test runs from the current committed `HEAD`, so its pass is
**baseline-only** and does not include these uncommitted AH19 changes. If this
batch is committed, F20 must be rerun against the new `HEAD`.

Remaining open boundaries: duplicate Native manifests at one Session/epoch
have no real-process negative qualification; a half-null portable frontier has
no dedicated process negative (only the decoder predicate rejects it); the
ConversationResponse cross-Episode checkpoint-owner gap remains open; and
before-first-checkpoint Work history beyond its existing 64-entry window is
unqualified. These limits do not close AH19 or the wider AH15–AH19/SCRC
recovery matrices. No design document was modified, and no commit or push was
made.
