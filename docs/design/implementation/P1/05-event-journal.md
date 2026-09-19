# P1 — 05 Event Journal

**Authority:** DID v1.5 §2.3, §5.1–§5.4, §9.9
**Status:** P1 phase-scoped closure (draft for review)
**Closes:** P1-DG-06 (sequence scope, `eventVersion` policy, offset
atomicity); the event-journal DDL is in `04-sqlite-schema.md`.

## 1. Sequence scope (frozen)

DID §2.3 allows "Project-local sequence **或** journal partition sequence".
P1 freezes **Project-local monotonic sequence**:

```text
sequence = lastSequence(project_id) + 1
allocated inside the semantic command transaction
UNIQUE(project_id, sequence)
```

Rules:

- Allocation happens in the same transaction as the canonical write and the
  event insert; a rollback also rolls back the allocation → **no gaps** for
  committed events.
- SQLite write serialization (`BEGIN IMMEDIATE` for write scopes) makes
  concurrent allocation safe.
- Consumers order strictly by `(project_id, sequence)`.
- `EventId` and `EventSequence` remain distinct (DID §2.3).

## 2. Append contract

```text
DomainEventJournal.append(events)
  - requires TransactionScope
  - events are appended in the order emitted by the command
  - each event receives the next project-local sequence
  - payload stored as JSON in domain_events.payload_json
  - atomic with canonical state + Committed receipt (DID §12.6)
```

`domain_events` is the durable outbox (DID §9.9); there is no separate
delivery-flag table.

## 3. `eventVersion` policy (frozen)

```text
- Each event type starts at eventVersion = 1.
- eventVersion is per event type, not global.
- Consumers MUST tolerate a higher version by ignoring unknown fields.
- v1 performs NO upcasting; a consumer that cannot handle a version records
  a projection error and retries/catches up (DID §5.4).
```

## 4. Consumer offset / projection transaction boundary (frozen)

Each consumer owns a `(consumer_id, project_id)` offset row. To make
at-least-once delivery safe:

```text
transact {
  read events after consumer.last_sequence (batch)
  apply projection writes
  advance consumer_offsets.last_sequence to the batch end
}
COMMIT
```

- Offset advance and projection write are in the **same transaction**
  (apply-then-advance) → a crash re-delivers the batch and re-applies it.
- Consumers are therefore required to be **idempotent** (deterministic
  re-apply). Projection failure never rolls back the domain transaction
  (DID §5.4).
- `consumer_offsets` is keyed `(consumer_id, project_id)` and is never
  deleted; rebuild = reset offset to 0 and replay.

## 5. Duplicate delivery / event→command

```text
- at-least-once delivery (DID §5.4)
- Event→Command uses a deterministic CommandId so redelivery is idempotent
- Consumer never mutates Domain except through a Command handler
- Events notify; canonical state decides
```

## 6. Rebuild

```text
Projection rebuild:
  reset consumer_offsets.last_sequence = 0 for that consumer/project
  replay domain_events in (project_id, sequence) order
```

`domain_events` is append-only before the retention horizon
(`04-sqlite-schema.md` §6), so rebuild is always possible within retention.

## 7. Out of scope

- Projection query models (P10).
- Scheduler/coordination consumers (later phases).
