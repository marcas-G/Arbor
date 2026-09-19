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
`03-transaction-model.md` §2) is an **upsert**, so a new project allocates its
first sequence without a pre-seeded row:

```sql
INSERT INTO project_event_sequences(project_id, last_sequence)
VALUES (?, 1)
ON CONFLICT(project_id) DO UPDATE SET last_sequence = last_sequence + 1
RETURNING last_sequence;
```

`DomainEventJournal.lastSequence(projectId)` returns `0` when the row is
absent.

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
- Consumers MUST tolerate a higher version by ignoring unknown OPTIONAL
  fields within a supported range (forward-compatible).
- If an event is unprocessable (a required field/version ceiling is exceeded,
  or any deterministic projection defect), it is a POISON EVENT:
    in the SAME transaction: write consumer_dead_letters(consumer_id,
    project_id, sequence, reason) AND advance consumer_offsets.last_sequence
    past that sequence (skip), then alert.
  The offset MUST advance past a quarantined sequence so the consumer never
  stalls (no head-of-line block). Operator reviews dead letters.
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
- `ConsumerOffsetStore.read` returns `0` when the row is absent; `advance`
  upserts.
- Processing a batch: apply each event in order; a poison event is
  dead-lettered and skipped; the offset advances to the last
  processed-or-quarantined sequence in the batch (never stuck on a poison
  event).
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
  pruned floor = MIN(domain_events.sequence) for the project (0 if none)
  refuse if consumer offset < pruned floor (events already pruned)
  reset consumer_offsets.last_sequence to the pruned floor
  replay domain_events in (project_id, sequence) order
```

`domain_events` is append-only before the retention horizon
(`04-sqlite-schema.md`); rebuild within retention is always possible.

## 7. Out of scope

- Projection query models (P10).
- Scheduler/coordination consumers (later phases).
- External projection stores.
