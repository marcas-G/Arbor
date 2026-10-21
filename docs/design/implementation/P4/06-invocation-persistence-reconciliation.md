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
action_index, logical_action_id)` unique index. It also recreates 0033's
`action_approvals_id_project UNIQUE(approval_id, project_id)` key because the
existing `assign_work_target_bindings(action_approval_id, project_id)` foreign
key references that composite pair. This preserves the existing AssignWork
binding and Control semantics; 0038 does not alter 0033. Legacy 0032
Executable rows retain `binding_proven=0`, their terminal `Expired`/`Consumed`
state, `source_state` and any `consumed_by`; they are never upgraded or reused.
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

## Accepted AH7-DG-02 / P39 persistence contract (DID v1.40)

Accepted logical proposal SHA-256:
`D0A43BCDF3F95424BE7167B49D2170917B7605EE1E498A2601F2FFFB3DD6940B`;
accepted physical supplement SHA-256:
`D2FF13087BB7A1BC5C9D422B4D5CEDE56689F83E765F96615FE13561CE5D446C`.
The exact owner DDL is migration `0039_ah7_reconciliation_attempts`, after
integrated P36/P37/P38 owner contracts. Their migration implementation is not
integrated here; P39 cannot be implemented or released as a standalone schema.

### Durable rows

P39 rebuilds `tool_invocations` in one forward-only transaction, preserving
existing invocation identity, tool/version/tag, arguments, resolved regions,
approval ID, intent timestamp, settlement payload and result ref. It adds:

| Column | Contract |
|---|---|
| `recovery_binding_state` | `Bound`, `LegacyBindingUnproven`, `HistoricalSettled`, `DeniedUnbound`; historical settled rows remain historical, active P36 rows whose binding cannot be proven are marked unproven, and new terminal no-effect Denied before any claim is represented by `DeniedUnbound` |
| `recovery_binding_sha256` | Nullable unless Bound; composite FK `(invocation_id,digest)` to immutable binding row |
| `settlement_provenance` | `Ordinary`, `Reconciliation`, `LegacyHistorical`; null exactly while unsettled |
| `selected_attempt_no`, `selected_fact_id` | Both set only for reconciliation-proven terminal state; composite deferred FK `(invocation_id,attempt_no,fact_id)` to the same immutable fact |
| `settlement_kind` | Existing terminal values plus `ReconciledNoEffect`; Denied requires `NotAdmitted`; ReconciledNoEffect requires `MayHaveStarted` and a result ref |

Check constraints enforce the closed provenance/selected-field combinations:
Reconciliation provenance is only Success/ExpectedFailure/ReconciledNoEffect
from MayHaveStarted; Ordinary or LegacyHistorical has no selected fact;
settled LegacyBindingUnproven rows are forbidden and HistoricalSettled must
already be terminal. Settlement columns, provenance and selected fact are
immutable after terminal. Invocation admission is monotone
`NotAdmitted→MayHaveStarted`; neither MayHaveStarted nor LegacyUnknown can be
rewritten as a no-effect denial/interruption.

`tool_invocation_recovery_bindings` has `invocation_id` PK/FK,
`binding_version=1`, immutable canonical binding JSON, lowercase SHA-256
digest, created time, and UNIQUE `(invocation_id,binding_sha256)`. Its triggers
reject update and delete. The binding contains P3-owned ProviderTurn,
AgentLoopStep, LogicalAction/actionIndex/callRef identity; exact P4 invocation
and tool definition identity/hash/side-effect tag; canonical args/resource
snapshot digests and revisions; P4/P38 approval ID, subject, pre/post revision,
consumer, target/basis and expiry snapshot; and exact profile/effect identity
or explicit nulls where not applicable. It is never a source of authority.

The canonical `RecoveryBindingV1` key set is exact (null is explicit for
inapplicable approval/profile fields):

```text
bindingVersion, digestAlgorithm,
executionId, invocationId, providerTurnId,
logicalStepNo, repairAttempt, logicalActionId, actionIndex, callRef,
toolName, toolVersion, toolDefinitionHash, sideEffectSemantics,
canonicalArgumentsDigest, targetResourceIdentityDigest,
resourceBoundaryRevision, environmentRevision,
authoritySourceRevision, principalId, capability, permissionGrantRevisions,
workspacePolicyRevision, projectPolicyRevision, controlBasisDigest,
approvalId, approvalSubject, approvalPreConsumeRevision,
approvalConsumedRevision, approvalExpiresAt, approvalTargetDigest,
approvalActionDigest, approvalConsumedBy,
profileId, profileVersion, profileHash, profileProtocol, effectKey
```

P3 is the authority for its source-identity fields; the Application transports
the same tuple; P4 checks it against ToolIntent/ToolExecutionContext and the
current ExecutionOrigin. P38's trusted ledger is the only source for approval
subject/revisions/consumer. Profile/effect fields are runtime catalog/adapter
facts, never model-selected inputs. `digestAlgorithm` and `bindingVersion` are
persisted with the canonical JSON and hashed by the repository's canonicalizer.

`tool_invocation_effect_attempts` is keyed by `(invocation_id,attempt_no)`;
attempt is constrained to 0 or 1. It stores admission state, tool-definition
hash, side-effect tag, nullable profile ID/version/hash/protocol and effect
key, binding digest, admission timestamp, `admission_source`, and
`admission_time_precision`. Profile fields are either all null or complete;
a profile requires a binding. Admission source is `P36Backfill`, `P39Claim`,
or `P39Admission`; precision is `NotAdmitted`, `TransactionTimestamp`, or
`UnknownLegacy`. NotAdmitted has null time and NotAdmitted precision; P39
MayHaveStarted admission has a transaction timestamp; historical P36
MayHaveStarted/LegacyUnknown has null time and UnknownLegacy precision.
`intent_at` is never substituted for `admitted_at`. Admission is monotone and
attempt identity fields are immutable.

`tool_reconciliation_facts` is append-only, keyed by lowercase SHA-256 fact ID,
with unique exact-redelivery identity. It records invocation/attempt,
binding/profile/effect key (nullable only for approved historical
unprofiled provenance), `fact_origin` (`ProfileReconciliation` or
`P36LegacyUnprofiled`), nullable `legacy_reason` limited to
`LegacyProfileUnavailable`, disposition (`RecoveryInput` or
`PostTerminalEvidence`), outcome (`NotOccurred`, `Occurred`, `StillUnknown`),
closed unknown reason code, evidence/result Artifact refs and observed time.
Its composite FKs bind to the exact attempt/binding; evidence and result refs
reference P4 Artifacts. P36 unprofiled facts require StillUnknown /
ProfileUnavailable / LegacyProfileUnavailable and null binding, profile hash
and effect key. `NotOccurred` requires evidence; `Occurred` requires result;
StillUnknown requires one closed reason code. PostTerminalEvidence is only
StillUnknown/EvidenceBindingMismatch and cannot be selected for settlement.
No absence/presence-only SQL rule is treated as proof.

Exact physical key/column inventory:

| Relation | Columns | Key / foreign references |
|---|---|---|
| `tool_invocation_recovery_bindings` | `invocation_id`, `binding_version`, `canonical_binding_json`, `binding_sha256`, `created_at` | PK invocation; UNIQUE invocation+digest; invocation FK |
| `tool_invocation_effect_attempts` | `invocation_id`, `attempt_no`, `admission_state`, `tool_definition_hash`, `side_effect_semantics`, `profile_id`, `profile_version`, `profile_hash`, `profile_protocol`, `effect_key`, `binding_sha256`, `admitted_at`, `admission_source`, `admission_time_precision` | PK invocation+attempt; FKs to invocation and same binding digest |
| `tool_reconciliation_facts` | `fact_id`, `invocation_id`, `attempt_no`, `binding_sha256`, `profile_hash`, `effect_key`, `fact_origin`, `legacy_reason`, `fact_disposition`, `outcome`, `reason_code`, `evidence_ref`, `evidence_sha256`, `result_ref`, `observed_at` | PK fact; FKs to same invocation+attempt/binding and Artifact refs |

Required indexes are `idx_effect_attempts_unsettled(invocation_id,
admission_state)`, `idx_reconciliation_facts_invocation(invocation_id,
attempt_no,observed_at)`, unique `reconciliation_facts_invocation_ref`,
unique `reconciliation_facts_attempt_ref`, and unique
`reconciliation_facts_exact_redelivery` over invocation/attempt/origin/outcome/
disposition plus null-normalized binding/profile/effect/reason/legacy/evidence/
result identity. Required immutable/invariant triggers are
`recovery_binding_no_update`, `recovery_binding_no_delete`,
`tool_invocation_binding_immutable`, `tool_invocation_settlement_no_rewrite`,
`tool_invocation_admission_monotone`, `effect_attempt_admission_monotone`,
`effect_attempt_identity_immutable`,
`reconciliation_fact_disposition_matches_terminal`,
`reconciliation_fact_no_update` and `reconciliation_fact_no_delete`.

The P4 transaction additionally verifies canonical binding digest, exact
current authority/resource/profile/effect key, current grant/policy/verifier
and ControlBasis revisions, full current Worker lease tuple and approval
subject/revision/consumer. These mutable values are re-resolved from trusted
current sources; the immutable binding digest is not a substitute for current
authorization. It selects only one
non-conflicting authoritative RecoveryInput fact for the exact invocation and
attempt: Success/ExpectedFailure require `Occurred`; ReconciledNoEffect
requires `NotOccurred`. A second/different fact cannot replace that selected
fact. A late contradictory fact is appended only as PostTerminalEvidence and
does not change P4 settlement or P3 projection. P4 does not invent a new P9/P10
post-terminal notification.

### Claim, admission and recovery transactions

P4's existing P2-facing `ReconciliationSource.pending(executionId)` remains a
reference enumerator only. `ToolReconciliationPort.reconcile` is a separate
P4-owned read/confirm/cancel/fence capability and returns the closed P4
`ToolReconciliationResult` union; it never calls the Executor as a probe.
The returned proof is checked against the exact RecoveryBinding, attempt,
profile hash, effect key, source revision/watermark, and evidence/result refs
before any fact, selected terminal result or new admission is committed.
External I/O happens outside SQLite; fact insertion, settlement selection and
P9 escalation use the existing short transaction/fencing boundary.

The claim transaction atomically verifies/writes RecoveryBinding, claims the
invocation, validates current trusted P38 approval subject/revision and consumes
it once if required, and creates attempt 0 NotAdmitted under the full current
Worker fence. Re-entry accepts the same consumed approval only for the same
ToolInvocation and binding; no refund/transfer/re-consume occurs. The later
effect-admission transaction changes exactly one attempt from NotAdmitted to
MayHaveStarted only after rechecking full Worker lease tuple and expiry, stop
predicate, current grant/policy/verifier/resource revisions, approval binding,
and tool/profile hashes. No Executor opens before that commit is confirmed.

Reconciliation runs outside SQLite through the P4-owned port; facts, known
settlement and P9 escalation commit under the current full lease even after
Stop. Stop only blocks new effect-attempt admission. `StillUnknown` never
starts an Executor. Final `NotOccurred` permits at most attempt 1 of the same
invocation after a single transaction revalidates the entire binding and
`stop_requested_at IS NULL`; changed authority/resource/approval, Stop, or
attempt limit selects the accepted `ReconciledNoEffect` reason. `Occurred`
settles only with a reconstructable canonical result/observation. Terminal
P4 replay is receipt-first and never re-runs reconciliation/Executor or changes
the selected fact.

P39 backfill never infers a source binding, profile, effect key, approval
revision or fact. Historical MayHaveStarted has `admission_source=P36Backfill`,
null `admitted_at`, and `UnknownLegacy` precision; unprofiled history preserves
null profile/effectKey/binding and uses physical `LegacyProfileUnavailable`
while the canonical closed reason remains `ProfileUnavailable`. Active P36
NotAdmitted rows are blocked by P1's mandatory preflight before any pending
P37/P38/P39 migration and remain unchanged in a permanently isolated DB cohort
until future governance; P4 does not manufacture a manual settlement.

## Accepted AH7-DG-01 / P39-P40 terminal Observation evidence (DID v1.41)

Accepted inputs: DG01 logical SHA-256
`19EFED54E037D3E2EC6F4D273D917F5249195650E5E41B3DCFF8DEB9784F29CD`, P40 physical
`5B61E0FF922A10D225FD5DAEA00176BD16C5C0B39484D626B7FEF6340516373A`, RNO
compatibility addendum `8B8E5D3C5729CF5619605DA8D8DF34BA00E1F817E80A743555029F331690E830`,
and companion matrix `AD9AB72D0AA51AB84F4194EC2BF4BB90EC957BD062788C480BCBDD39B8E8DD35`.

P40 is `0040_tool_observation_evidence` after P36→P37→P38→P39 and is
cumulative-only at `user_version=39`. P4 `06` owns the `tool_invocations`
columns/checks/triggers; it does not alter P39 RecoveryBinding/attempt/fact
tables or existing P39 triggers/contracts. The three added columns are:

```sql
ALTER TABLE tool_invocations ADD COLUMN observation_format_version TEXT
  CHECK (observation_format_version IS NULL OR
         observation_format_version = 'p4-canonical-tool-observation-v1');
ALTER TABLE tool_invocations ADD COLUMN observation_json BLOB
  CHECK (observation_json IS NULL OR
         (typeof(observation_json) = 'blob'
          AND length(observation_json) BETWEEN 1 AND 16384
          AND json_valid(CAST(observation_json AS TEXT))));
ALTER TABLE tool_invocations ADD COLUMN observation_sha256 TEXT
  CHECK (observation_sha256 IS NULL OR
         (length(observation_sha256) = 64
          AND observation_sha256 NOT GLOB '*[^0-9a-f]*'));
```

The all-null/all-present and immutable-row triggers use the exact P40 `5B61`
five-tag evidence branches plus the separate DG03 `Denied/NotAdmitted`
NULL-evidence branch. Their closed terminal `CASE` additionally admits the
following P39 RNO branch in **both** before-insert and unsettled→terminal
before-update validation. Every branch is wrapped in `COALESCE(...,0)`; a
missing JSON path/NULL cannot turn invalid evidence into a passing write.

```sql
WHEN NEW.settlement_kind = 'ReconciledNoEffect' THEN COALESCE((
  NEW.settlement_provenance = 'Reconciliation'
  AND NEW.effect_admission_state = 'MayHaveStarted'
  AND NEW.recovery_binding_state = 'Bound'
  AND NEW.recovery_binding_sha256 IS NOT NULL
  AND NEW.selected_attempt_no IS NOT NULL
  AND NEW.selected_fact_id IS NOT NULL
  AND NEW.result_ref IS NOT NULL
  AND NEW.observation_format_version = 'p4-canonical-tool-observation-v1'
  AND NEW.observation_json IS NOT NULL
  AND NEW.observation_sha256 IS NOT NULL
  AND json_valid(NEW.settlement_json)
  AND json_valid(CAST(NEW.observation_json AS TEXT))
  AND json_extract(NEW.settlement_json, '$._tag') = 'ReconciledNoEffect'
  AND json_extract(CAST(NEW.observation_json AS TEXT), '$._tag') = 'ReconciledNoEffect'
  AND json_extract(NEW.settlement_json, '$.reasonCode') IN (
    'AuthoritySnapshotChanged','ResourceSnapshotChanged',
    'ApprovalNoLongerAuthorized','StopRequested','ReplayLimitReached'
  )
  AND json_extract(CAST(NEW.observation_json AS TEXT), '$.reasonCode') =
      json_extract(NEW.settlement_json, '$.reasonCode')
  AND json_extract(NEW.settlement_json, '$.reconciliationFactRef') = NEW.selected_fact_id
  AND json_extract(CAST(NEW.observation_json AS TEXT), '$.reconciliationFactRef') =
      NEW.selected_fact_id
  AND json_type(CAST(NEW.observation_json AS TEXT), '$.observation.text') = 'text'
  AND json_type(CAST(NEW.observation_json AS TEXT), '$.observation.truncated')
      IN ('true','false')
  AND json_type(CAST(NEW.observation_json AS TEXT), '$.resultRef') = 'text'
  AND json_extract(CAST(NEW.observation_json AS TEXT), '$.resultRef') = NEW.result_ref
  AND EXISTS (
    SELECT 1 FROM tool_reconciliation_facts AS f
    WHERE f.fact_id = NEW.selected_fact_id
      AND f.invocation_id = NEW.invocation_id
      AND f.attempt_no = NEW.selected_attempt_no
      AND f.fact_origin = 'ProfileReconciliation'
      AND f.fact_disposition = 'RecoveryInput'
      AND f.binding_sha256 = NEW.recovery_binding_sha256
      AND f.outcome = 'NotOccurred'
      AND f.reason_code IS NULL
      AND f.evidence_ref IS NOT NULL
      AND f.evidence_sha256 IS NOT NULL
      AND length(f.evidence_sha256) = 64
      AND f.evidence_sha256 NOT GLOB '*[^0-9a-f]*'
      AND f.result_ref IS NULL
  )
), 0)
```

The trigger bodies use that RNO predicate in the closed terminal `CASE` below;
the five P40 v1 tag predicates and DG03 Denied predicate are the accepted
`5B61` SQL branches. P39 terminal identity/effect/selection columns join the
terminal immutability list so P40 never edits a P39 selected fact.

```sql
CREATE TRIGGER tool_invocations_observation_insert_guard
BEFORE INSERT ON tool_invocations
WHEN
  (NEW.settled_at IS NULL AND
   (NEW.settlement_kind IS NOT NULL OR NEW.settlement_json IS NOT NULL OR
    NEW.result_ref IS NOT NULL OR NEW.observation_format_version IS NOT NULL OR
    NEW.observation_json IS NOT NULL OR NEW.observation_sha256 IS NOT NULL))
  OR
  (NEW.settled_at IS NOT NULL AND COALESCE(CASE
    WHEN NEW.settlement_kind = 'Denied' THEN COALESCE((
      NEW.effect_admission_state = 'NotAdmitted' AND NEW.result_ref IS NULL
      AND NEW.observation_format_version IS NULL AND NEW.observation_json IS NULL
      AND NEW.observation_sha256 IS NULL AND json_valid(NEW.settlement_json)
      AND json_extract(NEW.settlement_json, '$._tag') = 'Denied'
      AND json_extract(NEW.settlement_json, '$.projectionVersion') = 1
      AND json_type(NEW.settlement_json, '$.reasonCode') = 'text'
      AND json_extract(NEW.settlement_json, '$.reasonCode') IN (
        'InvocationAuthorityDenied','ApprovalRequired','ApprovalNotFound',
        'ApprovalMismatch','ApprovalExpired','ApprovalConsumedByOtherInvocation',
        'ResourceResolutionDenied','ResourceAdmissionDenied','ApprovalNoLongerAuthorized')
    ), 0)
    WHEN NEW.settlement_kind IN
      ('Success','ExpectedFailure','Interrupted','OutcomeUnknown','RuntimeFailure','ReconciledNoEffect')
    THEN COALESCE((
      NEW.settlement_json IS NOT NULL
      AND NEW.observation_format_version = 'p4-canonical-tool-observation-v1'
      AND NEW.observation_json IS NOT NULL AND NEW.observation_sha256 IS NOT NULL
      AND json_valid(NEW.settlement_json)
      AND json_valid(CAST(NEW.observation_json AS TEXT))
      AND json_extract(NEW.settlement_json, '$._tag') = NEW.settlement_kind
      AND json_extract(CAST(NEW.observation_json AS TEXT), '$._tag') = NEW.settlement_kind
      AND CASE NEW.settlement_kind
        WHEN 'Success' THEN (
          ((NEW.result_ref IS NULL AND json_type(CAST(NEW.observation_json AS TEXT), '$.resultRef') IS 'null')
           OR (NEW.result_ref IS NOT NULL
               AND json_type(CAST(NEW.observation_json AS TEXT), '$.resultRef') = 'text'
               AND json_extract(CAST(NEW.observation_json AS TEXT), '$.resultRef') = NEW.result_ref))
          AND json_type(CAST(NEW.observation_json AS TEXT), '$.observation.text') = 'text'
          AND json_type(CAST(NEW.observation_json AS TEXT), '$.observation.truncated') IN ('true','false'))
        WHEN 'ExpectedFailure' THEN (
          NEW.result_ref IS NULL
          AND json_type(CAST(NEW.observation_json AS TEXT), '$.observation.text') = 'text'
          AND json_type(CAST(NEW.observation_json AS TEXT), '$.observation.truncated') IN ('true','false'))
        WHEN 'Interrupted' THEN NEW.result_ref IS NULL
        WHEN 'OutcomeUnknown' THEN (
          NEW.result_ref IS NULL
          AND json_type(CAST(NEW.observation_json AS TEXT), '$.reconciliationRefs') = 'array'
          AND json_extract(NEW.settlement_json, '$.reconciliationRefs') =
              json_extract(CAST(NEW.observation_json AS TEXT), '$.reconciliationRefs')
          AND json_array_length(CAST(NEW.observation_json AS TEXT), '$.reconciliationRefs') BETWEEN 1 AND 8
          AND NOT EXISTS (
            SELECT 1 FROM json_each(CAST(NEW.observation_json AS TEXT), '$.reconciliationRefs')
            WHERE type <> 'text' OR length(CAST(value AS BLOB)) > 128))
        WHEN 'RuntimeFailure' THEN (
          NEW.result_ref IS NULL
          AND json_type(CAST(NEW.observation_json AS TEXT), '$.cause') = 'text'
          AND length(CAST(json_extract(CAST(NEW.observation_json AS TEXT), '$.cause') AS BLOB)) <= 1024
          AND json_extract(NEW.settlement_json, '$.cause') =
              json_extract(CAST(NEW.observation_json AS TEXT), '$.cause'))
        WHEN 'ReconciledNoEffect' THEN (
          NEW.settlement_provenance = 'Reconciliation'
          AND NEW.effect_admission_state = 'MayHaveStarted'
          AND NEW.recovery_binding_state = 'Bound' AND NEW.recovery_binding_sha256 IS NOT NULL
          AND NEW.selected_attempt_no IS NOT NULL AND NEW.selected_fact_id IS NOT NULL
          AND NEW.result_ref IS NOT NULL
          AND json_extract(NEW.settlement_json, '$.reasonCode') IN (
            'AuthoritySnapshotChanged','ResourceSnapshotChanged',
            'ApprovalNoLongerAuthorized','StopRequested','ReplayLimitReached')
          AND json_extract(CAST(NEW.observation_json AS TEXT), '$.reasonCode') =
              json_extract(NEW.settlement_json, '$.reasonCode')
          AND json_extract(NEW.settlement_json, '$.reconciliationFactRef') = NEW.selected_fact_id
          AND json_extract(CAST(NEW.observation_json AS TEXT), '$.reconciliationFactRef') = NEW.selected_fact_id
          AND json_type(CAST(NEW.observation_json AS TEXT), '$.observation.text') = 'text'
          AND json_type(CAST(NEW.observation_json AS TEXT), '$.observation.truncated') IN ('true','false')
          AND json_type(CAST(NEW.observation_json AS TEXT), '$.resultRef') = 'text'
          AND json_extract(CAST(NEW.observation_json AS TEXT), '$.resultRef') = NEW.result_ref
          AND EXISTS (
            SELECT 1 FROM tool_reconciliation_facts AS f
            WHERE f.fact_id = NEW.selected_fact_id
              AND f.invocation_id = NEW.invocation_id
              AND f.attempt_no = NEW.selected_attempt_no
              AND f.fact_origin = 'ProfileReconciliation'
              AND f.fact_disposition = 'RecoveryInput'
              AND f.binding_sha256 = NEW.recovery_binding_sha256
              AND f.outcome = 'NotOccurred' AND f.reason_code IS NULL
              AND f.evidence_ref IS NOT NULL AND f.evidence_sha256 IS NOT NULL
              AND length(f.evidence_sha256) = 64
              AND f.evidence_sha256 NOT GLOB '*[^0-9a-f]*'
              AND f.result_ref IS NULL))
        ELSE 0
      END
    ), 0)
    ELSE 0
  END, 0) = 0)
BEGIN
  SELECT RAISE(ABORT, 'tool invocation observation evidence invariant');
END;

CREATE TRIGGER tool_invocations_observation_update_guard
BEFORE UPDATE OF settled_at, settlement_kind, settlement_json, result_ref,
  effect_admission_state, recovery_binding_state, recovery_binding_sha256,
  settlement_provenance, selected_attempt_no, selected_fact_id,
  observation_format_version, observation_json, observation_sha256
ON tool_invocations
WHEN
  (OLD.settled_at IS NULL AND NEW.settled_at IS NULL AND
   (NEW.settlement_kind IS NOT NULL OR NEW.settlement_json IS NOT NULL OR
    NEW.result_ref IS NOT NULL OR NEW.observation_format_version IS NOT NULL OR
    NEW.observation_json IS NOT NULL OR NEW.observation_sha256 IS NOT NULL))
  OR
  (OLD.settled_at IS NULL AND NEW.settled_at IS NOT NULL AND COALESCE(CASE
    WHEN NEW.settlement_kind = 'Denied' THEN COALESCE((
      NEW.effect_admission_state = 'NotAdmitted' AND NEW.result_ref IS NULL
      AND NEW.observation_format_version IS NULL AND NEW.observation_json IS NULL
      AND NEW.observation_sha256 IS NULL AND json_valid(NEW.settlement_json)
      AND json_extract(NEW.settlement_json, '$._tag') = 'Denied'
      AND json_extract(NEW.settlement_json, '$.projectionVersion') = 1
      AND json_type(NEW.settlement_json, '$.reasonCode') = 'text'
      AND json_extract(NEW.settlement_json, '$.reasonCode') IN (
        'InvocationAuthorityDenied','ApprovalRequired','ApprovalNotFound',
        'ApprovalMismatch','ApprovalExpired','ApprovalConsumedByOtherInvocation',
        'ResourceResolutionDenied','ResourceAdmissionDenied','ApprovalNoLongerAuthorized')
    ), 0)
    WHEN NEW.settlement_kind IN
      ('Success','ExpectedFailure','Interrupted','OutcomeUnknown','RuntimeFailure','ReconciledNoEffect')
    THEN COALESCE((
      NEW.settlement_json IS NOT NULL
      AND NEW.observation_format_version = 'p4-canonical-tool-observation-v1'
      AND NEW.observation_json IS NOT NULL AND NEW.observation_sha256 IS NOT NULL
      AND json_valid(NEW.settlement_json)
      AND json_valid(CAST(NEW.observation_json AS TEXT))
      AND json_extract(NEW.settlement_json, '$._tag') = NEW.settlement_kind
      AND json_extract(CAST(NEW.observation_json AS TEXT), '$._tag') = NEW.settlement_kind
      AND CASE NEW.settlement_kind
        WHEN 'Success' THEN (
          ((NEW.result_ref IS NULL AND json_type(CAST(NEW.observation_json AS TEXT), '$.resultRef') IS 'null')
           OR (NEW.result_ref IS NOT NULL
               AND json_type(CAST(NEW.observation_json AS TEXT), '$.resultRef') = 'text'
               AND json_extract(CAST(NEW.observation_json AS TEXT), '$.resultRef') = NEW.result_ref))
          AND json_type(CAST(NEW.observation_json AS TEXT), '$.observation.text') = 'text'
          AND json_type(CAST(NEW.observation_json AS TEXT), '$.observation.truncated') IN ('true','false'))
        WHEN 'ExpectedFailure' THEN (
          NEW.result_ref IS NULL
          AND json_type(CAST(NEW.observation_json AS TEXT), '$.observation.text') = 'text'
          AND json_type(CAST(NEW.observation_json AS TEXT), '$.observation.truncated') IN ('true','false'))
        WHEN 'Interrupted' THEN NEW.result_ref IS NULL
        WHEN 'OutcomeUnknown' THEN (
          NEW.result_ref IS NULL
          AND json_type(CAST(NEW.observation_json AS TEXT), '$.reconciliationRefs') = 'array'
          AND json_extract(NEW.settlement_json, '$.reconciliationRefs') =
              json_extract(CAST(NEW.observation_json AS TEXT), '$.reconciliationRefs')
          AND json_array_length(CAST(NEW.observation_json AS TEXT), '$.reconciliationRefs') BETWEEN 1 AND 8
          AND NOT EXISTS (
            SELECT 1 FROM json_each(CAST(NEW.observation_json AS TEXT), '$.reconciliationRefs')
            WHERE type <> 'text' OR length(CAST(value AS BLOB)) > 128))
        WHEN 'RuntimeFailure' THEN (
          NEW.result_ref IS NULL
          AND json_type(CAST(NEW.observation_json AS TEXT), '$.cause') = 'text'
          AND length(CAST(json_extract(CAST(NEW.observation_json AS TEXT), '$.cause') AS BLOB)) <= 1024
          AND json_extract(NEW.settlement_json, '$.cause') =
              json_extract(CAST(NEW.observation_json AS TEXT), '$.cause'))
        WHEN 'ReconciledNoEffect' THEN (
          NEW.settlement_provenance = 'Reconciliation'
          AND NEW.effect_admission_state = 'MayHaveStarted'
          AND NEW.recovery_binding_state = 'Bound' AND NEW.recovery_binding_sha256 IS NOT NULL
          AND NEW.selected_attempt_no IS NOT NULL AND NEW.selected_fact_id IS NOT NULL
          AND NEW.result_ref IS NOT NULL
          AND json_extract(NEW.settlement_json, '$.reasonCode') IN (
            'AuthoritySnapshotChanged','ResourceSnapshotChanged',
            'ApprovalNoLongerAuthorized','StopRequested','ReplayLimitReached')
          AND json_extract(CAST(NEW.observation_json AS TEXT), '$.reasonCode') =
              json_extract(NEW.settlement_json, '$.reasonCode')
          AND json_extract(NEW.settlement_json, '$.reconciliationFactRef') = NEW.selected_fact_id
          AND json_extract(CAST(NEW.observation_json AS TEXT), '$.reconciliationFactRef') = NEW.selected_fact_id
          AND json_type(CAST(NEW.observation_json AS TEXT), '$.observation.text') = 'text'
          AND json_type(CAST(NEW.observation_json AS TEXT), '$.observation.truncated') IN ('true','false')
          AND json_type(CAST(NEW.observation_json AS TEXT), '$.resultRef') = 'text'
          AND json_extract(CAST(NEW.observation_json AS TEXT), '$.resultRef') = NEW.result_ref
          AND EXISTS (
            SELECT 1 FROM tool_reconciliation_facts AS f
            WHERE f.fact_id = NEW.selected_fact_id
              AND f.invocation_id = NEW.invocation_id
              AND f.attempt_no = NEW.selected_attempt_no
              AND f.fact_origin = 'ProfileReconciliation'
              AND f.fact_disposition = 'RecoveryInput'
              AND f.binding_sha256 = NEW.recovery_binding_sha256
              AND f.outcome = 'NotOccurred' AND f.reason_code IS NULL
              AND f.evidence_ref IS NOT NULL AND f.evidence_sha256 IS NOT NULL
              AND length(f.evidence_sha256) = 64
              AND f.evidence_sha256 NOT GLOB '*[^0-9a-f]*'
              AND f.result_ref IS NULL))
        ELSE 0
      END
    ), 0)
    ELSE 0
  END, 0) = 0)
  OR
  (OLD.settled_at IS NOT NULL AND (
    NEW.settled_at IS NOT OLD.settled_at OR NEW.settlement_kind IS NOT OLD.settlement_kind OR
    NEW.settlement_json IS NOT OLD.settlement_json OR NEW.result_ref IS NOT OLD.result_ref OR
    NEW.effect_admission_state IS NOT OLD.effect_admission_state OR
    NEW.recovery_binding_state IS NOT OLD.recovery_binding_state OR
    NEW.recovery_binding_sha256 IS NOT OLD.recovery_binding_sha256 OR
    NEW.settlement_provenance IS NOT OLD.settlement_provenance OR
    NEW.selected_attempt_no IS NOT OLD.selected_attempt_no OR NEW.selected_fact_id IS NOT OLD.selected_fact_id OR
    NEW.observation_format_version IS NOT OLD.observation_format_version OR
    NEW.observation_json IS NOT OLD.observation_json OR NEW.observation_sha256 IS NOT OLD.observation_sha256
  ))
BEGIN
  SELECT RAISE(ABORT, 'terminal settlement and P39 selected fact are immutable');
END;
```

P39's existing composite selected-fact FK still binds the exact
`(invocation_id, selected_attempt_no, selected_fact_id)` at COMMIT. The trigger
checks the selected NotOccurred fact/provenance; the P4 codec additionally
verifies current RecoveryBinding/profile/effect identity, the accepted proof
hash/finality, strict UTF-8/canonical v1 hash and P4 Artifact metadata. The P39
fact's NotOccurred `result_ref` stays NULL. P4 row `result_ref` is a different,
non-NULL ArtifactRef equal to the canonical Observation's `resultRef`; P3's
bounded-payload content hash is a third identity.

The terminal immutable trigger includes P40 version/body/hash together with
P39 settlement/effect-state/provenance/selected-attempt/fact fields. No P40
write may clear or replace `selected_fact_id`, P39 proof evidence or P4
Artifact. No migration backfill is performed. Historical P39 RNO terminal
rows with NULL P40 evidence remain unchanged and P4 reports `Missing` on a
valid-fence replay; P4 does not reconstruct the Observation from Artifact
bytes. P40 is forward-only; no down migration exists.

## 8. Accepted P39 DeniedUnbound terminal no-effect projection (schema 39)

Accepted fixed supplement:
`planning/proposals/P39-unbound-denied-state-design-gap-draft.md`, SHA-256
`294300E103DE1EFC34B250EC41A30DC2EDDBB5671216499254695C32E6D91D1E`.
The independent fixed-proposal review is
`planning/results/P39-unbound-denied-state-fixed-proposal-review.result.md`
(Blocking = 0). This storage state does not add a settlement tag or a
user-visible P3/P40 behavior.

`DeniedUnbound` is a schema-39-only `recovery_binding_state`. It means exactly
that the P4 invocation is terminally `Denied` under the ordinary P4 no-effect
path and no P39 RecoveryBinding claim/receipt was committed. It is not legacy
history and is not an additional ToolInvocationSettlement.

Extend the D2FF state CHECK to:

```sql
recovery_binding_state TEXT NOT NULL CHECK (recovery_binding_state IN
  ('Bound','LegacyBindingUnproven','HistoricalSettled','DeniedUnbound')),
```

Add this table CHECK without weakening any existing D2FF CHECK:

```sql
CHECK (recovery_binding_state <> 'DeniedUnbound' OR
  (settled_at IS NOT NULL AND settlement_kind = 'Denied'
   AND settlement_provenance = 'Ordinary'
   AND effect_admission_state = 'NotAdmitted'
   AND result_ref IS NULL AND recovery_binding_sha256 IS NULL
   AND selected_attempt_no IS NULL AND selected_fact_id IS NULL)),
```

Keep these D2FF meanings unchanged: `Bound` iff the SHA-256 is non-null;
`LegacyBindingUnproven` requires unsettled; `HistoricalSettled` requires a
settled `LegacyHistorical` row; `Denied` requires `NotAdmitted` and null
`result_ref`; reconciliation provenance requires `Bound` and its exact
selected fact. The table CHECK additionally requires an ordinary P4 Denied
settlement and no binding digest/selected reconciliation tuple.

Replace `tool_invocation_binding_immutable` with the following transition
guard. The accepted P39 store inserts the exact binding row before the
`LegacyBindingUnproven` → `Bound` update; P4 denial updates state and
settlement together under its existing `BEGIN IMMEDIATE` fence/Stop
transaction.

```sql
DROP TRIGGER tool_invocation_binding_immutable;

CREATE TRIGGER tool_invocation_binding_immutable
BEFORE UPDATE OF recovery_binding_state, recovery_binding_sha256
ON tool_invocations
WHEN NOT (
  (OLD.recovery_binding_state = NEW.recovery_binding_state
   AND OLD.recovery_binding_sha256 IS NEW.recovery_binding_sha256)
  OR
  (OLD.recovery_binding_state = 'LegacyBindingUnproven'
   AND OLD.recovery_binding_sha256 IS NULL
   AND OLD.effect_admission_state = 'NotAdmitted'
   AND OLD.settled_at IS NULL
   AND NEW.recovery_binding_state = 'Bound'
   AND NEW.recovery_binding_sha256 IS NOT NULL
   AND NEW.effect_admission_state = 'NotAdmitted'
   AND NEW.settled_at IS NULL
   AND NEW.settlement_provenance IS NULL
   AND EXISTS (
     SELECT 1 FROM tool_invocation_recovery_bindings AS b
      WHERE b.invocation_id = NEW.invocation_id
        AND b.binding_sha256 = NEW.recovery_binding_sha256))
  OR
  (OLD.recovery_binding_state = 'LegacyBindingUnproven'
   AND OLD.recovery_binding_sha256 IS NULL
   AND OLD.effect_admission_state = 'NotAdmitted'
   AND OLD.settled_at IS NULL
   AND NEW.recovery_binding_state = 'DeniedUnbound'
   AND NEW.recovery_binding_sha256 IS NULL
   AND NEW.effect_admission_state = 'NotAdmitted'
   AND NEW.settled_at IS NOT NULL
   AND NEW.settlement_kind = 'Denied'
   AND NEW.settlement_provenance = 'Ordinary'
   AND NEW.result_ref IS NULL
   AND NEW.selected_attempt_no IS NULL
   AND NEW.selected_fact_id IS NULL
   AND NOT EXISTS (
     SELECT 1 FROM tool_invocation_effect_attempts AS a
      WHERE a.invocation_id = NEW.invocation_id
        AND a.admission_state <> 'NotAdmitted'))
)
BEGIN
  SELECT RAISE(ABORT, 'invalid RecoveryBinding state transition');
END;
```

The only state changes allowed by this trigger are the existing accepted
claim transition and the new terminal denial transition. `Bound`,
`HistoricalSettled`, and `DeniedUnbound` cannot transition to another state;
an existing `Bound` denial only changes P4 settlement columns, not binding
state/digest. Preserve immutable binding rows and add these guards:

```sql
CREATE TRIGGER recovery_binding_reject_denied_unbound
BEFORE INSERT ON tool_invocation_recovery_bindings
WHEN EXISTS (
  SELECT 1 FROM tool_invocations AS i
   WHERE i.invocation_id = NEW.invocation_id
     AND i.recovery_binding_state = 'DeniedUnbound')
BEGIN
  SELECT RAISE(ABORT, 'DeniedUnbound cannot acquire a RecoveryBinding');
END;

CREATE TRIGGER effect_attempt_reject_denied_unbound
BEFORE INSERT ON tool_invocation_effect_attempts
WHEN EXISTS (
  SELECT 1 FROM tool_invocations AS i
   WHERE i.invocation_id = NEW.invocation_id
     AND i.recovery_binding_state = 'DeniedUnbound')
BEGIN
  SELECT RAISE(ABORT, 'DeniedUnbound cannot acquire a new effect attempt');
END;
```

A P36Backfill attempt already present before a permitted
`LegacyBindingUnproven` → `DeniedUnbound` transition may remain only if its
admission state is `NotAdmitted`; no P39 attempt or binding is created for
that denial.

`recordNoEffectDenial` behavior under schema 39 is exact:

- With no prior invocation row, insert one `DeniedUnbound` row directly, with
  `settlement_provenance='Ordinary'`, under the existing full Worker-fence
  and Stop predicate. Do not insert an intent first.
- With an exact prior unsettled `LegacyBindingUnproven` row, atomically write
  Denied with `Ordinary` provenance and transition it to `DeniedUnbound` in
  that same fenced transaction.
- With an exact prior `Bound` row still `NotAdmitted`, write the P4 Denied
  settlement with `Ordinary` provenance but preserve `Bound`, its digest,
  receipt-mapped binding, and attempt-0. This covers a denial after the P39
  claim already committed.
- A terminal exact Denied replay returns the stored reason code. An identity
  or payload conflict fails closed. `MayHaveStarted` and `LegacyUnknown`
  cannot be rewritten as no-effect Denied. No branch consumes, refunds, or
  transfers a P38 approval.

Add a typed read to `P39RecoveryEvidenceStore`:

```ts
readonly findTerminalUnboundDenial: (
  invocationId: ToolInvocationId,
) => Effect.Effect<
  Option.Option<{
    readonly invocationId: ToolInvocationId;
    readonly recoveryBindingState: "DeniedUnbound";
  }>,
  RepositoryFailure<"P39RecoveryEvidenceStore">,
  TransactionScope
>;
```

It returns `Some` only after reading a schema-39 row that satisfies the
`DeniedUnbound` table CHECK, has null binding digest, and has no binding row.
It returns `None` when there is no row in this state, and typed persistence
corruption if the state is DeniedUnbound but a binding row/digest or invalid
settlement exists. It is a typed storage projection, never negative evidence.
Before resolving mutable resources/authority for a replay, Runtime reads
`ToolInvocationStore.findById` and checks the exact trusted P3 source tuple
plus stored P4 stable invocation tuple `(invocationId, executionId,
workspaceId, toolName, toolVersion, sideEffectSemantics, argumentsJson,
approvalId)`. It does not compare newly resolved regions, since this terminal
no-effect denial is the result for the stored request even if current resource
state changed. Runtime then uses this read before RecoveryBinding comparison:
exact `DeniedUnbound` replay returns the persisted P4 Denied reason without
re-resolving/re-admitting, consuming approval, Sandbox, or Executor.
Otherwise P39 replay still requires the exact stored Bound RecoveryBinding;
absence/mismatch remains fail-closed.

`P39RecoveryEvidenceStore.findBinding` returns only Bound bindings.
`findSelected` and all P39/P40 reconciliation-source queries require
`recovery_binding_state='Bound'`; they must never select or expose a
`DeniedUnbound` invocation. `ToolInvocationStore.findUnsettled` naturally
excludes it because it is terminal.

The 0039 migration does not backfill `DeniedUnbound`. Preserve D2FF legacy
conversion exactly: settled P36 rows, including historical P4 Denied rows,
remain `HistoricalSettled`/`LegacyHistorical`; unsettled unproven rows remain
`LegacyBindingUnproven`; active `NotAdmitted` blockers remain subject to the
existing pre-DDL sidecar isolation. `DeniedUnbound` can be written only after
the schema-39 P4 writer is activated. A maintenance run against an already
schema-39 database does not reinterpret or rewrite any row. Earlier supported
databases upgrade only through the frozen ordered prefix and retain their
pre-upgrade P4 denial replay exactly.

Before the first schema-39 use, the P39 startup/maintenance gate must verify
the exact accepted 0039 schema fingerprint, including the `DeniedUnbound`
CHECK and transition guards. A database reporting `user_version=39` but built
with the earlier three-state DDL is out-of-contract: fail closed before
primary/sidecar mutation; do not `ALTER`, stamp, re-run or shadow-migrate it
under the same 0039 number. Since 0039 is not registered/released on the
supported user-database line, qualification rebuilds disposable fixtures
through the exact authorized prefix. If any supported database is found
already at 39 with the earlier DDL, stop and seek separate migration


## Accepted full-chain Sandbox interruption/recovery contract (V21)

P4 may return SandboxPolicyRequiredInterruption only after exact ToolInvocation
intent is durable and existing RecoveryBindingV1 is Bound and strictly
verified. The invocation remains effectAdmissionState=NotAdmitted, settled_at
NULL, Action Pending and AgentLoopStep ActionsInProgress. It is internal, not a
ToolObservation, ExpectedFailure, Command result or P9 unavailable fact. The
existing HumanIntervention flow releases/does not renew the lease and parks the
same active Execution/Episode; no new wait, Execution, WorkEpisode, invocation,
Step state/ID, blocker, table or migration is added. P10 derives
SandboxPolicyDecisionRequired/NeedsDecision from existing pending-intent and
policy facts. DecideSandboxPolicy remains bound to the same Execution/Episode;
its committed event is only a wake hint; P2/P9 redispatches the same action and
invocation. Read-only startup/periodic scan resumes only with exact current
policy/basis and original admission proof; otherwise it remains parked or uses
existing no-effect Denied. Event pruning does not erase the durable state.

RecoveryBindingV1 is sole same-invocation authority. Never synthesize, upgrade,
repair, rebind, re-resolve or substitute intent/regions. Strictly decode stored
binding bytes/hash; recompute canonicalArgumentsDigestV1(JSON.parse(arguments_json))
and targetResourceIdentityDigestV1(decoded resolved_regions_json); exact-match
both and all bound execution/invocation/step/action/callRef/tool/version/
definition/side-effect, authority/grant, resource/policy/control/approval and
effect fields. Persisted arguments/regions remain original authority. Current
path-free target refs/mounts separately must cover the same original targets
with same-or-stricter access under the pinned ToolDefinition; never rebind.
Missing/non-Bound/corrupt/mismatched proof is internal RecoveryBlocked with
Pending/NotAdmitted and zero effect/dispatch; V21 forbids P9/P40 fact/event/
marker; P10 derives non-persisted SandboxRecoveryBindingFailure Attention.
Current source drift after valid proof uses existing P4 denial/approval or
policy-required path, not proof corruption. Existing intents are never
re-probed or re-spawned by recovery.

For an interrupted real provider probe after durable intent, P4's persistence
service uses exact lease/fence and trusted GatewayNow to commit one typed
ExpectedFailure, code sandbox/probe-interrupted, NoEffect, exact provider/
version/capability/policy/evidence/intent binding, and the sole safe summary
“required sandbox capability was unavailable or could not be verified;
execution did not start”. Restart reuses this observation and never re-probes
or respawns. Under valid fence, P9 atomically materializes terminal
SandboxUnavailable action disposition, immutable SandboxProviderUnavailableFactV1,
one P10 queue row and wake event. Before commit only observation persists;
after commit restart reuses terminal Step/fact without duplicate/provider call.
Stale fence writes none. This ends only the action/Step; no Execution/Work
settlement, PASS or later action occurs. Completion remains gated for that
current failed policy; T4 is read-only. Ordinary authorized WorkspaceWrite,
content dirtiness and mtimes do not stale policy.

If the committed policy is missing/stale against otherwise unchanged
original source/admission facts, P4 returns SandboxPolicyRequiredInterruption
before effect admission and writes no ExpectedFailure/Observation/P9 fact. The
same active Execution parks for a new human decision. It does not emit a
sandbox/policy-basis-stale Observation/code; that earlier proposal branch is
superseded by the final same-Execution NotAdmitted policy interruption.
Current resource access denial uses existing ResourceAdmissionDenied; current
authority/approval drift uses existing P4 denial/approval. Only actual
provider probe/broker/OS primitive failure after policy admission follows the
distinct ExpectedFailure→P9 SandboxProviderUnavailableFact path.

## Accepted sandbox candidate-read-model V5 requirement read port

P4 `06` owns the read-only `SandboxPolicyRequirementReadPort` used by P10's
candidate read. It consumes P3-owned `agent_loop_step_actions` and
`agent_loop_steps` under the caller's existing `TransactionScope`; it writes
no requirement, marker, Attention, event, queue item, or P3 state and does
not mutate/reconcile those rows. P10 MUST NOT read P3 or P4 private stores
directly. P4 returns proof-bearing internal evidence only; no invocation or
binding detail is included in the candidate DTO.

```ts
interface SandboxPolicyRequirementReadPortService {
  readonly findPendingByExecution: (input: {
    readonly projectId: ProjectId;
    readonly workspaceId: WorkspaceId;
    readonly executionId: ExecutionId;
  }) => Effect.Effect<
    Option.Option<
      SandboxPolicyRequirementV1 | SandboxPolicyPreIntentRequirementV1
    >,
    ToolObservationEvidenceStoreError,
    TransactionScope
  >;
}

interface SandboxPolicyRequirementV1 {
  readonly _tag: "SandboxPolicyRequirementV1";
  readonly projectId: ProjectId;
  readonly workspaceId: WorkspaceId;
  readonly executionId: ExecutionId;
  readonly episodeBinding: ExecutionEpisodeBinding;
  readonly expectedEpisodeRevision: number;
  readonly invocationId: ToolInvocationId;
  readonly providerTurnId: ProviderTurnId;
  readonly logicalStepNo: number;
  readonly repairAttempt: number;
  readonly logicalActionId: string;
  readonly actionIndex: number;
  readonly callRef: CallRef;
  readonly recoveryBindingDigest: Sha256;
}
```

## Accepted pre-intent P3 Action requirement (2026-10-21)

Under `ACCEPT_P10_P1_PREINTENT_CANDIDATE_READ_BOOTSTRAP_V1`, the existing
read-only port also returns this closed proof variant:

```ts
interface SandboxPolicyPreIntentRequirementV1 {
  readonly _tag: "SandboxPolicyPreIntentRequirementV1";
  readonly version: 1;
  readonly projectId: ProjectId;
  readonly workspaceId: WorkspaceId;
  readonly executionId: ExecutionId;
  readonly episodeBinding: ExecutionEpisodeBinding;
  readonly expectedEpisodeRevision: number;
  readonly providerTurnId: ProviderTurnId;
  readonly logicalStepNo: number;
  readonly repairAttempt: number;
  readonly logicalActionId: string;
  readonly actionIndex: number;
  readonly callRef: CallRef;
  readonly actionRevision: number;
  readonly inputHash: Sha256;
  readonly toolName: string;
  readonly toolVersion: string;
  readonly approvalId: string;
  readonly approvalState: "Pending";
  readonly approvalRevision: number;
  readonly approvalConsumedBy: null;
  readonly approvalExpiresAt: string;
}
```

The existing `SandboxPolicyRequirementV1` remains the post-intent variant and
keeps its exact NotAdmitted invocation/Bound RecoveryBinding checks. The
pre-intent variant is returned only after P4's existing nonterminal
`ApprovalRequired` handoff created an exact Pending P4 Executable approval for
the same unique current P3 Executable Action. Its Execution is active,
unsettled, and not stop-requested; its Step is ActionsInProgress at that
action's cursor; the Action is Pending with exact pinned ProviderTurn/Step/
LogicalAction/actionIndex/callRef/inputHash/toolName/toolVersion; the approval
is exact to the same action, `state=Pending` and unconsumed, and there is no
ToolInvocation or RecoveryBinding for that action. The proof carries its
immutable `expiresAt`; P1 checks it against trusted GatewayNow inside the
final transaction. Ambiguous/duplicate/corrupt source rows fail closed through
the existing typed read error. Valid absence, Approved/Rejected/Expired/
Cancelled/consumed approval, terminal/stopped/settled execution, non-Pending
action, or a newly present P4 intent returns None or the applicable existing
post-intent variant; it never fabricates a new invocation/binding.

Both variants are obtained under the caller's existing TransactionScope and
are read-only. The P10 candidate DTO remains unchanged and omits Action,
approval, invocation, RecoveryBinding, tool arguments, target refs/paths and
source digests. P1's read-only preparation resolves path-free TargetRefs/access
from the exact pinned action through existing P11 rules outside its write
transaction; those targets are not fields of the requirement source tuple.
P1's current-preconditions CAS re-reads the exact Action and approval source
under the same final transaction. No requirement, marker,
P3/P4 row, event, queue item, Attention or approval consumption is created by
this port. P9's terminal unavailable contract is unchanged.

For the existing post-intent `SandboxPolicyRequirementV1` variant, return a
value only when the canonical Execution is exact, active, unsettled,
and not stop-requested; the exact invocation is unsettled and
`effect_admission_state=NotAdmitted`; its immutable RecoveryBinding is
Bound and verifies canonical bytes, SHA-256 and exact intent/resource
identity; exactly one P3 Action is Pending on the Executable route with exact
action identity and matching P3 input hash; and the matching AgentLoopStep
is ActionsInProgress at that current action cursor. The invocation must be
policy-bearing under the existing P4 rule (`shell` or exact sandbox-profile
binding). Where an effect attempt has profile fields, they are either all
NULL or complete and exact against the bound proof.

For that post-intent variant, valid absence, terminal/stopped/settled Execution, settled or
MayHaveStarted invocation, non-Pending action, or non-policy-bearing tool
returns `None`. Missing, malformed, mismatched, duplicate, or ambiguous
RecoveryBinding/action evidence returns the existing typed P4 read/corruption
error, never `None`. The port uses the query's existing transaction and
opens no independent transaction. P10 combines its verified result with the
same-read candidate/currentness barrier; it returns no partial candidate DTO
on a typed port, authority, tuple, or barrier failure.

Post-intent qualification cases: exact active Execution + Pending Executable P3 Action +
matching ActionsInProgress cursor + NotAdmitted invocation + verified Bound
RecoveryBinding yields exactly one proof result; duplicate actions/bindings,
valid-JSON identity or input-hash mismatch, malformed binding, and proof
corruption yield the existing typed error; terminal/stopped/settled,
MayHaveStarted, non-Pending, non-Executable, non-policy-bearing or absent
invocation yields None only when source integrity is valid. Assert that every
branch is read-only, runs within the caller's TransactionScope, makes no
independent connection, and creates no P3/P4/P9/P10 row, event, marker,
Attention, or candidate state.

Pre-intent qualification cases: the exact Pending Action plus exact Pending,
unconsumed approval after `ApprovalRequired` yields one
`SandboxPolicyPreIntentRequirementV1`; no P4 invocation/binding is required or
created. Approved/expired/rejected/cancelled/consumed approval, missing or
duplicate Action/approval, stale input hash, a different current action
cursor, or any P4 intent for the same source yields no pre-intent proof or the
existing typed integrity error as applicable. P10's combined query returns
no partial DTO. Every branch is read-only, uses the existing TransactionScope
and writes no row/event/marker/Attention; P4's effect/approval claim semantics
are unchanged.
