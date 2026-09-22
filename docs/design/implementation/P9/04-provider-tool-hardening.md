# P9 — 04 Provider & Tool Fault Hardening

**Authority:** P4 `06` (intent-before-effect, four-tier semantics, ReconciliationSource); P4 `02` §5–§6 (tool pipeline retry / stop-quiescence); P3 `01` §4–§6 + `04` §3 (ProviderTurn / ProviderAttempt, persisted Turn intent); P3 `06` §2 (retryable/terminal mapping); P2 `02` §5 (WorkerDispatchPort), `06` (recovery skeleton); GQ4 governance ruling; DID v1.9 §6A.7–§6A.9, §9.12, §3.4; SD v1.3 §6.5–§6.6, §14 No.35/No.54.
**Status:** DRAFT (first draft for contract review).
**Naming:** Phase P9 ≠ DID §8.4 "P9 Verification Program" (shipped with P8); all P9 artifacts say "Phase P9 / recovery hardening" (scope-extraction B-10).

## 1. B-1 Recovery visibility fix (phase-scoped closure)

Governance ruling: replacing the composition-root `ReconciliationSourceStub`
is a **P9 phase-scoped closure**, not a Design Gap — P2 `06` §5 froze the
hook and explicitly shipped the stub as temporary ("no tool/provider tables
exist yet"); the tables have existed since P4.

### 1.1 Wiring

```text
before: apps/single-workspace/src/composition.ts wires
        ReconciliationSourceStubLive (execution-runtime recovery.ts:93-96,
        pending -> [])                          ← defect carrier
after:  composition root wires ReconciliationSourceLive
        (tool-runtime reconciliation.ts; requires ToolInvocationStore)
```

Defect being closed: under the stub, `pending` is always empty, so a stopped
Execution holding an unsettled side-effectful invocation settles
`Interrupted(StopRequested)` — violating SD §14 No.54 (unresolved side
effects must Reconcile or enter `OutcomeUnknown`).

### 1.2 Escalation durability

```text
before: RecoveryResult.escalated = in-memory array; lost at process exit
after:  the recovery pass records each escalate outcome as a durable
        Attention fact, event-carried at the same reliable commit boundary
```

- Pattern: P7 `05` §2 `DeadlockAttentionRequested` — the detector emits a
  fact event; presentation/routing is L6/P10. P9 owns the fact, not the view.
- Minimal frozen surface: one durable Attention fact per escalated Execution
  per recovery fingerprint; replay idempotency follows the P6 `01` §3
  settlement→Inbox precedent — deterministic dedup key
  `executionId + invocationRefs fingerprint`; repeated recovery passes are
  no-ops (at most one live fact).
- The recovery pass never resolves external reality; it enumerates refs
  (P4 `06` §6 — the owning tool decides).

### 1.3 Injection assertions (before/after)

```text
I-1  stopped Execution + unsettled NonIdempotent invocation
       before fix (red — documents the defect):
         settles Interrupted(StopRequested)            [No.54 violation]
       after fix (green):
         refs enumerable  -> settles OutcomeUnknown(ReconciliationRequired(refs))
                              via SettleExecution, RecoveryController authority
         enumeration fails (ReconciliationSourceError)
                           -> no settlement, no guess; remains Active +
                              durable Attention fact; next pass retries
         never Interrupted / Completed / Failed        [P2 `06` §4–§5]
I-2  stopped Execution + all invocations settled (or none)
       -> Interrupted(StopRequested) unchanged (stub-equivalent behavior
          preserved; wiring must not regress the deterministic case)
I-3  repeated recovery passes over the same escalation
       -> exactly one durable Attention fact (dedup key)
```

## 2. Provider disconnect injection semantics (GQ4 landing)

### 2.1 Mapping — zero new tags

```text
injected disconnect                                → ProviderFailureKind
───────────────────────────────────────────────────────────────────────
failure before the stream is established            → ProviderUnavailable
(connect refused / DNS / TLS / pre-flight timeout)
interruption after TurnStarted (stream began)       → StreamInterrupted
```

- Both retryable under the P3 `06` §2 safe-retry policy (bounded backoff).
- No new failure tag; no DID §6A.8 change (GQ4 option a: disconnect is an
  injection scenario **composition**, not a new classification).
- The injection harness classifies by the observable boundary (`TurnStarted`
  emitted or not), never by transport errno.

### 2.2 Unsettled ProviderTurn crash recovery (P9-owned frozen surface)

P3 `06` §7 explicitly defers reconciliation to P4/P9; GQ4 acknowledges the
ownership transfer for the provider-turn crash disposition — frozen here:

```text
crash leaves provider_turns row with settled_at IS NULL
  (Turn intent + Manifest persisted before the request, P3 `04` §3,
   so the dangling Turn is always visible)
  → deterministic disposition:
     1. resume-by-retry: same ProviderTurn, new ProviderAttempt
        (attempt_no = MAX+1, Turn-local); Agent turnNo unchanged;
        no new Manifest (DID §6A.9; P3 `01` §4–§5) — a resumed Turn is a
        transport retry, not a new model decision
     2. retry bound exhausted (safe-retry policy / safety gate):
        Turn settles under the existing driver Turn-failure semantics
        (P2/P3); Execution-level disposition follows P2 `06` §4 recovery
        rules — recovery never invents a settlement
```

- The recovery pass itself never calls the provider: it leaves the Execution
  Active; the Scheduler re-dispatches; the driver resumes the dangling Turn
  as a new attempt under the same `providerTurnId` + `manifestId`.
- Streaming deltas never entered Session history (DID §9.8), so a crashed
  mid-stream Turn has no partial durable output — resume is clean by
  construction.
- Provider turns carry no external side effect beyond the provider request
  itself; tool-style `OutcomeUnknown` ambiguity does not arise
  (`OutcomeUnknown` is the tool-invocation settlement vocabulary, P4 `06`).

### 2.3 Injection assertions

```text
I-4  disconnect pre-connection      → ProviderAttempt.outcome = RetryableFailure,
                                       provider_error_kind = ProviderUnavailable;
                                       no new ProviderTurn issued
I-5  disconnect mid-stream          → StreamInterrupted; retried under the SAME
                                       Turn; turnNo unchanged across attempts;
                                       no partial Session entry
I-6  bounded retries exhausted      → Turn settles failed; Execution disposed by
                                       driver strategy / P2 `06` §4; durable
                                       Attention on escalation
I-7  crash mid-Turn + restart       → dangling Turn resumed as new
                                       ProviderAttempt, same providerTurnId +
                                       manifestId; UsageReported aggregates per
                                       Turn over attempts (P3 `01` §5)
```

## 3. Tool four-tier injection assertions (invariant 35)

Intent-before-effect (P4 `06` §2) makes every dangling invocation visible to
the recovery pass. Per DID §6A.7 retry rule; SD §14 No.35 verbatim:
**OutcomeUnknown side effects are never blindly replayed.**

```text
ReadOnly      dangling after crash → safe settlement / transient retry;
              no OutcomeUnknown required; retry re-runs the full pipeline
              (P4 `02` §5 — re-entry re-runs authority/resource checks)
Idempotent    replay uses the same invocation key (executionId, invocationId);
              assertion: replay yields exactly one settlement row; adapter
              probe observes no duplicate external effect
Reconcilable  reconcile-then-settle: recovery enumerates the ref; the owning
              tool reconciles external reality BEFORE any replay decision
              (P4 `06` §4); ordering assertion: no replay admitted before a
              reconcile result exists
NonIdempotent ambiguity → OutcomeUnknown(ReconciliationRequired(refs)),
              NEVER automatic replay (No.35; DID §9.12); assertions:
              no second invocation row under the same key; no re-execute;
              Execution not settled Interrupted (No.54, cf. I-1)
```

## 4. Dispatch failure semantics (systematized)

```text
never settles      a dispatch failure never settles an Execution
                   (P2 `02` §5; DID §6A.6) — frozen since P2, now
                   injection-asserted
lost dispatch      detection = periodic sweep fallback: the reevaluate loop
                   (existing) re-admits Active unsettled Executions; a lost
                   dispatch is bounded-stale and self-heals on the next
                   sweep — no dispatch ack surface
observable surface injection assertions derive from Execution state
                   (Active + no live lease + no session progress →
                   re-dispatch within N sweeps); NO new durable dispatch
                   record (GQ ruling: no dispatch table)
```

## 5. Must Not Decide

- No new failure tags; no DID §6A.8 change (GQ4: mapping only over existing
  `ProviderFailureKind`).
- No P3 retry-bound / backoff modification (bounds stay empirical; the
  mechanism is contract, P3 `06` §3 precedent).
- No durable dispatch table / ack surface.
- No P8 spawn-window reopening (P8 crash windows formally closed).
- No Attention presentation / routing / UI (P10; P9 emits facts only).
- No provider/tool external reconciliation logic beyond ref enumeration
  (the owning tool decides, P4 `06` §6).
- No recovery trigger-timing semantics (GQ3 — separate contract).
