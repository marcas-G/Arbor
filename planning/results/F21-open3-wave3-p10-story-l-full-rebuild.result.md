# F21 OPEN-3 Wave3 — P10 Story L full rebuild qualification

Date: 2026-10-10

Base: `df8def61ac71b2c06f6d04fbbe79ccddffde6308`

Status: **P10 Story L activation Attention rebuild qualification PASS at the
real-process level. This does not close F21 OPEN-3.**

## Boundary under qualification

The existing full rebuild path calls the project-scoped P10 `ProjectionStore`
reset (clear P10 rows and reconcile from the current P1 ActivationIntent
snapshot), then rewinds the P10 offset to `floor - 1`, all inside one
`TransactionPort.transact`. The added test-only hooks expose the two relevant
process kill boundaries without changing reset, snapshot, replay, or offset
semantics:

- P10 activation Attention row written during reset/snapshot, before the
  reset+snapshot+offset-rewind transaction commits.
- That transaction committed, before retained-event catch-up starts.

Each fixture begins with a Pending P1 intent, removes its Pending status event
and Activation Attention row, and gives P10 offset `3` while the retained
journal floor is `1`. Thus the rebuild cannot recover the Pending Attention
from the pruned event; it must use current intent truth.

## Verification

```text
pnpm typecheck                                      PASS
Biome: P10 probe, P11 test, Story L process files   PASS
ownership.test.ts                                  8/8 PASS
Story L process cases                               2/2 PASS
```

1. **Before-commit kill + P11 interleave:** P10 pauses after writing the
   snapshot row. A separate process tries SQLite `BEGIN IMMEDIATE` and writes
   an explicit `SQLITE_BUSY` lock-wait marker while P10 holds the transaction;
   no fixed sleep is used to infer ordering. Killing P10 rolls back both the
   snapshot write and offset rewind. The P11 process observes the writer lock
   become available, invokes the actual
   `activatePendingWorkspaceResource` service, and commits Active, one claim
   and one Active event. A subsequent full rebuild reads the Active intent,
   does not recreate Pending Attention, and catches up the P10 offset to `4`;
   the public Attention view has no Activation Pending row.
2. **After-commit/pre-catch-up kill + P11 Active + restart:** P10 pauses only
   after reset, current-intent snapshot and offset rewind have committed, but
   before catch-up. Killing the process leaves the Pending Attention row
   present and offset `0` (`floor - 1`). P11 then commits Active before the P10
   event consumer confirms its event. The same public Attention query still
   shows the materialized Pending row while the offset is behind. A fresh P10
   consumer process reads the two retained events plus the Active event,
   advances offset to `4`, reconciles from current Active intent truth and
   removes the row. The public Attention view confirms the row is absent.

These are deterministic SQLite process tests; they do not claim an OS crash in
the middle of SQLite's own COMMIT syscall. A follow-up added the Active
transition after the P10 snapshot commit and before catch-up, the public view
oracle on both sides of consumer reconciliation, and an observable
`SQLITE_BUSY`/lock-acquired handshake in place of a fixed delay. The earlier harness REDs were
test-runner issues (package entrypoint resolution and pending promises without
an event-loop handle), not P10 behavior failures; the final process batch is
2/2 green. No production behavior or design semantics were changed. No full
`pnpm check` or `pnpm test:functional` was run. P10 rebuild qualification here
does not close F21 OPEN-3 or the remaining F21 governance work.
