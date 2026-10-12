# P37 L6 DeliverMessage Process-Crash Matrix — First Full Run

Date: 2026-10-12 (Asia/Shanghai)
Baseline: `ed5fba00ee60e169cadf0df12395179862abd1e8`
Worktree: `C:\Users\ThinkPad\.codex\worktrees\p37-delivermessage-closure`
Status: **First full run 0/11 PASS; test-only fixture repairs applied; post-repair qualification not run**

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
