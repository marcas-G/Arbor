# P9 — 01 Recovery Visibility & Trigger Semantics

**Authority:** P2 `06` §3–§5（settle 规则/ReconciliationSource/RecoveryController）; P4 `06`（ReconciliationSource 实现）; GQ3 裁决; DID v1.11 §6A.6/§6A.7; SD §10.6/不变量 54; 治理裁决（2026-09-21）: ReconciliationSourceStub replacement 属 phase-scoped closure.
**Status:** DRAFT (first draft for contract review). Cross-refs: `03` §2 (trigger surface), `04` §1 (attention facts).

## 1. Recovery-visibility pre-fix (B-1, phase-scoped closure)

Two durable gaps close **before** any injection hardening is meaningful:

1.1 **ReconciliationSource wiring**: the composition root currently binds `ReconciliationSourceStubLive` (恒 `[]`) — a stopped Execution carrying unresolved side-effectful ToolInvocations would settle as plain `Interrupted(StopRequested)`, violating invariant 54 / SD §7.3. P9 wires the existing real `ReconciliationSourceLive` (P4 `06` — already implemented, test-covered, merely unbound).

1.2 **Escalation becomes durable**: `runRecovery`'s in-memory `escalated` array is replaced by durable Attention facts (one event per escalated execution, deduplicated by `executionId + invocationRefs fingerprint` (the `04` §1 key — repeated passes never mint new facts); presentation stays P10). The carrying event is `ReconciliationEscalated {executionId, invocationRefsFingerprint, refs}` — catalogued in DID v1.12 G1 (§5.3). Until P10, the fact event is the entire attention surface — assertions read the journal.

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

## Accepted AH7-DG-02 escalation source (DID v1.40)

P9 drives the P4-owned proof/recovery contract; P9 does not establish external
reality. Only `StillUnknown`/unprofiled unresolved effect evidence enters the
existing `ReconciliationEscalated{executionId, invocationRefsFingerprint,
refs}` path. P4 owns the immutable attempt/fact and settlement; P9 owns
RecoveryController trigger/order and the existing event payload/dedup identity.
Repeated recovery with the same `(executionId, invocationRefsFingerprint)` is
idempotent. A missing ref, temporary negative lookup or `StillUnknown` is never
reconciliation success, never an Executor replay permit, and never ordinary
Execution completion. Known `Occurred` facts and selected terminal results
converge under the current full Worker fence, including after Stop; stale
generation writes remain rejected.

P10 owns the `ActionRequired` read-model row and rebuild. Its visibility is
bounded by the accepted P1 journal retention horizon; this contract does not
add a durable post-pruning P9 fact store or new event.

## Accepted AH7-DG-01 replay-evidence failure fact (DID v1.41)

An exact current P3 action whose P4 terminal Settlement/Observation envelope
is missing or inconsistent under a valid lease stops at RecoveryBlocked. P9
records the source-specific `ToolObservationReplayEvidenceEscalated(v1)` event
and immutable fact atomically. Its identity is `(executionId, invocationId)`;
the bound LogicalActionId/ProviderTurn/callRef and closed P40 failureCode must
match on duplicate delivery. Fact ID is `att_` + SHA-256 lowercase hex of
canonical UTF-8 JSON `{"executionId":...,"invocationId":...,"version":1}`
with fixed key order/no whitespace/no trailing newline.

The event payload is exactly
`{attentionFactId, executionId, targetWorkspaceId, logicalActionId,
providerTurnId, callRef, invocationId, failureCode}`. Envelope: project from
Execution, `aggregateRef=targetWorkspaceId`,
`correlationRef=logicalActionId`, `actor=system:recovery`, no Command cause.
No tool args/output, Artifact content, observation bytes, cause, parser/OS
detail or secret is stored. The P9 write transaction rechecks the complete
current lease/expiry; stale generations write no fact/event. This event is not
`ReconciliationEscalated` and does not imply an unresolved external effect.
