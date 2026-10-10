# F21 OPEN-3 Wave2 — P10 Activation Attention reconciliation

Date: 2026-10-10

Base: `1aa605c7074b6ccb56e6fea8ad2f4752316fb402`

Scope: P10 source-only materialization/reconciliation. P11 ownership claim +
Pending→Active transition and P12 post-commit/startup calls remain Wave3 and
are not implemented or wired here. OPEN-3 remains open.

## Contract implemented

- Added `reconcileProjectActivationAttention(projectId)` in projection runtime.
  It opens one `TransactionPort` transaction, reads the current P1
  ActivationIntent table through `listAll`, and passes that snapshot to the
  P10 Attention store in the same `TransactionScope`.
- The P10 store touches only
  `workspace_resource_activation_attention_rows`: it upserts current Pending
  tuples and deletes rows for Active/absent tuples. Identity is
  `(projectId, workspaceId, resourceBoundaryRevision)`, and the stored row
  contains only identity plus `createdAt` as `occurredAt`—no path, Profile,
  failure, or OS-error data. Other Attention sources are untouched.
- `WorkspaceResourceActivationChanged(v1)` is a wakeup only. The generic P10
  consumer validates the event envelope, re-reads current P1 intent state, and
  reconciles the Activation source; a delayed Pending event cannot revive an
  Active row. The ordinary generic consumer still owns its normal
  apply-then-advance offset transaction.
- P10 full-projection reset now snapshots/reconciles Activation rows in the
  same existing rebuild transaction. The separate source-only function never
  reads or changes the shared P1 consumer offset and does not invoke generic
  rebuild.
- Added the materialized Activation rows to P10's read face, yielding the
  fixed path-free `ActionRequired` row from P10 `02`/`05`.

## Qualification

```text
pnpm typecheck                                      PASS
Biome check (9 Wave2 TypeScript files)              PASS
Default Vitest: 5 files / 29 tests                  PASS
  P10 source-only retention-floor/replay/race tests  3 cases included
  P10 acceptance + rebuild                          included
  P34/P35 SQLite migration tests                    included
Functional Vitest: AH10 P10 consumer materialization 1 file / 9 tests PASS
git diff --check                                    PASS
```

The source-only tests seed `consumer_offsets.last_sequence=1` below retained
floor `5`, with no retained Activation event and no Activation row; two direct
reconciliations materialize exactly one row while leaving the offset unchanged.
They also prove an unrelated AssignWork Attention row is unchanged,
the private Workspace path does not appear in the row/view, Active residual
rows are deleted, duplicate calls do not duplicate rows, and a late Pending
wakeup re-reads Active source truth. A concurrent CAS/reconcile test exercises
the SQLite transaction serialization point, then redelivers the wakeup and
asserts the final Active/no-row state.

No P12 runtime call was added, no P11 activation behavior was changed, and no
new migration/DDL was needed. Full `pnpm check` and full `pnpm test:functional`
were not run. This result does not claim crash/restart qualification or OPEN-3
closure.
