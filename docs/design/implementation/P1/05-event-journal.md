# P1 — 05 Event Journal

**Authority:** DID v1.6 §2.3, §5.1–§5.4, §9.9
**Status:** P1 phase-scoped closure (revised after 4-way review)
**Closes:** P1-DG-06 (sequence scope, `eventVersion` policy, offset atomicity).

## 1. Sequence scope (frozen)

DID §2.3 allows "Project-local sequence **或** journal partition sequence".
P1 freezes **Project-local monotonic sequence**, backed by a **durable
counter** independent of event rows:

```sql
project_event_sequences (
  project_id     TEXT PRIMARY KEY,
  last_sequence  INTEGER NOT NULL
)
```

Allocation (inside the command transaction, which uses `BEGIN IMMEDIATE`,
`03-transaction-model.md` §2):

```sql
UPDATE project_event_sequences
   SET last_sequence = last_sequence + 1
 WHERE project_id = ?
RETURNING last_sequence;
```

Rules:

- Allocation happens in the same transaction as the canonical write and the
  event insert; a rollback also rolls back the counter → **no gaps** for
  committed events.
- `BEGIN IMMEDIATE` serializes writers, so concurrent allocation is safe.
- The counter is **not** derived from `domain_events` rows, so retention
  pruning cannot reset it.
- Consumers order strictly by `(project_id, sequence)`.
- `EventId` and `EventSequence` remain distinct (DID §2.3).
- Guarantee is "no gaps at commit time"; consumers must not depend on
  gap-freeness across pruning.

## 2. Append contract

```text
DomainEventJournal.append(events)
  - requires TransactionScope
  - appended in emitted order; each receives the next project-local sequence
  - payload stored as JSON in domain_events.payload_json
  - atomic with canonical state + Committed receipt (DID §12.6)
```

`domain_events` is the durable outbox (DID §9.9); no separate delivery flag.

## 3. `eventVersion` policy (frozen)

```text
- Each event type starts at eventVersion = 1 (per type, not global).
- Consumers MUST tolerate a higher version by ignoring unknown fields
  (forward-compatible).
- If a consumer cannot process a version, it is a PROJECTION DEFECT:
    quarantine the event (dead-letter table) + alert + operator decision.
  It must NOT block the offset forever (no head-of-line stall).
- v1 performs NO upcasting.
```

## 4. Consumer offset / projection boundary (frozen)

Offset advance and projection write are in the **same SQLite database and
the same transaction** (apply-then-advance), so a crash re-delivers and
re-applies:

```text
transact {
  read events after consumer.last_sequence (batch)
  apply projection writes (same DB)
  advance consumer_offsets.last_sequence to batch end
}
COMMIT
```

- Re-apply idempotency key: `(project_id, sequence)` (equivalently `event_id`).
- Projections to an external store are **out of P1 scope**; P1 projections
  are co-located with `consumer_offsets`.
- Projection failure never rolls back the domain transaction (DID §5.4).
- `consumer_offsets` keyed `(consumer_id, project_id)`, never deleted.
- Single-flight per `(consumer_id, project_id)`; concurrent dispatchers rely
  on `BEGIN IMMEDIATE` + idempotent re-apply.

## 5. Duplicate delivery / event→command

```text
- at-least-once delivery (DID §5.4)
- Event→Command uses a deterministic CommandId so redelivery is idempotent
- Consumer never mutates Domain except through a Command handler
```

## 6. Rebuild

```text
Projection rebuild:
  refuse if consumer offset < the pruned floor for that project
  reset consumer_offsets.last_sequence = 0 (or pruned floor)
  replay domain_events in (project_id, sequence) order
```

`domain_events` is append-only before the retention horizon
(`04-sqlite-schema.md`); rebuild within retention is always possible.

## 7. Out of scope

- Projection query models (P10).
- Scheduler/coordination consumers (later phases).
- External projection stores.
