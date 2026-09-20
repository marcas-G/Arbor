# P1 — 03 Transaction Model

**Authority:** DID v1.6 §7.4, §12.6, §6.3, §6A.15, §9.1, §9.7
**Status:** P1 phase-scoped closure (revised after 4-way review)
**Implements:** concrete transaction mechanism; supports P1-DG-02 / P1-DG-04.

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

## 2. Frozen mechanism — `TransactionScope` service

Chosen from the three DID options: **TransactionScope service**, implemented
as an Effect `Context.Tag` whose service carries the **live adapter session**
(not a bare string), so the type system enforces propagation.

```ts
// owning package: ports
class TransactionScope extends Context.Tag("arbor/TransactionScope")<
  TransactionScope,
  { readonly session: AdapterSession }   // opaque; domain/application never see SQL
>() {}

interface TransactionPort {
  readonly transact: <A, E, R>(
    body: Effect.Effect<A, E, R | TransactionScope>
  ) => Effect.Effect<A, E | TransactionOperationalFailure, Exclude<R, TransactionScope>>
}
```

Rules:

- `TransactionPort.transact` opens exactly one DB transaction and provides
  one `TransactionScope` to `body`.
- Every P1 Repository method **requires `TransactionScope`** in `R` and never
  opens its own connection. Repository methods take no raw `sessionId`.
- The adapter issues `BEGIN IMMEDIATE` explicitly (not the driver's default
  deferred transaction) to guarantee write serialization.
- Nested `transact` is forbidden; the adapter detects re-entry by the presence
  of a `TransactionScope` in the environment and rejects it.
- **Every `transact` scope uses `BEGIN IMMEDIATE`** (SQLite), including command
  scopes that append events / allocate the project sequence. This serializes
  writers and makes sequence allocation safe (see `05-event-journal.md`).
  `foreign_keys = ON`, WAL, `busy_timeout` (DID §9.1).
- The transaction is the **only** place `commands` rows, canonical state, and
  `domain_events` are written.

## 3. Sequences

### 3.1 Successful / replay / conflict (single transaction)

```text
transact {
  load commands row by command_id
  if row exists (Committed | TerminalRejected):
      if stored.semantic_request_fingerprint == incoming.fingerprint
         AND stored.schema_version == incoming.schemaVersion
         AND stored.fingerprint_algorithm_version == incoming.algorithmVersion:
           return existing Receipt            // no domain re-execution
      else:
           return TerminalRejected(IdempotencyConflict)   // deterministic replay response; the existing row is not overwritten
  if ExecutionOrigin:
      fence check   (see §4)
      stop check    (see §4)
  load canonical state (required aggregates)
  authority / preconditions / invariants
  apply domain transition
  write canonical state
  write Committed receipt + result_json
  append Domain Events (Committed only)
  recordResolvingAttempt(Committed)
}
COMMIT
```

Atomic: canonical state + Committed receipt + events.

### 3.2 Terminal semantic rejection (single transaction)

```text
transact {
  load commands row
  consistent canonical read
  evaluate terminal rejection
  write TerminalRejected receipt + terminal_error_json
  recordResolvingAttempt(TerminalRejected)
}
COMMIT
```

No Domain Event. `terminal_error_json` carries a `CommandRejection`
(DID §6A.15).

### 3.3 Retryable operational failure (no authoritative resolution)

```text
transact { ... } ROLLBACK
→ no commands row written / unchanged
→ in a SEPARATE short transaction (outside the failed scope):
     CommandStore.recordRetryableAttempt(commandId, failureKind, startedAt, settledAt)
→ same CommandId may retry with unchanged semantic request
```

`TransactionOperationalFailure` (e.g. `PersistenceUnavailable`, `SQLITE_BUSY`,
`SQLITE_BUSY_SNAPSHOT`) is **not** a `CommandRejection` and never produces a
receipt. The attempt trace write uses its own connection/transaction; it is
non-authoritative and may be lost on crash (see `06-recovery-matrix.md`).

### 3.4 Concurrent duplicate attempt (commit-conflict protocol)

DID §7.4 requires one authoritative resolution. Protocol:

```text
attempt A and attempt B race on the same command_id
- both begin (BEGIN IMMEDIATE serializes; B waits or gets SQLITE_BUSY)
- winner commits the commands row
- loser, on COMMIT:
    * PK conflict on commands.command_id  OR
    * SQLITE_BUSY / BUSY_SNAPSHOT (operational)
  -> ROLLBACK the loser scope
  -> re-read commands row by command_id
       exists + fingerprint matches  -> return existing Receipt
       exists + fingerprint differs  -> IdempotencyConflict
       absent (winner still in flight / operational) -> bounded retry, new CommandAttempt
```

No blind retry after an authoritative conflict.

## 4. Fence and stop checks (P1 hook; P2 lease)

Two **independent** checks (DID §9.7 / §6A.15):

```text
1) fence validation (ownership/generation)
     invalid -> CommandRejection.FencingRejected
2) stop / quiescence admission
     fence valid but stopRequestedAt != null
     -> CommandRejection.ExecutionStopping   (NOT FencingRejected)
```

The checks must be evaluated separately so the caller can distinguish the
outcomes (exact SQL in `04-sqlite-schema.md` §4). `FencingRejected` and
`ExecutionStopping` are **terminal**: they are persisted via the §3.2 path as
a `TerminalRejected` receipt (no Domain Event), per DID §9.9. P1 provides the
hook; P2 provides lease acquisition/renewal/loss and the generation source. In
P1 all commands are `External`/`System`, so the hook is inert and tested with
a stub.

## 5. Effect channels

```text
TransactionPort.transact
  A = body success
  E = body E | TransactionOperationalFailure
  R = (body R minus TransactionScope)

Repository method
  A = typed result (ADT / Option where absence is a normal alternative)
  E = <RepositoryName>Error        // per-repository semantic error, NOT a catch-all
  R = TransactionScope
```

- There is **no** universal `RepositoryError` (DID §6A.2 / §0A.6). Each
  repository declares its own narrow error (e.g. `ProjectRepositoryError`).
- CAS failures are typed errors of the owning repository (e.g.
  `RevisionConflict`); they are not a generic persistence error.
- Adapter-specific errors (`SqliteError`, …) are translated at the adapter
  boundary and never appear in a port `E` (DID §0A.6).

## 6. Open items closed here

- Concrete transaction mechanism (`TransactionScope` Effect service).
- `BEGIN IMMEDIATE` for all write scopes (with `05`).
- Single-transaction command resolution + fingerprint comparison (with `01`).
- Concurrent duplicate-attempt protocol.
- Fence/stop two-check split (with `04`).

## 7. P0 artifact evolution (P1 owns)

P1 evolves these P0 artifacts (P0→P1 contract evolution, not a P0 reopen):

```text
CommandResolution<R>          -> CommandResolution<Result, Rejection>
                                 (Domain instantiates DomainError; Application CommandRejection)
semanticRequestFingerprint    -> SHA-256 canonical v1 (P0 32-bit FNV-1a superseded)
work.assignWork branch        -> RetirePreconditionFailed superseded by TerminalLifecycleMutation
```

## 8. Out of scope

- Lease lifecycle (P2).
- Exact SQL text for fence/CAS (04).
- Offset/projection transaction boundary (05).
