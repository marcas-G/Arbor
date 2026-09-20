# P2 — 04 SQLite Schema

**Authority:** DID v1.7 §9.1, §9.6, §9.7, §9.8, §9.13, §12.3; DID v1.7 G5.
**Status:** DRAFT (first draft for gap review).

P2 lands the `executions` / `execution_leases` tables that P1 `04` §4 explicitly
deferred, plus the Session / AgentExecutionState / wait / timer records.

## 1. Storage settings (inherited, unchanged)

```text
WAL; PRAGMA foreign_keys = ON; busy_timeout; synchronous = FULL
BEGIN IMMEDIATE for every write scope
```

## 2. Migration

```text
P1: 0001_init
P2: 0002_execution_session_kernel   (forward-only; PRAGMA user_version = 2)
```

Additive migration in a single transaction; startup refuses when
`user_version > latest`.

## 3. DDL

### 3.1 executions

```sql
CREATE TABLE executions (
  execution_id        TEXT PRIMARY KEY,
  project_id          TEXT NOT NULL REFERENCES projects(project_id),
  binding_kind        TEXT NOT NULL CHECK (binding_kind IN ('workspace','execution_bound')),
  workspace_id        TEXT NOT NULL REFERENCES workspaces(workspace_id),
  focus_kind          TEXT CHECK (focus_kind IN ('work','coordination')),
  focus_work_id       TEXT REFERENCES works(work_id),
  parent_execution_id TEXT REFERENCES executions(execution_id),
  mission             TEXT,
  session_id          TEXT NOT NULL REFERENCES sessions(session_id),
  admitted_at         TEXT NOT NULL,
  stop_requested_at   TEXT,
  settlement_kind     TEXT CHECK (settlement_kind IN
                        ('Completed','Interrupted','Failed','OutcomeUnknown')),
  settlement_json     TEXT,
  settled_at          TEXT,
  CHECK ((binding_kind = 'workspace') = (focus_kind IS NOT NULL)),
  CHECK ((focus_kind = 'work') = (focus_work_id IS NOT NULL)),
  CHECK (binding_kind = 'execution_bound' OR parent_execution_id IS NULL),
  CHECK (binding_kind = 'execution_bound' OR mission IS NULL),
  CHECK ((settlement_kind IS NULL) = (settled_at IS NULL)),
  CHECK ((settlement_kind IS NULL) = (settlement_json IS NULL))
);

CREATE UNIQUE INDEX idx_executions_active_main
  ON executions(workspace_id)
  WHERE binding_kind = 'workspace' AND settled_at IS NULL;

CREATE INDEX idx_executions_project ON executions(project_id);
CREATE INDEX idx_executions_unsettled ON executions(settled_at) WHERE settled_at IS NULL;
```

- `binding_kind = 'workspace'` → `WorkspaceExecution` (focus Work/Coordination).
- `binding_kind = 'execution_bound'` → specialist; `focus_kind IS NULL`,
  `parent_execution_id` / `mission` present.
- The partial unique index enforces at most one active **main** Execution;
  `ExecutionBound` rows are unconstrained (no specialist concurrency limit).

### 3.2 execution_leases

```sql
CREATE TABLE execution_leases (
  execution_id TEXT PRIMARY KEY REFERENCES executions(execution_id),
  worker_id    TEXT NOT NULL,
  generation   INTEGER NOT NULL,
  expires_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);

CREATE INDEX idx_execution_leases_expiry ON execution_leases(expires_at);
```

### 3.3 agent_execution_state

```sql
CREATE TABLE agent_execution_state (
  execution_id                    TEXT PRIMARY KEY REFERENCES executions(execution_id),
  focus_json                      TEXT NOT NULL,
  wake_reason                     TEXT NOT NULL,
  current_mode                    TEXT,
  active_skill_refs_json          TEXT NOT NULL,
  turn_no                         INTEGER NOT NULL,
  recent_directive_refs_json      TEXT NOT NULL,
  recent_action_fingerprints_json TEXT NOT NULL,
  updated_at                      TEXT NOT NULL
);
```

Fields mirror DID §3.7. High-frequency `turn_no` updates are runtime
operational writes; they never enter the Project Domain Event journal.

### 3.4 session_entries

```sql
CREATE TABLE session_entries (
  session_id   TEXT NOT NULL REFERENCES sessions(session_id),
  sequence     INTEGER NOT NULL,
  entry_kind   TEXT NOT NULL CHECK (entry_kind IN
                 ('Input','ModelOutput','Observation','CheckpointReference','ContextUpdate')),
  payload_json TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  PRIMARY KEY (session_id, sequence)
);
```

`sequence` is Session-local (`MAX(sequence)+1`, serialized by
`BEGIN IMMEDIATE`). Streaming deltas are not stored here (DID §9.8).

### 3.5 work_waits

```sql
CREATE TABLE work_waits (
  work_id         TEXT PRIMARY KEY REFERENCES works(work_id),
  wait_mode       TEXT NOT NULL CHECK (wait_mode = 'Any'),
  conditions_json TEXT NOT NULL,
  registered_at   TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);
```

`conditions_json` is a non-empty `WakeCondition[]` (`05` §2); empty is rejected
before write.

### 3.6 scheduler_timers

```sql
CREATE TABLE scheduler_timers (
  timer_id     TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(workspace_id),
  work_id      TEXT REFERENCES works(work_id),
  kind         TEXT NOT NULL CHECK (kind = 'TimeReached'),
  fire_at      TEXT NOT NULL,
  created_at   TEXT NOT NULL
);

CREATE INDEX idx_scheduler_timers_due ON scheduler_timers(fire_at);
```

`TimeReached` waits are durable here, never in a Worker's in-memory timer
(DID §8.16).

## 4. Fence / stop / CAS queries

```sql
-- fence validity (authoritative; same tx as the mutation; expires_at enforced)
SELECT 1
FROM executions e
JOIN execution_leases l ON l.execution_id = e.execution_id
WHERE e.execution_id = ? AND l.generation = ? AND l.expires_at > ? AND e.settled_at IS NULL;

-- stop admission
SELECT stop_requested_at IS NOT NULL
FROM executions WHERE execution_id = ?;

-- settle-once CAS
UPDATE executions
SET settlement_kind = ?, settlement_json = ?, settled_at = ?
WHERE execution_id = ? AND settled_at IS NULL
RETURNING execution_id;
-- no row -> already settled (idempotent receipt / TerminalLifecycleMutation)

-- lease acquisition (succeeds only when absent or expired)
INSERT INTO execution_leases (execution_id, worker_id, generation, expires_at, updated_at)
VALUES (?, ?, COALESCE((SELECT MAX(generation) + 1
                        FROM execution_leases WHERE execution_id = ?), 0), ?, ?)
ON CONFLICT(execution_id) DO UPDATE
  SET worker_id = excluded.worker_id,
      generation = excluded.generation,
      expires_at = excluded.expires_at,
      updated_at = excluded.updated_at
  WHERE execution_leases.expires_at <= ?
RETURNING generation;
-- no row -> a live lease exists -> acquisition fails

-- lease renewal
UPDATE execution_leases
SET expires_at = ?, updated_at = ?
WHERE execution_id = ? AND worker_id = ? AND generation = ?
RETURNING generation;
-- no row -> LeaseLost (stale generation)

-- lease release is SOFT (never DELETE): generation must stay monotonic so a
-- stale worker's fence can never re-validate after release/re-acquire.
UPDATE execution_leases
SET expires_at = ?, updated_at = ?
WHERE execution_id = ? AND worker_id = ? AND generation = ?;

-- admission main pre-check inside BEGIN IMMEDIATE
SELECT 1 FROM executions
WHERE workspace_id = ? AND binding_kind = 'workspace' AND settled_at IS NULL;
-- row -> ActiveExecutionConflict (partial unique index is the safety net)
```

## 5. Retention

```text
executions            NEVER hard-deleted (canonical + recovery anchor).
execution_leases      transient runtime ownership; deletion allowed once expired/released.
agent_execution_state runtime control state; retention/archival allowed.
session_entries       append-only history; retention per Session policy (P3+).
work_waits            deleted/cleared on wake; not history.
scheduler_timers      deleted on fire/cancel.
```

## 6. Out of scope

- ProviderTurn / ToolInvocation / Evidence / Usage tables (P3/P4/P8).
- Environment change DDL (P11).
- Projection tables (P10).
