# P3 — 04 SQLite Schema

**Authority:** DID v1.7 §9.8, §9.10, §9.11, §9.13; P2 `04` (session_entries seam).
**Status:** DRAFT (first draft for contract review).

## 1. Storage settings (inherited)

WAL; `foreign_keys = ON`; `busy_timeout`; `synchronous = FULL`;
`BEGIN IMMEDIATE` for write scopes.

## 2. Migration

```text
P1: 0001_init
P2: 0002_execution_session_kernel
P3: 0003_provider_model_context      (forward-only; PRAGMA user_version = 3)
v1.21: 0017_agent_loop_step_handoff (forward-only; implementation authorized)
```

## 3. DDL

### 3.1 provider_turns

```sql
CREATE TABLE provider_turns (
  provider_turn_id    TEXT PRIMARY KEY,
  execution_id        TEXT NOT NULL REFERENCES executions(execution_id),
  session_id          TEXT NOT NULL REFERENCES sessions(session_id),
  context_epoch       INTEGER NOT NULL,
  model_ref           TEXT NOT NULL,
  output_contract_ref TEXT NOT NULL,
  manifest_id         TEXT NOT NULL,
  started_at          TEXT NOT NULL,
  settled_at          TEXT,
  finish_reason       TEXT,
  usage_json          TEXT,
  created_at          TEXT NOT NULL,
  CHECK ((settled_at IS NULL) = (finish_reason IS NULL))
);

CREATE INDEX idx_provider_turns_execution ON provider_turns(execution_id);
```

The Turn intent + Manifest row is written **before** the provider request
(DID §9.10), so a crash can always answer which context was used.

### 3.2 provider_attempts

```sql
CREATE TABLE provider_attempts (
  provider_turn_id      TEXT NOT NULL
                          REFERENCES provider_turns(provider_turn_id),
  attempt_no            INTEGER NOT NULL,
  started_at            TEXT NOT NULL,
  settled_at            TEXT,
  outcome               TEXT NOT NULL CHECK (outcome IN
                          ('Success','RetryableFailure','TerminalFailure')),
  provider_error_kind   TEXT,
  transport_metadata_json TEXT,
  PRIMARY KEY (provider_turn_id, attempt_no)
);
```

`attempt_no` is Turn-local from 0; retries never create a new Turn or bump the
Agent `turnNo` (DID §6A.9).

> **Current-baseline propagation.** P16 continuation/usage migrations already
> add `canonical_event_prefix_json`, delivered position/checkpoint and retry
> evidence. DID v1.20 migration 0017 adds `success_evidence_version`; P3 `08`
> uses the persisted canonical prefix plus that validator version for complete-
> success local convergence. New Provider success atomically updates Attempt
> and Turn in one transaction.

### 3.3 model_context_manifests

```sql
CREATE TABLE model_context_manifests (
  manifest_id          TEXT PRIMARY KEY,
  provider_turn_id     TEXT NOT NULL REFERENCES provider_turns(provider_turn_id),
  execution_id         TEXT NOT NULL,
  session_id           TEXT NOT NULL,
  context_epoch        INTEGER NOT NULL,
  model_ref            TEXT NOT NULL,
  compiled_request_hash TEXT NOT NULL,
  manifest_json        TEXT NOT NULL,
  created_at           TEXT NOT NULL
);
```

`manifest_json` stores the DID §8.19 `ModelContextManifest` (instructions,
context refs, skill/tool refs, output contract, budget decision, `ControlBasis`).

### 3.4 Session entry content (P3 over P2's table)

P2 owns `session_entries`; P3 owns the payload shapes for its entry kinds:

```ts
type P3SessionEntry =
  | { entryKind: "ModelOutput"; payload: { providerTurnId; outputContractRef;
      decoderVersion: string; invocationKinds: ReadonlyArray<string>;
      textRef?: string; contentHash: string } }
  | { entryKind: "Observation"; payload: { source: "Tool" | "Provider" | "Runtime";
      ref: string; trust: InformationTrustMetadata } }
  | { entryKind: "CheckpointReference"; payload: { checkpointRef; summaryRef;
      epoch: number } }
  | { entryKind: "ContextUpdate"; payload: { fragmentRefs: ReadonlyArray<string>;
      reason: "Compaction" | "ProgressiveDisclosure" } };
```

- Streaming deltas are never stored (DID §9.8).
- Entry append is fenced when worker-originated (P2 `02` §3).
- `invocationKinds` is diagnostic metadata only; trusted invocation identity
  and disposition live in the AgentLoopStep action ledger, not this payload.
- DID v1.20 adds `source_kind/source_ref/content_hash` and the unique partial
  source index through migration 0017 (P2 `04` §3.4). ModelOutput source is the
  owning ProviderTurn; same source/different hash is an invariant conflict.

### 3.5 AgentLoopStep handoff schema (v1.20 successor)

P2 `04` §3.7 owns the exact `agent_loop_steps` / `agent_loop_step_actions` DDL. P3 `08`
owns their state semantics. This document does not define a second schema.
Migration 0017 is authorized by DID v1.21 ALS-I1.

## 4. Retention

```text
provider_turns / provider_attempts   runtime trace; retention/archival allowed.
model_context_manifests              provenance; retained with the Turn.
session_entries                      append-only history; Session policy.
agent_loop_steps / agent_loop_step_actions     retained with Execution + Provider result.
```

## 5. Out of scope

- Tool invocation / evidence / usage tables (P4/P8).
- Memory / knowledge stores (later phase).
- Projection tables (P10).
