# P2 — 03 Lease / Fencing Model

**Authority:** DID v1.7 §3.4, §4.4, §6.3, §6A.5, §6A.6, §9.6, §9.7, §12.3,
§12.11; DID v1.7 G1.
**Status:** FROZEN; accepted AH7-DG-03 amendment (2026-10-10). Post-landing
consistency review pending.
**Accepted amendment:** `planning/proposals/AH7-approval-settlement-fixed-decision-draft.md`,
SHA-256 `E818CC208F6A3B233FEF213E54E02AA30A1E96D6147313870C75FDE38DC94CBE`.

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
execution_id         PK
worker_id
worker_incarnation_id
generation           INTEGER NOT NULL
expires_at
updated_at
```

- `generation` is monotonic per `execution_id`: a successful acquisition sets
  `generation = COALESCE(MAX(generation), -1) + 1` (first acquisition = 0).
- Acquisition is a CAS: it succeeds only when no live lease exists or the
  previous lease is expired (`expires_at <= now`).
- Renewal is a CAS on `(worker_id, worker_incarnation_id, generation)`; a stale
  `generation` fails.
- Release is a CAS on `(worker_id, worker_incarnation_id, generation)`.
- Lease duration / renewal cadence are implementation parameters, not contract.

`LeaseRecord = { executionId, workerId, workerIncarnationId, generation, expiresAt, updatedAt }`.

> **P12 TR-9 propagation (P12 `06` §3).** The lease holder identity is the
> triple `(worker_id, worker_incarnation_id, generation)` so an old process
> incarnation of the same `WorkerId` cannot re-validate. `generation` remains
> monotonic; all other lease semantics are unchanged.

**ExecutionOrigin provenance.** A production Worker drive receives its
`ExecutionOrigin` from the `LeaseRecord` returned by that drive's successful
`LeaseService.acquire`. Dispatch/wake, a stored lease row, or a tuple copied
from another caller does not create a second lease owner. A second driver may
start only after its own successful acquisition; live-lease rejection leaves
the current driver as the sole authorized writer, while expiry/takeover uses
the existing monotonic generation rule.

## 3. Fence validation

Fencing protects **all** Worker-originated durable writes (DID §6.3):

```text
Execution semantic mutation
Session append
ProviderTurn settlement
ToolInvocation intent / approval consumption / effect admission / settlement
ToolInvocation no-effect Denied / Interrupted settlement
Agent-produced canonical command
```

Authoritative predicate (P1 `04` §4, tables now exist):

```sql
SELECT 1
FROM executions e
JOIN execution_leases l ON l.execution_id = e.execution_id
WHERE e.execution_id = ?
  AND l.worker_id = ?
  AND l.worker_incarnation_id = ?
  AND l.generation = ?
  AND l.expires_at > ?
  AND e.settled_at IS NULL;
```

> **P12 TR-9 propagation (P12 `06` §3).** The authoritative predicate extends to
> the lease-holder triple `(worker_id, worker_incarnation_id, generation)`;
> matching on generation alone is insufficient. The same-transaction
> authoritative-fence semantics are unchanged.

> **Inherited P1 fence-contract correction (R8).** The frozen P1 hook
> predicate (`P1 04` §4) checked ownership/generation only. System Design v1.3
> §10.5 requires that an expired Worker cannot commit, so the authoritative
> implementation additionally requires `expires_at > now`; P1 `04` §4 has been
> corrected to match **without reopening the P1 phase**. This is the predicate
> P2 implements.

- No row → authoritative rejection (`FencingRejected` for canonical commands;
  `LeaseFencingRejected` for runtime operational writes).
- The check **must** share the transaction of the canonical write, Command
  resolution and Domain Event append; a transaction-external pre-check is only
  a fast-fail (no TOCTOU) (DID §6.3, §12.3).
- P4 applies the same predicate in the mutation transaction for intent,
  approval consumption, effect admission, no-effect Denied/Interrupted, and
  ToolInvocation settlement. Approval-required claim composes intent insertion
  and approval compare-and-set in one `TransactionScope`; a stale fence cannot
  leave a partial claim. P4 effect admission also requires
  `stop_requested_at IS NULL` before writing
  `effect_admission_state = MayHaveStarted`.
- `executions.settled_at IS NULL` means a fence can never authorize a write on
  a settled Execution.

## 4. Stop / quiescence admission

Two **independent** checks (DID §9.7):

```text
1) fence validation (ownership/generation; P12 TR-9 triple
     (worker_id, worker_incarnation_id, generation))
     invalid -> CommandRejection.FencingRejected
2) stop / quiescence admission
     fence valid but stop_requested_at != null
     -> NormalExecutionMutation: CommandRejection.ExecutionStopping
     -> QuiescenceControlMutation: Pass
```

- A generation that is still valid must never receive `FencingRejected` merely
  because `stop_requested_at != null`.
- P4 claim/intent and effect-admission transactions apply both checks in this
  order: validate the full current lease tuple and expiry, then inspect
  `stop_requested_at` in the same transaction. If StopExecution committed
  first, claim returns `ExecutionStopping` without intent or approval
  consumption; an already claimed `NotAdmitted` invocation settles
  `Interrupted` without effect. Neither outcome is permission Denied.
- StopExecution and P4 effect admission linearize by commit order. If the
  effect-admission commit wins, the invocation is in flight and P4
  cancellation/confirmation/reconciliation applies; stop does not authorize a
  new Executor call or replay.
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
- `LeaseFencingRejected` at a P4 intent/approval/effect-admission/settlement
  boundary likewise rejects that old Worker write. If the effect-admission
  marker already committed, generic external I/O may not accept a lease token;
  a late old-Worker settlement is fenced and P2/P9 recover from the durable
  `MayHaveStarted` state without assuming the effect was absent.
- Neither automatically fails or cancels the Work (DID §6A.5).

## 8. Out of scope

- Worker crash / daemon crash / provider disconnect / tool `OutcomeUnknown`
  fault-injection hardening (P9); P2 provides the skeleton (`06`).
- Lease duration / renewal cadence numeric values (implementation).
- Specialist concurrency limits (none added in P2).
