# P2 — 03 Lease / Fencing Model

**Authority:** DID v1.7 §3.4, §4.4, §6.3, §6A.5, §6A.6, §9.6, §9.7, §12.3,
§12.11; DID v1.7 G1.
**Status:** DRAFT (first draft for gap review).

This document freezes the P2 lease/fencing mechanism. DID §9.7 freezes the
*guarantees* (expiry + generation + authoritative same-transaction check); P2
freezes the concrete mechanism.

## 1. Observable guarantee

```text
Execution identity = durable
Worker identity    = replaceable
```

- Every active **main** Execution is temporarily assigned to a Worker by a
  lease with an expiry and a monotonic generation/fencing token.
- An expired or superseded Worker must not commit any durable mutation, even
  if it resumes.
- At most one active main Execution per Workspace (partial unique index).
- Worker crash / lease expiry alone never transitions `Active → Settled`.

## 2. Lease record

```text
execution_leases
────────────────────────────
execution_id    PK
worker_id
generation      INTEGER NOT NULL
expires_at
updated_at
```

- `generation` is monotonic per `execution_id`: a successful acquisition sets
  `generation = COALESCE(MAX(generation), -1) + 1` (first acquisition = 0).
- Acquisition is a CAS: it succeeds only when no live lease exists or the
  previous lease is expired (`expires_at <= now`).
- Renewal is a CAS on `(worker_id, generation)`; a stale `generation` fails.
- Release is a CAS on `(worker_id, generation)`.
- Lease duration / renewal cadence are implementation parameters, not contract.

`LeaseRecord = { executionId, workerId, generation, expiresAt, updatedAt }`.

## 3. Fence validation

Fencing protects **all** Worker-originated durable writes (DID §6.3):

```text
Execution semantic mutation
Session append
ProviderTurn settlement
ToolInvocation settlement
Agent-produced canonical command
```

Authoritative predicate (P1 `04` §4, tables now exist):

```sql
SELECT 1
FROM executions e
JOIN execution_leases l ON l.execution_id = e.execution_id
WHERE e.execution_id = ?
  AND l.generation = ?
  AND l.expires_at > ?
  AND e.settled_at IS NULL;
```

> **P2 correction (SD v1.3 §10.5):** the frozen P1 hook predicate
> (`P1 04` §4) checks ownership/generation only. The real P2 implementation
> additionally requires `expires_at > now`, otherwise a resurrected worker
> whose lease expired (but was not yet invalidated) could still commit —
> violating "过期 Worker 即使恢复，也不能继续提交状态".

- No row → authoritative rejection (`FencingRejected` for canonical commands;
  `LeaseFencingRejected` for runtime operational writes).
- The check **must** share the transaction of the canonical write, Command
  resolution and Domain Event append; a transaction-external pre-check is only
  a fast-fail (no TOCTOU) (DID §6.3, §12.3).
- `executions.settled_at IS NULL` means a fence can never authorize a write on
  a settled Execution.

## 4. Stop / quiescence admission

Two **independent** checks (DID §9.7):

```text
1) fence validation (ownership/generation)
     invalid -> CommandRejection.FencingRejected
2) stop / quiescence admission
     fence valid but stop_requested_at != null
     -> NormalExecutionMutation: CommandRejection.ExecutionStopping
     -> QuiescenceControlMutation: Pass
```

- A generation that is still valid must never receive `FencingRejected` merely
  because `stop_requested_at != null`.
- `StopExecution` itself is not classified (`01` §3) and is admissible while
  the Execution is Active.
- Admission (`AdmitExecution`) is not classified.

## 5. Quiescence-control admission and settlement validity

### 5.1 QuiescenceControlMutation

`SettleExecution` on the `ExecutionOrigin` path is a
`QuiescenceControlMutation` (`01` §3): admitted after `stop_requested_at !=
null`, but **still** subject to authoritative fencing. A stale Worker can
therefore never settle an Execution after losing its lease.

`RecoveryController` settlement is not classified and carries no worker
generation.

### 5.2 Settlement structural validity

The Runtime is the only producer of an `ExecutionSettlement`. A structurally
invalid settlement is a **defect** (invariant violation, DID §0A.1), not a
typed rejection:

```text
Completed(Yielded)             requires a non-empty WaitSpec
Completed(CompletionClaimed)   requires claimRef + target Work revision
Completed(CoordinationCompleted | QueryCompleted)  no extra fields
Interrupted(StopRequested)     requires stop_requested_at != null
Interrupted(ControlledInterruption)  requires reason
Failed(ExecutionFailure)       requires reason
OutcomeUnknown(ReconciliationRequired) requires non-empty invocationRefs
```

- `Completed(Yielded)` registers/replaces the durable `WorkWait` in the **same
  transaction** as the settlement and re-reads observed facts; if an observed
  fact already changed, the Work must not be permanently parked (`05` §5).
- A semantic precondition violation that is reachable from a legitimate
  Runtime state (e.g. `Interrupted(StopRequested)` without a stop request)
  is `TerminalRejected(AuthorityDenied)` with a reason; a structurally
  malformed ADT is a defect.

## 6. Recovery authority

`RecoveryController` is an authenticated submission origin (`01` §2.2). A
recovery settlement:

```text
- uses SettleExecutionAuthority { submissionOrigin: "RecoveryController" }
- carries no worker fencingGeneration
- is admissible only through the recovery path (06), not through a live Worker
- still writes canonical state + Committed receipt + Domain Event atomically
```

Recovery never resurrects an old Worker's authority; it settles from durable
trace + reconciled external reality (DID §6A.6, SD §10.6).

## 7. LeaseLost vs FencingRejected

```text
LeaseLost       = worker/runtime local ownership knowledge
FencingRejected = authoritative persistence rejection
```

- `LeaseLost` is a runtime signal; it may trigger a runtime stop but is not a
  durable truth.
- `FencingRejected` is terminal for the Execution-originated logical Command;
  the old Worker must stop durable mutation and must not ordinary-retry
  (DID §6A.5).
- Neither automatically fails or cancels the Work (DID §6A.5).

## 8. Out of scope

- Worker crash / daemon crash / provider disconnect / tool `OutcomeUnknown`
  fault-injection hardening (P9); P2 provides the skeleton (`06`).
- Lease duration / renewal cadence numeric values (implementation).
- Specialist concurrency limits (none added in P2).
