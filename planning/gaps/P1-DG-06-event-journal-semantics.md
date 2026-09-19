# P1-DG-06 — Event journal semantics: sequence scope, eventVersion, offset atomicity

## Status

RESOLVED — P1 contract 05-event-journal.md (4-way review round 4, Blocking=0).

## Resolution

Project-local monotonic sequence with a durable `project_event_sequences`
counter (upsert, survives retention pruning); `eventVersion` forward-tolerant
with poison quarantine (`consumer_dead_letters`) + offset skip (no stall);
offset/projection co-located in one transaction with re-apply key
`(project_id, sequence)`.

Authority: DID v1.6 §2.3/§5.2/§5.4/§9.9; `docs/design/implementation/P1/05-event-journal.md`, `04-sqlite-schema.md`.


## Owning design document

`docs/design/03-detailed-implementation-design.md` §2.3, §5.2, §5.4, §9.9.

## Symptom

1. Sequence scope is an explicit either/or: §2.3:779 "Project-local sequence
   **或** journal partition sequence". This determines the DDL unique
   constraint and `consumer_offsets` key.
2. `eventVersion` policy is undefined (initial value, per-type vs global,
   unknown-version handling). P0 types it `number`.
3. Consumer offset vs side-effect atomicity: §5.4:1384-1389 mandates
   at-least-once and that projection failure not roll back the domain tx,
   but is silent on whether the offset advances in the same transaction as
   the projection write (advance-then-apply loses events; apply-then-advance
   duplicates).
4. Whether event sequences must be gap-free under concurrent writers is
   unstated.

## Evidence

```text
DID §2.3:779    Project-local sequence 或 journal partition sequence
DID §5.2:1322   envelope.sequence
DID §5.2:1324   envelope.eventVersion
DID §9.9:2921   domain_events outbox + consumer_offsets
DID §5.4:1384   at-least-once; projection failure 不回滚 domain transaction
```

## Why planning cannot decide this

Ordering, versioning, and consumer-delivery atomicity are **event/journal
semantics**.

## Required resolution

Freeze: one sequence mechanism (+ gap-freeness); `eventVersion` start and
compatibility policy; and the offset/projection transaction boundary with
duplicate-handling.

## Affected P1 areas

`domain_events` / `consumer_offsets` DDL, journal contract, projections.
