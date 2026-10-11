# P4 — 06 Invocation Persistence + Reconciliation

**Authority:** DID v1.8 §9.12, §3.4, §6A.7; SD v1.3 §10.4; P2 `06` §5.
**Status:** FROZEN; accepted AH7-DG-03 amendment (2026-10-10). Post-landing
consistency review pending.
**Accepted amendment:** `planning/proposals/AH7-approval-settlement-fixed-decision-draft.md`,
SHA-256 `E818CC208F6A3B233FEF213E54E02AA30A1E96D6147313870C75FDE38DC94CBE`.

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
  effect_admission_state TEXT NOT NULL DEFAULT 'LegacyUnknown' CHECK (effect_admission_state IN
                           ('NotAdmitted','MayHaveStarted','LegacyUnknown')),
  intent_at              TEXT NOT NULL,
  settled_at             TEXT,
  settlement_kind        TEXT CHECK (settlement_kind IN
                           ('Success','ExpectedFailure','Denied','Interrupted','OutcomeUnknown','RuntimeFailure')),
  settlement_json        TEXT,
  result_ref             TEXT,
  CHECK ((settled_at IS NULL) = (settlement_kind IS NULL)),
  CHECK (settlement_kind <> 'Denied' OR effect_admission_state = 'NotAdmitted')
);

CREATE INDEX idx_tool_invocations_execution ON tool_invocations(execution_id);
CREATE INDEX idx_tool_invocations_unsettled
  ON tool_invocations(settled_at) WHERE settled_at IS NULL;
```

The `side_effect_semantics` snapshot is required so recovery can distinguish
ReadOnly/Idempotent/Reconcilable/NonIdempotent after a crash (DID §9.12).
`effect_admission_state` is independent of `intent_at`: an intent is not proof
that the external effect began. New intents start `NotAdmitted`; the fenced
effect-admission commit changes this monotonically to `MayHaveStarted` before
Sandbox/Executor. Existing rows migrate to `LegacyUnknown`, never
`NotAdmitted`. Settled legacy records replay their existing settlement; an
unsettled `LegacyUnknown` row cannot become a no-effect Denied or Interrupted
without side-effect recovery evidence.

The additive migration assigns `LegacyUnknown` to every existing row. All new
intent and no-effect-rejection writes explicitly set `NotAdmitted`; the SQL
default is fail-closed for maintenance/legacy inserts that omit the state.
No transition may reset `MayHaveStarted` to `NotAdmitted`.

`Denied` is a terminal no-effect settlement. Its `settlement_json` stores one
closed `NoEffectDenialCode` from `01` §4–§5 plus the version-1 projection
identity. It is legal only with `effect_admission_state = NotAdmitted`.

## 2. Intent-before-effect

```text
resolve exact tool/resources/authority and match approval
→ persist intent + consume exact approval atomically (when approval is required)
  or persist intent (no approval), with current Worker fence and stop check
→ commit effect_admission_state = MayHaveStarted with fresh authority,
  exact approval binding, stop check and current Worker fence
→ execute (external effect, outside SQLite transaction)
→ persist terminal settlement with current Worker fence
```

A no-effect authority/approval/resource rejection uses a fenced transaction to
insert a terminal `Denied` ToolInvocation record even when there is no prior
intent row. It is a terminal invocation record, not an unsettled executable
intent, and remains `NotAdmitted`. A `ResourceResolutionDenied` record carries
an empty resolved-region list and cannot satisfy an approval match.

For an approval-required claim, intent insertion and the conditional approval
consumption share one `TransactionScope` and either both commit or both roll
back. If the consume CAS loses, the claim transaction rolls back before a
separate `Denied(ApprovalConsumedByOtherInvocation)` record is written. A
crash before claim commit leaves neither intent nor consumption; after commit
both are durable and the effect remains `NotAdmitted` until the next gate.

A crash after effect admission leaves a detectable `MayHaveStarted` invocation.
That marker means the external effect may have started, even if the process
crashed before the executor returned; recovery must follow `SideEffectSemantics`
and may not infer no effect.

## 3. ToolInvocationStore

```ts
interface ToolInvocationStoreService {
  readonly recordIntent: (
    invocation: ToolInvocationIntent,
    executionFence: ToolExecutionContext["executionFence"],
  ) =>
    Effect.Effect<void, ToolInvocationStoreError, TransactionScope>;
  readonly consumeApproval: (
    approvalId: string,
    invocationId: ToolInvocationId,
    executionFence: ToolExecutionContext["executionFence"],
  ) => Effect.Effect<boolean, ToolInvocationStoreError, TransactionScope>;
  readonly recordNoEffectDenial: (
    invocation: ToolInvocationIntent,
    reasonCode: NoEffectDenialCode,
    settledAt: string,
    executionFence: ToolExecutionContext["executionFence"],
  ) => Effect.Effect<ToolInvocationRecord, ToolInvocationStoreError, TransactionScope>;
  readonly recordNoEffectInterruption: (
    invocationId: ToolInvocationId,
    settledAt: string,
    executionFence: ToolExecutionContext["executionFence"],
  ) => Effect.Effect<boolean, ToolInvocationStoreError, TransactionScope>;
  readonly admitEffect: (
    invocationId: ToolInvocationId,
    currentAuthority: InvocationAuthority,
    now: string,
    executionFence: ToolExecutionContext["executionFence"],
  ) => Effect.Effect<
    "Admitted" | "ExecutionStopping",
    ToolInvocationStoreError | LeaseFencingRejected,
    TransactionScope
  >;
  readonly settle: (
    invocationId: ToolInvocationId,
    settlement: ToolInvocationSettlement,
    resultRef: string | null,
    settledAt: string,
    executionFence: ToolExecutionContext["executionFence"],
    fenceNow: string,
  ) =>
    Effect.Effect<void, ToolInvocationStoreError, TransactionScope>;
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

RAI-DG-01 preserves this exact external-reality disposition as an independent
Work readmission source: when the owning Execution is bound to a Work Episode,
settled `OutcomeUnknown(ReconciliationRequired(nonempty invocationRefs))`
holds that exact `(WorkId, WorkRevision)` even if no separate
`ReconciliationEscalated` event or P10 Attention row exists. P2 derives the
hold from canonical settlement plus the validated EGP binding. This does not
change tool-invocation settlement, reconciliation, or retry semantics.

## 5. Transaction participation

All store methods require `TransactionScope`. Each Worker-originated mutation
validates the full trusted lease triple—`executionId`, `workerId`,
`workerIncarnationId`, `fencingGeneration`—and `expires_at > now` in the same
transaction as that mutation. Production obtains the triple only from the
current `ExecutionOrigin`; missing tuple members fail closed.

For the approval claim, the Application composes `recordIntent` and
`consumeApproval` in one `TransactionPort.transact` scope. Consumption is
atomic as a one-use conditional update, but is not in the later terminal
settlement transaction. `admitEffect` is a separate fenced transaction that
requires `stop_requested_at IS NULL`, a fresh trusted `InvocationAuthority`,
the exact consumed-by-this-invocation approval binding where required, and
`effect_admission_state = NotAdmitted`; it then writes `MayHaveStarted`.

`recordNoEffectDenial` checks the current fence and `stop_requested_at IS NULL`
before inserting/updating a terminal `Denied` row. If the Execution is
stopping, it returns P2 `ExecutionStopping` and creates no Denied row.
`recordNoEffectInterruption` applies only to an exact existing invocation in
`NotAdmitted` when `stop_requested_at IS NOT NULL`; it atomically settles
`Interrupted` without consuming or changing approval. Neither API may rewrite
`MayHaveStarted` or `LegacyUnknown` as a no-effect result.

The authoritative SQLite fence is the complete
`(executionId, workerId, workerIncarnationId, fencingGeneration)` tuple,
`expires_at > now`, and `executions.settled_at IS NULL`, checked in the same
transaction as every P4 mutation. `admitEffect` also checks
`stop_requested_at IS NULL`, the exact consumed-by-this-invocation approval
binding when required, and the current trusted `InvocationAuthority` before
setting `MayHaveStarted`. A failed fence or stop predicate leaves the marker
unchanged and prevents Sandbox/Executor admission. Stop and effect admission
linearize by transaction commit order.

## 6. Must Not Decide

- No provider/tool external reconciliation logic beyond ref enumeration (the
  owning tool decides).
- No Execution settlement policy (P2).
- No retry policy for providers (P3).
