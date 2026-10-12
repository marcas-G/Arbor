# P37 L6 DeliverMessage Process-Crash Matrix — Qualification Progress

Date: 2026-10-12 (Asia/Shanghai)
Baseline: `ed5fba00ee60e169cadf0df12395179862abd1e8`
Worktree: `C:\Users\ThinkPad\.codex\worktrees\p37-delivermessage-closure`
Status: **First run 0/11; rerun 1 7/11; rerun 2 9/11; two final local cases 2/2; full P37 L6 unqualified**

## Run

The unchanged L6 test cases and timeout values were invoked once, serially,
with retry disabled:

```powershell
pnpm exec vitest run --config vitest.p37-l6.config.ts `
  --maxWorkers=1 --no-file-parallelism --retry=0 --reporter=verbose
```

Before the run, the v19 worktree had the SQLite and single-workspace daemon
`dist` output from `pnpm typecheck`. The required Web static build was missing
and was produced with `pnpm --filter @arbor/web build` (PASS; existing Vite
chunk-size warning only). A temporary single-file Vitest config selected only
the original pending L6 file because the default functional config excludes
`pending/`. The case matrix, per-case timeout values and assertions were not
changed. No retry was configured or used.

The run started at 09:38:08 local time and completed in 360.93 seconds. Result:
1 file failed; **all 11 parameter-expanded cases failed**. The complete verbose
output, emitted process-boundary probes, per-case fixture paths, daemon error
arrays and assertion boundaries are in
`planning/results/P37-L6-process-crash-matrix.raw.log`. The 11 isolated SQLite
databases and their available WAL/SHM companions are copied with each case's
fixture metadata to `planning/results/P37-L6-process-crash-artifacts/`.

The test harness received capture-only instrumentation for this run: emitted
P37 probes are written as structured stdout lines; after each case, its
temporary fixture path, DB path, primary-daemon errors and sanitized process
snapshot are written to stdout; and fixture directories are retained until
copied. This instrumentation did not change a crash boundary, case, assertion,
or timeout. The temporary Vitest config was removed after the run. All 11
primary daemon processes exited; a process inventory found no remaining
`p37-deliver-process-child.mjs` Node process.

## Case results

| Case | First-run result |
|---|---|
| Gen0 FencingRejected before receipt commit | Timed out waiting for gen0 lease expiry; its lease-renewal loop remained active while ActionIntent was held. |
| Gen0 FencingRejected after receipt commit | Same active-renewal timeout; never reached the receipt assertions. |
| Committed receipt, Action/Observation pending | Public probe wait timed out before the intended recovery boundary. |
| Present but mismatched Inbox | Receipt/effect/action seed was incomplete. |
| Inbox absent after cleanup | Receipt/effect/action seed was incomplete. |
| P9 fact/event/outbox commit before | Receipt/effect/action seed was incomplete. |
| P9 fact/event/outbox commit after | Receipt/effect/action seed was incomplete. |
| Legacy gen0 direct-write Observation | P9 `PriorReceiptEffectConflict` fact/event and pending outbox were reached; the test timed out waiting for the P10 row-write boundary. No P10 marker/projection row was present in the captured DB; the queue remained pending and the P10 offset remained before the P9 event. This does not yet distinguish a P10 poll implementation issue from the fixture's setup/dispatch behavior. |
| P10 marker/ACK/offset commit before | Receipt/effect/action seed was incomplete. |
| P10 marker/ACK/offset commit after | Receipt/effect/action seed was incomplete. |
| Existing P9 fact after Inbox evidence drift | Receipt/effect/action seed was incomplete. |

## Failure clusters and disposition

The first and second cases show a deterministic qualification-fixture ordering
problem. The gen0 daemon is deliberately held after ActionIntent, but its
separate execution-lease renewal loop continues to move the real expiry forward.
The test waits for that lease to expire before starting gen1. It therefore times
out before testing a fenced Gateway receipt. The captured timeline contains
repeated `AH10BeforeLeaseRenewal` probes and a still-future gen0 `expires_at`.

Seven cases fail in `deliverAndHoldCommittedReceipt` before their requested
receipt/recovery boundaries. The captured Inbox-mismatch DB contains 24
formation proposals, 27 AgentLoopStep actions, 13 Commands, one Deliverable,
and zero Messages. Inspection of the scripted seed responder shows it keeps
returning `propose_workspace` for the same root user marker after
`ProposalRecorded(...)` is already in context. The sibling F19 responder already
has the missing context guard. This is a test-seed defect; these failures do not
exercise DeliverMessage/P9 receipt behavior.

The committed-receipt recovery and legacy-direct-write cases timed out before
their expected public/process boundaries. The legacy-direct-write case did
reach its accepted P9 failure fact, but did not observe P10 marker projection
within the test's existing wait. Its retained DB shows one immutable P9 fact
and one pending outbox row, zero P10 marker/projection rows, a cleared global
claim and no recorded P10 poll failure. This remains an unresolved
qualification boundary. No Design Gap or production defect is declared from
this single run.

After the first full run, two shared test-fixture root causes were repaired
without changing the L6 cases or their timeout values:

1. The gen0 FencingRejected cases now hold that exact Work Execution at
   `AH10BeforeLeaseRenewal`, wait for the persisted expiry, let gen1 acquire
   generation 1, then release the old action and renewal gates. They continue
   to assert both the receipt-commit-before/after branches.
2. The producer seed responder returns Text once `ProposalRecorded(...)` is in
   context. The receipt seed now observes the exact Deliver action intent for
   the seeded producer Work, waits for the same LogicalActionId's handler-return
   boundary, derives its expected generation-0 CommandId and stable MessageId
   from that ProviderTurn, and requires exactly one matching receipt, Action,
   Message, MessageSent event and Parent Inbox row. The process child applies
   the configured action-kind filter at the handler-return probe and emits the
   action kind, matching the existing generation-0/1 Delivery identity gate.

The P10 observation from the legacy-direct-write case is recorded separately
in `planning/results/P37-L6-direct-write-p10-poll-diagnostic.result.md`.
These fixes have **not** been requalified; the 11-case matrix still has no
passing run. Static checks after the repair pass: `pnpm typecheck`, targeted
Biome, `node --check` for the child daemon, and `git diff --check`. No Vitest,
daemon, browser or default functional suite was run after the first full run.

No `docs/design/**`, production source, migration or shared RAI/P38 code changed.
Layered unit/migration/Gateway qualification on this v19 worktree separately
passed 10 files / 48 tests; it does not substitute for this failed process
matrix. F19 in both delivery orders, default `pnpm test:functional`, and the
full L6 matrix after fixture-precondition repair remain unqualified.

All 11 P37 daemon children exited; a later process/port check found no P37
Node process and none of the 11 primary HTTP ports listening. The one-off
`vitest.p37-l6.config.ts` was removed. The 11 archived per-case DB directories
remain at the result path above. Copies were validated before attempted temp
directory cleanup, but the local tool policy rejected recursive deletion of
those exact `%LOCALAPPDATA%\\Temp\\arbor-functional-*` folders; the original
temp copies therefore remain recoverable alongside the archived copies.

## Fixture-repair rerun 1

Date: 2026-10-12 (Asia/Shanghai)
Base/patch: `800d71c8cd58905842becb76731655a57d503580`
Run command: the same single-file command above, with the recreated temporary
L6-only Vitest config and `--retry=0`.
Start: 10:09:13 local. Duration: 626.88 s. Result: **7/11 PASS; 4 fail**.
Raw output is `planning/results/P37-L6-process-crash-matrix-rerun-1.raw.log`;
11 DB/WAL/SHM sets and per-case metadata are at
`planning/results/P37-L6-process-crash-artifacts-rerun-1/`.

| Case | Rerun 1 |
|---|---|
| Gen0 FencingRejected before | PASS |
| Gen0 FencingRejected after | PASS |
| Committed receipt, Action/Observation pending | PASS |
| Present but mismatched Inbox | Timed out waiting for P10/public Attention; P9 fact/event/outbox had committed. |
| Inbox absent after cleanup | PASS |
| P9 transaction before commit | PASS, including restart and one public Attention. |
| P9 transaction after commit | Timed out waiting for P10/public Attention. |
| Legacy gen0 direct-write Observation | Timed out waiting for P10/public Attention after P9 fact/outbox commit. |
| P10 transaction before commit | Reached the pre-commit row probe and verified marker absent/queue pending, then failed because the offset was already 21 rather than the scenario-start 15. |
| P10 transaction after commit | PASS, including one public row. |
| Existing P9 fact after Inbox evidence drift | PASS |

### Rerun 1 common-cause classification

The three P10 wait failures share a qualification-fixture gate-order defect.
The test child holds `AfterDeliverReplayAttentionCommit` while awaiting the
P10 row-write boundary. Recovery runs as part of `schedulerTick`; the production
daemon main loop invokes `pollConsumers` only after `schedulerTick` returns
(`apps/single-workspace/src/main.ts:417-418`). Thus the held Action blocks the
same daemon from reaching the P10 poll. The retained case DBs show durable P9
fact/event/outbox, the P10 offset still just before the P9 event, an empty poll
claim and no stored poll failure. This is test orchestration evidence, not a
P10 production liveness failure.

The P10-before assertion compared the offset at the row-write probe with a
snapshot taken before the recovery daemon started. The P10 consumer had already
committed earlier journal records: the exact failing DB had P9 event sequence
22 and offset sequence 21 at the pre-commit hook, while the test's original
baseline was 15. The marker was absent and pending outbox row remained. The
frozen atomicity oracle is that the marker/ACK/offset changes in the *current*
P10 transaction all roll back together; it does not require unrelated prior
events to remain unconsumed from the scenario's initial snapshot.

The test-only correction now releases the P9 post-commit gate after the P9 fact
identity/durable-row assertions, then waits at the P10 pre-commit gate. The
P10-before oracle captures the independently visible committed offset at that
hook and asserts that offset remains unchanged after killing the transaction,
while retaining the no-marker, queue-still-pending, restart, unique public-row
and commit-after assertions. Matrix cases and timeout values remain unchanged.
This correction has only received static verification; no post-correction
Vitest or daemon qualification has run yet.

## Fixture-repair rerun 2

Date: 2026-10-12 (Asia/Shanghai)
Baseline/patch: `ad30b1c897dd346d7270d558a833881b5cf16380`
Run command: the same original single-file command, serial and with
`--retry=0`.
Start: 10:45:59 local. Duration: 745.24 s. Result: **9/11 PASS; 2 fail**.
Raw output is `planning/results/P37-L6-process-crash-matrix-rerun-2.raw.log`;
per-case databases/WAL/SHM and fixture metadata are at
`planning/results/P37-L6-process-crash-artifacts-rerun-2/`.

| Case | Rerun 2 |
|---|---|
| Gen0 FencingRejected before | Failed waiting for the Gateway pre-commit probe; releasing the gen0 lease-renewal gate after gen1 takeover produced an uncaught `LeaseLost` in the old daemon. |
| Gen0 FencingRejected after | PASS |
| Committed receipt, Action/Observation pending | PASS |
| Present but mismatched Inbox | PASS; P9 fact and P10 pre/post boundaries reached. |
| Inbox absent after cleanup | PASS |
| P9 transaction before commit | PASS |
| P9 transaction after commit | Failed waiting for P10 because the P9 after-commit release was mistakenly placed after that wait in rerun 2. |
| Legacy gen0 direct-write Observation | PASS; P9 fact/outbox and P10 pre/post boundaries reached. |
| P10 transaction before commit | PASS with boundary-relative offset rollback baseline. |
| P10 transaction after commit | PASS |
| Existing P9 fact after Inbox evidence drift | PASS |

The two remaining failures are test gate placement only. The gen0 renewal gate
must stay parked through the old Gateway before/after receipt observation and
the old-process kill; releasing it immediately after gen1 takes over lets the
renewal fiber throw `LeaseLost` before the intended pre-commit oracle settles.
For the P9-after matrix branch, the P9 fact identity must be asserted, then its
after-commit gate released **before** awaiting the P10 poll row hook so the
sequential scheduler loop can advance into `pollConsumers`.

Those two exact gate-order fixes have now been applied in the worktree without
changing the matrix or timeout values. The P9-after branch additionally checks
fact/event/outbox durability before releasing the gate. No P37 closure claim is
made pending the full 11-case run.

## Final gate-fix local qualification

After the two gate-order corrections, only the original FencingRejected-before
case and P9-after-commit case were run, serially and with retry disabled. The
filtered Vitest result was **2 passed / 9 skipped**, duration 119.06 s, exit 0.
The raw output is `planning/results/P37-L6-local-targeted-boundaries.raw.log`;
both DB/WAL/SHM captures and fixture metadata are in
`planning/results/P37-L6-local-targeted-artifacts/`.

- Fencing-before reached gen1 generation 1, then gen0 `AH10BeforeFencedReceiptCommit` while its lease-renewal fiber remained parked; the committed-receipt/new-generation assertions passed.
- P9-after asserted the committed fact/event/outbox before releasing the P9 gate, then reached P10 row-write pre-commit and poll post-commit boundaries and passed the public Attention/restart assertions.

This local pass validates the corrected boundaries but does not qualify the
other nine cases after the final edits. Root has reserved the next P37 window
for one full unfiltered 11-case run. Until that run passes, P37 L6, F19 and
default `pnpm test:functional` remain open.
