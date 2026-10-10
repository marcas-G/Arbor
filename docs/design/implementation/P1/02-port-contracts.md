# P1 — 02 Port Contracts

**Authority:** DID v1.6 §7.1–§7.4, §7.7, §9.5, §9.7, §10.4.1, §12.6, §12.10; DID v1.35 §4.1C FT-DG-01 ProjectResourceProfilePort
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
| `findResolution(commandId): Effect<Option<StoredCommandResolution>, CommandStoreError>` | returns tuple metadata and the stored result/error JSON as raw text; does not decode the receipt |
| `insertCommitted(commandId, projectId, fingerprint, schemaVersion, fingerprintAlgorithmVersion, resultJson)` | authoritative |
| `insertTerminalRejected(commandId, projectId, fingerprint, schemaVersion, fingerprintAlgorithmVersion, terminalErrorJson)` | authoritative, no event |
| `recordResolvingAttempt(commandId, outcome, startedAt, settledAt)` | resolving attempt (Committed / TerminalRejected); written in the **command transaction** (03 §3.1/§3.2) |
| `recordRetryableAttempt(commandId, failureKind, startedAt, settledAt)` | non-authoritative trace; written in a **separate** short transaction after rollback (03 §3.3) |

`StoredCommandResolution` is the ports-owned pre-decode representation of an
existing `commands` row:

```ts
interface StoredCommandResolution {
  readonly commandId: CommandId;
  readonly projectId: ProjectId;
  readonly semanticRequestFingerprint: SemanticRequestFingerprint;
  readonly schemaVersion: string;
  readonly fingerprintAlgorithmVersion: number;
  readonly resolution: "Committed" | "TerminalRejected";
  readonly resultJson: string | null;
  readonly terminalErrorJson: string | null;
  readonly createdAt: string;
  readonly settledAt: string;
}
```

`resultJson` and `terminalErrorJson` are the stored column text, not parsed
JSON values; `findResolution` MUST NOT parse, validate, or otherwise interpret
either field. Within the existing command transaction, the Application
compares `(semanticRequestFingerprint, schemaVersion,
fingerprintAlgorithmVersion)` from this representation with the current
request first. A mismatch follows P1 `01`'s existing `IdempotencyConflict`
branch without decoding or disclosing either raw field. Only an exact tuple
match may proceed to the existing Application receipt decoding and produce a
typed P1 `CommandReceipt`. This port contract does not define exact-tuple
result/error shape rules or decoding failures; it adds no corruption error
type, failure mapping, or receipt repair behavior.

The exact-tuple Application decoder and its `PersistenceCorruption<"CommandStore">`
classification are defined in `01-command-contracts.md` §3A. The Port remains
raw and version-neutral: it does not select a command result schema, convert
`result_json` / `terminal_error_json` to a typed value, or make a corruption
disposition. Gateway/Recovery call sites own the trusted command type and
schema selection after the appropriate identity/tuple checks; adapter JSON
parsing before those boundaries is forbidden. This clarification changes no
`StoredCommandResolution` field, SQL, DDL, migration, or transaction owner.

`CommandStore` allocates the next free `attempt_no` for a `command_id`
(serialized by `BEGIN IMMEDIATE`); callers do not supply it.

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

### ProjectionStore

| Method | Semantics |
|---|---|
| `apply(batch)` | projection writes in the same SQLite DB/tx as the offset advance (05 §4) |
| `reset()` | clear the projection for rebuild (05 §6) |

### OwnershipWriteService

| Method | Semantics |
|---|---|
| `resolveAndWrite(projectId, addresses, claims)` | implements the 04 §3.3 ownership write sequence; returns `{ regions, claims }` |

`ProjectionStore` requires `TransactionScope`; `OwnershipWriteService` opens
its own transaction (it resolves outside, then transacts).

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
| `Clock` | `now(): Effect<string, never>` | ISO timestamp; testable; provided by the adapter Layer |
| `IdGenerator` | `generate<T>(kind): Effect<T, never>` | used by **callers** and the journal (EventId), not command handlers |
| `ProjectEnvironmentPort` | `resolve(projectId, addresses): Effect<{ regions: ReadonlyArray<CanonicalResourceRegion>; observedEnvironmentRevision: string }, EnvironmentError>` | resolve **outside** write tx (DID §1.5); returns regions + revision together |

### ProjectResourceProfilePort (FT-DG-01 CreateProject v2)

The P12 host composition loads and validates the local host Profile registry at
startup, then supplies this immutable, read-only snapshot to Application. The
Port itself performs no filesystem I/O; its Profile lookup is deterministic
memory access so CreateProject may call it only after the Gateway has checked
for an existing receipt, without holding the transaction across a slow host
probe.

```ts
interface ProjectResourceProfileSummary {
  readonly resourceProfileRef: string;
  readonly version: string;
  readonly displayName: string;
  readonly available: boolean;
}

interface TrustedProjectResourceProfile extends ProjectResourceProfileSummary {
  readonly available: true;
  readonly canonicalAddress: Extract<ResourceAddress, { readonly _tag: "FileTree" }>;
}

interface ProjectResourceProfilePortService {
  readonly list: () => Effect.Effect<ReadonlyArray<ProjectResourceProfileSummary>, never>;
  readonly resolve: (
    resourceProfileRef: string,
    version: string,
  ) => Effect.Effect<Option.Option<TrustedProjectResourceProfile>, never>;
}
```

`canonicalAddress` is an Application/handler trusted value and must never be
returned by the public profile-list transport. The list exposes only opaque
ref, version, friendly display name and availability. The host configuration
owns stable ref/version values across process restart; changing canonical path
or scope requires a new version. Profile lookup does not decide authority,
create a GitWorktree, or mutate ownership claims. The existing
ProjectEnvironmentPort / OwnershipWriteService remains the filesystem
resolution and ownership-activation path after the canonical Workspace
boundary has committed.

## 4A. Application boundary input: `VerifiedCommandAuthority`

`VerifiedCommandAuthority` (`01-command-contracts.md` §2A, P1-DG-11) is **not**
a port service and has **no** repository or adapter in P1. It is a trusted
**Application-boundary input fact** passed to
`CommandGateway.execute(envelope, submissionContext, authority)`; the `ports`
package neither defines, stores, nor resolves it. P1 performs deterministic
exact-match validation only (no Permission/RBAC/Authority Resolver).

## 5. Transaction participation summary

```text
ProjectRepository / WorkspaceRepository / WorkRepository / SessionRepository
ResourceOwnershipRepository / CommandStore / DomainEventJournal
ConsumerOffsetStore / EnvironmentRevisionStore / ConsumerDeadLetterStore
ProjectionStore                                    -> require TransactionScope
OwnershipWriteService                               -> opens its own transaction
ProjectEnvironmentPort                             -> NO TransactionScope (slow I/O)
ProjectResourceProfilePort                         -> NO TransactionScope (immutable in-memory snapshot)
Clock / IdGenerator                                -> NO TransactionScope
CommandStore.recordResolvingAttempt                -> command transaction
CommandStore.recordRetryableAttempt                -> separate scope (after rollback)
```

## 6. Frozen execution details

- **Time source.** Repositories/adapters obtain `created_at` / `updated_at` /
  `settled_at` from `Clock` (provided by the adapter Layer); the domain never
  reads time. `recordResolvingAttempt` / `recordRetryableAttempt` receive
  `startedAt` / `settledAt` from the caller (Clock-backed).
- **`AdapterSession`.** Repositories obtain the live driver connection from
  `TransactionScope.session`; the adapter Layer owns the concrete cast.
- **Ownership write orchestration.** The 04 §3.3 sequence is a ports-level
  service `OwnershipWriteService.resolveAndWrite(projectId, addresses, claims)`
  returning `{ regions, claims }` or
  `EnvironmentError | ResourceOwnershipRepositoryError | ResourceResolutionStale`.
  Implemented by the SQLite adapter in P1-007 and exercised by tests; P1 has
  no ownership command.

## 7. Out of scope

- Execution/lease ports (P2), including `SessionRepository.appendEntry`.
- Provider/Tool/Blob/Projection ports (P3+).
