# AH7-DG-03 — Exact approval consumption and ToolInvocation settlement

Status: **DRAFT / pending manual governance; implementation not authorized**  
Proposed decision: `ACCEPT_TOOL_APPROVAL_SETTLEMENT_ATOMICITY`  
Owners: P4 `02`, `03` §4, `06` §5, and `01` settlement ADT; P2/P9 own the
Worker fence and recovery consequences.

## Decision requested

Resolve the contradictory frozen wording without treating an external effect
as part of a database transaction:

1. Keep exact approval validation before resource admission and keep approval
   consumption before Sandbox execution and any external effect, as P4 `02`
   requires.
2. Define the single-use approval as an irreversible fact bound to exactly one
   `ToolInvocationId`. Consumption is a conditional, atomic SQLite update, but
   it is **not** in the later terminal-settlement transaction. Amend P4 `03`
   §4 and P4 `06` §5 together. P4 `02` must say match first, then consume after
   the remaining admission checks and before effect.
3. Keep intent-before-effect. Every Worker-originated durable P4 write—intent,
   approval consumption and ToolInvocation settlement—must validate the full
   current lease-holder triple and expiry in the same transaction as that
   write. Current code fences settlement only; this decision requires the P4
   ports/SQLite adapter to carry and check the fence for intent and approval
   consumption too.
4. Before entering Sandbox/Executor, revalidate current authority and the
   Worker fence. If the Worker is already stale at this gate, it must not
   initiate the effect. A lease check cannot be atomic with a generic external
   effect: if expiry/takeover races after the gate or while the effect is in
   flight, treat the effect as in flight/uncertain. The old Worker may not
   commit settlement or Observation after losing its lease; the new generation
   must follow `SideEffectSemantics` and must not blindly replay a
   `NonIdempotent` effect. A downstream system that accepts a fencing token can
   enforce a stronger boundary; local shell has no such generic token.
5. Re-entry uses the same exact `ExecutionId + ToolInvocationId` and immutable
   intent. It re-resolves current authority, target resources and ControlBasis
   before any further effect. Approval is consent to the exact action, not a
   PermissionGrant and never bypasses revocation.
6. Record every no-effect authority, approval, resource-resolution or
   ResourceAdmission denial for a resolved tool as a terminal invocation record
   with typed P4 `Denied` settlement. The record is explicitly marked
   `NotAdmitted`; it is a rejected attempt and does not say an external effect
   began. Its reason code is from the closed list below. It is persisted even
   when no unsettled invocation row exists yet.
7. A consumed invocation that is rechecked before effect and now fails current
   authority is durably settled as `Denied(ApprovalNoLongerAuthorized)` only
   when its durable effect-admission state proves `NotAdmitted`. It produces a
   canonical `Denied` ToolResult, status `Denied`, disposition
   `AuthorizationDenied`; the AgentLoop action becomes `TerminalRejected` and
   advances once. The Work Execution is not terminally failed merely because
   this tool action was denied. A repeated same invocation returns the same
   denial without executing; renewed permission requires a new action,
   invocation and approval.
8. Stop/quiescence admission is a separate P2 condition, never an authority or
   approval Denied code. The claim/intent transaction and the later
   `NotAdmitted → MayHaveStarted` transaction both check
   `executions.stop_requested_at IS NULL` and the trusted current lease triple
   in the same transaction. If StopExecution wins before either boundary, no
   new effect is admitted. A pre-claim stop consumes no approval and creates no
   ToolInvocation intent; AgentLoop records the no-effect interruption and
   closes the action/cursor. A stop after claim commit but while state is
   `NotAdmitted` settles that exact invocation as P4 `Interrupted`, keeps any
   already-consumed approval bound, and closes the same AgentLoop action.
   After `MayHaveStarted`, follow P4 `02` §6 and P2/P9 side-effect recovery;
   never start a new effect or blind replay.

The closed `NoEffectDenialCode` set is:

```ts
type NoEffectDenialCode =
  | "InvocationAuthorityDenied"
  | "ApprovalRequired"
  | "ApprovalNotFound"
  | "ApprovalMismatch"
  | "ApprovalExpired"
  | "ApprovalConsumedByOtherInvocation"
  | "ResourceResolutionDenied"
  | "ResourceAdmissionDenied"
  | "ApprovalNoLongerAuthorized";
```

No generic fallback code or owner-selected equivalent is permitted. The
version-1 Denied projection maps each code to a fixed bounded Runtime
observation, so replay does not depend on current permission state or mutable
error text.

Stop is deliberately outside this enum. `ExecutionStopping` is the typed P2
admission result; for an already admitted P4 invocation still at
`NotAdmitted`, the durable terminal ToolInvocation result is the existing
`Interrupted` settlement. Neither case is `Denied`.

This denial rule depends on durable approval and effect-admission state. Before
this invocation consumes approval, persist a no-effect Denied row and leave
the approval unused. If an exact prior invocation proves that this same
`ToolInvocationId` consumed approval and its effect-admission state remains
`NotAdmitted`, persist `Denied(ApprovalNoLongerAuthorized)` under the current
Worker fence before returning. A different invocation's consume record never
authorizes or settles this invocation. If the effect-admission state is
`MayHaveStarted` or `LegacyUnknown`, do not write a no-effect denial; use the
side-effect recovery rule and fail closed when outcome cannot be established.

This choice retains the frozen P4 `02` pre-effect authorization and single-use
intent of P4 `03` §4 while replacing P4 `03` §4 / `06` §5's incompatible
“consumed in the same transaction as settlement” clause. Since P4 `01`'s
`ToolInvocationSettlement` and P4 `06`'s SQL `CHECK` currently omit `Denied`,
the accepted landing must add a typed, durable no-effect denial settlement (or
an equally precise existing representation) so the rule above is executable
and replayable. `Denied` must remain distinct from `ExpectedFailure` and
`OutcomeUnknown`. Scope is Executable `InvocationApproval` only; the separate
Control `ActionApproval`/AssignWork consumption contract stays unchanged.

## Alternatives considered

| Option | Semantics | Advantages | Costs / failure behavior | Disposition |
|---|---|---|---|---|
| A. Consume before effect; separate from settlement | Match exact approval; complete current admission; atomically persist intent + consume approval before effect; persist terminal result later. Fence each Worker write. | Smallest model that closes the intent/approval partial-commit window; consistent with P4 `02`; prevents approval reuse after ambiguous effects; no DB transaction spans external work. | Crash after claim commit can leave consumed approval + unsettled invocation. Recovery follows the persisted side-effect tier. A lost lease can stop the old Worker at the pre-effect gate, but generic external I/O cannot be atomically fenced once entered. | **Recommended.** |
| B. Consume at terminal settlement | Validate before effect, execute while approval remains unconsumed, then consume approval and persist settlement together. | Approval row and known terminal result commit together. | Contradicts P4 `02`'s pre-effect consumption. A crash after effect but before commit leaves the approval apparently reusable; a different invocation could perform the same approved effect unless an in-flight claim is added. | Reject: unsafe alone; becomes option C with added state. |
| C. Durable reservation / claim | Before effect, atomically bind a new Reserved state to one invocation; at terminal settlement, consume reservation with settlement. | Makes the in-flight approval claim explicit and blocks competing invocation claims. | Adds durable states/migration, reservation identity, revocation, expiry and recovery rules; still cannot atomically commit the external effect with SQLite. It does not remove the lease/effect ambiguity. | Reject for v1: more state without closing the external-effect crash window. |

## State transitions and transaction boundaries

```text
Approved, unconsumed
  ├─ authority / approval / resource denial before intent or consume
  │    → fenced recordNoEffectDenial transaction:
  │      insert terminal Denied + effect_admission_state=NotAdmitted
  │      approval remains Approved and unconsumed
  └─ all checks pass
       → claim/intent transaction also checks stop_requested_at IS NULL
            ├─ stopped → ExecutionStopping; no intent/approval consumption
            └─ admitted
                 ├─ approval-required: insert exact intent + consume exact
                 │  approval with one-use CAS in this fenced transaction
                 └─ no approval: insert exact intent in this fenced transaction
       → COMMIT before Sandbox/Execute
            ├─ current authority/fence recheck denies while NotAdmitted
            │    → fenced recordNoEffectDenial; terminal Denied
            └─ current authority/fence passes; second transaction checks
               stop_requested_at IS NULL and the same current fence
                 ├─ stopped → P4 Interrupted; do not admit effect
                 └─ current and not stopped
                 → fenced effect-admission transaction sets MayHaveStarted
                 → COMMIT before entering Executor
                 ├─ known result → separate fenced terminal-settlement transaction
                 └─ crash/lease loss/unknown → same invocation recovery by
                    SideEffectSemantics; approval remains consumed
```

The schema adds `effect_admission_state` with exactly three values:
`NotAdmitted`, `MayHaveStarted`, and `LegacyUnknown`. A new intent begins at
`NotAdmitted`; the fenced effect-admission transaction rechecks current trusted
authority, exact approval binding and the complete lease triple, then
monotonically changes it to `MayHaveStarted` immediately before opening
Sandbox/Executor. If revocation committed before this transaction, it records
typed no-effect Denied. A revocation or lease takeover after this commit sees
the call as already admitted/in flight. That marker means the effect **may**
have begun; it does not claim the external system confirmed execution. A crash
with `NotAdmitted` proves no Executor call was admitted under this protocol. A
crash with `MayHaveStarted` is ambiguous and must follow `SideEffectSemantics`.
All existing rows migrate to `LegacyUnknown`, never to `NotAdmitted`; settled
rows continue to replay their existing terminal fact, while old unsettled rows
cannot prove the effect had not begun.

The claim/intent transaction and effect-admission transaction independently
read `stop_requested_at` under their write transaction. Their order against
`StopExecution` is decided by SQLite commit order: if StopExecution commits
first, the gate returns `ExecutionStopping`; if effect admission commits first,
the invocation is in flight and P4 quiescence rules apply. There is no gap in
which a committed stop is ignored by a later effect-admission commit.

For an invocation already claimed but still `NotAdmitted`,
`recordNoEffectInterruption` atomically checks the full current Worker fence,
checks `stop_requested_at IS NOT NULL`, and writes the existing P4
`Interrupted` settlement. It does not change the approval binding or mark
`MayHaveStarted`. Exact replay returns that same Interrupted result. Before an
intent/claim exists, the P2 admission result is `ExecutionStopping`; AgentLoop
records ToolResult status `Interrupted` and disposition `ExecutionStopping`,
marks the current action `TerminalRejected`, marks remaining actions
`SkippedEarlySettlement`, advances the action cursor once, and proposes
`Interrupted(StopRequested)`. This is an AgentLoop/P2 interruption record, not
a P4 invocation row, because no P4 invoke was admitted.

When P4 returns the no-effect `Interrupted` settlement for an already claimed
invocation, the executable handler projects it to ToolResult status
`Interrupted`; AgentLoop uses the same `TerminalRejected`,
`SkippedEarlySettlement`, one cursor advance and `Interrupted(StopRequested)`
proposal. The approval remains consumed if claim committed; it remains unused
if stop won before claim. A stop after `MayHaveStarted` enters P4 `02` §6
quiescence: cancel, confirm or reconcile the in-flight effect. A known terminal
result is recorded once; unresolved state is
`OutcomeUnknown(ReconciliationRequired)` or remains reconciliation-pending. No
new executor call or replay is started.

`recordNoEffectDenial` is one P4 SQLite transaction that:

1. validates the full current Worker lease triple and expiry;
2. checks `stop_requested_at IS NULL`; otherwise returns `ExecutionStopping`
   without inserting a Denied row;
3. compares or inserts the exact invocation identity and immutable intent
   fields, including tool/version/arguments/regions/approval id;
4. requires either no row or an exact row with `effect_admission_state` equal
   to `NotAdmitted` or (for a new row) initializes it as `NotAdmitted`;
5. writes the terminal typed Denied settlement and stable version-1 Denied
   projection, without consuming or changing approval; and
6. returns the existing identical terminal Denied on exact replay, while
   rejecting a different payload or a `MayHaveStarted`/`LegacyUnknown` row.

Thus a no-effect rejection may create a canonical ToolInvocation **record**,
but it is not an unsettled executable intent and does not represent that an
external effect started. The record is terminal at insertion. It uses the
preallocated `ToolInvocationId` already bound to the model `callRef`; a later
attempt with changed authority or approval must use a new action/invocation
identity.

For `ResourceResolutionDenied`, `resolved_regions_json` is the empty list and
the reason code records that canonical resolution did not complete; this row
cannot satisfy or transfer an approval match. All other no-effect denial codes
store the exact resolved regions used in their authority/approval decision.

The current implementation uses separate intent and consume transactions. The
fixed decision changes approval-required calls to one fenced claim transaction:
either both the exact intent and approval consumption commit, or neither does.
If the consume CAS loses, roll back the intent insert, then persist a separate
terminal `Denied(ApprovalConsumedByOtherInvocation)` with
`recordNoEffectDenial`; this second transaction does not modify the winner's
approval. A crash before claim commit leaves no intent/consumption; a crash
after commit leaves both, with state `NotAdmitted`. Non-approval calls persist
their intent in one fenced transaction. Neither form opens the executor before
the later effect-admission commit.

The external effect and terminal settlement remain separate durability
boundaries. No SQLite transaction spans Sandbox execution. A Worker fence
protects canonical writes, not a generic filesystem/process/service effect.
The pre-effect fence/authority gate prevents a Worker already known stale from
starting; a takeover after that gate cannot prove the external effect absent.
Recovery therefore uses the invocation's immutable side-effect semantics:

```text
ReadOnly       → safe read may be repeated under same identity
Idempotent     → same-identity replay may converge
Reconcilable   → reconcile external reality before replay
NonIdempotent  → no blind replay; persist/reach OutcomeUnknown or Attention
```

Old-generation intent, approval-consumption and settlement commits are
rejected by authoritative same-transaction fence checks. If an old generation
already entered a non-fenceable external effect before losing the lease, its
late settlement/Observation is rejected; a new generation does not infer
“effect absent” from the rejected commit. It recovers the same invocation by
the table above. This is the limit of lease fencing, not permission for a
stale Worker to begin another action after it observes fencing rejection.

On re-entry, resolve the prior invocation by exact Execution, Workspace,
ToolInvocation identity, tool version, arguments, resolved regions and
approval id before projecting a denial from current authority. A prior terminal
settlement is replayed as stored. If the exact unsettled record shows approval
consumed by itself, has `NotAdmitted`, and current authority is denied, persist
`Denied(ApprovalNoLongerAuthorized)` under the current fence. If approval is
not consumed by this invocation and state is `NotAdmitted`, persist the
ordinary typed P4 `Denied` under the current fence and leave the approval
unused. `MayHaveStarted` or `LegacyUnknown` cannot be rewritten as Denied; use
side-effect recovery instead. This makes the same-invocation path deterministic
across a crash and prevents a consumed approval from leaving a forever-pending
AgentLoop action.

## Required observable semantics

| Event | Approval / invocation state | Effect and AgentLoop behavior |
|---|---|---|
| Authority/approval/admission denial before consumption | Fenced `recordNoEffectDenial` inserts terminal Denied + `NotAdmitted`; approval stays Approved and unconsumed. | AgentLoop records ToolResult status Denied and terminally resolves this action. A different invocation may use the exact approval once if it is still unexpired and its ControlBasis/resources still match. The same terminal invocation cannot later execute. |
| Kill before non-approval intent transaction commits | No intent or effect is committed. | A later matching call may be admitted after fresh checks. |
| Kill before approval claim transaction commits | Approval stays Approved / unused; no intent is committed. | No effect. Same or another exact-matching invocation may attempt the claim; one conditional CAS wins. |
| Kill after approval claim transaction commits, before effect-admission commit | Approval is consumed by this exact invocation; exact intent exists with `NotAdmitted`. | Same invocation only. After restart, current authority and lease are checked again. If valid, it may pass the final gate; if revoked/expired or basis changed, persist typed `Denied(ApprovalNoLongerAuthorized)` under the current fence, return ToolResult status `Denied`, mark action `TerminalRejected`, advance once, and do not terminally fail the Work. |
| Kill after effect-admission commit, before/during executor | Approval is consumed; state is `MayHaveStarted`. | The external effect may or may not have begun. Never claim no-effect Denied; use side-effect recovery semantics. |
| Different invocation presents consumed approval | Approval remains consumed by the first invocation. | Return typed Denied before executor; no effect and no reassignment, even if payload matches. |
| Kill after final effect gate / effect has begun, before settlement | Approval stays consumed; intent unsettled. | External effect may or may not have happened. Old Worker cannot settle after fencing. New Worker resumes same invocation using side-effect semantics; no blind NonIdempotent replay. |
| Kill after settlement, before AgentLoop Observation/action cursor | Approval stays consumed; canonical settlement exists. | Same invocation re-entry reads terminal result; no executor and no second consumption. AgentLoop writes the sourced result/action/cursor once. Missing non-Success bounded observation remains AH7-DG-01. |
| Repeat same exact invocation after durable `Denied` | Approval stays consumed if denial followed consumption. | Return the same typed denial; no executor. Restored permission requires a new action/invocation and new approval. |
| Permission revoked after an effect may have begun | Approval remains consumed; effect state is not inferred from revocation. | No new attempt starts under revoked authority. Resolve only through permitted reconciliation or fail-closed `OutcomeUnknown` / Attention; never report no-effect Denied for an effect that may have happened. |

For a denial before consumption, the invocation record is terminally Denied
with `NotAdmitted`, but the approval is not consumed or reserved; it may serve
one later exact-matching invocation until expiry/revocation/consumption.
For a denial after consumption, the approval is spent and permanently bound to
that `ToolInvocationId`; the typed denial is terminal for that invocation. This
distinction resolves approval reuse without returning consumed approval to the
pool.

The P4 `Denied` settlement stores exactly one `NoEffectDenialCode` from the
closed enum above and the typed version-1 projection needed for same-invocation
replay. Its transaction is fenced. The AgentLoop writes the
result with stable `(providerTurnId, callRef, resultRef)` source, status
`Denied`, disposition `AuthorizationDenied`, `TerminalRejected` action state
and cursor advance atomically. The batch may continue to later actions under
existing AgentLoop rules; no whole-Execution settlement is proposed for this
tool-level denial.

## Existing RED and diagnosis

The deterministic pending test is
`tests/functional/pending/ah7-approval-settlement-atomicity.functional.test.ts`.
It uses the production ToolRuntime and SQLite stores and interrupts after the
external effect, before terminal settlement. Its observed state is:

```text
effect count = 1
intent exists, terminal settlement absent
approval consumed_by = this ToolInvocationId
```

Its current assertion expects `consumed_by IS NULL`, following P4 `06` §5's
same-transaction wording. The targeted run on this worktree reproduced the
single failure exactly: expected NULL; received the current invocation ID.
That is a contract-conflict RED, not by itself proof that pre-effect approval
consumption is an implementation defect. Under option A, retain the effect,
intent, interruption and exact-binding assertions; update the oracle after
governance accepts A to require the approval remain consumed by this invocation
and unavailable to a second invocation.

The current runtime sequence in
`planning/results/AH7-approval-settlement-gap.review.md` is exact approval
lookup/match → ResourceAdmission → intent transaction → separate approval
consume transaction → Sandbox/Execute → settlement transaction. At this base,
`ToolInvocationStore.settle` accepts the execution-fence triple and SQLite
checks it in the settlement transaction. `recordIntent` and `consumeApproval`
accept no fence, and ToolRuntime has no authoritative current-lease gate
immediately before Sandbox/Executor. Thus the existing P4 settlement-fence
qualification does not prove that an old generation cannot write an intent,
consume an approval, or enter a new effect after takeover. This proposal adds
fencing for those writes plus a pre-effect gate; it does not claim that the
gate atomically fences generic external I/O once the call has begun.

The production triple comes only from the active `ExecutionOrigin` supplied
by `runExecution`: `workerId`, `workerIncarnationId`, and
`fencingGeneration` are copied by `ExecutableToolHandler` into
`ToolExecutionContext.executionFence`. They are Runtime-owned, never decoded
from model arguments or approval payload. Production fails closed if any
member is missing. P4 uses this exact triple, plus `expires_at > now`, for
intent, approval-consume, effect-admission and settlement mutations in the
same SQLite transaction. The pre-effect authority check uses current trusted
Runtime facts, not the prior Provider Turn's model context as authority.

## Exact post-acceptance diff scope

The accepted package must revise these owning clauses together:

1. P4 `02` §1–§2 and §6: retain match before admission; state that consumption
   occurs after checks and before Sandbox/Execute; distinguish match from
   consume; add the separately fenced stop/quiescence checks at claim/intent
   and effect admission.
2. P4 `03` §4–§5: in the Executable `InvocationApproval` subsection only,
   replace “same transaction as invocation settlement” with the one-use
   invocation binding and revocation rules; define pre-consume versus
   post-consume denial and replay. Leave the Control `ActionApproval` route
   contract intact.
3. P4 `01` §4–§5 and P4 `06` §1/§3/§5: add typed `Denied` terminal settlement,
   closed reason enum, versioned deterministic projection, `effect_admission_state`,
   `recordNoEffectDenial`, legacy backfill to `LegacyUnknown`, SQL constraints
   and precise transaction/fence rules; approval consume is atomic as a
   one-use CAS, not atomic with the external effect's result settlement.
4. P2 `03` §4 / `06` §4–§5 and P9 `02`/`07`: record the independent stop
   predicate at claim and effect-admission commits, the full lease fence on P4
   intent/approval/denial/interruption/effect-admission/settlement writes, and
   the non-fenceable external-effect recovery boundary.
5. P3 `08`: define post-consume pre-effect revoked-authority and
   `ExecutionStopping` ToolResults, `TerminalRejected` action disposition,
   remaining-action skip, cursor convergence and `Interrupted(StopRequested)`
   settlement proposal.

This list is a proposed landing scope only. No design file has been changed or
accepted.

## Qualification matrix after acceptance and separate implementation authorization

| Layer / case | Required oracle |
|---|---|
| Existing focused approval/effect RED | Effect once; intent exists; settlement absent at injected boundary; approval consumed by the exact invocation. A different invocation cannot consume it. |
| No-effect denial with no prior row | Fenced `recordNoEffectDenial` inserts one terminal Denied record with `NotAdmitted`, exact identity and one closed `NoEffectDenialCode`; it consumes no approval and never opens Sandbox/Executor. Exact repeat returns stored result; conflicting identity/payload fails closed. |
| No-effect denial with prior intent | Exact unsettled row must still be `NotAdmitted`; same transaction/fence changes it to terminal Denied. `MayHaveStarted` and `LegacyUnknown` cannot be converted to Denied. |
| Pre-consume denial / reuse | Fenced Denied record, no effect, no consume; the still-valid exact approval can be consumed once by a later different matching invocation; mismatch/expiry/control-basis change denies without consumption. The terminal denied ToolInvocation itself cannot be reused. |
| Same-invocation repeat | Exact intent required; approval consume count stays one; current authority is rechecked; settled success/failure/denial is replayed without effect. |
| Different-invocation duplicate | One conditional-consume winner; loser gets typed Denied before effect; consumed_by never changes. |
| SQLite two-connection / two-process race | One approval winner, one consuming ToolInvocationId, at most one matching effect. Label as concurrency, not crash evidence. |
| Stop wins before approval-claim commit | Claim returns `ExecutionStopping`; no intent and no approval consumption. AgentLoop records `Interrupted`, marks current action `TerminalRejected`, remaining actions `SkippedEarlySettlement`, advances cursor once, and proposes `Interrupted(StopRequested)`. |
| Stop wins before non-approval intent commit | No intent or effect; same P2/AgentLoop no-effect interruption/cursor rule. |
| Stop wins after approval claim (`NotAdmitted`), before effect-admission commit | Approval remains consumed by the same invocation; P4 `recordNoEffectInterruption` writes `Interrupted` under current fence, with no effect. AgentLoop converges the same interrupted result/action/cursor once. |
| Stop races effect-admission transaction | If stop commits first, return `ExecutionStopping`/P4 `Interrupted`, no effect admission. If the marker commits first, state is `MayHaveStarted` and P4 quiescence applies; both branches are asserted from commit order. |
| Stop after effect-admission commit (`MayHaveStarted`) | No new executor call or replay. Cancel/confirm/reconcile by SideEffectSemantics; known result settles once, unresolved invocation stays reconciliation-pending or becomes `OutcomeUnknown(ReconciliationRequired)`. |
| Crash/restart in no-effect stop convergence | Same durable StopExecution, `NotAdmitted`/Interrupted (or no invocation row before claim), exact AgentLoop ToolResult/TerminalRejected/SkippedEarlySettlement/cursor; no approval re-consume or effect. |
| Real daemon kill after settlement, before Observation/cursor | No second approval consumption or effect; exact durable settlement/typed denial is replayed; one sourced ToolResult/action/cursor transition. |
| Lease takeover across generations | At each durable boundary, stale intent/consume/effect-admission/settlement and no-effect-denial commit is rejected in the authoritative same transaction; Worker-originated writes stop and P2 recovery/settlement respects stop and unresolved-effect gates. Include the already-frozen P4 settlement-fence qualification but separately test new fence surfaces. |
| Permission revocation before effect | Executor count zero; durable `Denied(ApprovalNoLongerAuthorized)` under current generation; ToolResult status Denied, disposition AuthorizationDenied, action TerminalRejected and cursor advances once; same invocation replays denial; new identity requires new approval. |
| Permission revocation after effect entered | No further effect attempt; do not emit no-effect Denied; reconcile or fail closed by side-effect tier; no stale settlement/Observation. |

For process cases, kill at explicit probes on both sides of the named commits,
restart an ordinary daemon against the same DB, and inspect approval, intent,
settlement, effect log, ToolResult, AgentLoop action/cursor and ProviderTurn in
one coherent read snapshot. Repeat recovery to prove idempotence. Report SQLite
transaction/concurrency and real process crash qualification separately.
Passing this seam alone does not close AH7.

## Landing and authorization gates

Manual governance must accept this fixed choice and exact proposal hash. Only
then may the exact accepted package be landed in the owning contracts, with a
decision record, document revisions and independent landing consistency
review. Product-code implementation remains separately gated on that review
and explicit implementation authorization. This draft changes no
`docs/design/**`, production source or migration and does not claim acceptance.

Current status remains **open / not accepted / not authorized**. Independent
review is requested on this revision before any acceptance decision.
