# P1 — 02 Port Contracts

**Authority:** DID v1.5 §7.1–§7.4, §7.7, §9.5, §9.7, §10.4.1, §12.6, §12.10
**Status:** P1 phase-scoped closure (draft for review)
**Closes:** A2 for P1 ports; P1-DG-08 persistence access; P1-DG-10 port ownership.

Ports are Effect services (DID §7.1/§7.7); adapters are Layers. All P1
repositories **require `TransactionScope`** and never open their own
connection. No generic CRUD `Repository<T>{findById, save, delete}` (DID §7.3).

Owning package: **`ports`** (except where noted). Adapters:
`adapters/persistence-sqlite`, `adapters/environment-local`.

## 1. Transaction

```ts
interface TransactionScope { readonly sessionId: string }
interface TransactionPort {
  transact: <A, E, R>(body: Effect<A, E, R | TransactionScope>)
    => Effect<A, E | TransactionOperationalFailure, Exclude<R, TransactionScope>>
}
```

See `03-transaction-model.md`. `TransactionOperationalFailure` is
non-authoritative and retryable.

## 2. Repositories

Every method:

```text
E = RepositoryError | (typed CAS conflict, e.g. RevisionConflict) | TransactionOperationalFailure
R = TransactionScope | <owning repository service>
```

`RepositoryError` is adapter-specific and never crosses the semantic
boundary (DID §0A.6).

### ProjectRepository

| Method | Semantics |
|---|---|
| `findById(projectId)` | `Effect<Project \| null, …>` |
| `create(project)` | insert; `UNIQUE(root_workspace_id)` enforced |
| `updatePolicyIfRevision(projectId, expectedRevision, policy, newPolicyRevision, newRevision)` | CAS on `revision` |
| `closeIfRevision(projectId, expectedRevision, newRevision)` | CAS on `revision` |

### WorkspaceRepository

| Method | Semantics |
|---|---|
| `findById(workspaceId)` | |
| `create(workspace)` | parent immutable; child inherits project |
| `changeResponsibilityIfRevision(...)` | CAS; `responsibility_revision++` |
| `updateResourceBoundaryIfRevision(...)` | CAS; `resource_boundary_revision++` |
| `updatePolicyIfRevision(...)` | CAS; `workspace_policy_revision++` |
| `selectCurrentWorkIfRevision(workspaceId, expectedRevision, workId, newRevision)` | CAS; sets `current_work_id` |
| `replacePrimarySessionIfRevision(...)` | CAS; sets `primary_session_id` |
| `retireIfRevision(...)` | CAS; lifecycle = Retired |
| `countActiveChildren(workspaceId)` | retire precondition |
| `hasOpenWork(workspaceId)` | retire precondition (or via WorkRepository) |

### WorkRepository

| Method | Semantics |
|---|---|
| `findById(workId)` | |
| `create(work)` | lifecycle Open |
| `refineIfRevision(workId, expectedRevision, fields, newRevision)` | CAS |
| `completeIfRevision(workId, expectedRevision)` | CAS; lifecycle Completed |
| `cancelIfRevision(workId, expectedRevision)` | CAS; lifecycle Cancelled |
| `listByWorkspace(workspaceId, lifecycle?)` | open-work / current-work checks |

### SessionRepository

| Method | Semantics |
|---|---|
| `findById(sessionId)` | |
| `create(session)` | `WorkspacePrimary` / `ExecutionScoped` binding |
| `appendEntry(sessionId, entry)` | Session-local monotonic sequence |

### ResourceOwnershipRepository

| Method | Semantics |
|---|---|
| `loadActiveConflicts(resourceSpaceId)` | conflict load inside `BEGIN IMMEDIATE` |
| `insertClaim(claim)` | resolved `CanonicalResourceRegion` |
| `releaseClaim(claimId, releasedAt)` | lifecycle (P1-DG-08) |
| `listActiveByWorkspace(workspaceId)` | retire precondition |

### CommandStore

| Method | Semantics |
|---|---|
| `findResolution(commandId)` | `Effect<CommandReceipt \| null, …>` |
| `insertCommitted(commandId, projectId, fingerprint, schemaVersion, resultJson)` | authoritative |
| `insertTerminalRejected(commandId, projectId, fingerprint, schemaVersion, terminalErrorJson)` | authoritative, no event |
| `recordAttempt(commandId, attemptNo, outcome, failureKind?)` | non-authoritative trace; no FK to commands |

No generic `save`. `CommandReceipt` is a read view of the `commands` row.

### DomainEventJournal

| Method | Semantics |
|---|---|
| `append(events)` | append in the semantic transaction; allocates project-local sequence |
| `readAfter(projectId, sequence, limit)` | consumer catch-up |
| `lastSequence(projectId)` | allocation support |

## 3. Other P1 ports

| Port | Method | Notes |
|---|---|---|
| `Clock` | `now(): Effect<string, never>` | ISO timestamp; adapter-provided; testable |
| `IdGenerator` | `generate<T>(kind): Effect<T, never>` | used by **callers**, not command handlers |
| `ProjectEnvironmentPort` | `resolve(addresses): Effect<ReadonlyArray<CanonicalResourceRegion>, EnvironmentError>`; `currentEnvironmentRevision(): Effect<string, EnvironmentError>` | resolve **outside** write tx (DID §9.5) |

## 4. Transaction participation summary

```text
ProjectRepository            -> requires TransactionScope
WorkspaceRepository          -> requires TransactionScope
WorkRepository               -> requires TransactionScope
SessionRepository            -> requires TransactionScope
ResourceOwnershipRepository  -> requires TransactionScope
CommandStore                 -> requires TransactionScope
DomainEventJournal           -> requires TransactionScope
ProjectEnvironmentPort       -> NO TransactionScope (slow I/O outside write tx)
Clock / IdGenerator          -> NO TransactionScope
```

## 5. Out of scope

- Execution/lease ports (P2).
- Provider/Tool/Blob/Projection ports (P3+).
