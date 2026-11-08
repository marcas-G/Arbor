# AH10 DeliverMessage Implementation/Test DAG — Planning Result

Date: 2026-10-11
Status: **Planning complete; implementation not started; execution gates pending**

## Baseline

- Planning tree base: `fdf25c844614e20a6c723d61c473eefe2f7481cb`.
- DID v1.38 design landing is independent-post-reviewed with Blocking = 0;
  design is closed for this Deliver storage correction, while implementation
  remains unstarted.
- The accepted P10 addendum remains fixed at SHA-256
  `040789D32BE1D92F1BAD28C5E3346439C1E902236452E778CD104AF6AA71EC8B`.
- This AH10 tree remains at P35/user_version 35. P36/0036 is accepted but not
  integrated here, so P37 cannot be implemented or released independently.

## DAG artifact

The task is
[`AH10-DeliverMessage-generation-attention-DAG.md`](../tasks/AH10-DeliverMessage-generation-attention-DAG.md).
It sequences the P36 prerequisite, P37 P9 fact/P10 marker storage,
DeliverMessage/1 codec + Gateway, P9 receipt-first/legacy proof, P10 public
Attention + MessageSent wake consumer, and a final true two-daemon commit
before/after/restart matrix. Each layer has a proposed exact first RED, module
versus process qualification boundary, and an explicit pre-P36 preparation
decision.

The existing pending test
`tests/functional/pending/ah10-deliver-stale-generation-replay.functional.test.ts`
is described as a direct-handler bypass reproduction: gen0 returns failure
after gen1 owns the lease, yet the direct handler has already written one
Message, MessageSent and Inbox row. Its same-MessageId repeat is not receipt
replay evidence. The DAG requires a Gateway-routed replacement/companion RED;
it does not reclassify the pending test as green or as a double-daemon test.

## Awaited gates and current evidence snapshot

- Current functional-run terminal status: **not confirmed in this task**.
  No run was started or polled. The coordinator must report terminal output
  and resource release before L6/process work is scheduled.
- AH7-DG-03 isolated tree was at
  `C:\Users\ThinkPad\.codex\worktrees\ah7-approval-atomicity\Arbor` HEAD
  `83ea2a4c2349b4194111e586cbc8315d3747f0b5`. It contains P36 L1/L2/L3 result
  records and the planned
  `planning/tasks/AH7-DG-03-L4-process-matrix.md`, but no AH7-DG-03 L4 result
  artifact was present at inspection. Therefore P36 L4 status is **pending / do
  not infer phase closure**.
- Only the planning tree was changed. No `docs/design/**`, production,
  migration implementation, or test file was changed. No test, build, full
  gate, daemon, or process-kill run was executed.

## Handoff

Start remains blocked until the coordinator supplies the current functional
terminal result and AH7 L4 progress, and the AH10 target tree has integrated
and qualified P36/0036. This DAG is not implementation authorization, release
qualification, or AH10 phase closure.
