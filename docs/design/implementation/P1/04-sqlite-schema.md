# P1 — 04 SQLite Schema

**Authority:** DID v1.6 §9.1–§9.9, §9.13, §12.11, §3.1–§3.3
**Status:** P1 phase-scoped closure (revised after 4-way review)
**Closes:** P1-DG-07 (cyclic FKs, mapping, root uniqueness), P1-DG-08
(`resource_ownership` lifecycle), P1-DG-09 (retention/delete + migration),
resource-region physical encoding, and the P1 DDL blocker (DID §13).

## 1. Storage settings (DID §9.1)

```sql
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;
PRAGMA synchronous = FULL;   -- durability; see 06-recovery-matrix.md
```

Requires SQLite ≥ 3.35 (`RETURNING`, `ON CONFLICT ... DO UPDATE`); the
`@effect/sql-sqlite-node` driver's bundled SQLite satisfies this.

Only the Arbor Runtime writes this DB (DID §9.2).

## 2. Table ↔ domain mapping (P1-DG-07)

| Table | Domain type |
|---|---|
| `projects` | `Project` |
| `workspaces` | `Workspace` |
| `sessions` | `Session` |
| `works` | `Work` |
| `resource_ownership` | `ResourceOwnershipClaim` |
| `environment_revisions` | environment revision anchor |
| `commands` | `CommandReceipt` (authoritative resolution) |
| `command_attempts` | `CommandAttempt` (non-authoritative trace) |
| `domain_events` | `DomainEvent` (durable outbox) |
| `project_event_sequences` | project-local sequence counter |
| `consumer_offsets` | consumer cursor |
| `consumer_dead_letters` | poison event quarantine |

Later-phase tables (`work_waits` ↔ `Dependency`, `work_acceptances` ↔
`Acceptance`, `executions`, `execution_leases`, `verifications`, …) are owned
by their phases; their mapping is authoritative in the owning phase.

## 3. DDL

### 3.1 projects / workspaces / sessions

Both DID §9.13 cycles use `DEFERRABLE INITIALLY DEFERRED`. The
`current_work_id ↔ works` reference is also deferred.

```sql
CREATE TABLE projects (
  project_id              TEXT PRIMARY KEY,
  name                    TEXT NOT NULL,
  root_workspace_id       TEXT NOT NULL,
  project_policy          TEXT NOT NULL,              -- JSON
  project_policy_revision INTEGER NOT NULL,
  default_configuration   TEXT NOT NULL,              -- JSON
  environment_ref         TEXT NOT NULL,
  lifecycle               TEXT NOT NULL CHECK (lifecycle IN ('Open','Closed')),
  revision                INTEGER NOT NULL,
  created_at              TEXT NOT NULL,
  updated_at              TEXT NOT NULL,
  FOREIGN KEY (root_workspace_id, project_id)
    REFERENCES workspaces(workspace_id, project_id) DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE workspaces (
  workspace_id                TEXT PRIMARY KEY,
  project_id                  TEXT NOT NULL REFERENCES projects(project_id),
  parent_workspace_id         TEXT,
  name                        TEXT NOT NULL,
  responsibility_definition   TEXT NOT NULL,          -- JSON
  responsibility_revision     INTEGER NOT NULL,
  resource_boundary           TEXT NOT NULL,          -- JSON
  resource_boundary_revision  INTEGER NOT NULL,
  agent_binding               TEXT NOT NULL,          -- JSON
  primary_session_id          TEXT NOT NULL
                                REFERENCES sessions(session_id) DEFERRABLE INITIALLY DEFERRED,
  current_work_id             TEXT
                                REFERENCES works(work_id) DEFERRABLE INITIALLY DEFERRED,
  workspace_policy            TEXT NOT NULL,          -- JSON
  workspace_policy_revision   INTEGER NOT NULL,
  revision                    INTEGER NOT NULL,
  lifecycle                   TEXT NOT NULL CHECK (lifecycle IN ('Active','Retired')),
  created_at                  TEXT NOT NULL,
  updated_at                  TEXT NOT NULL,
  UNIQUE (workspace_id, project_id),
  FOREIGN KEY (parent_workspace_id, project_id)
    REFERENCES workspaces(workspace_id, project_id) DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE sessions (
  session_id     TEXT PRIMARY KEY,
  binding_kind   TEXT NOT NULL CHECK (binding_kind IN ('WorkspacePrimary','ExecutionScoped')),
  workspace_id   TEXT REFERENCES workspaces(workspace_id) DEFERRABLE INITIALLY DEFERRED,
  execution_id   TEXT,                                 -- executions table is P2
  context_epoch  INTEGER NOT NULL,
  created_at     TEXT NOT NULL,
  CHECK ((binding_kind = 'WorkspacePrimary') = (workspace_id IS NOT NULL)),
  CHECK ((binding_kind = 'ExecutionScoped') = (execution_id IS NOT NULL))
);

CREATE INDEX idx_workspaces_project ON workspaces(project_id);
```

`UNIQUE(projects.root_workspace_id)` is replaced by the composite
`(root_workspace_id, project_id)` FK, which enforces both exactly-one-root
(the column is singular per project) and workspace-tree-same-project at L3.
The composite `(parent_workspace_id, project_id)` FK enforces the same for the
parent edge (DID §6.2).

### 3.2 works

```sql
CREATE TABLE works (
  work_id                TEXT PRIMARY KEY,
  project_id             TEXT NOT NULL REFERENCES projects(project_id),
  workspace_id           TEXT NOT NULL REFERENCES workspaces(workspace_id),
  objective              TEXT NOT NULL,
  why                    TEXT NOT NULL,
  constraints            TEXT NOT NULL,               -- JSON array
  completion_expectation TEXT NOT NULL,
  verification_mission   TEXT NOT NULL,               -- JSON
  provenance             TEXT NOT NULL,               -- JSON
  lifecycle              TEXT NOT NULL CHECK (lifecycle IN ('Open','Completed','Cancelled')),
  revision               INTEGER NOT NULL,
  created_at             TEXT NOT NULL,
  updated_at             TEXT NOT NULL
);

CREATE INDEX idx_works_workspace_lifecycle ON works(workspace_id, lifecycle);
```

### 3.3 resource_ownership + environment_revisions (P1-DG-08)

Claim release is a soft update (`released_at`); rows are never hard-deleted.

```sql
CREATE TABLE resource_ownership (
  claim_id                         TEXT PRIMARY KEY,
  workspace_id                     TEXT NOT NULL REFERENCES workspaces(workspace_id),
  resource_space_id                TEXT NOT NULL,
  canonical_region                 TEXT NOT NULL,     -- JSON CanonicalResourceRegion
  source_address_snapshot          TEXT NOT NULL,     -- JSON ResourceAddress
  resource_boundary_revision       INTEGER NOT NULL,
  resolved_at_environment_revision TEXT NOT NULL,
  created_at                       TEXT NOT NULL,
  released_at                      TEXT,
  CHECK (released_at IS NULL OR released_at >= created_at)
);

CREATE INDEX idx_resource_ownership_active
  ON resource_ownership(resource_space_id) WHERE released_at IS NULL;
CREATE INDEX idx_resource_ownership_ws_active
  ON resource_ownership(workspace_id) WHERE released_at IS NULL;

CREATE TABLE environment_revisions (
  project_id  TEXT PRIMARY KEY REFERENCES projects(project_id),
  revision    TEXT,          -- NULL = not yet observed
  updated_at  TEXT NOT NULL
);
```

`environment_revisions` is initialized lazily: the first successful ownership
write records the observed revision. `EnvironmentRevisionStore.current`
returns `None` when absent/NULL, and the stale check treats that as
"not stale" (nothing observed yet).

Write transaction (DID §9.5): `ProjectEnvironmentPort.resolve` outside the tx
returns `{ regions, observedEnvironmentRevision }`; then `BEGIN IMMEDIATE` →
`EnvironmentRevisionStore.current(projectId)` compared to
`observedEnvironmentRevision` → `ResourceResolutionStale` on drift →
`loadActiveConflicts` → domain `overlaps()` → insert/release →
`EnvironmentRevisionStore.record(projectId, observedEnvironmentRevision)` →
COMMIT.

`resource_boundary_revision` and `resolved_at_environment_revision` are CAS
columns: the ownership write compares the observed environment revision and
the basis responsibility revision before committing.

#### Resource-region physical encoding (frozen)

```text
canonical_region = JSON { resourceSpaceId, normalizedRegion }
normalizedRegion (per kind):
  FileTree          { kind, path }            // absolute, normalized
  GitWorktree       { kind, path }            // resolved worktree root
  DatabaseNamespace { kind, namespace }       // segment-normalized
  ExternalResource  { kind, address }         // resolver-canonical address

contains/overlaps are pure domain functions on normalizedRegion within the
same resourceSpaceId:
  FileTree / GitWorktree / DatabaseNamespace: segment-prefix containment
    contains(a,b) = a.path == b.path || b.path startsWith a.path + "/"
    overlaps(a,b) = contains(a,b) || contains(b,a)
  ExternalResource: exact equality
SQL MUST NOT approximate overlap by string prefix.
```

### 3.4 commands / command_attempts (DID §9.9)

```sql
CREATE TABLE commands (
  command_id                    TEXT PRIMARY KEY,
  project_id                    TEXT NOT NULL,          -- no FK: TerminalRejected may reference an unknown project
  semantic_request_fingerprint  TEXT NOT NULL,
  schema_version                TEXT NOT NULL,
  fingerprint_algorithm_version INTEGER NOT NULL,
  resolution                    TEXT NOT NULL CHECK (resolution IN ('Committed','TerminalRejected')),
  result_json                   TEXT,
  terminal_error_json           TEXT,
  created_at                    TEXT NOT NULL,
  settled_at                    TEXT NOT NULL,          -- always written with a resolution
  CHECK ((resolution = 'Committed') = (result_json IS NOT NULL)),
  CHECK ((resolution = 'TerminalRejected') = (terminal_error_json IS NOT NULL))
);

CREATE TABLE command_attempts (
  command_id    TEXT NOT NULL,                          -- no FK: non-authoritative trace
  attempt_no    INTEGER NOT NULL,                       -- 0-based (DID §9.9)
  started_at    TEXT NOT NULL,
  settled_at    TEXT,
  outcome       TEXT NOT NULL CHECK (outcome IN ('Committed','TerminalRejected','RetryableOperationalFailure')),
  failure_kind  TEXT,
  metadata_json TEXT,
  PRIMARY KEY (command_id, attempt_no)
);
```

`settled_at` is `NOT NULL` — a deliberate deviation from DID §9.9's
`settled_at?`: since there is no durable `Pending`, every `commands` row is
written together with its resolution.

Attempt recording:

```text
- resolving attempt (Committed / TerminalRejected): recorded in the SAME
  command transaction.
- retryable operational failure: recorded in a SEPARATE short transaction
  after ROLLBACK (03 §3.3); may be lost on crash (non-authoritative).
```

`result_json` / `terminal_error_json` are JSON keyed by the row's
`schema_version`; `terminal_error_json` decodes to a `CommandRejection`.

### 3.5 domain_events / sequence / offsets / dead letters (DID §5.2, §9.9)

```sql
CREATE TABLE domain_events (
  event_id             TEXT PRIMARY KEY,
  project_id           TEXT NOT NULL,
  sequence             INTEGER NOT NULL,
  event_type           TEXT NOT NULL,
  event_version        INTEGER NOT NULL,
  occurred_at          TEXT NOT NULL,
  aggregate_ref        TEXT NOT NULL,
  actor                TEXT NOT NULL,
  caused_by_command_id TEXT,
  caused_by_event_id   TEXT,
  correlation_ref      TEXT,
  payload_json         TEXT NOT NULL,
  UNIQUE (project_id, sequence)
);

CREATE TABLE project_event_sequences (
  project_id     TEXT PRIMARY KEY,
  last_sequence  INTEGER NOT NULL
);

CREATE TABLE consumer_offsets (
  consumer_id   TEXT NOT NULL,
  project_id    TEXT NOT NULL,
  last_sequence INTEGER NOT NULL,
  updated_at    TEXT NOT NULL,
  PRIMARY KEY (consumer_id, project_id)
);

CREATE TABLE consumer_dead_letters (
  consumer_id  TEXT NOT NULL,
  project_id   TEXT NOT NULL,
  sequence     INTEGER NOT NULL,
  reason       TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  PRIMARY KEY (consumer_id, project_id, sequence)
);
```

Re-quarantine of the same `(consumer_id, project_id, sequence)` is
`INSERT OR IGNORE`.

(`UNIQUE(project_id, sequence)` already provides the project/sequence index.)

## 4. Fence and stop predicates (DID §9.7; tables are P2)

Two separate queries so `FencingRejected` and `ExecutionStopping` are
distinguishable:

```sql
-- 1) fence validity (ownership/generation + lease expiry)
SELECT 1
FROM executions e
JOIN execution_leases l ON l.execution_id = e.execution_id
WHERE e.execution_id = ?
  AND l.generation = ?
  AND l.expires_at > ?
  AND e.settled_at IS NULL;
-- no row -> CommandRejection.FencingRejected

-- 2) stop / quiescence admission (only if fence valid)
SELECT stop_requested_at IS NOT NULL
FROM executions
WHERE execution_id = ?;
-- true -> CommandRejection.ExecutionStopping (NOT FencingRejected)
```

P1 provides the hook and these predicates; `executions` / `execution_leases`
DDL lands in P2. In P1 all commands are `External`/`System`, so the hook is
inert and tested with a stub.

> **Inherited fence-contract correction (R8).** The frozen P1 hook predicate
> checked ownership/generation only. System Design v1.3 §10.5 requires that an
> expired Worker cannot commit ("过期 Worker 即使恢复，也不能继续提交状态"),
> so the authoritative implementation additionally requires `expires_at > now`.
> SD v1.3 is the higher-authority owner of this invariant; this corrects the
> P1 contract text **without reopening the P1 phase** (P1 remains COMPLETE).
> P2 freezes the real predicate in
> `docs/design/implementation/P2/03-lease-fencing-model.md` §3 and `04` §4.

## 5. Migration (P1-DG-09)

```text
- PRAGMA user_version stores the schema version.
- Forward-only ordered migrations: migrations/0001_init.sql, 0002_*.sql, …
- Startup: if user_version > latest known -> refuse to start.
- Additive migrations run in a single transaction; table-rebuild migrations
  require PRAGMA foreign_keys=OFF outside the transaction (documented exception).
```

## 6. Retention / delete (P1-DG-09)

```text
commands         NEVER hard-deleted (stable idempotency guarantee).
command_attempts non-authoritative trace; retention/archival allowed.
domain_events    append-only; no hard DELETE before the retention horizon;
                 project_event_sequences persists the counter so pruning
                 cannot reset allocation.
consumer_offsets never deleted.
consumer_dead_letters retained (poison quarantine).
resource_ownership released rows retained (released_at), never hard-deleted.
```

Retention horizon is deployment configuration; the rules above are frozen.

## 7. Out of scope

- executions / execution_leases / verifications / dependencies /
  deliverables / permissions / messages DDL (owning phases).
- Query optimization / index tuning beyond the indexes above.
