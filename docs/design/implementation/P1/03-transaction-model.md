# P1 — 03 Transaction Model

**Authority:** DID v1.5 §7.4, §12.6, §6.3, §6A.15, §9.1, §9.7
**Status:** P1 phase-scoped closure (draft for review)
**Closes:** A3 (concrete transaction mechanism); supports P1-DG-02 / P1-DG-04.

This document freezes the concrete transaction interface that DID §7.4 leaves
open ("v1.2 不冻结具体机制，只冻结可观察保证"). It does not change the DID.

## 1. Observable guarantee (from DID §7.4 / §12.6)

```text
One semantic Command = ONE transaction-scoped DB session.

Within that scope:
  all participating Repository reads/writes
  authoritative fence validation (ExecutionOrigin)
  Command resolution
  DomainEventJournal append
observe/write through the same transactional DB session.
```

A `transact()` wrapper around repositories that each open their own
connection is **not** compliant.

## 2. Frozen mechanism

Chosen from the three DID options: **TransactionScope service**.

```ts
// owning package: ports (see 02-port-contracts.md)
interface TransactionScope {
  // opaque adapter session handle; domain/application never see SQL
  readonly sessionId: string
}

interface TransactionPort {
  readonly transact: <A, E, R>(
    body: Effect.Effect<A, E, R | TransactionScope>
  ) => Effect.Effect<A, E | TransactionOperationalFailure, Exclude<R, TransactionScope>>
}
```

Rules:

- `TransactionPort.transact` opens exactly one DB transaction and provides one
  `TransactionScope` to `body`.
- Every P1 Repository method **requires** `TransactionScope` in `R`; it never
  opens its own connection.
- Nested `transact` is forbidden; the adapter rejects re-entry.
- SQLite adapter uses `BEGIN IMMEDIATE` for ownership-changing scopes (§9.5)
  and `BEGIN` otherwise; `foreign_keys = ON`, WAL, `busy_timeout` (§9.1).
- The transaction is the **only** place `commands` rows, canonical state, and
  `domain_events` are written.

## 3. Sequences

### 3.1 Successful mutation (single transaction)

```text
transact {
  load logical Command (commands row)            // fingerprint / idempotency
  if already Committed | TerminalRejected:
      return existing Receipt                    // no domain re-execution
  if ExecutionOrigin: validate authoritative fence
  load canonical state (required aggregates)
  authority / preconditions / invariants
  apply domain transition
  write canonical state
  write authoritative receipt (Committed + result_json)
  append Domain Events (Committed only)
}
COMMIT
```

Atomic: canonical state + Committed receipt + events.

### 3.2 Terminal semantic rejection (single transaction)

```text
transact {
  load logical Command
  consistent canonical read
  evaluate terminal rejection
  write authoritative receipt (TerminalRejected + terminal_error_json)
}
COMMIT
```

No Domain Event. `terminal_error_json` carries a `CommandRejection`
(DID §6A.15).

### 3.3 Retryable operational failure (no authoritative resolution)

```text
transact { ... } ROLLBACK
→ no commands row written / unchanged
→ record command_attempts (non-authoritative trace; outcome = RetryableOperationalFailure)
→ same CommandId may retry with unchanged semantic request
```

`TransactionOperationalFailure` (e.g. `PersistenceUnavailable`, SQLITE_BUSY)
is **not** a `CommandRejection` and never produces a receipt.

## 4. Fence validation hook (P1 vs P2)

- P1 provides the **hook**: the canonical mutation path evaluates the
  authoritative fence inside the transaction, before canonical writes.
- P2 provides lease acquisition/renewal/loss and the concrete generation
  source.
- Two independent checks (DID §9.7 / §6A.15):

```text
fence invalid (ownership/generation)      → CommandRejection.FencingRejected
fence valid but stopRequestedAt != null   → CommandRejection.ExecutionStopping
```

The exact SQL predicate is frozen in `04-sqlite-schema.md`.

## 5. Effect channels

```text
TransactionPort.transact
  A = body success
  E = body E | TransactionOperationalFailure
  R = (body R minus TransactionScope)

Repository method
  A = typed result
  E = RepositoryError (adapter-specific, translated at the boundary)
  R = TransactionScope | Repository
```

`RepositoryError` never crosses the application semantic boundary (DID §0A.6).

## 6. Open items closed here

- Concrete transaction mechanism (TransactionScope service).
- Single-transaction command resolution (with 01/04/05).
- Fence validation hook ownership (with 04).

## 7. Out of scope

- Lease lifecycle (P2).
- SQL text for fence/CAS (04).
- Offset/projection transaction boundary (05).
