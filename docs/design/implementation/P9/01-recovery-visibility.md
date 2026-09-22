# P9 — 01 Recovery Visibility & Trigger Semantics

**Authority:** P2 `06` §3–§5（settle 规则/ReconciliationSource/RecoveryController）; P4 `06`（ReconciliationSource 实现）; GQ3 裁决; DID v1.11 §6A.6/§6A.7; SD §10.6/不变量 54; 治理裁决（2026-09-21）: ReconciliationSourceStub replacement 属 phase-scoped closure.
**Status:** DRAFT (first draft for contract review). Cross-refs: `03` §2 (trigger surface), `04` §1 (attention facts).

## 1. Recovery-visibility pre-fix (B-1, phase-scoped closure)

Two durable gaps close **before** any injection hardening is meaningful:

1.1 **ReconciliationSource wiring**: the composition root currently binds `ReconciliationSourceStubLive` (恒 `[]`) — a stopped Execution carrying unresolved side-effectful ToolInvocations would settle as plain `Interrupted(StopRequested)`, violating invariant 54 / SD §7.3. P9 wires the existing real `ReconciliationSourceLive` (P4 `06` — already implemented, test-covered, merely unbound).

1.2 **Escalation becomes durable**: `runRecovery`'s in-memory `escalated` array is replaced by durable Attention facts (one event per escalated execution, deduplicated by `executionId + invocationRefs fingerprint` (the `04` §1 key — repeated passes never mint new facts); presentation stays P10). Until P10, the fact event is the entire attention surface — assertions read the journal.

Pre/post-fix injection assertion (gates the whole phase): an execution with an unsettled NonIdempotent invocation and `stopRequestedAt != null` must **never** settle `Interrupted`; it escalates or settles `OutcomeUnknown(ReconciliationRequired(...))`.

## 2. Missing deterministic settle case (B-2)

P2 `06` §4 freezes a second deterministic settle: a durable completion fact (`Completed(CompletionClaimed | Yielded …)` persisted in the settlement trace) found on an unsettled execution settles to the **corresponding Completed form** — never a guess, never a downgrade. Implementation follows the same RecoveryController authority path (gateway submission, recovery origin, deterministic commandId `f("recovery", executionId, "completion")`); idempotent replay returns the existing receipt.

## 3. Trigger semantics (GQ3 — frozen)

```text
T1  startup full recovery   — once per daemon start, the full nine-step pass
                              (P2 `06` §2); idempotent re-entry
T2  periodic sweep          — interval is empirical (task-level); runs the
                              nine steps; coalesce with T3 hooks
T3  event-triggered hooks   — lease-expiry invalidation, execution settle,
                              dead-letter quarantine fire a (coalesced) sweep — the
                              same nine-step pass as T2, enqueued by frozen hooks;
                              "targeted" is reserved for T4 only (03 §2)
T4  pre-dispatch check      — the targeted lease/fence predicate ONLY
```

**Prohibition (restated from the ruling):** T4 never runs the nine-step recovery; full passes belong to T1/T2 only. Recovery pass triggers produce no organizational mutations (SD §10.6: "Runtime failure != organizational change").

## 4. Must Not Decide

- No new recovery authority variants (P2 owns RecoveryController origin).
- No Attention presentation/UI (P10); the fact event is the whole P9 surface.
- No settle-rule changes beyond the P2-frozen two deterministic cases.
- No change to the nine-step order (P2 `06`).
