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
- Domain mapping (R6/R9): the `Execution` record carries `workspaceId` (owning
  Workspace, both binding kinds) and `stopRequestedAt`, matching `workspace_id`
  and `stop_requested_at`.

### 3.2 execution_leases

```sql
CREATE TABLE execution_leases (
  execution_id          TEXT PRIMARY KEY REFERENCES executions(execution_id),
  worker_id             TEXT NOT NULL,
  worker_incarnation_id TEXT NOT NULL DEFAULT '',   -- P12 TR-9 (migration 0011)
  generation            INTEGER NOT NULL,
  expires_at            TEXT NOT NULL,
  updated_at            TEXT NOT NULL
);

CREATE INDEX idx_execution_leases_expiry ON execution_leases(expires_at);
```

> **P12 TR-9 propagation (P12 `06` §3).** `worker_incarnation_id` is added by
> P12 migration `0011_lease_worker_incarnation` (forward-only; P12 final
> baseline `user_version = 13`); the holder / fence identity is the triple
> `(worker_id, worker_incarnation_id, generation)`. No other P2 schema semantics
> change.

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

Migration `0017_agent_loop_step_handoff` rebuilds `session_entries` inside the
migration transaction so the source-shape invariant is a table `CHECK` (the
runner intentionally splits ordinary statements and does not parse trigger
bodies). Legacy rows are copied with an all-null source:

```sql
ALTER TABLE provider_attempts ADD COLUMN success_evidence_version TEXT;

ALTER TABLE session_entries RENAME TO session_entries_legacy_v1;

CREATE TABLE session_entries (
  session_id   TEXT NOT NULL REFERENCES sessions(session_id),
  sequence     INTEGER NOT NULL,
  entry_kind   TEXT NOT NULL CHECK (entry_kind IN
                 ('Input','ModelOutput','Observation','CheckpointReference','ContextUpdate')),
  payload_json TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  source_kind  TEXT,
  source_ref   TEXT,
  content_hash TEXT,
  PRIMARY KEY (session_id, sequence),
  CHECK (
    (source_kind IS NULL AND source_ref IS NULL AND content_hash IS NULL)
    OR
    (source_kind IS NOT NULL AND source_ref IS NOT NULL AND content_hash IS NOT NULL)
  )
);

INSERT INTO session_entries (..., source_kind, source_ref, content_hash)
SELECT ..., NULL, NULL, NULL FROM session_entries_legacy_v1;

DROP TABLE session_entries_legacy_v1;

CREATE UNIQUE INDEX idx_session_entries_source
  ON session_entries(session_id, entry_kind, source_kind, source_ref)
  WHERE source_kind IS NOT NULL;

```

For runtime-produced ModelOutput, `source_kind='ProviderTurn'` and
`source_ref=provider_turn_id`. New sourced entries require all three source/hash
columns; legacy nulls are admitted only as migration evidence and are never
silently matched by payload text.

`provider_attempts.success_evidence_version` pins the complete-canonical-event
validator used by P3 `08` §5. New atomic success writes set it. Legacy nulls are
accepted only by the governed legacy validator and are filled when locally
converged; null never means “complete”.

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

### 3.7 agent_loop_steps / agent_loop_step_actions (migration 0017)

```sql
CREATE TABLE agent_loop_steps (
  execution_id                  TEXT NOT NULL REFERENCES executions(execution_id),
  logical_step_no               INTEGER NOT NULL CHECK (logical_step_no >= 0),
  repair_attempt                INTEGER NOT NULL CHECK (repair_attempt >= 0),
  provider_turn_id              TEXT NOT NULL UNIQUE,
  predecessor_logical_step_no   INTEGER,
  predecessor_repair_attempt    INTEGER,
  manifest_id                   TEXT,
  state                         TEXT NOT NULL CHECK (state IN
    ('Prepared','ProviderResultAvailable','OutputRejected','OutputAccepted',
     'ActionsInProgress','StepEffectsCommitted','NextStepReady',
     'SettlementProposed')),
  decoder_version               TEXT,
  provider_failure_json         TEXT,
  repair_disposition_json       TEXT,
  successor_json                TEXT,
  next_step_reason              TEXT,
  decoded_output_hash           TEXT,
  model_output_session_sequence INTEGER,
  next_action_index             INTEGER NOT NULL DEFAULT 0 CHECK (next_action_index >= 0),
  settlement_json               TEXT,
  migration_provenance_json     TEXT,
  revision                      INTEGER NOT NULL CHECK (revision >= 0),
  updated_at                    TEXT NOT NULL,
  PRIMARY KEY (execution_id, logical_step_no, repair_attempt),
  CHECK ((predecessor_logical_step_no IS NULL) =
         (predecessor_repair_attempt IS NULL)),
  CHECK ((state = 'SettlementProposed') = (settlement_json IS NOT NULL))
);

CREATE INDEX idx_agent_loop_steps_execution_state
  ON agent_loop_steps(execution_id, state);

CREATE TABLE agent_loop_step_actions (
  execution_id           TEXT NOT NULL,
  logical_step_no        INTEGER NOT NULL,
  repair_attempt         INTEGER NOT NULL,
  action_index           INTEGER NOT NULL CHECK (action_index >= 0),
  logical_action_id      TEXT NOT NULL UNIQUE,
  call_ref               TEXT NOT NULL,
  route_kind             TEXT NOT NULL CHECK (route_kind IN ('Executable','Control')),
  action_kind            TEXT NOT NULL,
  input_hash             TEXT NOT NULL,
  state                  TEXT NOT NULL CHECK (state IN
    ('Pending','Applied','SkippedStale','SkippedEarlySettlement',
     'TerminalRejected','ReconciliationPending')),
  result_ref             TEXT,
  settlement_ref         TEXT,
  disposition_json       TEXT,
  observation_source_ref TEXT,
  revision               INTEGER NOT NULL CHECK (revision >= 0),
  updated_at              TEXT NOT NULL,
  PRIMARY KEY (execution_id, logical_step_no, repair_attempt, action_index),
  FOREIGN KEY (execution_id, logical_step_no, repair_attempt)
    REFERENCES agent_loop_steps(execution_id, logical_step_no, repair_attempt)
);
```

`provider_turn_id` is preallocated before the ProviderTurn row exists, so it is
unique but deliberately not an immediate FK. Binding is validated by the P3
store when Manifest/ProviderTurn is created. Action rows persist hashes and
references only; the process-local `AgentAction` is not serialized.

## 4. Fence / stop / CAS queries

```sql
-- fence validity (authoritative; same tx as the mutation; expires_at enforced;
-- P12 TR-9: lease-holder triple (worker_id, worker_incarnation_id, generation))
SELECT 1
FROM executions e
JOIN execution_leases l ON l.execution_id = e.execution_id
WHERE e.execution_id = ? AND l.worker_id = ? AND l.worker_incarnation_id = ?
  AND l.generation = ? AND l.expires_at > ? AND e.settled_at IS NULL;

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
INSERT INTO execution_leases (execution_id, worker_id, worker_incarnation_id, generation, expires_at, updated_at)
VALUES (?, ?, ?, COALESCE((SELECT MAX(generation) + 1
                        FROM execution_leases WHERE execution_id = ?), 0), ?, ?)
ON CONFLICT(execution_id) DO UPDATE
  SET worker_id = excluded.worker_id,
      worker_incarnation_id = excluded.worker_incarnation_id,
      generation = excluded.generation,
      expires_at = excluded.expires_at,
      updated_at = excluded.updated_at
  WHERE execution_leases.expires_at <= ?
RETURNING generation;
-- no row -> a live lease exists -> acquisition fails

-- lease renewal
UPDATE execution_leases
SET expires_at = ?, updated_at = ?
WHERE execution_id = ? AND worker_id = ? AND worker_incarnation_id = ? AND generation = ?
RETURNING generation;
-- no row -> LeaseLost (stale generation)

-- lease release is SOFT (never DELETE): generation must stay monotonic so a
-- stale worker's fence can never re-validate after release/re-acquire.
UPDATE execution_leases
SET expires_at = ?, updated_at = ?
WHERE execution_id = ? AND worker_id = ? AND worker_incarnation_id = ? AND generation = ?;

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
agent_loop_steps/actions    recovery anchors; retain with the owning Execution and
                       referenced Provider/Tool evidence.
work_waits            deleted/cleared on wake; not history.
scheduler_timers      deleted on fire/cancel.
```

## 6. Out of scope

- ProviderTurn / ToolInvocation / Evidence / Usage tables (P3/P4/P8).
- Environment change DDL (P11).
- Projection tables (P10).
