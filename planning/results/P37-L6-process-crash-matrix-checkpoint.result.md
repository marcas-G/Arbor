# P37 L6 DeliverMessage Process-Crash Matrix — Source Checkpoint

Date: 2026-10-11
Status: **test source / probe checkpoint only; qualification not run**

## Baseline and scope

- Independent worktree based on the P37 L2/L3 integration checkpoint
  `04e25f14...` (L2 storage and L3 Gateway route present).
- The current accepted v6 P9 contract makes `DeliverReplayEscalated`, its
  immutable P9 fact and its pending outbox row one `BEGIN IMMEDIATE` transaction.
- The current accepted P10 contract requires marker-before-ACK, with the marker
  and P1 per-project offset committed in the same transaction. Public Attention
  uses the frozen safe row and deduplicates by `attentionFactId`.
- All commit pauses live in the dedicated functional process child. Production
  composition does not read the test environment variables or install probes.

## Source added

- `tests/functional/support/p37-deliver-process-child.mjs` — dedicated daemon
  entry with process-local pause gates for Gateway fenced receipt, Action /
  Observation, P9 fact, and P10 marker/consumer commit boundaries.
- `tests/functional/pending/p37-delivermessage-process-crash.functional.test.ts`
  — six isolated matrix cases covering the requested crash groups.

## Matrix coverage checklist

| Case | Required assertion | Source status |
|---|---|---|
| Old gen0 FencingRejected before commit | no receipt/effect survives; gen1 commits using same MessageId and stable LogicalAction/ProviderTurn with its generation CommandId | `it.todo`; needs public Deliver seed and process runner |
| Old gen0 FencingRejected after commit | exact old rejection is read before gen1 committed route; one final Message/Event/Inbox | `it.todo`; needs public Deliver seed and process runner |
| Committed DeliverMessage, Action/Observation Pending | receipt-first recovery; one Message/Event/Inbox/Observation and one Provider request | `it.todo`; P37 route/action probe exists in child |
| P9 fact + event + outbox transaction | before commit: none durable; after commit: all durable once | `it.todo`; recovery implementation must expose both transaction probes |
| P10 marker + ACK + P1 offset transaction | before commit: none advanced; after commit: all advanced and exactly one public Attention row | `it.todo`; needs L5 consumer and post-commit probe integration |
| Old receipt/effect contradiction | public `ActionRequired`, Action remains pending, no Observation or replay | `it.todo`; needs public Deliver seed and L4 failure path |

## Verification and limitations

- No Vitest, daemon, browser, or full gate was run, per the requested execution
  policy.
- `pnpm typecheck` was attempted against the initial `04e25f1` base and failed
  in three existing L2/L3 fixture mocks (`adapters/persistence-sqlite/test/
  ownership.test.ts:758` and `tests/p10-activation-attention-reconciliation.
  test.ts:360,402`); none pointed at the new test source. The task owner then
  supplied combined checkpoint `80f1055`, which includes fixture integration
  updates. Static typecheck will be repeated on that base before handoff.
- The test file remains under `tests/functional/pending/`; no case is counted as
  implemented or passing. The runner and exact coherent SQLite snapshot oracle
  remain TODOs because the L4/L5 interface work is being integrated separately.
- This result is a source checkpoint, not L6 or P37 qualification.
