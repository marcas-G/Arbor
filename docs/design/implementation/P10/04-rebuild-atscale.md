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
- **Inbox (M1 fix)**: the P6 store is command-path maintained (not event-replayed), so its "rebuild" face is **state reconciliation** — a P10-owned audit pass comparing inbox_entries against canonical message/specialist-settlement facts (drift report + operator-triggered repair via the P6 admission paths, never direct writes). Projection-side retention: consumed entries' view lifetime is bounded (summary aging), underlying rows stay canonical (P6 semantics unchanged). Story E covers the reconciliation pass.

## 3. Must Not Decide

- No journal pruning/horizon change (P1 `04`).
- No P9 generic-mechanism change (this phase only configures/uses it).
- No cross-project rebuild (single project scope).
