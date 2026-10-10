# P10 — 04 Business-Projection Rebuild at Scale (GQ2 handover from P9)

**Authority:** P9 `05` §3.2 (the four-item handover), §closure-reconciliation; P1 `05` §4/§6 (apply-then-advance; floor/reset/replay); DID v1.13 G1/G2; GQ ruling: projection-side retention only, journal horizon stays P1 `04`.
**Status:** DRAFT.

## 1. The four handover items (frozen)

1. **Incremental checkpoints**: each business projection persists its applied-watermark; catch-up resumes from checkpoint + 1 (never below pruned floor).
2. **Per-projection retention policy**: projection-side state lifecycle only (e.g., transcript paging windows, attention-row lifetime after underlying facts are superseded). **Journal horizon ownership stays with P1 `04` — unchanged.**
3. **Rebuild orchestration**: triggers = startup (after the P2 nine-step pass step 8), explicit operator command, detected drift (watermark < pruned floor ⇒ forced reset). Orchestration reuses the P9-hardened generic rebuild — the P9 closure reconciliation (DID v1.12 G2a) corrected the rewind to `floor−1` as an implementation correction restoring P1 `05` §6 full-replay semantics; P10 consumes that corrected form and changes nothing further (EffectiveFacts after raw fact views; Attention last).
4. **Query correctness**: after any rebuild path, the projection reaches the same state as incremental application from the same events (RB-4 semantics restated for business projections; per-view assertion in `07`).

## 2. Which projections are rebuildable materializations

- Materialized (checkpointed): Attention read-model rows, EffectiveFacts snapshot, Tree aggregates, Usage aggregates.
- On-read derived (no materialization): WaitingOnVacantProducer (a live join; "rebuild" = re-derive, trivially correct).
- **FT-DG-01 OPEN-3 activation Attention**: P10 stores a source-specific row in `workspace_resource_activation_attention_rows`, keyed by `(project_id, workspace_id, resource_boundary_revision)` and FK-bound to the P1 activation intent. The row is a materialized view only; the P1 intent table is the durable rebuild source. Journal retention never prunes or changes an intent.
- **Inbox (M1 fix)**: the P6 store is command-path maintained (not event-replayed), so its "rebuild" face is **state reconciliation** — a P10-owned audit pass comparing inbox_entries against canonical message/specialist-settlement facts (drift report + operator-triggered repair via the P6 admission paths, never direct writes). Projection-side retention: consumed entries' view lifetime is bounded (summary aging), underlying rows stay canonical (P6 semantics unchanged). Story E covers the reconciliation pass.

## 3. FT-DG-01 OPEN-3 Attention reset, intent snapshot, and offset rewind

The additive P10 source table is in the same forward-only migration as the P1
intent table (next migration after current `user_version=34`). It stores no
event FK, path, Profile identifier, or failure material, so a pending row
remains rebuildable after its original event is pruned:

```sql
CREATE TABLE workspace_resource_activation_attention_rows (
  project_id                 TEXT NOT NULL,
  workspace_id               TEXT NOT NULL,
  resource_boundary_revision INTEGER NOT NULL,
  occurred_at                TEXT NOT NULL,
  PRIMARY KEY (project_id, workspace_id, resource_boundary_revision),
  FOREIGN KEY (project_id, workspace_id, resource_boundary_revision)
    REFERENCES workspace_resource_activation_intents
      (project_id, workspace_id, resource_boundary_revision)
);

CREATE INDEX workspace_resource_activation_attention_target
  ON workspace_resource_activation_attention_rows
    (project_id, workspace_id, occurred_at);
```

The activation source must survive a journal-pruned P10 rebuild. For one
project, the rebuild's `BEGIN IMMEDIATE` / `TransactionScope` contains all of:

1. reset the P10 Attention projection rows, including activation-source rows;
2. read the P1 consumer's retained floor and rewind its Attention offset to
   `floor - 1` using the existing P9-hardened rebuild rule; and
3. read a consistent snapshot of the P1 `Pending` activation intents and seed
   exactly one path-free Attention row per intent into the activation source
   table.

These three operations commit or roll back together. P11 activation uses the
same SQLite `BEGIN IMMEDIATE` serialization point, so it cannot commit an
Active intent/event between the P10 intent snapshot and offset rewind. After
the reset transaction commits, replay retained journal events in project
sequence order through the ordinary generic consumer. A retained Pending
event re-upserts the same tuple; a retained Active event deletes it. If the
Pending event was pruned but its intent remains Pending, the seeded row remains
visible. If P11 commits Active after the reset snapshot, its later Active event
is above the rewind point and clears the seeded row during catch-up. The final
projection is therefore equivalent to incremental application without a
mixed-intent/offset snapshot, duplicate row, or missed Active transition.

The same atomic reset/snapshot/rewind rule applies to a startup rebuild, an
explicit operator rebuild, and detected projection drift. Rebuild never
changes the P1 intent, resource boundary, ownership claims, Project, or
receipt; it does not expose a Profile/path value. P1 remains the owner of the
event-journal pruning floor.

## 4. Must Not Decide

- No journal pruning/horizon change (P1 `04`).
- No P9 generic-mechanism change (this phase only configures/uses it).
- No cross-project rebuild (single project scope).
