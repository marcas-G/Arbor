# P2 — 06 Recovery Skeleton

**Authority:** DID v1.7 §3.4, §6A.6, §9.6, §9.7, §12.11; System Design v1.3
§10.3–§10.7; DID v1.7 G1.
**Status:** DRAFT (first draft for gap review).

## 1. Scope (P2 skeleton vs P9 hardening)

P2 delivers a deterministic **Execution-boundary recovery skeleton**. It does
not perform systematic fault-injection hardening (P9) and does not reconcile
Provider/Tool reality (P3/P4).

```text
P2 skeleton covers:
  load canonical state
  invalidate expired leases
  find unsettled Executions
  settle deterministic Execution outcomes (RecoveryController authority)
  rebuild the runnable set via RunnableWorkSource (P7 source; P2 stub)
  re-dispatch or leave Active for the Scheduler

P2 skeleton defers:
  Provider / Tool / external-effect reconciliation (P3/P4) -> ReconciliationSource stub
  genuinely uncertain cases -> escalate / Attention (no blind replay)
  projection rebuild (P10)
  worker-crash / daemon-crash / resurrection fault injection (P9)
```

## 2. Recovery order

```text
1. Load Canonical State
2. Invalidate expired leases
3. Find unsettled Execution boundaries
4. Reconcile external reality            (P2: ReconciliationSource stub)
5. Settle deterministic outcomes         (RecoveryController)
6. Escalate genuinely uncertain cases
7. Rebuild runnable set                  (RunnableWorkSource; P7 real source)
8. Rebuild projections                   (P10)
9. Resume meaningful work only
```

Core principle (SD §10.6): **recover reality before cognition**;
**runtime failure != organizational change**.

## 3. Expired-lease invalidation

```text
for each execution_leases row with expires_at <= now:
  delete the lease row (or mark invalid)
```

- Invalidation never settles an Execution by itself (DID §3.4/§12.11).
- After invalidation, a previously leased Worker's fence no longer validates:
  any late durable write is rejected authoritatively
  (`FencingRejected` / `LeaseFencingRejected`).
- Old-worker resurrection is therefore safe by construction; systematic
  fault-injection verification is P9.

## 4. Unsettled Execution detection and settlement

```text
for each executions row with settled_at IS NULL:
  if a durable settlement intent exists and is deterministic:
      settle via SettleExecution { submissionOrigin: "RecoveryController" }
  else:
      leave Active; the Scheduler re-evaluates / re-dispatches
```

Deterministic cases the P2 skeleton settles:

```text
- stop_requested_at != null and no unresolved side effect known to the
  ReconciliationSource -> Interrupted(StopRequested)
- a persisted completion/claim fact that was not settled -> the corresponding
  Completed(...) settlement
```

Non-deterministic cases are **not** guessed: they remain Active or become
`OutcomeUnknown(ReconciliationRequired)` only when the reconciliation source
can enumerate `invocationRefs`; otherwise they are escalated (step 6) with no
blind replay (DID §3.4/§6A.6).

## 5. Reconciliation boundary

P2 defines the hook; P3/P4 own the content:

```ts
interface ReconciliationSourceService {
  readonly pending: (executionId: ExecutionId) => Effect<
    ReadonlyArray<InvocationRef>, ReconciliationSourceError, TransactionScope>;
}
```

- P2 ships a stub returning `[]` (no tool/provider tables exist yet).
- P3/P4 implement real ProviderTurn / ToolInvocation reconciliation.
- An Execution with unresolved side-effectful invocations must not settle to
  plain `Completed`/`Interrupted`/`Failed`; it stays reconciling or becomes
  `OutcomeUnknown(ReconciliationRequired(invocationRefs))` (DID §3.4).
- Recovery never resurrects an old Worker's authority.

## 6. RecoveryController authority

The recovery pass runs as an authenticated origin (`01` §2.2) and settles
through the normal command pipeline:

```text
SettleExecutionAuthority {
  submissionOrigin: "RecoveryController"
  principal, commandId, semanticRequestFingerprint, projectId,
  commandKind: "SettleExecution", executionId
}
```

- No worker `fencingGeneration` is carried.
- Canonical state + Committed receipt + Domain Event commit atomically, exactly
  as for an `ExecutionOrigin` settlement.
- The controller is a single control-plane component; it does not bypass
  `CommandGateway`.

## 7. Durability envelope

P2 declares the envelope it tests (SD §10.7):

```text
Covered (with intact canonical storage):
  process crash, Worker loss, Runtime restart, compute host reboot

Not covered (deployment backup/replication, explicit RPO/RTO):
  storage-media loss, region loss
```

- `synchronous = FULL` + WAL (P1 `04` §1) are the durability mechanism.
- Failures beyond the declared envelope are reported truthfully; no automatic
  recovery is promised.

## 8. Out of scope

- Systematic fault injection and hardening (P9).
- Provider/Tool `OutcomeUnknown` reconciliation implementation (P3/P4).
- Projection rebuild (P10).
- Distributed recovery / multi-host failover (P12).
