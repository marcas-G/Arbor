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

RAI-DG-01 freshness rule: Attention rebuilds reconstruct only Work-bound rows
whose validated source Execution Work Episode revision equals the canonical
Work revision in the same source snapshot (`02` §1.1). A rebuild, reset,
restart or delayed WorkSteered consumer must never revive an old-revision row.
This affects only active P10 projection rows; it does not delete or rewrite
canonical settlement/P9 source records. The P41 Submitted DecisionEpisode
marker remains governed by its exact P9 fact and separate accepted rebuild
contract.

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
event-journal pruning floor. The source-specific P12 reconciliation does not
invoke this generic rebuild and does not change its refusal/offset contract;
it can make only the activation source current while a generic
`ConsumerRebuildRefused` remains unresolved.

## 3.1 AH10 Deliver fact-backed Attention reset and rebuild

Accepted DID v1.38 storage correction SHA-256:
`040789D32BE1D92F1BAD28C5E3346439C1E902236452E778CD104AF6AA71EC8B`.
Deliver's P10 marker source is `deliver_replay_attention_rows`, keyed by and
FK-bound to P9's immutable `deliver_replay_attention_facts` row. The P9 fact
list, not retained MessageSent events, is the durable rebuild source; therefore
a pruned `DeliverReplayEscalated` event cannot erase an existing Attention
fact.

For one project, an authorized full P10 rebuild performs the following in one
`BEGIN IMMEDIATE` / `TransactionScope`:

1. reset the Deliver marker together with the other P10 source projections;
2. read the P1 retained floor and rewind the Attention consumer offset to
   `floor - 1` under the existing P9-hardened rebuild rule;
3. read one consistent `listDeliverReplayFailures(projectId)` P9 fact snapshot
   and insert one marker per returned `attentionFactId`; and
4. commit the reset, fact snapshot/seed and offset rewind together.

After commit, replay retained journal events in project-sequence order. The
P10 event consumer inserts the Deliver marker and advances its own project
offset in the same transaction; a marker primary-key conflict for the same
P9 fact is idempotent. The source reset, fact snapshot, marker inserts and
offset rewind either all commit or all roll back. A post-reset P9 fact/event
is above the rewind point and is applied by ordinary catch-up. P10 never
changes or removes the P9 fact, Message, MessageSent, Inbox, receipt, Work or
Dependency. This Deliver path does not change F21's source-specific
reset/refusal behavior or the accepted AH7/P36 offset rules; P37 remains
conditional on P36 integration.

## 3.2 AH7-DG-02 ReconciliationEscalated rebuild boundary (DID v1.40)

The accepted P9 `ReconciliationEscalated` source remains event-backed; P39 adds
no P10 marker or second source table. P10 full rebuild resets this existing
Attention row with its other event-derived rows and replays the retained P9
event stream from the P1 retained floor while atomically rewinding/advancing
the existing project offset. Duplicate
`(executionId,invocationRefsFingerprint)` is idempotent. P10 cannot rebuild an
event that has been pruned; the user-visible guarantee ends at the existing
journal-retention horizon. No indefinite attention storage or late
post-terminal contradiction notification is added.

P39 `tool_reconciliation_facts` remain P4-owned and are not directly consumed
as a P10 rebuild source. This preserves the accepted D0A P9→P10 event boundary.

## 3.3 AH7-DG-01 / P39-P40 replay-evidence marker rebuild (DID v1.41)

Accepted P40 physical hash:
`5B61E0FF922A10D225FD5DAEA00176BD16C5C0B39484D626B7FEF6340516373A`;
accepted P39/P40 compatibility addendum hash
`8B8E5D3C5729CF5619605DA8D8DF34BA00E1F817E80A743555029F331690E830` and
matrix hash `AD9AB72D0AA51AB84F4194EC2BF4BB90EC957BD062788C480BCBDD39B8E8DD35`.

`tool_observation_replay_attention_rows` is an event-backed P10 materialized
marker for the P9 `ToolObservationReplayEvidenceEscalated` fact/event. It uses
the same per-project P1 Attention consumer offset as all existing sources; row
write and offset advance are one transaction. Before-commit crash leaves
neither marker nor offset advance; after-commit restart/replay leaves one row.
`AttentionProjectionStore.resetProject` includes this marker; a full P10
rebuild resets it and rewinds the shared offset to `floor-1` atomically, then
replays retained P9 events. No P9 fact snapshot/level-triggered seed is added:
after event pruning, this source is visible only within the accepted retained
journal horizon. Below-floor reset/rebuild preserves current rows and returns
the existing `ConsumerRebuildRefused` contract; it does not silently repair or
change P39/P4/P3 state.

## 3.4 AH10 Submitted DecisionEpisode binding Attention rebuild (DID v1.42)

Accepted fixed proposal SHA-256:
`10D5A2532810B65DFBD3E397B141F6C0765AD32F4992BDDD0FE17F468975339A`;
acceptance/landing audit:
`planning/results/AH10-submitted-decision-binding-P41-governance-acceptance-and-landing.md`.

`submitted_decision_binding_attention_rows` is a P10 materialized marker; the
immutable P9 `submitted_decision_binding_attention_facts` list is its durable
rebuild source. This source specifically adds P9-fact snapshot seeding to
P10 `04` (unlike the retention-bounded P40 event-only source). For one project,
an authorized full Attention rebuild runs one SQLite `BEGIN IMMEDIATE` /
`TransactionScope` that atomically:

1. resets all Attention source rows, including this marker;
2. reads the P1 Attention retained floor and rewinds the shared offset to
   `floor - 1` under the existing P9-hardened rule;
3. reads one consistent P9 binding-failure fact snapshot and seeds exactly one
   marker per `attentionFactId`; and
4. commits reset, snapshot/seed and offset rewind together.

Then replay retained events in sequence order. The consumer validates a
`SubmittedDecisionBindingEscalated` event against its exact immutable P9 fact,
upserts the same marker, and advances the P1 Attention offset in one
transaction. Duplicate event/marker consumption is idempotent. If the source
event has been pruned but the P9 fact remains, full rebuild still reconstructs
one Attention row because the fact's `event_id` is audit-only and neither it nor
the P10 marker has an FK to `domain_events`; P10 marker remains FK-bound to the
P9 fact. Below-floor refusal behavior remains unchanged.

A pre-commit crash rolls back marker reset, snapshot/seed and offset rewind;
the previous projection remains. A post-commit/pre-catchup crash preserves
the fact-seeded marker and rewound offset; restart replay converges without
duplicates. SQLite writer serialization defines fact/rebuild races: a P9 fact
committed before the snapshot is seeded and replay is idempotent; a fact
committed after rebuild commit lies above the rewound offset and normal catchup
adds the marker. Qualify concurrent writers on each side of the rebuild
transaction, including when source events are pruned. P10 changes no P9 fact,
P1 event/floor, Execution, Step, Action, Work, Command, receipt or canonical
state. This source does not alter F21 reconciliation/refusal semantics or P1
retention ownership.

## 4. Must Not Decide

- No journal pruning/horizon change (P1 `04`).
- No P9 generic-mechanism change (this phase only configures/uses it).
- No cross-project rebuild (single project scope).

## Accepted AH10 DeliverReplay outbox/reconciliation amendment (DID v1.43)

The accepted v5+v6 package hashes and decision are recorded in
`planning/results/AH10-deliver-event-pruning-v6-governance-acceptance-and-landing.md`.
For the Deliver source, rebuild runs its existing full reset/seed/rewind
boundary in one `BEGIN IMMEDIATE` / `TransactionScope`: reset the Deliver
marker; read the P1 retained floor; snapshot all durable P9 Deliver facts;
insert/verify one marker per fact; ACK the pending queue rows only after each
marker exists; rewind the shared Attention offset to `floor - 1`; commit all
or roll back all. Rebuild ACKs are measured separately from steady queue
service.

P9 fact/outbox insertion and ordinary P1 pruning also use SQLite writer
transactions on this database. The rebuild therefore observes one serialized
side of a fact/queue or prune race. A fact committed before the snapshot is
seeded and any pending row is ACKed with its marker. A P9 fact committed after
rebuild commit remains pending and is discovered by bounded fact-to-marker
queue reconciliation even if its event is subsequently pruned. A poll begun
after rebuild reads the committed offset; a rebuild begun after a poll waits
for the full poll transaction. No event offset advancement may be used as a
proxy for draining the durable P9 queue.

The outbox poll uses the global dispatcher CAS/lease and attempt-fair
backoff defined by P1 `05` and DID v1.43. A valid lease cannot be stolen or
refreshed by another claimant; an expired crashed attempt is finalized once,
rotated and delayed, so due healthy Projects can continue. This scheduler
amendment does not promise completion for a repeatedly crashing Project and
does not change the single-Project full-rebuild scope or existing
below-retained-floor refusal behavior.

### P41 Submitted DecisionEpisode binding Attention source

The P41 marker in `submitted_decision_binding_attention_rows` is a P10
materialization of the immutable P9 fact, not of the journal event. For one
project, the existing full Attention rebuild transaction includes:

1. reset all Attention source rows for that project, including the P41 marker;
2. read the P1 retained floor and rewind the shared Attention offset to
   `floor - 1`;
3. read one consistent snapshot from
   `submitted_decision_binding_attention_facts` and seed exactly one marker
   for each fact; and
4. commit reset, seed and offset together before retained journal replay.

Replay validates the matching fact/event and converges idempotently. A failure
before commit preserves the previous marker/offset state; restart after commit
keeps seeded markers and the rewound offset. SQLite writer serialization
covers P9 fact creation on either side of the rebuild. Event pruning does not
remove the fact source; P1 continues to own retained-floor refusal and journal
retention. P10 rebuild does not mutate P9 facts, canonical Execution/Step/
Action, Work, selection, Command, receipt or journal event.
