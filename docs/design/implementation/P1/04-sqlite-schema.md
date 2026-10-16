# P1 — 04 SQLite Schema

**Authority:** DID v1.6 §9.1–§9.9, §9.13, §12.11, §3.1–§3.3; accepted P41/0041 storage and FT-DG-01 OPEN-1/OPEN-2 owner amendments
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
| `workspace_resource_activation_intents` | `WorkspaceResourceActivationIntent` (P1 operational convergence fact; FT-DG-01 OPEN-3) |
| `environment_revisions` | environment revision anchor |
| `commands` | `CommandReceipt` (authoritative resolution) |
| `retry_verification_origins` | immutable P8 originating-command/source/successor identity (non-receipt canonical fact) |
| `retry_verification_legacy_dispositions` | immutable P8 `UnboundLegacy` replay disposition (non-receipt canonical fact) |
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
  resource_source_json    TEXT NOT NULL
                            DEFAULT '{"_tag":"LegacyUnknown"}'
                            CHECK (json_valid(resource_source_json)),
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

The FT-DG-01 OPEN-3 intent is additive and contains no resource address or
Profile provenance. It is created only for a new Profile CreateProject after
the handler has built the canonical Workspace boundary; ConversationOnly has
no intent. There is no migration backfill from historical Workspace paths or
missing ownership claims.

```sql
CREATE TABLE workspace_resource_activation_intents (
  project_id                  TEXT NOT NULL,
  workspace_id                TEXT NOT NULL,
  resource_boundary_revision  INTEGER NOT NULL,
  status                      TEXT NOT NULL CHECK (status IN ('Pending','Active')),
  created_at                  TEXT NOT NULL,
  updated_at                  TEXT NOT NULL,
  activated_at                TEXT,
  PRIMARY KEY (project_id, workspace_id, resource_boundary_revision),
  FOREIGN KEY (workspace_id, project_id)
    REFERENCES workspaces(workspace_id, project_id),
  CHECK ((status = 'Active') = (activated_at IS NOT NULL))
);

CREATE INDEX idx_workspace_resource_activation_pending
  ON workspace_resource_activation_intents(project_id, created_at, workspace_id,
                                            resource_boundary_revision)
  WHERE status = 'Pending';
```

The next forward-only additive migration after the current P10 Attention
projection baseline (`user_version=34`) creates this table together with the
P10-owned activation-attention projection table (`04`/`05`). Active intent
rows are retained as the durable idempotency record for their exact boundary
revision. The migration does not inspect/interpret old command result JSON or
reconstruct v1/v2 intents from raw paths.

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

For FT-DG-03, `commands.schema_version` is the registered Handler's semantic
Command/receipt schema version and result/error decoding key. It is not an
external wire version. `fingerprint_algorithm_version` identifies the P1
canonical serialization/hash algorithm; the current algorithm is 1
(SHA-256). External codec version 1 is server-selected and is not stored.
The existing tuple `(semantic_request_fingerprint, schema_version,
fingerprint_algorithm_version)` remains the only replay comparison:

| Stored row / current authenticated candidate | Receipt behavior | Persistence disposition |
|---|---|---|
| Current Handler schema and algorithm 1; exact current-valid semantic tuple; Resolver succeeds | Return the stored receipt without handler re-execution | No row change |
| Current Handler schema and algorithm 1; changed valid semantic payload; Resolver succeeds | Return `IdempotencyConflict`; do not disclose the prior result | Row unchanged |
| Historical Handler schema or algorithm (including P0 FNV if present); candidate passes current codec and Resolver | Existing exact tuple rule returns `IdempotencyConflict`; no historical comparator | Row unchanged; no guessing or upgrade |
| Exact tuple row whose result/error JSON cannot be decoded | Non-disclosing receipt-integrity Problem/Attention | Row unchanged; no repair |
| Stored receipt exists, but the current payload or CommandId fails the codec | Return `InvalidCommandPayload` before Resolver/Gateway; do not look up or disclose the receipt | Historical row preserved read-only; non-replayable |
| No stored row and malformed CommandId or payload | Return `InvalidCommandPayload`; no Resolver/Gateway or durable write | No receipt, attempt, Event, or canonical mutation |

No raw payload column, external wire-version column, compatibility table, or
F23 migration is added. The required read-only historical receipt inventory
before implementation authorization classifies rows by Handler schema,
fingerprint algorithm, resolution/result/error decodability, and known
deployment era/producer; it records counts and representative IDs/fields
without sensitive payloads. Migration 0033 and its AH10 AssignWork binding
contracts remain unchanged (DID §6A.16/§9.3/§9.9 and SD §4.11).

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

### EA-DG-01 migration contract — 0038

The ordered accepted/planned suffix is `0036` AH7/P36,
`0037` AH10 Deliver P9/P10, then `0038` Executable approval handoff.
Migration 0037 is conditional on integrated 0036; 0038 is conditional on both
0036 and 0037. Supported suffix paths are v35→36→37→38,
v36→37→38, and v37→38. A v35 database must not skip either prerequisite.

Migration `0038_executable_approval_handoff` is a forward-only rebuild of the
0032 unified `action_approvals` table. It adds exact Executable Step/action/
call/invocation identity fields and cancellation provenance, permits the
shared MAC `Cancelled` terminal state with provenance checks, and replaces
only 0032's route-blind digest uniqueness with separate Control and
Executable-logical-action partial indexes. Existing 0032 rows retain route,
`binding_proven`, source state, terminal Expired/Consumed disposition and
consumer identity; no binding is inferred and no prior migration or 0037
Deliver source row is rewritten. The rebuild also recreates the existing
`action_approvals_id_project UNIQUE(approval_id, project_id)` key from 0033;
`assign_work_target_bindings(action_approval_id, project_id)` depends on that
exact composite parent key. This is preservation of the existing AssignWork
foreign-key contract, not a new approval identity or Control behavior. The
exact DDL delta and legacy constraints are owned by DID §9.3 and P4 `03`/`06`.

The decision/Inbox/wake facts for request, Resolve, Expire and Stop remain in
their owning P1/P4/P6/P2 transactions as specified in the EA-DG-01 owner
contracts. This migration slot contract does not authorize executing the
migration or changing the preserved dogfood database.

### Accepted AH7-DG-02 P39 migration and operator-report contract (DID v1.40)

Accepted logical proposal SHA-256:
`D0A43BCDF3F95424BE7167B49D2170917B7605EE1E498A2601F2FFFB3DD6940B`;
accepted P39 physical supplement SHA-256:
`D2FF13087BB7A1BC5C9D422B4D5CEDE56689F83E765F96615FE13561CE5D446C`.
P4 `06` owns the P39 tool-invocation DDL; this section owns the global
`user_version`/startup boundary and the operator sidecar database contract.

The accepted/planned suffix is `0036` P36 → `0037` P37 → `0038` P38 →
`0039_ah7_reconciliation_attempts` P39. P39 depends on P36/P38 schema facts;
the global version prefix also requires P37. P36–P38 owner contracts are
integrated in this tree, but the real migration implementation/registration
for those versions is not. P39 is conditional and cannot be implemented,
installed or released alone. The actual P39 runner must gate before any
pending 0037/0038/0039 DDL when the primary DB is at `user_version` 36–38.

Before constructing either SQLite client, the P39-targeting maintenance entry
requires `--migration-block-report-db <absolute-local-path>`. There is no
default. The path must be local, non-temporary, distinct from the primary DB
and all of its sidecars/configured storage, and pass filesystem identity,
link/reparse/alias and supported-volume checks. Validate an existing sidecar
read-only first; only the exact reserved application id, schema version,
object set and schema digest are accepted. Never migrate/overwrite an unknown
or unrelated file. A new or empty identity-zero database may be initialized
exclusively with the accepted report table:

```sql
CREATE TABLE p39_migration_block_reports (
  report_key        TEXT PRIMARY KEY CHECK
                      (length(report_key) = 64 AND report_key NOT GLOB '*[^0-9a-f]*'),
  content_hash      TEXT NOT NULL UNIQUE CHECK
                      (length(content_hash) = 64 AND content_hash NOT GLOB '*[^0-9a-f]*'),
  report_json       TEXT NOT NULL
);
CREATE TRIGGER p39_report_no_update BEFORE UPDATE ON p39_migration_block_reports
BEGIN SELECT RAISE(ABORT, 'P39 audit report is immutable'); END;
CREATE TRIGGER p39_report_no_delete BEFORE DELETE ON p39_migration_block_reports
BEGIN SELECT RAISE(ABORT, 'P39 audit report is retained'); END;
```

Set and read back sidecar `application_id=0x41523739`, `user_version=1`,
`journal_mode=WAL`, `synchronous=FULL`, foreign keys and bounded busy timeout.
`report_key` is SHA-256 of canonical `{schema,targetUserVersion,
databaseFingerprint}`; `content_hash` hashes exact canonical UTF-8 report JSON
excluding that hash field. The immutable report contains stable schema/kind,
observed/target version, blocker-state fingerprint and sorted invocation IDs;
it contains no DB path, command/argument/resource path, principal or secret.
Same key and same bytes is idempotent; same key with different bytes is typed
`P39_REPORT_KEY_CONFLICT` and is never overwritten. On uncertain sidecar
commit, reopen and query exact key/hash before any continuation; unresolved
uncertainty fails closed.

The closed maintenance error set is `P39_REPORT_DB_REQUIRED`,
`P39_REPORT_DB_PATH_INVALID`, `P39_REPORT_DB_SCHEMA_UNSUPPORTED`,
`P39_REPORT_DB_PRAGMA_MISMATCH`, `P39_REPORT_DB_IO_FAILURE`,
`P39_REPORT_KEY_CONFLICT`, `P39_REPORT_COMMIT_UNRESOLVED`,
`P39_PRIMARY_JOURNAL_MODE_UNSUPPORTED`, `P39_REPORT_DURABILITY_UNSUPPORTED`,
and `P39_LEGACY_DB_ISOLATED`.
Diagnostics contain stable typed codes only, never the path or row contents.

Deployment maintenance mode stops every primary DB writer across preflight and
the ordered migration chain. Validate the sidecar first and close its
validation handle. For a v36–v38 primary, use the P1 adapter's preflight-only
`disableWAL=true`, require existing `journal_mode=wal` by readback, then take a
primary `BEGIN IMMEDIATE` consistent snapshot of `user_version` and active P36
unsettled `NotAdmitted` invocation IDs/fingerprint. This snapshot is read-only
at the committed application-state/schema/version level; transient SQLite
WAL/SHM lock metadata may be managed. If blockers exist, while retaining the
primary reservation acquire sidecar `BEGIN IMMEDIATE`, insert or verify the
immutable report, read it back, then rollback/close primary and exit
`P39_LEGACY_DB_ISOLATED` / 78 before pending P37/P38/P39 DDL or service start.
The primary DB's committed rows, approvals, P3 state and `user_version` remain
unchanged. That DB cohort stays isolated until future governance; do not
fabricate binding, refund/transfer approval, delete rows, or retry invocations.
If no blocker exists, rollback/close the snapshot and apply the ordered
0037→0038→0039 transactions while maintenance mode continues to exclude other
writers. The P39 rebuild/backfill/DDL/FK check and `user_version=39` update
share one forward-only transaction; there is no down migration.

The sidecar and primary use one lock order—primary then sidecar—and must be
distinct file identities. Retain sidecar DB and SQLite `-wal`/`-shm` together;
the named operator is responsible for backup and retention using SQLite's
consistent backup mechanism. Windows deployment is blocked until the actual
`@effect/sql-sqlite-node`/Node VFS, each supported local filesystem, and
hardware pass process-kill, injected I/O failure, VM hard-power-off, reopen and
integrity qualification. `FULL` durability is conditional on VFS/OS/device
flush behavior. Network and unknown filesystems fail closed before primary DB
open. No Windows deployment qualification is asserted here.

### Accepted AH7-DG-01 / P39-P40 migration and startup boundary (DID v1.41)

Accepted hashes: DG01 logical `19EFED54E037D3E2EC6F4D273D917F5249195650E5E41B3DCFF8DEB9784F29CD`;
P40 physical `5B61E0FF922A10D225FD5DAEA00176BD16C5C0B39484D626B7FEF6340516373A`;
compatibility addendum `8B8E5D3C5729CF5619605DA8D8DF34BA00E1F817E80A743555029F331690E830`;
matrix `AD9AB72D0AA51AB84F4194EC2BF4BB90EC957BD062788C480BCBDD39B8E8DD35`.

The ordered suffix is `0036` P36 → `0037` P37 → `0038` P38 → `0039` P39 →
`0040_tool_observation_evidence` P40. P40 may enter only at
`PRAGMA user_version=39`, cannot be registered in phase-local
`P4_MIGRATIONS`, cannot ship as a standalone v35 upgrade, and may not skip a
predecessor. These are owner contracts, not migration implementation.

P39 can be landed/applied only inside the ordered cumulative maintenance chain;
a P39-only database at `user_version=39` MUST NOT start Agent/P4 Runtime or be
released. Service start is permitted only after P40 commits version 40 and the
binary includes the accepted RNO branch in its closed v1 Observation decoder.
P40 adds only P4 `06` observation columns/triggers, the P9 replay-evidence
fact/event and P10 source-specific marker. It does not edit earlier migration
bodies/checksums, backfill historical terminal rows, change P39 selected facts,
or reuse/change the P39 sidecar/preflight.

P39's preflight/report rules remain unchanged. Cross-process serialization of
the cumulative startup migration runner is required before P40 can be
registered/executed; it is not qualified here. P36–P40 prefix integration and
P39 Windows/local-filesystem sidecar durability remain explicit gates. P40 is
forward-only and commits its DDL plus `user_version=40` atomically.

### Accepted P41 migration 0041 physical-storage gate

The accepted P41 storage package adds migration descriptor
`{ id: 41, name: "p41_submitted_decision_binding_attention" }`. The P9 fact key must be declared `TEXT NOT NULL PRIMARY KEY`; ordinary SQLite rowid tables permit NULL in non-INTEGER text primary-key columns unless explicitly `NOT NULL`. Its fact
relation is owned by P9 `07`; its rebuildable Attention marker is owned by P10
`02`/`04`. The exact DDL, composite keys, closed failure-code set and
immutability constraints are specified in those owner contracts. Migration
0041 is additive, creates both relations empty, and performs no historical
backfill or canonical-row rewrite.

Migration 0041 is conditional on the complete 0036→0037→0038→0039→0040 prefix
being integrated and qualified. A migration-runner registration-presence
check for IDs 37–40 is not qualification evidence. Until the prefix gate
passes, 0041 must not enter a runnable/current migration list. The runner
executes its DDL and `PRAGMA user_version = 41` in one transaction; failure
preserves the previous schema and version. A schema at `user_version <= 40`
does not support P41 storage and must not activate P41 recovery or Attention
projection. No down migration or new qualification marker is defined. The
existing refusal of a database whose `user_version` exceeds the latest known
migration remains in force.

#### Project resource source attribution (FT-DG-01 OPEN-1)

`resource_source_json` stores the exact P1 `ProjectResourceSource` tagged
union: `Profile` requires non-empty string `resourceProfileRef` and `version`;
`ConversationOnly` and `LegacyUnknown` have no additional fields. The
ProjectRepository decoder is strict over JSON syntax, tag, exact owned fields,
and primitive values. Invalid stored values fail as persistence corruption;
they are not repaired or coerced to `LegacyUnknown`. Application Project
inserts always set the column explicitly. The SQL default is retained only as
SQLite's additive-migration requirement, not as a new-command semantic
fallback.

The forward-only migration owner reserves ID 0042,
`project_resource_source_attribution`, in the production sequence only after
the integrated cumulative prefix includes P38/0038 and the already-owned
migrations 0039, 0040, and 0041. Its exact DDL is:

```sql
ALTER TABLE projects ADD COLUMN resource_source_json TEXT NOT NULL
  DEFAULT '{"_tag":"LegacyUnknown"}'
  CHECK (json_valid(resource_source_json));
UPDATE projects
   SET resource_source_json = '{"_tag":"LegacyUnknown"}';
```

The uniform backfill assigns every pre-existing Project `LegacyUnknown`; it
does not read Workspace ResourceBoundary/path, resource ownership, Events,
Commands/receipts, the Profile catalog, or the host filesystem. Migration
0042 must not be registered or executed ahead of 0039–0041, and must not be
run against the preserved user database under this authorization. When the
required prefix is integrated and qualified, 0042 is appended to
`CURRENT_MIGRATIONS` and the high-water mark advances to 42.

### P8 permanent RetryVerification origin and legacy disposition (DID v1.46)

The ordered forward-only migration is accepted at design level, but its
migration ID/name is **TBD** and it is not registered, implemented, or
authorized for execution. At activation it must follow the then-current
integrated migration prefix under the existing strict `user_version` gate and
commit DDL, backfill, `UnboundLegacy` facts, and matching P6 Governance Inbox
admissions atomically. Reapplying a committed migration is a no-op; a failed
or interrupted application leaves neither partial schema nor partial
backfill. No downgrade or online/preserved-DB upgrade is authorized here.

The permanent origin relation has exactly the following P8 facts and no
payload/tuple material:

```sql
CREATE TABLE retry_verification_origins (
  command_id                       TEXT PRIMARY KEY,
  project_id                       TEXT NOT NULL REFERENCES projects(project_id),
  actor                            TEXT NOT NULL,
  source_verification_id           TEXT NOT NULL REFERENCES verifications(verification_id),
  source_work_id                   TEXT NOT NULL REFERENCES works(work_id),
  successor_verification_id        TEXT NOT NULL REFERENCES verifications(verification_id),
  successor_verifier_execution_id  TEXT NOT NULL,
  created_at                       TEXT NOT NULL,
  UNIQUE (source_verification_id),
  UNIQUE (successor_verification_id),
  UNIQUE (successor_verifier_execution_id),
  FOREIGN KEY (command_id) REFERENCES commands(command_id)
    DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE retry_verification_legacy_dispositions (
  command_id    TEXT PRIMARY KEY REFERENCES commands(command_id),
  project_id    TEXT NOT NULL REFERENCES projects(project_id),
  disposition   TEXT NOT NULL CHECK (disposition = 'UnboundLegacy'),
  reason_code   TEXT NOT NULL CHECK (reason_code = 'OriginEvidenceIncomplete'),
  created_at    TEXT NOT NULL
);

CREATE TRIGGER retry_verification_origins_immutable_update
BEFORE UPDATE ON retry_verification_origins
BEGIN SELECT RAISE(ABORT, 'retry_verification_origin_immutable'); END;
CREATE TRIGGER retry_verification_origins_immutable_delete
BEFORE DELETE ON retry_verification_origins
BEGIN SELECT RAISE(ABORT, 'retry_verification_origin_immutable'); END;
CREATE TRIGGER retry_verification_legacy_dispositions_immutable_update
BEFORE UPDATE ON retry_verification_legacy_dispositions
BEGIN SELECT RAISE(ABORT, 'retry_verification_legacy_disposition_immutable'); END;
CREATE TRIGGER retry_verification_legacy_dispositions_immutable_delete
BEFORE DELETE ON retry_verification_legacy_dispositions
BEGIN SELECT RAISE(ABORT, 'retry_verification_legacy_disposition_immutable'); END;
```

The Application verifies that source/successor rows and project/work
relationships agree before insert. The successor verifier Execution ID has
no FK because P8 `02` creates it later through post-commit `AdmitExecution`
and binding backfill; that existing P8 intent boundary must remain intact.
Update and delete are prohibited; the
origin has the same effective lifetime as its never-hard-deleted Command
receipt and is not subject to Domain Event retention. It stores no fingerprint,
Handler schema version, fingerprint algorithm version, summary, expected
revision, payload JSON, or result JSON. The deferred Command FK permits the
origin to be inserted by the P8 handler inside the Gateway transaction before
Gateway inserts the successful receipt; both are present at commit or neither
is.

The separate `retry_verification_legacy_dispositions` fact marks a recognized
successful old P8 receipt for which origin cannot be proven. It stores only
`command_id`, `project_id`, fixed disposition `UnboundLegacy`, bounded
reason code `OriginEvidenceIncomplete`, and `created_at`; it never copies the
receipt payload/result. It is immutable, retained, and paired atomically with
the P6 human-only Governance Inbox entry keyed
`retry-verification-unbound:<commandId>`. If migration cannot resolve the
current P8 governance Workspace for that entry, it fails closed and rolls back
the migration/backfill rather than routing the item to a broader principal.

Backfill an origin only if one strict Committed RetryVerification result and
exactly one retained `VerificationConcluded(Unknown, Orphaned)` plus one
`VerificationStarted` event prove the same CommandId, ProjectId, actor, source
Work/Verification/revision and successor Verification; the successor
Verification's persisted preallocated `verification_execution_ids` must bind
the exact verifier Execution ID from the typed result; if a physical
`verification_executions`/Execution binding has already been admitted, it
must agree. Missing/pruned, duplicate, malformed, or conflicting evidence is
never inferred from Session text or a partial row: preserve the receipt,
insert `UnboundLegacy`, and admit the P6 entry in the same migration
transaction. Current Command receipts and historical JSON are never rewritten
or deleted.

## 6. Retention / delete (P1-DG-09)

```text
commands         NEVER hard-deleted (stable idempotency guarantee).
retry_verification_origins
                 NEVER hard-deleted; same lifetime as originating Command.
retry_verification_legacy_dispositions
                 retained as an immutable governance disposition.
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
