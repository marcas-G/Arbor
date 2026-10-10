# P9 — 07 AgentLoopStep Recovery and Legacy Adoption

**Authority:** DID v1.20 AHT-1…AHT-8；P3 `08`；人工治理裁决
`planning/proposals/provider-result-handoff-governance-decision.md`。
**Status:** FROZEN；implementation AUTHORIZED by DID v1.21 ALS-I1。
Accepted AH7-DG-03 amendment (2026-10-10); post-landing consistency review
pending. Source proposal SHA-256:
`E818CC208F6A3B233FEF213E54E02AA30A1E96D6147313870C75FDE38DC94CBE`.

**Accepted AH10 Deliver amendment (DID v1.37):** this document owns the
DeliverMessage receipt precedence, legacy exact-proof adoption, and immutable
DeliverReplayEscalated P9 fact/event. The accepted proposal SHA-256 is
`75EAF29FC8FC90C5E098DA3758EFAD8C69074F478C82F2399619F522AE596565`;
runtime implementation remains separately gated.

**Accepted AH10 Deliver P10 storage addendum (DID v1.38):** this document's
P9 fact/event semantics and identity remain unchanged. The Deliver fact is
created by P9 and is the durable source for P10's `deliver_replay_attention_rows`
marker and rebuild. Its forward migration is proposed `0037`, conditional on
integrating accepted AH7/P36 migration `0036`; the integrated tree currently
ends at P35/user_version 35. P37 MUST NOT be independently implemented or
released before P36 integration. Accepted addendum SHA-256:
`040789D32BE1D92F1BAD28C5E3346439C1E902236452E778CD104AF6AA71EC8B`.

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

### DeliverMessage receipt and pre-Gateway legacy effect recovery (AH10)

P1 `07` binds the Deliver AgentAction to `DeliverMessage/1`; P7 `02` owns its
Gateway effect. Recovery follows this strict order for the pinned
`LogicalActionId` and stable MessageId:

| Earlier-generation `DeliverMessage/1` receipt | Canonical facts | Recovery |
|---|---|---|
| Committed and exact typed receipt | One exact Message and MessageSent(v1); causedByCommandId equals this receipt CommandId; if Inbox row remains, exact P7 fields | Reuse receipt; append the original Action Observation once; no new Command/effect |
| Committed, but receipt/result/effect/event/Inbox proof is missing or mismatched | Any | Record `PriorReceiptResultMismatch`, return `AgentActionRecoveryBlocked`; no replay/Observation/Applied |
| `TerminalRejected(FencingRejected)` | No Message, MessageSent, or Inbox effect exists for stable MessageId | Apply P1 eligibility; next owner may submit its generation-scoped CommandId |
| `FencingRejected` | Any such effect exists | Record `RejectedReceiptEffectConflict`; block and do not treat effect as success or retry |
| Retryable `OperationalFailure` | No effect evidence | Retry with the same CommandId/fingerprint |
| Retryable failure or non-FencingRejected terminal rejection | Any effect evidence | Record `PriorReceiptEffectConflict`; block, never change CommandId to overwrite history |
| Non-FencingRejected terminal rejection | No effect evidence | Apply the DeliverMessage/Command error algebra; generation change does not retry |
| No prior receipt | Exact pre-Gateway direct-write evidence below | Adopt the existing effect without synthesizing a receipt; converge one Action Observation |
| No prior receipt | No Message, MessageSent, or Inbox key exists | If P1 action/freshness/effect eligibility holds, submit current-generation DeliverMessage |
| No prior receipt | Partial, duplicate, or conflicting effect evidence | Record the corresponding Legacy failure; block with Action Required |

For a prior Committed receipt, `exact` requires that the typed
DeliverMessage/1 receipt result and pinned AgentAction match the unique
Message fields and unique MessageSent(v1) envelope/payload listed below; the
event's `causedByCommandId` must equal the Committed receipt's CommandId (not
the legacy gen0 ID). A missing/duplicate Message or event, a mismatch of
project/aggregate/type/version/payload, or an extant Inbox row that differs
from the P7 fields is `PriorReceiptResultMismatch` and cannot converge the
Action.

The legacy case is limited to the old handler which committed the delivery
transaction without CommandGateway. It is considered committed only if all of
these facts match the same pinned action: the unique Message row has the exact
stable MessageId, sender Workspace, kind=Deliver, direct-parent recipient,
deliverableId, bounded bodyRef and optional correlation/causation, and
`sentAt=MessageSent.occurredAt`; there is exactly one `MessageSent` event with
`projectId=execution.projectId`, `aggregateRef=messageId`,
`eventType=MessageSent`, `eventVersion=1`, `causedByCommandId` equal to
`legacyDeliverCommandId(providerTurnId,outputPosition)`, and exact payload
`{messageId,kind:"Deliver",sender,recipient,deliverableId,
correlationId:null,causationId:null}`. Duplicate or mismatched events, or
wrong Message identity/fields, are `LegacyMessageBindingMismatch`. This is a
strict tuple proof, not a containment/field-presence check.

Inbox admission used `workspaceId=recipientWorkspaceId`,
`entryKey=messageEntryKey(messageId)`, `kind="Message"`, summary exactly
`Deliver <deliverableId> from <senderWorkspaceId>`, `correlationId=null`, and
`admittedAt=MessageSent.occurredAt`. If `findByKey` returns a row, including a
consumed row retained by the projection, every field must match. A missing
row after consumption/projection cleanup is allowed. An Inbox row without the
exact Message/Event proof, or with mismatched fields, is `LegacyInboxConflict`.

The P9 failure source is one `deliver_replay_attention_facts` row plus
`DeliverReplayEscalated(v1)`. Its fields are
`{attentionFactId,eventId,projectId,executionId,targetWorkspaceId,
logicalActionId,messageId,failureCode,firstDetectedAt}`. Closed failure codes
are `LegacyMessageMissingEvent`, `LegacyEventMissingMessage`,
`LegacyMessageBindingMismatch`, `LegacyInboxConflict`,
`PriorReceiptDecodeMismatch`, `PriorReceiptResultMismatch`,
`RejectedReceiptEffectConflict`, and `PriorReceiptEffectConflict`. The fact
identity is `att_` + lowercase SHA-256 of UTF-8
`JSON.stringify({version:1,executionId,logicalActionId,messageId})`; the
database also enforces UNIQUE `(execution_id,logical_action_id,message_id)`.
The first failure code/time is immutable; an exact tuple retry returns the
original fact; conflicting project/target/identity is a typed invariant
failure. No message body, model summary, raw JSON, parser/database error or
authority material is persisted in the fact/event.

`RecoveryAttentionFactStore.recordDeliverReplayFailure(input)` returns the
exact stored fact, `findDeliverReplayFailure(attentionFactId)` is the targeted
read, and `listDeliverReplayFailures(projectId)` is the P10 rebuild read. All
three require `TransactionScope`. Their error channel reuses the existing
`RecoveryAttentionFactStore` repository/journal errors and typed
`RecoveryAttentionFactInvariantConflict`; the Deliver extension adds no
generic Attention port or error union.

`listDeliverReplayFailures(projectId)` is the source-fact snapshot for P10's
authorized full rebuild. P10 derives the projection marker from each returned
immutable fact; it does not write or clear P9 facts. The fact table and event
are part of proposed migration 0037 only after P36 integration; the existing
fact identity, event payload, failure codes, transaction and retry behavior do
not change.

Fact and event are committed in one `TransactionScope` before recovery
returns blocked. Event payload is exactly
`{attentionFactId,executionId,targetWorkspaceId,logicalActionId,messageId,
failureCode}`; `aggregate_ref=targetWorkspaceId`,
`correlation_ref=logicalActionId`, actor=`system:recovery`, and
`occurred_at=firstDetectedAt`. `caused_by_command_id` is the exact prior
DeliverMessage CommandId when one exists; it is omitted for receipt-absent
legacy proof failure. A pre-commit crash leaves neither fact nor event; a
post-commit retry returns the same fact without another event. If the
transaction fails, recovery remains fail-closed and does not advance the
Action or append an Observation.

After fact commit, recovery returns `AgentActionRecoveryBlocked`, preserves
the Action as Pending with no Observation/Applied, leaves the
`ActionsInProgress` Step without inventing a SettlementProposed result, and
releases the current owner lease. A subsequent recovery first finds the same
fact and blocks again; it does not submit a Command, Message, Inbox admission,
or Provider request. The P10 Attention has no automatic dismiss/repair path in
v1. P10 `02` owns projection fields; P10 `07` owns materialization, rebuild,
and restart qualification.

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
