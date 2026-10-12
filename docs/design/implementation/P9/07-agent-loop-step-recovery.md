# P9 — 07 AgentLoopStep Recovery and Legacy Adoption

**Authority:** DID v1.20 AHT-1…AHT-8；P3 `08`；人工治理裁决
`planning/proposals/provider-result-handoff-governance-decision.md`。
**Status:** FROZEN；implementation AUTHORIZED by DID v1.21 ALS-I1。
Accepted AH7-DG-03 amendment (2026-10-10); post-landing consistency review
pending. Source proposal SHA-256:
`E818CC208F6A3B233FEF213E54E02AA30A1E96D6147313870C75FDE38DC94CBE`.

## 1. Recovery order extension

P2's nine-step recovery order remains. During “reconcile external reality” and
“settle deterministic outcomes”, P9 adds the following per-Execution order:

```text
1. reconcile Provider success evidence locally
2. load / adopt the unique AgentLoopStep
3. replay pinned decode for settled Provider success
4. converge idempotent Session output
5. converge action ledger + immediate Observations
6. apply unresolved-side-effect gate
7. ensure the persisted successor OR submit the persisted settlement proposal
8. converge settled Execution → HumanMessage / projections
```

Recovery obtains a current lease before any Execution-originated runtime write.
RecoveryController authority remains the only unfenced path for canonical
settlement and cannot execute Agent actions.

## 2. State disposition matrix

| Durable state | Recovery action | Provider request |
|---|---|---|
| Turn unsettled + complete success evidence | atomically complete Attempt/Turn locally | forbidden |
| Turn unsettled + no complete success evidence | existing P9 same-Turn safe retry | allowed by retry policy |
| Turn terminal failure / repair exhausted | persist/read settlement proposal | forbidden |
| settled success + `Prepared`/`ProviderResultAvailable` | read events, pinned decode, advance handoff | forbidden |
| `OutputRejected(Retry(successor))` | `ensureSuccessor`; resume exact record | only successor's first execution |
| `OutputRejected(Exhausted(settlement))` | advance to persisted `SettlementProposed` | forbidden |
| `OutputAccepted` | rebuild decoded calls, verify hashes, continue at action cursor | forbidden |
| `ActionsInProgress` | query each LogicalActionId; converge or execute next Pending | forbidden |
| exact terminal P4 `Denied` + `NotAdmitted` | replay the stored closed reason code; converge the same ToolResult / `TerminalRejected` action / cursor once | forbidden |
| exact P4 `Interrupted` + `NotAdmitted` + StopExecution | converge the same Interrupted ToolResult/action/cursor, then `Interrupted(StopRequested)` if no unresolved side effect remains | forbidden |
| unsettled P4 `MayHaveStarted` | apply P4 `SideEffectSemantics`; reconcile or remain `ReconciliationPending` / `OutcomeUnknown`; never infer no effect | forbidden |
| any `ReconciliationPending` | reconcile, Attention, or OutcomeUnknown | blind replay forbidden |
| `StepEffectsCommitted` | persist one next-turn successor or settlement | only new successor |
| `NextStepReady(successor)` | `ensureSuccessor`; resume exact record | only new successor |
| `SettlementProposed` + Active Execution | new-generation SettleExecution Command | forbidden |
| settled Execution | converge linked runtime/message state only | forbidden |

### Direct-child AssignWork Committed receipt failure fact (AH10)

For the exact exception owned semantically by System Design §4.11 and
executable under DID §6A.16, recovery validates the pinned
`LogicalActionId`'s prior Committed Command receipt and its immutable
`AssignWorkTargetBinding` before it marks the Action Applied or appends an
Observation. A proven binding converges that same Action/Observation without
re-resolving the opaque selector. Missing, duplicate, malformed, conflicting,
foreign, or mismatched binding/effect evidence—including a historical
Committed AssignWork without a binding—leaves the Action Pending and stops
recovery before Observation, new Command, canonical repair, or Provider
request. Existing FencingRejected takeover is unchanged.

#### Stored Committed receipt decode failure (F23)

For this direct-child proof gate only, recovery selects the `AssignWork` v1
receipt decoder from the trusted action route/Handler registry after it has
validated the prior CommandId and Project identity. A syntax-invalid raw
`result_json` (A1) is internally classified as
`PersistenceCorruption<"CommandStore">` but is also proof-incomplete Committed
effect evidence: recovery records the existing `ReceiptMismatch` failure fact
and `AssignWorkTargetBindingEscalated` event using the fact store's existing
atomic transaction, then returns `AgentActionRecoveryBlocked`. It must not
return this decoder failure as a generic `AgentActionOperationalFailure` that
becomes `ControlActionHandlerRejected`, nor expose the raw JSON/parser text,
invoke the old/new handler, issue a Gateway Command, write/repair a receipt,
or produce Observation/Applied.

A JSON-parseable result with a wrong v1 shape (A2) remains the same existing
`ReceiptMismatch` proof-failure path; a structurally valid result with a
binding/ref/Work/provenance/authority/event mismatch (B) retains its existing
specific `failure_code`. These are not new failure codes, events, schema
versions, SQL changes or P10 sources. The P9 fact keeps the existing
`(executionId, logicalActionId, committedCommandId)` identity, atomic fact/event
commit, deduplication and before/after-commit crash behavior. If that fact
transaction fails, recovery remains fail-closed: no action advancement,
Observation or new Command, and the failure is not represented as a committed
fact.

This disposition applies only when an old Committed receipt is part of the
direct-child AssignWork proof. Other prior-receipt consumers use their trusted
action-route CommandType and Handler schema decoder; corruption there remains
a non-retryable operational failure and does not create an AssignWork binding
fact. `AgentActionRecoveryBlocked` carries only execution/action identity and
does not carry the corruption cause. This contract does not assert an existing
observable logger/diagnostic sink; any operator-visible diagnostic requires a
separate port decision. P10's existing AH10 projection is unchanged, and no
generic CommandStore corruption Attention source is added.

The P9-owned `assign_work_binding_attention_facts` row records one immutable
failure for `(executionId, logicalActionId, committedCommandId)`. Its
`attention_fact_id` is `att_` plus lowercase hex of the versioned SHA-256
tuple; its `failure_code` records the first typed condition and is not
rewritten. Do not store the opaque selector, model text, or raw database
errors. `RecoveryAttentionFactStore.recordAssignWorkBindingFailure` appends
the `AssignWorkTargetBindingEscalated` event and fact atomically in the same
`TransactionScope`; a repeated exact tuple returns the existing row without
another event, while conflicting payload is a typed invariant failure.

The event payload is exactly
`{attentionFactId, executionId, targetWorkspaceId, logicalActionId,
committedCommandId, failureCode}`; `aggregate_ref` is the Execution's owning
Workspace, `correlation_ref` is the LogicalActionId, and
`caused_by_command_id` is the committed AssignWork Command. Event and fact
commit before recovery returns blocked. A pre-commit crash retries the same
deterministic pair; a post-commit crash reads that pair. P10 `02` owns the
Action Required projection and P10 `07` owns its qualification; this recovery
contract does not define projection semantics.

### RAI-DG-01 closed Work-readmission sources

P9 recovery failures that hold a Work revision are a closed source set. Each
source is attached to the exact source Execution and its validated EGP
`ExecutionEpisodeBinding`; P2/P7 join by `executionId` and never infer a Work
from projection target or Session content.

| Source | Durable identity / witness | Closed failure codes |
|---|---|---|
| Deliver receipt replay proof failure | `deliver_replay_attention_facts` row plus `DeliverReplayEscalated`; exact `executionId`, `logicalActionId`, `attentionFactId` | `LegacyMessageMissingEvent`, `LegacyEventMissingMessage`, `LegacyMessageBindingMismatch`, `LegacyInboxConflict`, `PriorReceiptDecodeMismatch`, `PriorReceiptResultMismatch`, `RejectedReceiptEffectConflict`, `PriorReceiptEffectConflict` |
| AssignWork committed-receipt target proof failure | `assign_work_binding_attention_facts` row plus `AssignWorkTargetBindingEscalated`; exact `executionId`, `logicalActionId`, `committedCommandId`, `attentionFactId`; only direct-child proof | `LegacyUnbound`, `MissingBinding`, `DuplicateBinding`, `MalformedBinding`, `RefMismatch`, `AuthorityMismatch`, `ForeignTarget`, `PlacementMismatch`, `SourceActionMismatch`, `ReceiptMismatch`, `WorkMismatch`, `ProvenanceMismatch`, `EventMismatch`, `CommitLifecycleMismatch` |
| External reality cannot be reconciled | every committed `ReconciliationEscalated` journal event; `aggregate_ref` and payload bind the exact `executionId`; dedup identity remains `(executionId, invocationRefsFingerprint)` | No failure-code union |

The Deliver and AssignWork fact/event pairs retain their existing exact
identities, immutability and atomic `TransactionScope` commit. A conflicting
replay remains a typed invariant failure; no fact is rewritten or deleted.
Once committed, a P9 source fact starts the hold even if its Execution has not
settled; while Active, the existing one-active-main gate independently
prevents another Work admission.
`OutcomeUnknown(ReconciliationRequired(nonempty invocationRefs))` is also a
readmission source from canonical Execution settlement even without a separate
escalation event or Attention row; P4 `06` owns that invocation truth and the
no-blind-replay rule.

Ephemeral `AgentActionRecoveryBlocked` / `ExecutionDriveOutcome.RecoveryBlocked`
and `ReconciliationSourceError` do not independently create this gate. They
leave the same Execution Active, and the existing one-active-main invariant
already prevents a second Work Execution. A later durable source in this
closed set or a Work-bound RuntimeSafetyStop settlement starts the readmission
hold. No in-memory recovery outcome is promoted to a P9 fact. The P10 queue,
projected Attention row and consumer ACK are never source truth for P2/P7.

## 3. Legacy adoption

Migration `0017_agent_loop_step_handoff` is forward-only and additive. Its adoption
job enumerates Active Executions without an `AgentLoopStepRecord` and builds an
evidence set from Manifest, ProviderTurn/Attempt, sourced SessionEntry,
ToolInvocation, Application Command receipts and Execution state.

An AgentLoopStep is synthesized only when all of these are unique and consistent:

```text
executionId + logicalStepNo + repairAttempt + providerTurnId
Execution / Session / ContextEpoch / model / Manifest binding
decoder version or a governed legacy-decoder mapping
action/effect disposition (or proof that no action exists)
```

Disposition:

- existing sourced ModelOutput → bind its sequence and adopt at
  `OutputAccepted`;
- complete successful Provider result, no ModelOutput, no actions/effect
  ambiguity → adopt at `ProviderResultAvailable`;
- incomplete/contradictory identity, unknown repair attempt, or unprovable
  action side effect → durable Attention/ReconciliationRequired; no Provider
  request, action, Session append or direct settlement;
- a repeated adoption run returns the same record or Attention and never
  advances a step without new authoritative evidence.

The DOGFOOD-DG-01 equivalent fixture is explicitly authorized for the second
case: one settled successful Turn, complete canonical events, matching
Execution/Session/Manifest, no tool/control actions, and no sourced
ModelOutput. This is design authorization for a future migration test, not
permission to modify the preserved database now.

## 4. Crash-injection matrix

Kill before and after every commit boundary, restart on the same durable DB:

| ID | Boundary |
|---|---|
| AH1 | complete terminal events → ProviderAttempt Success |
| AH2 | ProviderAttempt Success → ProviderTurn settled |
| AH3 | ProviderTurn settled → AgentLoopStep ProviderResultAvailable |
| AH4 | Provider terminal failure / repair exhaustion → SettlementProposed |
| AH5 | decode complete → sourced ModelOutput SessionEntry |
| AH6 | SessionEntry → AgentLoopStep OutputAccepted |
| AH7 | each action intent/effect/settlement/Observation/cursor transition, including AH7-DG-03 approval claim, no-effect Denied/Interrupted, effect-admission and stop boundaries (`02` §5 supplement) |
| AH8 | action A committed; before B, ControlBasis becomes stale |
| AH9 | action proposes settlement; remaining actions not yet marked skipped |
| AH10 | old-generation FencingRejected receipt → new-generation takeover |
| AH11 | Observation append → StepEffectsCommitted |
| AH12 | SettlementProposed → SettleExecution |
| AH13 | Execution settled → HumanMessage convergence |
| AH14 | legacy adoption first run → identical second run |
| AH15 | Inbox Session append ↔ Inbox consumed |
| AH16 | Tool settlement ↔ sourced ToolResult append |
| AH17 | Compaction completed checkpoint ↔ epoch advance |
| AH18 | Provider overflow first recovery ↔ second terminal overflow |
| AH19 | ProviderNative binding match ↔ mismatch portable rebuild |

**AH7 lease-owner qualification.** A P9 AH7 cross-generation process case uses
the production P2 execution path: G0 obtains generation 0, commits P4 effect
admission, and the external effect occurs before settlement; G1 obtains its
own later generation through `LeaseService`, does not re-execute the
NonIdempotent effect, and follows the existing P4/P9 unknown/reconciliation
disposition; any late G0 terminal write is rejected by the existing full
fence. Two processes that were merely given the same copied holder tuple are
not two P2 lease generations and do not qualify as the real takeover case.

AH18 uses the DID v1.23 ordinal-0 ProviderTurn chain. Recovery ensures links
idempotently and never rewrites the failed inference Manifest. A replacement
overflow creates no second ordinal.

The AH7-DG-03 supplement in P9 `02` qualifies both sides of the fenced
intent+approval claim, no-effect Denied and Interrupted terminal records, and
the `NotAdmitted → MayHaveStarted` commit. Stop/claim/effect-admission races
are asserted by transaction commit order. After `MayHaveStarted`, recovery
does not start a new executor call or replay; it confirms/cancels/reconciles,
then records a known outcome or preserves the unresolved-side-effect gate.

Every injection asserts stale-generation writes are rejected, stable identities
prevent duplicate Session entries/external effects, and the state transition
matches its result branch. Branch-specific assertions:

| Branch | Required result |
|---|---|
| complete Provider success exists | no new request for that Turn; successful convergence yields one logical reply |
| authorized transport retry | same Turn/new Attempt; no duplicate accepted output/effect |
| repair/next-turn successor | exactly one stable new Turn; predecessor decision not recomputed |
| Completed | no extra request; HumanMessage Answered with one bounded reply |
| Interrupted | no automatic retry; DID v1.24/P17 maps the ResponseJob to Cancelled or resumes the same paused Attempt; legacy P14 HumanMessage Answered(null) is migration input only |
| Failed / OutcomeUnknown | original Execution creates no fake reply; P14 may release a new conversation attempt |
| ReconciliationPending / Attention | no blind request/action/ordinary settlement; no duplicate reply |
| insufficient legacy evidence | durable Attention; no request and no forced answer |

NonIdempotent/Reconcilable injection must include “external effect occurred,
settlement missing”: no blind replay and no ordinary completion until the tool
contract supplies reconciliation evidence; otherwise Attention or
OutcomeUnknown. The dense immediately-ready SSE test remains mandatory and
must show an actual TTL/3 lease renewal commit.

For stop at `NotAdmitted`, qualification requires no new effect, exact
Interrupted result and action/cursor convergence; pre-claim stop leaves
approval unused, post-claim stop preserves its consumed-by invocation. For
stop after `MayHaveStarted`, do not issue another Executor call, including an
Idempotent replay; only cancellation, confirmation or reconciliation may
resolve the in-flight effect.

## 5. Completion gate

Design closure resolves `DOGFOOD-DG-01`'s unanswered recovery semantics.
Implementation completion remains separately gated and requires:

1. migration `0017` and all new stores/ports;
2. AH1–AH14 green at both sides of each boundary;
3. the original-failure equivalent fixture converges to one authoritative
   Session answer without another Provider request;
4. evidence-insufficient fixtures stop at durable Attention;
5. the preserved database remains untouched until an explicitly authorized,
   separately verified migration run.
6. AH15–AH19 pass on both sides of each commit boundary; no duplicate Inbox
   delivery, Tool effect, inference step or checkpoint occurs.

## 6. Must Not Decide

- No new Provider failure or Tool side-effect tag.
- No direct SQL repair procedure for operators.
- No implementation authorization.
