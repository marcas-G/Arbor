# P1 — 03 Transaction Model

**Authority:** DID v1.6 §7.4, §12.6, §6.3, §6A.15, §9.1, §9.7; accepted DID v1.52 F23 P6 operator rebuild / v1 route-command qualification.
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

For an External request, transport authentication, strict wire-v1 codec,
Handler schema/fingerprint derivation, exact Actor/Principal binding, and the
P12 Resolver visibility check complete in Application/Composition **before**
`TransactionPort.transact` begins. This boundary performs no receipt read.
Once the Gateway opens the transaction, the existing receipt-first sequence
below remains intact: `BEGIN IMMEDIATE` reads and compares the exact receipt
tuple before the final in-transaction authority check. It is the sole receipt
linearization point. The direct-child AssignWork Command/Work/Event/binding/
ActionApproval atomic transaction under DID §6A.16/§9.9 is unchanged.

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
  if row absent and authority is RetryVerificationReplayOnlyAuthority:
      fail PersistenceCorruption<"CommandStore">  // roll back; no attempt/handler/write
  if ExecutionOrigin:
      fence check   (see §4)
      stop check    (see §4)
  authority exact-match (01 §2A: VerifiedCommandAuthority vs
                         envelope / submissionContext / fingerprint / payload)
      mismatch -> TerminalRejected(AuthorityDenied)   // §3.2 path, no event
  load canonical state (required aggregates)
  preconditions / invariants
  apply domain transition
  write canonical state
  if this is a successful RetryVerification:
      write immutable retry_verification_origins fact in this transaction
  write Committed receipt + result_json
  append Domain Events (Committed only)
  recordResolvingAttempt(Committed)
}
COMMIT
```

The existing-receipt branch precedes the final in-transaction authority check:
an authorized resolution is replayed **without** re-running the authority
predicate (P1-DG-11). External requests have already passed the P12 current
visibility/authorization check before this Gateway transaction begins.
Authority is not part of `semanticRequestFingerprint`. The P8
`RetryVerificationReplayOnlyAuthority` is a narrow exception to the absent-row
continuation only: it is usable on an existing exact receipt, while the
existing-row tuple mismatch still returns `IdempotencyConflict`; an absent
receipt fails closed as `PersistenceCorruption<"CommandStore">` and cannot
fall through to the handler.

For the exact-tuple existing-receipt branch, the Application decoder specified
by `01-command-contracts.md` §3A runs inside this same transaction, after the
tuple comparison. If its result/error JSON or DTO shape fails, the transaction
rolls back and returns the non-command
`PersistenceCorruption<"CommandStore">` failure; the existing row is
unchanged, no handler/canonical/event/receipt write occurs, and no
`recordRetryableAttempt` is written. This failure is not a retryable
`TransactionOperationalFailure` and cannot become a receipt or
`TerminalRejected`. No data repair is attempted.

Atomic: canonical state, optional P8 retry origin (for successful
RetryVerification), Committed receipt, and Events.

**FT-DG-01 OPEN-3 operational successor:** a non-empty Profile CreateProject
also writes its `WorkspaceResourceActivationIntent(Pending)` and
`WorkspaceResourceActivationChanged(Pending)` in this same command scope, in
addition to the unchanged ProjectCreated/WorkspaceCreated v1 events. These
remain committed together; later activation failure is post-commit and cannot
roll back this command or manufacture a second receipt. The separate P11
activation operation resolves the persisted boundary before opening its write
scope, then commits the claim set + Pending→Active CAS + Active event in one
`BEGIN IMMEDIATE` transaction. It does not nest the existing self-transactional
`OwnershipWriteService.resolveAndWrite` call.

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

No v1 P1 command changes canonical Work owner or Workspace Parent, so the
command-level UnboundLegacy route-move/terminal-rejection branch and its
receipt-commit crash qualification are N/A for v1 only. This does not make the
same-key route helper or future-command invariant N/A. If a future separately
governed P1 command changes the recipient and cannot move the stable Inbox key
in the same command transaction, it uses this ordinary terminal-rejection
path with the existing `AuthorityDenied` (or narrowest existing typed
rejection). The transaction commits the normal `TerminalRejected` receipt and
resolving attempt, while committing no canonical Work/Workspace/owner mutation,
Domain Event, Inbox route mutation or UnboundLegacy disposition mutation. The
same CommandId and tuple replays this receipt; a different CommandId
independently reaches the rejection. A crash before COMMIT leaves neither the
rejection receipt/attempt nor canonical changes; a crash after COMMIT preserves
the receipt/attempt and still leaves canonical/Inbox/disposition state
unchanged. This path enters through Gateway and performs no pre-Gateway receipt
read/rejection. If a future Inbox move can be done, it shares the P1 command
transaction with the canonical owner/Parent change.

The accepted P6 operator rebuild is not an Application Command or online
Gateway transaction. The local operator CLI runs only against the stopped
current schema-48 primary under P39 `MaintenanceExclusive`; it invokes the
existing P6 Inbox repository helper in a single `TransactionPort` transaction
on the same P39 primary SqlClient connection. P39's report sidecar and writer
lock are separate infrastructure files; the JSONL manifest is separate audit.
The operation changes only stable-key Inbox projection rows and never writes a
Command receipt/attempt, Domain Event or canonical owner/disposition row. The
P39 sidecar's pre-permit `wx` creation/validation may persist on lock refusal,
but the primary, P6 rows and JSONL manifest remain untouched.

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
Failure of that best-effort trace must not replace, defect, or otherwise mask
the original typed `TransactionOperationalFailure`.

Only the frozen `TransactionOperationalFailure` class follows this §3.3
retryable-attempt path. A receipt JSON/schema `PersistenceCorruption` is a
non-retryable integrity failure and must not be relabeled as this class or
recorded by `recordRetryableAttempt`.

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

For DID v1.20 AgentLoopStep takeover this terminality remains per `CommandId`.
`07` freezes the outer logical ledger and permits a new owner to create a new
generation-scoped CommandId only after reading existing receipts and proving
the logical action is still eligible. It is never a retry of the terminal
CommandId and never overwrites its receipt.

> **P2 evolution (DID v1.7 G1):** `FenceStopCheck.check(context, stopAdmission)`
> receives an explicit `StopAdmission` ADT; `QuiescenceControlMutation` is
> admitted after `stopRequestedAt != null` while still being fence-checked. See
> `docs/design/implementation/P2/01-command-contracts.md` §3 and `02` §4.

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
- `CommandHandlerError` is the closed union of normalized Port failures that
  command handlers may expose. A handler must not convert a declared
  repository failure into a defect merely because that repository was added
  after P1. Such a failure rolls back the transaction and produces no Receipt.

### 5.1 Implementation boundaries

The Application implementation keeps these responsibilities separate while
preserving the public `gateway.ts` export surface:

- `gateway-contracts.ts`: command/gateway Effect contracts and error union;
- `command-handler-registry.ts`: command-type lookup;
- `project-admission.ts`: bootstrap/open/closed lifecycle admission policy;
- `fence-stop.ts`: execution-origin admission service contract;
- `command-receipt.ts`: stored Receipt decoding and Receipt construction;
- `gateway.ts`: transaction orchestration only.

The SQLite adapter separates Project, Workspace, Work and Session repositories
by aggregate. `repositories.ts` is a compatibility barrel only. This is an
implementation boundary; transaction scope, SQL, CAS and Port contracts are
unchanged.

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

## Accepted AH14 P9 fact and resolution transaction boundary (DID v1.49)

Accepted token `ACCEPT_AH14_LEGACY_ADOPTION_EVIDENCE_ATTENTION_GOVERNANCE`,
proposal raw SHA-256
`71F81F8B61375B9828FAB208D517FBF2CE0092C0B71ECCD124353262E23FCFB1`,
accepted 2026-10-17. The P9 legacy-adoption evidence failure event and
immutable fact share one current-lease-fenced `TransactionScope`: before
commit neither exists; after commit both exist; storage failure claims no
durable Attention. Exact retry returns the same pair, and a conflicting tuple
is a typed invariant failure.

Evidence-driven resolution writes the P9 resolution event/fact atomically
with the ordinary AgentLoopStep adoption/progression it authorizes. The
resolution must prove the entire original non-empty decoded action set and
exact terminal P4 evidence under P9 `07`; partial or conflicting proof commits
neither resolution nor progression. Exact replay returns the immutable
resolution, and a different tuple cannot replace it. This amendment does not
alter `TransactionScope`, `BEGIN IMMEDIATE`, shared transaction semantics, or
authorize implementation/migration.
