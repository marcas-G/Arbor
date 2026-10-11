# P37 L6 DeliverMessage Process-Crash Matrix — Source Checkpoint

Date: 2026-10-11
Status: **test source / probe checkpoint only; qualification not run**

## Baseline and scope

- Independent worktree rebased to the complete L4/L5 integration checkpoint
  `78b7cdaab222721faf3c6e6885d2f2efd4b760e3`.
- The current accepted v6 P9 contract makes `DeliverReplayEscalated`, its
  immutable P9 fact and its pending outbox row one `BEGIN IMMEDIATE` transaction.
- The current accepted P10 contract requires marker-before-ACK, with the marker
  and P1 per-project offset committed in the same transaction. Public Attention
  uses the frozen safe row and deduplicates by `attentionFactId`.
- All commit pauses live in the dedicated functional process child. Production
  composition does not read the test environment variables or install probes.
- For the legacy direct-write negative branch, the historical handler runs
  inside the gen0 daemon child after ActionIntent commit. The child emits its
  transient Observation result, then pauses before Agent Loop Observation
  persistence so the test kills that same OS process. Gen1 must record
  `PriorReceiptEffectConflict`; after Inbox deletion and another restart, the
  existing P9 fact must continue to block.

## Source added

- `tests/functional/support/p37-deliver-process-child.mjs` — dedicated daemon
  entry with process-local pause gates for Gateway fenced receipt, Action /
  Observation, P9 fact, P10 marker/consumer commits, and the legacy gen0
  direct-write return window.
- `tests/functional/pending/p37-delivermessage-process-crash.functional.test.ts`
  — eleven isolated process cases across the requested crash groups. The suite
  creates a Project and child Work through public APIs, produces a real
  Artifact/Deliverable, then holds the Deliver action at process-local commit
  boundaries. Receipt corruption and Inbox drift/deletion mutations are
  confined to the isolated test DB.
- `tests/functional/support/p37-attention-poll-claim-child.mjs` plus
  `tests/functional/pending/p37-deliver-replay-capacity.functional.test.ts`
  — multi-process poll-claim, repeated-expiry fairness, restart-persisted
  backoff and attempt-order source; profile-dependent capacity assessment
  cases remain explicitly pending until deployment selects a v1.43 profile.
- P9 fact IDs for the crash matrix are read from `readP37Snapshot()`'s single
  SQLite read transaction after the P9 commit probe. P10 probes are matched to
  that stored fact ID; L6 does not compare against an absent P9 probe field.

## Matrix coverage checklist

| Case | Required assertion | Source status |
|---|---|---|
| Old gen0 FencingRejected before commit | no receipt/effect survives; gen1 commits once with the same LogicalAction/ProviderTurn/Message identity and a generation-specific CommandId | executable `it.each` before side |
| Old gen0 FencingRejected after commit | exact old rejection is present before gen1 commit; one final Message/Event/Inbox | executable `it.each` after side |
| Committed DeliverMessage, Action/Observation Pending | receipt-first recovery; one Message/Event/Inbox/Observation and one Deliver Provider decision | executable public process case |
| P9 fact + event + outbox transaction | before commit: none durable; after commit: fact/event/queue durable once; restart yields one Attention row | executable `it.each` before/after with the accepted L4 composition probe |
| P10 marker + ACK + P1 offset transaction | before commit: marker/ACK/offset unchanged; after commit: all advance atomically; restart exposes one public row | executable `it.each` before/after with the accepted L5 post-commit probe |
| Old receipt/effect contradiction | public `ActionRequired`, Action remains pending, no Observation or repeated Provider decision | executable public process case |
| Gen0 pre-Gateway direct-write Observation | gen0 daemon child returns transient Observation after its real legacy Message/Event/Inbox commit, then is killed before Observation persistence; gen1 records `PriorReceiptEffectConflict`; after Inbox deletion the existing P9 fact blocks again with no new command/effect | executable two-daemon process case |
| Committed receipt with a still-present but mismatched Inbox row | P9 `PriorReceiptResultMismatch`, one fact/event, Action remains Pending, no new Command or Observation, public `ActionRequired` remains after restart | executable public process case |
| Committed receipt with Inbox absent after cleanup | exact Message/Event receipt is adopted; original Action Observation converges once without a replacement Command, Message, or Inbox row | executable public process case |

The P12 source independently exercises: live-lease `NoClaim` without durable
mutation; one winner for an expired singleton lease under two OS poll workers;
and repeated hot-project lease expiry while healthy B/C projects continue to
receive attempts across independent worker process opens. The four capacity
measurement/assessor cases are `it.todo` behind the explicit profile-selection
gate. They cover queue INSERT/ACK/requeue accounting, same-window rates and
net growth, burst/drain and batch sizes, declared maximum population, raw
preflight / lock-hold / SQLite and P9 writer wait / rebuild measurements, and
the combined `SQLiteSufficient` assessor. No numeric profile limits are
invented.

## Verification and limitations

- No Vitest, daemon, browser, or full gate was run, per the requested execution
  policy.
- The initial `pnpm typecheck` against `04e25f1` failed in three existing
  L2/L3 fixture mocks; none pointed at the new source. The test source exposed
  and corrected a duplicate helper declaration, SQLite JSON result typing,
  and probe/direct-handler input types. After rebasing to the full L4/L5
  checkpoint `78b7cdaab222721faf3c6e6885d2f2efd4b760e3` and adding the two
  Inbox disposition cases, the final `pnpm typecheck` passed.
- Targeted Biome, `node --check` for the dedicated daemon child, and
  `git diff --check` passed on the same worktree. The final TypeScript pass
  included the P12 poll fairness / multi-process claim source and both
  test-child files.
- P12 capacity workloads are not reported as qualified: no deployment-pinned
  DeliverReplay profile was selected in the current `P12.storage-assessment.json`.
- The test file remains under `tests/functional/pending/` until L4/L5 integration
  and the centralized execution turn. No matrix case is counted as passing.
- This result is a source checkpoint, not L6 or P37 qualification.
