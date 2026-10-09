# AH10/P10 Attention Materialization — Superseded Implementation Disposition

Status: **SUPERSEDED as a governance proposal; implementation disposition only**

The independent P10 review concluded that P10 `02` §2, P10 `04` §1–§2, and
P10 `07` Story I already authorize durable Attention rows, same-transaction
offset application, and project-scoped rebuild as implementation details. No
new governance decision is required for those details. The first synthetic
P1-marker RED was invalid gap evidence; it is preserved in the result record
as historical diagnostic evidence only. A corrected P9-fact-backed RED then
confirmed the missing P10 consumer/materialization implementation.

The implementation now proceeds under the accepted P10 contract and the
separate AH10 implementation authorization. This file is retained only to
record the provisional implementation shape and avoid treating the prior
governance hold as active.

## Evidence and frozen contract

The accepted AH10 package assigns P9 ownership of the immutable
`AssignWorkTargetBindingEscalated` event and
`assign_work_binding_attention_facts` row. P10 owns the read-model projection:
one `Action Required` row at the failed Execution's owning Parent Workspace,
deduplicated by the fact's `attentionFactId`, counted once by existing subtree
aggregation, with no opaque target reference or authority material exposed.
P10 `02` also says the apply-then-advance consumer reads the P9 fact and writes
the Attention row in the same transaction as the consumer offset. P10 `07`
Story I requires duplicate suppression and the same single row after rebuild
and restart, without canonical-state mutation.

The existing implementation has no durable Attention DTO store. P1's generic
`ProjectionStoreLive` creates `projection_state(project_id, sequence,
event_type)` and inserts only those three values. `runConsumerBatch` calls
`projection.apply` and advances `consumer_offsets` inside one transaction, but
the generic projection marker contains no severity, target, dedup identity,
summary, or source-fact reference. The public Attention query still derives
rows from facts/events on demand.

The corrected isolated RED in
`tests/functional/pending/ah10-p10-attention-materialization.functional.test.ts`
creates the P9 fact and event through `RecoveryAttentionFactStore`, then runs
the existing generic P1 marker consumer against the P34 Attention store. It
confirmed offset 1 with zero P10 rows, and rebuild replayed the generic marker
without producing the missing Attention row. This red-to-green evidence is a
consumer integration test, not a real-process crash qualification.

The accepted DID v1.33 migration 0033 defines only the AssignWork target
binding and P9 failure-fact tables. It does not define a P10 projection-row
table or its reset contract. The P10 Attention mapping/rebuild story does not
specify row storage fields or project-scoped reset behavior. The current
generic `ProjectionStore.reset()` has no project argument, while P10 rebuild
is project-scoped. Adding a business table and wiring it to that generic reset
would therefore choose storage and cross-project reset semantics that are not
written down.

## Implemented disposition under the accepted P10 contract

Add a P10-owned durable Attention row store for event-backed materialized rows.
For this accepted AH10 source, the proposed row is:

| Field | Purpose |
|---|---|
| `project_id` | Projection and reset scope |
| `dedup_key` | Stable P10 row identity; equals P9 `attentionFactId` for this source |
| `source` | `AssignWorkTargetBindingFailure` |
| `severity` | `ActionRequired` |
| `target_workspace_id` | The Execution's owning Parent Workspace |
| `summary` | Fixed safe summary; excludes opaque target refs and authority evidence |
| `failure_code` | Typed P9 failure classification used by the detail view |
| `occurred_at` | Event occurrence time |
| `source_event_id` | Exact journal event provenance |
| `source_fact_id` | P9 `attentionFactId`; provenance only, not authority |

The row key is `(project_id, dedup_key)`, matching P10's existing
deduplicate-by-`dedupKey` read behavior. The consumer should load and validate
the exact P9 fact/event tuple, then upsert this row and advance the matching
Attention consumer offset within the same `TransactionPort` transaction.
Repeated delivery of the same fact/event must be an idempotent no-op. The
projection must not copy the opaque selector, Grant/Approval identifiers,
authority JSON, or other authority material into the row or public DTO.

The implemented project-bound `ProjectionStoreService` adapter delegates
`apply` to the P10 Attention store and closes `reset` over one `ProjectId`.
The existing `pollOnce` and `rebuildProjection` therefore retain their
apply-then-advance transaction while resetting only that project's Attention
rows. They do not reset the shared P1 `projection_state`. Rebuild replays
retained events through the same fact validation and row-upsert path. It does
not delete or rewrite P9 facts/events or canonical Work, Permission, or
Approval state. Existing subtree counts derive from the deduplicated rows;
they are not separately incremented or persisted.

The materialized row uses `executions.workspace_id` as its Parent target and
cross-checks it against the P9 fact. Migration 0034 adds
`attention_projection_rows`; accepted migration 0033 remains unchanged. The
P10 query reads this row for the AssignWork source and retains the existing
`summaryRef` public field. `failure_code` stays in the internal projection row;
the public DTO gains no field. No opaque selector or authority data is stored
or exposed.

## Focused implementation qualification

- A P9 fact/event is consumed into exactly one P10 row with the exact
  `attentionFactId`, `ActionRequired` severity, Parent target, safe summary,
  failure code, event time, and source provenance; subtree summary increases
  once.
- Duplicate event/fact replay creates no second row and no second subtree
  count. No opaque selector or authority material appears in persisted row or
  public Attention/Tree DTO.
- A forced projection failure after the row write rolls back both row and
  offset; retry commits both. Database close/reopen retains one row and the
  same checkpoint.
- A real daemon child is killed after P10 inserts the row but before the
  consumer transaction commits; neither row nor offset survives. A later
  daemon generation commits exactly one row/checkpoint, is killed after the
  poll returns, and another generation replays without duplication.
- Rebuild from an eligible retained event floor on fresh projection state
  reproduces exactly the incremental row and checkpoint. Rebuild one project
  does not erase another project's Attention rows.
- The production ProjectionQueryPort Attention and responsibility-tree views
  agree before/after restart and rebuild; Parent subtree `ActionRequired` is
  exactly one, and rebuilding one project leaves another project's Attention
  rows and P1 projection markers unchanged.
- Verify P9 fact/event and all canonical tables are unchanged by projection,
  restart, and rebuild. This case uses the real daemon and SQLite store with a
  test-only pause after the row write and before commit.

This disposition does not change `docs/design/**`. It records implementation
choices within the independently reviewed, already accepted P10 contract and
the focused real-process qualification in the result record.
