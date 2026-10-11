# P37 L6 DeliverMessage Process-Crash Matrix — Source Checkpoint

Date: 2026-10-11
Status: **test source / probe checkpoint only; qualification not run**

## Baseline and scope

- Independent worktree rebased to the P37 L2/L3 integration checkpoint
  `80f10551...` (L2 storage and L3 Gateway route present).
- The current accepted v6 P9 contract makes `DeliverReplayEscalated`, its
  immutable P9 fact and its pending outbox row one `BEGIN IMMEDIATE` transaction.
- The current accepted P10 contract requires marker-before-ACK, with the marker
  and P1 per-project offset committed in the same transaction. Public Attention
  uses the frozen safe row and deduplicates by `attentionFactId`.
- All commit pauses live in the dedicated functional process child. Production
  composition does not read the test environment variables or install probes.
- For the legacy direct-write negative branch, the historical handler is called
  explicitly by the test runner against the same file DB while gen0 is paused
  before its Gateway handler. The returned Observation is inspected in memory;
  the daemon does not persist it. Every process kill/restart is performed on
  the independent daemon child processes.

## Source added

- `tests/functional/support/p37-deliver-process-child.mjs` — dedicated daemon
  entry with process-local pause gates for Gateway fenced receipt, Action /
  Observation, P9 fact, and P10 marker/consumer commit boundaries.
- `tests/functional/pending/p37-delivermessage-process-crash.functional.test.ts`
  — nine isolated process cases across the requested crash groups. The suite
  creates a Project and child Work through public APIs, produces a real
  Artifact/Deliverable, then holds the Deliver action at process-local commit
  boundaries. Receipt corruption and Inbox drift/deletion mutations are
  confined to the isolated test DB.

## Matrix coverage checklist

| Case | Required assertion | Source status |
|---|---|---|
| Old gen0 FencingRejected before commit | no receipt/effect survives; gen1 commits once with the same LogicalAction/ProviderTurn/Message identity and a generation-specific CommandId | executable `it.each` before side |
| Old gen0 FencingRejected after commit | exact old rejection is present before gen1 commit; one final Message/Event/Inbox | executable `it.each` after side |
| Committed DeliverMessage, Action/Observation Pending | receipt-first recovery; one Message/Event/Inbox/Observation and one Deliver Provider decision | executable public process case |
| P9 fact + event + outbox transaction | before commit: none durable; after commit: fact/event/queue durable once; restart yields one Attention row | executable `it.each` before/after with the accepted L4 composition probe |
| P10 marker + ACK + P1 offset transaction | before commit: marker/ACK/offset unchanged; after commit: all advance atomically; restart exposes one public row | executable `it.each` before/after with the accepted L5 post-commit probe |
| Old receipt/effect contradiction | public `ActionRequired`, Action remains pending, no Observation or repeated Provider decision | executable public process case |
| Gen0 pre-Gateway direct-write Observation | shared-file legacy handler returns Observation but does not persist it; gen1 records `PriorReceiptEffectConflict`; after Inbox deletion the existing P9 fact blocks again with no new command/effect | executable public two-daemon process case |

## Verification and limitations

- No Vitest, daemon, browser, or full gate was run, per the requested execution
  policy.
- The initial `pnpm typecheck` against `04e25f1` failed in three existing
  L2/L3 fixture mocks; none pointed at the new source. The test source exposed
  and corrected a duplicate helper declaration and three SQLite JSON result
  typing errors, plus probe/direct-handler test input types. The final
  `pnpm typecheck` passed on the rebased full integration checkpoint
  `78b7cdaab222721faf3c6e6885d2f2efd4b760e3` with L4/L5 included.
- Targeted Biome, `node --check` for the dedicated daemon child, and
  `git diff --check` passed on the same worktree.
- The test file remains under `tests/functional/pending/` until L4/L5 integration
  and the centralized execution turn. No matrix case is counted as passing.
- This result is a source checkpoint, not L6 or P37 qualification.
