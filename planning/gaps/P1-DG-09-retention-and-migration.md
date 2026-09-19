# P1-DG-09 — Retention / delete policy and migration mechanism

## Status

OPEN — awaiting manual governance.

## Owning design document

`docs/design/03-detailed-implementation-design.md` §9.1, §12.11, §5.4, §6A.4.

## Symptom

1. Delete/retention is not frozen. §12.11 enumerates immutable durable
   records; §5.4:1388 requires projection "rebuild" (implying event
   retention); §9.1:2731 defines backup/RPO but no retention. `commands`,
   `command_attempts`, `domain_events`, `consumer_offsets` are unbounded.
   Whether SQL `DELETE` is permitted, and archival/compaction windows, are
   unstated.
2. Migration/schema-versioning mechanism is not frozen. §13 declares
   migration a P1 blocker; §6A.4:1571 references a "合法 migration 路径"; no
   version storage (`PRAGMA user_version`?), migration-file convention, or
   forward/backward policy is named.

## Evidence

```text
DID §9.1:2731   DurabilityEnvelope / backup / RPO (no retention)
DID §12.11      immutable durable records
DID §5.4:1388   projection rebuild
DID §13:3734    SQLite exact DDL / migration / indexes — P1 BLOCKER
DID §6A.4:1571  legal migration path
```

## Why planning cannot decide this

Retention/delete semantics and the migration/versioning contract are
**persistence governance** decisions.

## Required resolution

Freeze: append-only vs delete rules per table; retention/archival horizons;
and the migration mechanism (version storage, file convention, startup
compatibility rule).

## Affected P1 areas

DDL, migration, journal retention, consumer offsets.
