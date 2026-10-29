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

## F21/P12/P4 integration compatibility follow-up

The later `b6b3831` activation implementation requires the full read-only
`EnvironmentResolverPort` to verify the pinned canonical Workspace boundary.
The older P10 custom child supplied only a fake `ProjectEnvironmentPort` and
seeded the nonexistent `C:/F21_PRIVATE_TEST_PATH`. On the integrated tree this
correctly failed closed before activation with
`EnvironmentError: the pinned resource boundary cannot be verified`; this was
a stale test fixture, not evidence that production activation should relax its
resolver requirement.

The P10 fixture now creates a real temporary `pinned-tree` beside its isolated
SQLite file, seeds that exact path into the canonical Workspace boundary, and
passes the path to the custom child. The child provides the same local
read-only resolver and resolver-backed legacy projection as production. No
production behavior or Story L ordering/assertions were weakened.

The first retry after adding the resolver exposed a Windows-specific lock
probe result: while the P10 process held its real writer transaction,
`DatabaseSync` `BEGIN IMMEDIATE` returned extended SQLite `errcode=1546`
(`disk I/O error`), not a `SQLITE_BUSY` message. The test-only probe now treats
only the existing busy/locked messages or this exact Windows extended code as
the competing writer response; all other I/O failures still fail immediately.
Qualification continues to require that after killing P10, the same P11 child
actually acquires the writer lock and commits activation. The final P10 Story L
rerun is 2/2 PASS.

Integrated follow-up evidence at the temporary security/port/P4/OPEN3 stack:

- Typecheck and changed-file Biome: PASS.
- P10 Story L full-rebuild process cases: 2/2 PASS.
- P11/P12 activation-recovery process cases: 6/6 PASS.
- P10/P11 ownership, rebuild, admission, P1 recovery and architecture module
  set: 8 files / 42 tests PASS.
- P4 real-daemon lease-fencing process case: 1/1 PASS.
- P12 read-auth pending qualification: 2/2 PASS; F23 malformed-MessageId
  nonce representative: 1/1 PASS (other cases intentionally filtered).
- The initial fail-closed fake-path failure and the first Windows lock-probe
  failure are retained in this follow-up rather than represented as green.
  The exact `planning/results/P12.restore-drill.json` test output was restored
  after each run.

No full `pnpm check`, full `pnpm test:functional`, or Playwright run was made.
This qualification remains local and does not by itself close the complete
F21 governance/release gates.

## P10 architecture-gate follow-up at integration candidate `6fcbc17`

The first full `pnpm check` at the integration candidate had one failure in
Architecture (157 passed, 1 failed, 158 total); Core/Web did not run. The
failing test was `tests/architecture/p10-architecture.test.ts`'s
`zero canonical mutation` case. Its minimal reproduction was:

```text
pnpm exec vitest run tests/architecture/p10-architecture.test.ts -t "zero canonical mutation"
```

The sole reported violation was `transaction scope` in
`packages/projection-runtime/src/activation-attention-reconciliation.ts`.
This was a static-rule false positive, not a canonical write. P10 `02` §3
requires `reconcileProjectActivationAttention` to reread P1 intent state and
replace only the activation source's P10 rows in one transaction; P10 `04`
§3 requires the Attention reset/snapshot work to use a transaction boundary.
The function's typed dependency surface is limited to `TransactionPort.transact`,
`WorkspaceResourceActivationStore.listAll` and
`AttentionProjectionStore.reconcileWorkspaceResourceActivation`. The SQLite
adapter reads the canonical `workspace_resource_activation_intents` table and
only upserts/deletes `workspace_resource_activation_attention_rows`; it does
not alter intents, Workspaces, claims, receipts, or the P1 offset.

The correction is confined to `tests/architecture/p10-architecture.test.ts`:
transaction scope is no longer classified as a canonical write face, while
the rule still checks actual mutation calls and explicitly includes P1
activation intent `insertPending` and `compareAndSetActive` operations. No
production code or owner semantics changed. The exact architecture + P10
reconciliation unit command now passes 2 files / 9 tests.

Process regression evidence:

- P11/P12 activation-recovery: 6/6 PASS.
- P10 Story L: an initial combined rerun timed out waiting for the test-only
  SQLite lock probe to emit its contention marker; the platform connection
  could wait instead of returning immediately. The child now sets
  `PRAGMA busy_timeout = 0` before `BEGIN IMMEDIATE`, preserving the actual
  ordering proof (contention observed, P10 killed, same P11 child acquires the
  writer lock, then activation commits). Standalone P10 Story L rerun: 2/2
  PASS. This is test-fixture-only; other SQLite I/O errors remain failures.

Typecheck and Biome for the changed architecture/fixture files pass. No full
`pnpm check` or full `pnpm test:functional` was rerun after the fix; the initial
full-check Architecture red remains recorded above and is not represented as a
green full gate.
