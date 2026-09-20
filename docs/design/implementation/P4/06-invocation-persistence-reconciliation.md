# P4 — 06 Invocation Persistence + Reconciliation

**Authority:** DID v1.8 §9.12, §3.4, §6A.7; SD v1.3 §10.4; P2 `06` §5.
**Status:** DRAFT (first draft for contract review).

## 1. `tool_invocations` DDL

```sql
CREATE TABLE tool_invocations (
  invocation_id          TEXT PRIMARY KEY,
  execution_id           TEXT NOT NULL REFERENCES executions(execution_id),
  workspace_id           TEXT NOT NULL REFERENCES workspaces(workspace_id),
  tool_name              TEXT NOT NULL,
  tool_version           TEXT NOT NULL,
  side_effect_semantics  TEXT NOT NULL CHECK (side_effect_semantics IN
                           ('ReadOnly','Idempotent','Reconcilable','NonIdempotent')),
  arguments_json         TEXT NOT NULL,
  resolved_regions_json  TEXT NOT NULL,
  approval_id            TEXT,
  intent_at              TEXT NOT NULL,
  settled_at             TEXT,
  settlement_kind        TEXT CHECK (settlement_kind IN
                           ('Success','ExpectedFailure','Interrupted','OutcomeUnknown','RuntimeFailure')),
  settlement_json        TEXT,
  result_ref             TEXT,
  CHECK ((settled_at IS NULL) = (settlement_kind IS NULL))
);

CREATE INDEX idx_tool_invocations_execution ON tool_invocations(execution_id);
CREATE INDEX idx_tool_invocations_unsettled
  ON tool_invocations(settled_at) WHERE settled_at IS NULL;
```

The `side_effect_semantics` snapshot is required so recovery can distinguish
ReadOnly/Idempotent/Reconcilable/NonIdempotent after a crash (DID §9.12).

## 2. Intent-before-effect

```text
persist tool_invocations intent row
→ execute (external effect)
→ persist settlement
```

A crash between intent and settlement leaves a detectable dangling invocation
(SD §10.4).

## 3. ToolInvocationStore

```ts
interface ToolInvocationStoreService {
  readonly recordIntent: (invocation: ToolInvocationIntent) =>
    Effect.Effect<void, ToolInvocationStoreError, TransactionScope>;
  readonly settle: (invocationId: ToolInvocationId, settlement: ToolInvocationSettlement, resultRef: string | null) =>
    Effect.Effect<void, ToolInvocationStoreError, TransactionScope>;
  readonly consumeApproval: (approvalId: string, invocationId: ToolInvocationId) =>
    Effect.Effect<boolean, ToolInvocationStoreError, TransactionScope>;   // atomic single consumption
  readonly findUnsettled: (executionId: ExecutionId) =>
    Effect.Effect<ReadonlyArray<ToolInvocationRecord>, ToolInvocationStoreError, TransactionScope>;
}
```

## 4. ReconciliationSource (implements P2 `06` §5)

```ts
interface ReconciliationSourceService {
  readonly pending: (executionId: ExecutionId) => Effect.Effect<
    ReadonlyArray<InvocationRef>, ReconciliationSourceError, TransactionScope>;
}
```

- Returns refs of unsettled invocations whose `SideEffectSemantics` is
  `Reconcilable`/`NonIdempotent` (or `ReadOnly`/`Idempotent` that were
  interrupted mid-flight).
- P2 recovery uses this to decide `OutcomeUnknown(ReconciliationRequired)` vs
  a safe settlement; `OutcomeUnknown` must not be swallowed by retry (DID §9.12).
- `NonIdempotent` ambiguity → `OutcomeUnknown`, never automatic replay.

## 5. Transaction participation

All store methods require `TransactionScope`; the approval consumption shares
the settlement transaction (atomic single consumption, G2).

## 6. Must Not Decide

- No provider/tool external reconciliation logic beyond ref enumeration (the
  owning tool decides).
- No Execution settlement policy (P2).
- No retry policy for providers (P3).
