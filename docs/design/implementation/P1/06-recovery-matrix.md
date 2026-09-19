# P1 — 06 Recovery Matrix

**Authority:** DID v1.5 §7.4, §12.5, §12.6, §9.1, §9.9, §6A.5, §5.4
**Status:** P1 phase-scoped closure (draft for review)
**Closes:** the P1 crash-point matrix.

Because P1 uses **one transaction per semantic command** (no durable
`Pending`, no dual transaction), several hypothetical crash points collapse
into "transaction not committed". The matrix below is the frozen contract.

## 1. Command transaction crash points

| # | Crash point | Durable observation | Recovery action | Guarantee |
|---|---|---|---|---|
| C1 | before transaction starts | nothing | caller retries same CommandId | no resolution |
| C2 | after BEGIN, before any write | nothing (rolled back) | caller retries same CommandId | no resolution |
| C3 | after canonical writes, before event append | nothing (same tx, rolled back) | caller retries | atomicity |
| C4 | after event append, before COMMIT | nothing (same tx, rolled back) | caller retries | atomicity |
| C5 | during COMMIT | SQLite WAL: committed **or** not | re-read `commands` row by CommandId | all-or-nothing |
| C6 | after COMMIT, before response | `commands` row + canonical state + events | same CommandId retry returns existing Receipt | idempotent replay |
| C7 | concurrent duplicate command | one tx commits; the other sees conflict | loser re-reads `commands` row → existing Receipt | single authoritative resolution |
| C8 | process crash mid-transaction | nothing (WAL rollback on restart) | retry | no partial state |
| C9 | SQLITE_BUSY / rollback | nothing | `TransactionOperationalFailure` → bounded retry / new `CommandAttempt` | non-authoritative |

Notes:

- "After command registration" is **not** a durable point in P1: the
  `commands` row is written only with its authoritative resolution inside
  the transaction (DID v1.5 §9.9). There is no `Pending` row to reconcile.
- C3/C4 are listed for completeness; they cannot produce durable partial
  state because writes and events share one transaction.

## 2. Operational failure handling

```text
TransactionOperationalFailure (PersistenceUnavailable, SQLITE_BUSY, …):
  - no commands row written/unchanged
  - record command_attempts(outcome = RetryableOperationalFailure)
  - bounded retry (attempt_no++); same CommandId, unchanged fingerprint
  - changing the semantic request requires a NEW CommandId (DID §4.1)
```

`command_attempts` is a non-authoritative trace (no FK to `commands`).

## 3. Consumer / projection crash points

| # | Crash point | Durable observation | Recovery action |
|---|---|---|---|
| P1 | after projection writes, before COMMIT | nothing (offset+projection same tx) | re-deliver batch, re-apply |
| P2 | after COMMIT, before next batch | offset advanced | continue from offset |
| P3 | projection apply throws | offset not advanced | retry / catch-up (DID §5.4) |

Projection failure never rolls back the domain transaction (DID §5.4).
Consumers must be idempotent (deterministic re-apply).

## 4. Resource-ownership transaction

| Crash point | Recovery |
|---|---|
| after resolve, before `BEGIN IMMEDIATE` | re-resolve |
| inside `BEGIN IMMEDIATE`, before COMMIT | rollback; re-resolve; `ResourceResolutionStale` if environment revision changed |
| after COMMIT | claims durable |

Resolve/canonicalize happens outside the write transaction (DID §9.5).

## 5. Migration

| Crash point | Recovery |
|---|---|
| during migration transaction | rollback; `PRAGMA user_version` unchanged; re-run |
| after migration COMMIT | `user_version` advanced |

## 6. Explicitly not covered in P1

- Worker crash / lease expiry / old-worker resurrection (P2, DID §3.4/§9.7).
- Provider disconnect, tool `OutcomeUnknown` reconciliation (P3/P4).
- Projection rebuild at scale (P9/P10).
