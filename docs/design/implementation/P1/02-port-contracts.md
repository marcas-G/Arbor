# P1 — 02 Port Contracts

**Authority:** DID v1.6 §7.1–§7.4, §7.7, §9.5, §9.7, §10.4.1, §12.6, §12.10
**Status:** P1 phase-scoped closure (revised after 4-way review)
**Implements:** P1 port contracts; P1-DG-08 persistence access; P1-DG-10 port ownership.

Ports are Effect services (DID §7.1/§7.7); adapters are Layers. All P1
repositories **require `TransactionScope`** and never open their own
connection. No generic CRUD (DID §7.3). Owning package: **`ports`**.
Adapters: `adapters/persistence-sqlite`, `adapters/environment-local`.

## 1. Effect channel rules

```text
Repository method:
  A = typed result (ADT / Option where absence is a normal alternative)
  E = <RepositoryName>Error   // per-repository semantic error, NOT a catch-all
  R = TransactionScope        // the tag enters R at the call site; the method
                              // itself requires only TransactionScope
TransactionPort.transact adds TransactionOperationalFailure to E.
```

- There is **no** universal `RepositoryError` (DID §6A.2 / §0A.6). Each
  repository declares its own narrow error (`ProjectRepositoryError`, …).
- CAS failures are typed errors of the owning repository.
- Adapter errors (`SqliteError`, …) are translated at the adapter boundary and
  never appear in a port `E` (DID §0A.6).

## 2. Transaction

```ts
class TransactionScope extends Context.Tag("arbor/TransactionScope")<
  TransactionScope, { readonly session: AdapterSession }>() {}
interface TransactionPort {
  transact: <A, E, R>(body: Effect<A, E, R | TransactionScope>)
    => Effect<A, E | TransactionOperationalFailure, Exclude<R, TransactionScope>>
}
```

`AdapterSession` is an **opaque `ports`-owned type** (`interface AdapterSession
{ readonly id: string }`); it must not reference `adapters/*` (DID §10.4.1).

See `03-transaction-model.md`.

## 3. Repositories

### ProjectRepository

| Method | Semantics |
|---|---|
| `findById(projectId): Effect<Option<Project>, ProjectRepositoryError>` | |
| `create(project)` | insert; composite `(root_workspace_id, project_id)` FK + `UNIQUE(workspace_id, project_id)` |
| `updatePolicyIfRevision(projectId, expectedRevision, policy, newPolicyRevision, newRevision)` | CAS |
| `closeIfRevision(projectId, expectedRevision, newRevision)` | CAS |

### WorkspaceRepository

| Method | Semantics |
|---|---|
| `findById(workspaceId): Effect<Option<Workspace>, WorkspaceRepositoryError>` | |
| `create(workspace)` | parent immutable |
| `changeResponsibilityIfRevision(...)` | CAS; `responsibility_revision++` |
| `updateResourceBoundaryIfRevision(...)` | CAS; `resource_boundary_revision++` |
| `updatePolicyIfRevision(...)` | CAS; `workspace_policy_revision++` |
| `selectCurrentWorkIfRevision(...)` | CAS |
| `replacePrimarySessionIfRevision(...)` | CAS |
| `retireIfRevision(...)` | CAS |
| `countActiveChildren(workspaceId)` | retire precondition |
| `hasOpenWork(workspaceId)` | retire precondition |

### WorkRepository

| Method | Semantics |
|---|---|
| `findById(workId): Effect<Option<Work>, WorkRepositoryError>` | |
| `create(work)` | lifecycle Open |
| `refineIfRevision(...)` / `completeIfRevision(...)` / `cancelIfRevision(...)` | CAS |
| `listByWorkspace(workspaceId, lifecycle?)` | open-work / current checks |

### SessionRepository

| Method | Semantics |
|---|---|
| `findById(sessionId): Effect<Option<Session>, SessionRepositoryError>` | |
| `create(session)` | `WorkspacePrimary` / `ExecutionScoped` binding; P1 bootstrap |

`appendEntry` (runtime operational mutation, DID §4.4) is **P2**, not P1.

### ResourceOwnershipRepository

| Method | Semantics |
|---|---|
| `loadActiveConflicts(resourceSpaceId)` | conflict load inside `BEGIN IMMEDIATE` |
| `insertClaim(claim)` | resolved `CanonicalResourceRegion` |
| `releaseClaim(claimId, releasedAt)` | `UPDATE ... WHERE released_at IS NULL` |
| `listActiveByWorkspace(workspaceId)` | retire precondition |

P1 `ResourceOwnershipClaim` record (matches the DDL columns;
`resource_space_id` is derived from `region.resourceSpaceId`):

```ts
{ claimId, workspaceId, region: CanonicalResourceRegion,
  sourceAddressSnapshot: ResourceAddress, resourceBoundaryRevision,
  resolvedAtEnvironmentRevision, createdAt, releasedAt: string | null }
```

### CommandStore

| Method | Semantics |
|---|---|
| `findResolution(commandId): Effect<Option<CommandReceipt>, CommandStoreError>` | |
| `insertCommitted(commandId, projectId, fingerprint, schemaVersion, fingerprintAlgorithmVersion, resultJson)` | authoritative |
| `insertTerminalRejected(commandId, projectId, fingerprint, schemaVersion, fingerprintAlgorithmVersion, terminalErrorJson)` | authoritative, no event |
| `recordResolvingAttempt(commandId, attemptNo, outcome, startedAt, settledAt)` | resolving attempt (Committed / TerminalRejected); written in the **command transaction** (03 §3.1/§3.2) |
| `recordRetryableAttempt(commandId, attemptNo, failureKind, startedAt, settledAt)` | non-authoritative trace; written in a **separate** short transaction after rollback (03 §3.3) |

### DomainEventJournal

| Method | Semantics |
|---|---|
| `append(events)` | append in the semantic transaction; allocates project-local sequence |
| `readAfter(projectId, sequence, limit)` | consumer catch-up |
| `lastSequence(projectId): Effect<number, DomainEventJournalError>` | returns `0` when absent (allocation support) |

### ConsumerDeadLetterStore

| Method | Semantics |
|---|---|
| `quarantine(consumerId, projectId, sequence, reason)` | `INSERT OR IGNORE`; same transaction as the offset skip (05 §3) |

### ConsumerOffsetStore

| Method | Semantics |
|---|---|
| `read(consumerId, projectId): Effect<number, ConsumerOffsetStoreError>` | returns `0` when the row is absent |
| `advance(consumerId, projectId, lastSequence)` | upsert (`INSERT ... ON CONFLICT(consumer_id, project_id) DO UPDATE`); same transaction as the projection write (05 §4) |

### EnvironmentRevisionStore

| Method | Semantics |
|---|---|
| `current(projectId): Effect<Option<string>, EnvironmentRevisionStoreError>` | read **inside** the ownership write tx; `None` = not observed (treated as not stale) |
| `record(projectId, revision)` | called by the ownership write (lazy init with the observed revision) and by environment-change (later phase) |

### Error classification

```text
EnvironmentError / ResourceResolutionStale are Port/Application operational
errors, NOT DomainError. ResourceResolutionStale is a retryable operational
failure (re-resolve + re-evaluate), never an authoritative rejection.
```

## 4. Other P1 ports

| Port | Method | Notes |
|---|---|---|
| `Clock` | `now(): Effect<string, never>` | ISO timestamp; testable |
| `IdGenerator` | `generate<T>(kind): Effect<T, never>` | used by **callers**, not handlers |
| `ProjectEnvironmentPort` | `resolve(projectId, addresses): Effect<{ regions: ReadonlyArray<CanonicalResourceRegion>; observedEnvironmentRevision: string }, EnvironmentError>` | resolve **outside** write tx (DID §1.5); returns regions + revision together |

## 5. Transaction participation summary

```text
ProjectRepository / WorkspaceRepository / WorkRepository / SessionRepository
ResourceOwnershipRepository / CommandStore / DomainEventJournal
ConsumerOffsetStore / EnvironmentRevisionStore / ConsumerDeadLetterStore
                                                   -> require TransactionScope
ProjectEnvironmentPort                             -> NO TransactionScope (slow I/O)
Clock / IdGenerator                                -> NO TransactionScope
CommandStore.recordResolvingAttempt                -> command transaction
CommandStore.recordRetryableAttempt                -> separate scope (after rollback)
```

## 6. Out of scope

- Execution/lease ports (P2), including `SessionRepository.appendEntry`.
- Provider/Tool/Blob/Projection ports (P3+).
