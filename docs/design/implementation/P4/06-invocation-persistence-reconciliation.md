# P4 — 06 Invocation Persistence + Reconciliation

**Authority:** DID v1.8 §9.12, §3.4, §6A.7 and v1.39 EA-DG-01; SD v1.14 §10.4; P2 `06` §5.
**Status:** FROZEN; accepted AH7-DG-03 amendment (2026-10-10). Post-landing
consistency review pending.
**Accepted amendment:** `planning/proposals/AH7-approval-settlement-fixed-decision-draft.md`,
SHA-256 `E818CC208F6A3B233FEF213E54E02AA30A1E96D6147313870C75FDE38DC94CBE`.
Accepted EA-DG-01 Executable route amendment: fixed proposal SHA-256
`E4F1B2935E0397292049BB3FDB1AB5847B02443CCE1B55A9827F823C63F145EB`;
decision `planning/results/EA-DG-01-governance-acceptance.md`.

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
New `settle`/`recordNoEffectDenial` writers accept only the new
`NoEffectDenialCode`. Row decoding uses `PersistedToolInvocationSettlement`
and accepts legacy `Denied(ApprovalRequired)` solely to replay that stored
terminal result; it cannot create an approval request or enter new denial
codepaths.

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
    approvalRevision: number,
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

## 6. Executable ActionApproval persistence (EA-DG-01; migration 0038)

The unified `action_approvals` ledger remains the physical store. P4 owns the
Executable route row, exact binding check and single-consumption transaction;
P1 owns the generic command receipt, P6 the Inbox admission/consumption and
P12 the pure authority facts. Every P4 read/write for this handoff includes
`route_kind = 'Executable'`; Control/AssignWork continues to use
`route_kind = 'Control'` and its existing CommandId transaction.

The proven Executable binding consists of project/workspace/execution,
authenticated subject, logical step number, repair attempt, action index,
LogicalActionId, callRef, ToolInvocationId, stable tool identity/version,
exact normalized arguments/action digest, resolved resource IDs and
ControlBasis. `expiresAt`, approval revision, current state and decision
provenance are lifecycle data and are excluded from the immutable binding
comparison. The first successful Pending insert fixes `expiresAt`. A unique
logical-action conflict is resolved by reading the winner and comparing only
the stable binding fields; same binding reuses winner ApprovalId/expiry/revision
even if the losing issuer used another `now`, while any changed stable field
fails closed.

Migration 0038 (DID §9.3) rebuilds the existing 0032 table without rewriting
0032, adds the Runtime-owned action identity and cancellation provenance, and
adds the `Cancelled` state with constraints that preserve earlier approval
decisions. The 0032 exact-action index is replaced by a Control exact-action
index and an Executable `(execution_id, logical_step_no, repair_attempt,
action_index, logical_action_id)` unique index. Legacy 0032 Executable rows
retain `binding_proven=0`, their terminal `Expired`/`Consumed` state,
`source_state` and any `consumed_by`; they are never upgraded or reused.
Migration 0038 follows 0036 AH7 and 0037 AH10 in order; it modifies neither.

The Application composes the following short transactions:

```text
Worker issuance:
  verify complete current Worker lease triple + expires_at > now
  + Execution active + stop_requested_at IS NULL
  + exact AgentLoopStep action Pending
  → insert/read exact Pending Executable approval
  → admit exact eap:<approvalId>:<revision> Inbox entry
  → append ExecutableApprovalRequested + durable P2 wake fact

Human decision (P1 CommandGateway, P12-resolved authority):
  verify authenticated human, route/project/workspace/execution/revision
  → CAS Pending to Approved | Rejected, or Expired if expires_at <= now
  → consume exact Inbox entry + append ExecutableApprovalResolved
  → Command receipt; all commits atomic

Expiry:
  CAS Pending | Approved to Expired at exact revision
  → consume unconsumed exact Inbox entry + append resolved fact/wake
  → one commit; restart redelivery is idempotent

Stop:
  authorized P2 StopExecution commits stop_requested_at
  + closes unclaimed Pending | Approved Executable row as Cancelled
  + consumes exact Inbox entry if still unconsumed
  + appends resolved fact/wake, all in the same command transaction

Effect claim:
  accepted AH7-DG-03 transaction persists ToolInvocation intent
  + consumes only exact Approved revision for the bound ToolInvocationId
  + full Worker fence + stop_requested_at IS NULL
```

The P2 external Stop command uses its authenticated StopExecution authority,
not a Worker lease. Any Worker-originated cancellation or follow-up remains
fenced with the complete current lease tuple. Stop/issuance/claim serialize by
transaction commit order; a stale Worker cannot issue, cancel, claim, settle
or append an Observation.

P4 returns nonterminal `ApprovalRequired` with the P4-resolved trusted intent
when approval is absent or the exact request remains Pending. P4 writes no
ToolInvocation row/settlement and calls no Sandbox/Executor on this branch.
After Approve, Runtime supplies the exact Approved revision and the same
ToolInvocationId; P4 rechecks current authority/resources/ControlBasis before
the fenced claim and effect-admission transaction. Reject produces a new
`ApprovalRejected` no-effect Denied record; Expire uses `ApprovalExpired`;
changed authority before/after claim follows `InvocationAuthorityDenied` /
`ApprovalNoLongerAuthorized`; Stop uses Interrupted. Historical
`Denied(ApprovalRequired)` remains decoder/replay-only and is never a new
write or promoted request. When current authority passes, Rejected produces
`ApprovalRejected` and Expired produces `ApprovalExpired`; an earlier
authority denial at P4's authority step takes precedence and preserves the
unconsumed approval.

The route-specific repository contract is:

```ts
interface ExecutableApprovalStoreService {
  findByLogicalAction(key: ExecutableApprovalKey): Effect<
    Option<InvocationApproval>, ToolInvocationStoreError, TransactionScope>;
  putPendingExact(input: ExecutableApprovalBinding & {
    readonly approvalId: string;
    readonly requestedAt: string;
    readonly expiresAt: string;
  }, fence: ToolExecutionContext["executionFence"], now: string): Effect<
    InvocationApproval, ToolInvocationStoreError | LeaseFencingRejected,
    TransactionScope>;
  decide(input: { approvalId: string; expectedRevision: number;
    decision: "Approve" | "Reject"; decidedAt: string;
    decidedBy: Principal; reason: string | null }): Effect<
    Option<InvocationApproval>, ToolInvocationStoreError, TransactionScope>;
  expire(input: { approvalId: string; expectedRevision: number;
    expiredAt: string }): Effect<Option<InvocationApproval>,
    ToolInvocationStoreError, TransactionScope>;
  cancelForExecution(input: { executionId: ExecutionId;
    cancelledAt: string; cancelledBy: Principal;
    reason: "StopRequested" }): Effect<
    ReadonlyArray<InvocationApproval>, ToolInvocationStoreError,
    TransactionScope>;
  listResolved(executionId: ExecutionId): Effect<
    ReadonlyArray<InvocationApproval>, ToolInvocationStoreError,
    TransactionScope>;
}
```

Every operation is exact `Executable` route. `putPendingExact` verifies the
stable binding on conflict and returns the winner without comparing the
candidate expiry; `decide`/`expire` are exact-revision CAS;
`cancelForExecution` affects only unconsumed Executable Pending/Approved rows
and is composed into the authorized StopExecution transaction. `listResolved`
is the daemon's durable recovery source and never returns Control rows.

Before P4 invocation on every replay, Application derives the same key from
the pinned Step/LogicalAction/callRef/ToolInvocationId and reads it first:

- absent: invoke P4 with null approval; a returned `ApprovalRequired` causes
  the atomic Pending+Inbox+request-fact admission and pauses the same step;
- Pending: return the same pause with stored ApprovalId/revision; do not insert
  a second request or recompute `expiresAt`;
- Approved: pass stored ApprovalId and exact Approved revision to P4;
- Rejected/Expired: pass the same stored identity to P4 for the typed no-effect
  denial and terminal action result;
- Cancelled while Stop is committed: return the P2 Interrupted result;
- Consumed by this ToolInvocationId: P4 follows its exact same-invocation
  replay rules; another consumer is Denied.

The unique-key race on the absent path has the same stable-field comparison as
the pre-read path. Candidate TTL is excluded; the loser returns the committed
winner's ID/expiry/revision.

## 7. Must Not Decide

- No provider/tool external reconciliation logic beyond ref enumeration (the
  owning tool decides).
- No Execution settlement policy (P2).
- No retry policy for providers (P3).
