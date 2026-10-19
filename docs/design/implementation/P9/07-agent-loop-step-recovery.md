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
marker and rebuild. Its forward migration is `0037`, ordered after P36. P36/P37/P38
owner contracts are integrated in the current governance baseline, but their
real migration implementations/registration are not; P37 MUST NOT be
independently implemented or released ahead of P36. Accepted addendum SHA-256:
`040789D32BE1D92F1BAD28C5E3346439C1E902236452E778CD104AF6AA71EC8B`.

**Accepted EA-DG-01 Executable approval amendment (DID v1.39):** P9 owns the
restart/crash qualification for approval request issuance, resolution/expiry/
cancellation wake, and same-action resume. Fixed proposal SHA-256
`E4F1B2935E0397292049BB3FDB1AB5847B02443CCE1B55A9827F823C63F145EB`;
acceptance record `planning/results/EA-DG-01-governance-acceptance.md`.
This adds no SideEffectSemantics or Execution settlement variant.

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
| AH7 | each action intent/effect/settlement/Observation/cursor transition, including AH7-DG-03 approval claim, EA-DG-01 approval issuance/decision/expiry/Stop wake, no-effect Denied/Interrupted, effect-admission and stop boundaries (`02` §§5 and EA supplement) |
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

EA-DG-01 qualification adds the production route boundaries: Worker-fenced
Pending+Inbox+request-fact issuance, P1 human decision plus exact Inbox
consumption/receipt, Expire/Stop resolution fact plus durable P2 wake, and
resume of the same Execution/AgentLoopStep/LogicalAction/ToolInvocationId.
The process matrix distinguishes the two first-issuer `now` values: first
commit wins; a unique-key loser compares stable binding fields and reads back
the winner's ApprovalId/expiry/revision. Store-seeded approvals remain
necessary P4 storage evidence only; they do not qualify production issuance,
human decision, browser view, wake or same-action recovery.

Every injection asserts stale-generation writes are rejected, stable identities
prevent duplicate Session entries/external effects, and the state transition
matches its result branch. Branch-specific assertions:

**AH7 lease-owner qualification.** A P9 AH7 cross-generation process case uses
the production P2 execution path: G0 obtains generation 0, commits P4 effect
admission, and the external effect occurs before settlement; G1 obtains its
own later generation through `LeaseService`, does not re-execute the
NonIdempotent effect, and follows the existing P4/P9 unknown/reconciliation
disposition; any late G0 terminal write is rejected by the existing full
fence. Two processes that were merely given the same copied holder tuple are
not two P2 lease generations and do not qualify as the real takeover case.

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
7. EA-AP1–EA-AP7 run through the production approval issuer/decision/wake
   route with real process restart; a test-seeded approval cannot qualify
   issuance, human decision, Inbox projection or same-action resume.

## Accepted AH7-DG-02 Reconcilable recovery / P39 gate (DID v1.40)

Accepted logical proposal SHA-256:
`D0A43BCDF3F95424BE7167B49D2170917B7605EE1E498A2601F2FFFB3DD6940B`;
accepted P39 physical supplement SHA-256:
`D2FF13087BB7A1BC5C9D422B4D5CEDE56689F83E765F96615FE13561CE5D446C`.

P9's existing recovery order delegates external truth to the exact P4 profile
and durable fact. For an unsettled `MayHaveStarted` invocation, P9 invokes
reconciliation before any replay and then follows only these branches:

| P4 fact/result | P9 action | P3/P10 convergence |
|---|---|---|
| `Occurred` + reconstructable canonical outcome/result | Do not invoke Executor; persist/recognize P4 selected same-attempt fact and terminal settlement under current full Worker fence | P3 replays the canonical result to one ToolResult/Observation/Action/cursor |
| `NotOccurred` + all binding/authority/approval/resource/profile/finality checks still exact; no Stop; attempt 0 | Admit at most the single attempt 1 through P4's atomic fresh gate | Same invocation/ProviderTurn/LogicalAction/callRef and consumed approval; no P9-created identity or second approval consumption |
| `NotOccurred` but Stop, changed snapshot, or attempt limit | No attempt admission; accept only P4's typed `ReconciledNoEffect` settlement | P3 uses the exact reason→ToolResult/Action/cursor mapping in `08`; Stop maps to existing Interrupted/quiescence |
| `StillUnknown`, missing profile, stale/unbound/conflicting proof, or unreconstructable result | No Executor; retain unresolved-side-effect gate and write/replay existing P9 escalation through the current lease-fenced recovery path | One `ReconciliationEscalated` identity; P10 ActionRequired row/rebuild within retained event horizon |
| P4 terminal result exists, P3 handoff missing | Skip P4 reconciliation and Executor; receipt-first converge the selected P4 result/fact | One sourced ToolResult/Action/cursor, no second result/effect |

Stop closes new attempt admission only. Read-only reconciliation may continue;
known fact, P4 settlement and P9 escalation may commit after Stop only under the
current complete, unexpired Worker lease tuple and unsettled Execution. An
expired/stale generation cannot append a fact/event or settle. A profile that
cannot fence/cancel the old external attempt or establish finality cannot
claim NotOccurred even if a current lookup is empty.

P4 facts are append-only. A contradictory post-terminal fact is retained only
as `PostTerminalEvidence`; it cannot replace P4's selected same-attempt fact,
rewrite terminal settlement, reverse P3 ToolResult/Action/cursor or cause
automatic replay. The accepted contract does not add a post-terminal P9/P10
Attention event. P39's active P36 NotAdmitted binding gap is handled before
pending P37/P38/P39 DDL by P1's immutable SQLite sidecar report and permanent
database-cohort isolation; P9 does not fabricate a legacy source binding or
manual settlement.

These owner contracts and qualification matrices are design-only. They do not
assert that a profile adapter, migration, real external reconciliation, Windows
SQLite sidecar, or two-daemon crash/restart matrix has been implemented or
qualified.

## 6. Must Not Decide

- No new Provider failure or Tool side-effect tag.
- No direct SQL repair procedure for operators.
- No implementation authorization.

## Accepted AH7-DG-01 / P39-P40 replay-evidence Attention (DID v1.41)

Accepted hashes: DG01 logical `19EFED54E037D3E2EC6F4D273D917F5249195650E5E41B3DCFF8DEB9784F29CD`;
P40 physical `5B61E0FF922A10D225FD5DAEA00176BD16C5C0B39484D626B7FEF6340516373A`;
RNO compatibility addendum `8B8E5D3C5729CF5619605DA8D8DF34BA00E1F817E80A743555029F331690E830`;
matrix `AD9AB72D0AA51AB84F4194EC2BF4BB90EC957BD062788C480BCBDD39B8E8DD35`.

When P4 returns a closed replay-evidence failure for the same current P3
action, P9 leaves the action Pending/`ActionsInProgress`, writes no ToolResult
and advances no P3 cursor; the Application uses the existing RecoveryBlocked
handoff. Under the complete current lease, P9 records the missing/conflicting
evidence fact and `ToolObservationReplayEvidenceEscalated(v1)` atomically.
This does not mutate P4 terminal settlement, P39 proof/selected fact, approval,
P3 source or execution truth.

The P40-era fact table is:

```sql
CREATE TABLE tool_observation_replay_attention_facts (
  attention_fact_id   TEXT PRIMARY KEY,
  event_id            TEXT NOT NULL UNIQUE REFERENCES domain_events(event_id),
  project_id          TEXT NOT NULL,
  execution_id        TEXT NOT NULL,
  target_workspace_id TEXT NOT NULL,
  logical_action_id   TEXT NOT NULL,
  provider_turn_id    TEXT NOT NULL,
  call_ref            TEXT NOT NULL,
  invocation_id       TEXT NOT NULL REFERENCES tool_invocations(invocation_id),
  failure_code        TEXT NOT NULL CHECK (failure_code IN (
    'Missing','UnsupportedVersion','Malformed','HashMismatch',
    'SettlementMismatch','IntentMismatch','ResultRefMismatch','UnexpectedResultRef'
  )),
  first_detected_at   TEXT NOT NULL,
  UNIQUE (execution_id, invocation_id),
  UNIQUE (attention_fact_id, project_id, target_workspace_id, event_id),
  FOREIGN KEY (execution_id, project_id, target_workspace_id)
    REFERENCES executions(execution_id, project_id, workspace_id)
);
CREATE INDEX tool_observation_replay_fact_target
  ON tool_observation_replay_attention_facts
    (project_id, target_workspace_id, first_detected_at);
```

`attention_fact_id` is `att_` plus lowercase SHA-256 of canonical UTF-8 JSON
`{"executionId":...,"invocationId":...,"version":1}` with fixed key order,
no whitespace and no trailing newline. Event payload is exactly
`{attentionFactId, executionId, targetWorkspaceId, logicalActionId,
providerTurnId, callRef, invocationId, failureCode}`; envelope uses the
Execution project, target Workspace aggregate, LogicalAction correlation,
`system:recovery`, and no Command cause. Raw observation/tool/Artifact/error
data is excluded. Same tuple/same bound code is idempotent; conflict is a
typed invariant failure.

Fact/event share one current-fence `TransactionScope`: pre-COMMIT crash leaves
neither; post-COMMIT retry returns the same immutable fact/event. P9 rechecks
the full lease and expiry at this write boundary; stale generation writes no
fact/event. `ReconciliationEscalated` remains the separate unresolved-effect
signal and is not reused for terminal observation corruption.

## Accepted AH10 Submitted DecisionEpisode binding failure (DID v1.42)

Accepted fixed proposal SHA-256:
`10D5A2532810B65DFBD3E397B141F6C0765AD32F4992BDDD0FE17F468975339A`;
acceptance/landing audit:
`planning/results/AH10-submitted-decision-binding-P41-governance-acceptance-and-landing.md`.

For an exact non-legacy DecisionEpisode `select_current_work` action, before
ordinary `ActionsInProgress` replay P9 validates that the submitted
DecisionRequest Workspace equals the authoritative Execution Workspace and
that the settled Provider result Manifest equals the exact Step Manifest.
Either mismatch is a durable integrity failure, not a false replay predicate:
no new `SelectCurrentWork`, Provider request/Turn, action handler, Command,
Observation or ordinary settlement is permitted. Existing Committed receipt,
canonical selection and Work remain unchanged. If the exact immutable fact
already exists, recovery returns `RecoveryBlocked` before Provider/action
replay. Otherwise P9 records the fact/event under the complete current unexpired
lease in one TransactionScope, then returns `RecoveryBlocked`; a stale or old
generation cannot commit it. A read/write failure remains fail-closed and
claims no public Attention before commit.

The fact identity is exactly
`(executionId, logicalStepNo, repairAttempt, logicalActionId)`; derive
`attentionFactId` as `att_` plus lowercase SHA-256 of the version-1 canonical
JSON object `{"version":1,"executionId":…,"logicalStepNo":…,
"repairAttempt":…,"logicalActionId":…}` in exactly that key order, with no
whitespace or trailing newline. It retains only the authoritative project and
Workspace, exact Step/Action/ProviderTurn identities, first typed failure code,
first detection time and journal event id. The EventVersion 1 payload is
`{attentionFactId, executionId, workspaceId, logicalStepNo, repairAttempt,
providerTurnId, logicalActionId, failureCode}` with the authoritative Execution
Workspace aggregate, LogicalAction correlation and `system:recovery` actor.
The event id is audit-only (no FK to prunable `domain_events`). Exact retry
returns the original fact/event; a conflicting payload for that identity is an
invariant failure. Two independent SQLite connections and OS processes racing
the same tuple must result in one immutable fact and one event; the loser reads
the committed winner.

### Stop/fact ordering and P2/P3 composition

The fact leaves the Execution active and the Step `ActionsInProgress` with its
exact current Action Pending until the user invokes existing authorized
`StopExecution`. Fact-first stays RecoveryBlocked. If Stop is already durable,
the P9 Recovery/Application coordinator validates the current full lease,
rechecks the exact mismatch, Step/Action identities and Stop, then atomically
reuses/writes the fact/event and applies P3's pure early-settlement plan through
`AgentLoopStepStore`: current Action `TerminalRejected` with
`StopRequestedAfterSubmittedBindingFailure`, later Pending actions
`SkippedEarlySettlement`, cursor at the end of the pinned ledger, and
`SettlementProposed(Interrupted(StopRequested))`. P3 does not import or call a
P9 store. P2 RecoveryController settles only that persisted proposal through
the normal Gateway after the unresolved-P4-side-effect gate is empty. Stop
releases the active slot but never clears the fact/Attention, changes Work or
selection, asserts the old Command failed, or causes replay. Stop/fact writers
serialize into fact-first or stop-first; neither order may skip the P3 close.
Any unresolved side-effect reference blocks settlement and preserves the
existing reconciliation/quiescence/OutcomeUnknown gate.

For the Manifest mismatch, P3 may use the ProviderTurn's own internally
consistent immutable Manifest and exact pinned decoder only to enumerate and
identity-check already-persisted action rows for this stop-only close. It may
not accept or rewrite the Step's mismatched Manifest, execute decoded actions,
issue Commands, or append Observation. If ProviderTurn evidence or persisted
row identity cannot be proven, use the existing insufficient-evidence path;
never synthesize a Stop proposal from guessed actions.

### Migration and legacy settled orphan audit

P41/0041 adds `submitted_decision_binding_attention_facts` as an immutable
source relation after the fully integrated and qualified 0036→0037→0038→0039→
0040 prefix. It does not backfill/rewrite canonical or Command receipt rows.
After upgrade, before the settled-Execution recovery short-circuit, P9 scans
exact already-settled `Failed` DecisionEpisode rows whose exact Step remains
`ActionsInProgress` and whose cursor Action is Pending `select_current_work`.
That exact structural tuple is the audit trigger even if the original mismatch
was later repaired. Record audit-only Attention with the specific mismatch
code if current immutable evidence still proves it; otherwise use
`SettledExecutionWithPendingDecisionAction`. This does not reopen Execution,
Step, Action or receipt; it never retries the action. Unprovable identities
follow the existing insufficient-evidence path, not inferred Session history.
The migration and this audit are design-only until separately implemented and
qualified.

## Accepted AH10 DeliverReplay outbox amendment (DID v1.43)

Accepted package: v5 base SHA-256
`5AAA2CD1FC00DFA729730E36FF13BAD7038496985D57500FD841B210E76F8B2F` plus
v6 addendum SHA-256
`8E6F47EF5933B6241B5E02E43821B6B816F705A9840AAA62FDFD318283004AF4`;
governance decision and independent review are recorded in
`planning/results/AH10-deliver-event-pruning-v6-governance-acceptance-and-landing.md`.

The existing Deliver fact identity, failure-code set, exact event payload and
fact immutability from DID v1.37 remain. P9 additionally owns the durable
pending outbox in proposed migration 0037. `event_id` is `TEXT NOT NULL
UNIQUE`, an immutable audit identity, and has **no permanent FK** to
`domain_events` because journal events are prunable. P9 validates the full
event witness when it creates the fact. The fact keeps the exact project,
Execution, target, logical action, Message, failure code, first-detected time
and event ID. Its stable tuple identity remains
`(execution_id,logical_action_id,message_id)`.

`recordDeliverReplayFailure` runs under one `BEGIN IMMEDIATE` /
`TransactionScope`: look up the exact tuple; for a new tuple append the
DeliverReplayEscalated(v1) event; read and compare its complete stored event
witness; insert the fact and exactly one pending queue row; then commit all or
none. The witness binds EventId, Project, type/version, aggregate/target,
correlation, actor, nullable causal CommandId, occurrence time and complete
failure payload. A mismatch/uniqueness conflict rolls back event, fact and
queue. Exact retry returns the original immutable fact and ensures one
pending row; it never appends a replacement event or changes first-failure
time/code/event ID. If an item was ACKed after projection, exact retry inserts
one new pending row. A conflict-ignore while that item is already pending
inserts no row. Reusing a pruned event ID for another fact violates unique
`event_id` and rolls back the attempted journal/fact/queue write.

The queue is P9-owned durable state, ordered by monotonic
`queue_sequence INTEGER PRIMARY KEY AUTOINCREMENT`; it has a unique
`attention_fact_id` and an exact fact/project composite FK. It has no event FK,
TTL or capacity-drop behavior. P9 exposes transaction-scoped exact lookup by
raw event ID, fact lookup/list, pending queue batch read and exact queue ACK.
P10 is the only ACK consumer; its marker must exist before the P9 queue row
can be deleted. The accepted v1.43 P1 raw-ID predecode and atomic poll
transaction are defined in P1 `05` and DID §9.9; ordinary non-Deliver P1
poison semantics are unchanged.

This is an owner-contract amendment only. Migration 0037 implementation and
registration remain separately gated after integrated P36/0036; migration
0037 and its deployment/user_version preflight must not be run independently.

## 7. P41 / migration 0041 immutable Submitted DecisionEpisode fact storage

The accepted P41 behavior persists the P9 integrity fact under migration 0041.
This section fixes only its physical relation and adds no recovery authority or
failure semantics. Migration 0041 creates the table empty; historical orphan
handling remains the runtime audit specified by the accepted P41 contract, not
migration backfill.

```sql
CREATE TABLE submitted_decision_binding_attention_facts (
  attention_fact_id TEXT NOT NULL PRIMARY KEY,
  event_id TEXT NOT NULL UNIQUE,
  project_id TEXT NOT NULL,
  execution_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  logical_step_no INTEGER NOT NULL CHECK (logical_step_no >= 0),
  repair_attempt INTEGER NOT NULL CHECK (repair_attempt >= 0),
  provider_turn_id TEXT NOT NULL,
  logical_action_id TEXT NOT NULL,
  failure_code TEXT NOT NULL CHECK (failure_code IN (
    'DecisionRequestWorkspaceMismatch',
    'StepManifestMismatch',
    'SettledExecutionWithPendingDecisionAction'
  )),
  first_detected_at TEXT NOT NULL,
  UNIQUE (execution_id, logical_step_no, repair_attempt, logical_action_id),
  UNIQUE (attention_fact_id, project_id, workspace_id),
  FOREIGN KEY (execution_id, project_id, workspace_id)
    REFERENCES executions(execution_id, project_id, workspace_id)
);

CREATE INDEX submitted_decision_binding_fact_project_time
  ON submitted_decision_binding_attention_facts
    (project_id, first_detected_at, attention_fact_id);

CREATE TRIGGER submitted_decision_binding_fact_no_update
BEFORE UPDATE ON submitted_decision_binding_attention_facts
BEGIN
  SELECT RAISE(ABORT, 'submitted decision binding facts are immutable');
END;

CREATE TRIGGER submitted_decision_binding_fact_no_delete
BEFORE DELETE ON submitted_decision_binding_attention_facts
BEGIN
  SELECT RAISE(ABORT, 'submitted decision binding facts are retained');
END;
```

The exact P9 identity tuple is also the fact's concurrency key. The composite
Execution FK is supported by P33's unique index
`executions_id_project_workspace(execution_id, project_id, workspace_id)`.
`event_id` is unique audit data and deliberately has no FK to the prunable P1
`domain_events` journal. The fact's
`(attention_fact_id, project_id, workspace_id)` unique key is the exact P10
marker source key. The project/time index supports P9 project listing ordered
by `(first_detected_at, attention_fact_id)`; current source queries do not
require a separate target Workspace index. P9 identity, event envelope,
lease, Stop/quiescence, and legacy audit semantics remain those of the
accepted P41 behavior and are unchanged by this storage-only addition.

## Accepted Blocked WorkEpisode settlement/action replay

P9 replay validates every `TerminalActionDenial` against the pinned
AgentLoopStep action identity, paired `ToolResult.status=Denied`, action
ordering and exact P4 ToolInvocation/no-effect denial when present. A
pre-P4 `HandlerRejected` is accepted only as its closed executable-route
category. A may-have-started effect remains ReconciliationRequired and cannot
be reclassified as Blocked. A settled `Completed(Blocked)` Episode is not
re-driven: restart reuses its exact settlement and current WorkBlocker state,
with no Provider or action request. `resolve_work_blocker` replay is likewise
bound to the exact source WorkEpisode and later successful ToolResult refs;
receipt/result mismatch fails closed and cannot clear or recreate a blocker.

## Accepted Native OS Sandbox decision recovery amendment

At spawn and restart, P9 consumes only the P1 durable `SandboxPolicyDecision`
for the exact Project/Workspace/Execution/Episode/policyRevision and the
matching immutable Grant issuer provenance. It revalidates the persisted
operator-config revision/digest against the validated P5 snapshot and the
provider/policy digest against the original decision. Missing, duplicate,
corrupt, expired, superseded or mismatched records fail closed with the
existing typed Attention/unavailable path; no policy is reconstructed from
current defaults, Worktree state, model text or an old event payload.

## V5-authorized provider-unavailable fact storage contract

P9 is the sole owner of `SandboxProviderUnavailableFactV1`; migration 0050
physically stores the exact immutable fact. Its persisted fields are
`attentionFactId`, `eventId`, `projectId`, `executionId`, `workspaceId`,
canonical `episodeBinding`, `policyRevision`, `policyDigest`, `profileId`,
`providerId`, `providerVersion`, optional opaque `probeEvidenceRef`, bounded
opaque `failureCode`, and trusted `firstDetectedAt`. It is created only for
the existing typed provider-unavailable outcome bound to the exact current
Execution and durable policy decision. It stores no host path, environment
value, raw probe output/error, credentials, command arguments or policy
source material. Profile/provider/version and evidence ref must match their
existing canonical sources; P9 does not synthesize a missing ref.

The immutable fact identity is `(executionId, policyRevision)`.
`attentionFactId` is `att_` plus lowercase SHA-256 of the exact canonical
UTF-8 JSON `{"version":1,"executionId":...,"policyRevision":...}` with
keys in that order and no whitespace/trailing newline. Same identity and
same complete binding/reason returns the original fact/event. Any conflict
in tenant, Workspace, Episode, policy/digest, profile, provider/version,
evidence ref or reason is a typed integrity conflict and writes nothing.
`failureCode` is an opaque equality value, not a public reason vocabulary:
preserve exact bytes, reject NULL/empty/edge-U+0020 values and values above
128 UTF-8 bytes; do not normalize or enumerate meanings.

P9 allocates the event id before writing the initial fact. In one
lease-fenced `TransactionScope`, write fact → durable P10 queue row → wake
event `SandboxProviderUnavailable(v1)`; all three commit or roll back
together. Event payload is exactly
`{attentionFactId, executionId, workspaceId, policyRevision}`; its envelope
binds project/workspace, uses the system recovery actor and has no Command
cause. The event id on the fact is audit identity only, with no FK to prunable
`domain_events`. Retry does not emit a second event or reset a Consumed queue
row. Stale generation, changed binding or non-identical unique collision
fails closed.

`listSandboxProviderUnavailableFacts(projectId)` returns one consistent
snapshot ordered by `(firstDetectedAt, attentionFactId)`. P9 validates every
row and all Execution/Episode/policy/provider/evidence bindings; malformed,
duplicate or cross-tenant facts are typed fail-closed errors, never silently
omitted or guessed. P10 reads this fact and durable queue source, not event
payloads. Higher policyRevision supersedes the old fact only in the live
projection; the immutable source is never rewritten/deleted. This storage
contract changes no Work, approval, sandbox policy or provider failure
classification.

## Accepted P8 verification action time and receipt-first recovery (DID v1.48)

Accepted token `ACCEPT_VCS_STABLE_EVIDENCE_TIME_AND_CRITERIA_SNAPSHOT`,
proposal raw SHA-256
`B0C532FF66697CE1FB06B93CDE477B1A833FC310D360D48513E341D54F1FAD56`,
accepted 2026-10-17. A Pending `RecordVerificationEvidence` ActionIntent owns
the immutable Runtime-selected time: P9 persists the first-intent `updatedAt`
and every same-action retry or owner-generation takeover reuses it as
`recordedAt`. Any transition that leaves the Action Pending preserves it. If
recovery cannot prove the stored value is the original intent time, it fails
closed; it does not call the clock or invoke the handler with a replacement.

Before a new-generation P8 command, recovery decodes known prior-generation
receipts with the trusted registered handler/result schema. A matching
Committed `RecordVerificationEvidence` receipt converges only when the exact
Evidence row and Runtime-bound ToolObservation source tuple are proven. A
matching ordinary `ConcludeVerification` receipt converges only when canonical
row, v2 event and v2 result carry the identical complete mission snapshot,
ordered `criteriaResults`, verdict, summary reference, `Available` status and
conclusion reason. The `RetryVerification` G5 outer v1 receipt remains the
exception: validate its existing source/successor ID binding against the
canonical row and v2 event carrying `Unknown`/`Orphaned`,
`NotApplicableOrphaned`, and empty results; return the exact receipt without
adding snapshot fields or an inner Conclude receipt.

Do not invoke a handler, append duplicate facts, repair rows, or replay the
Provider when receipt/evidence is missing, malformed, unsupported, or
conflicting. Such inconsistency fails closed without Observation. Ordinary
Execution settlement continues through the existing P9/P1 path after the
action result is durable; this addendum grants no new settlement authority.
`TerminalRejected(FencingRejected)` permits a new-generation command only
while the logical action remains Pending, the P8 ControlBasis is current, and
no unresolved P4 effect exists. Any other terminal rejection is final for
that logical action. Implementation and migration registration remain
separately gated.

## Accepted AH14 legacy adoption disposition evidence Attention (DID v1.49)

Accepted token `ACCEPT_AH14_LEGACY_ADOPTION_EVIDENCE_ATTENTION_GOVERNANCE`,
proposal raw SHA-256
`71F81F8B61375B9828FAB208D517FBF2CE0092C0B71ECCD124353262E23FCFB1`,
accepted 2026-10-17. This extension covers only a legacy successful Provider
result with uniquely bound Execution, ProviderTurn, AgentLoopStep and decoded
actions, where durable evidence cannot prove the disposition of at least one
action. The closed failure code is `LegacyActionDispositionUnproven`. The
legacy result is not adopted as `ProviderResultAvailable`; Step, action ledger,
Session output and Execution settlement remain unchanged. Recovery issues no
Provider request, action execution/replay, sourced output, or action Command.
Other missing or contradictory legacy identity/decoder failures stay on their
existing typed fail-closed paths. Positive complete-evidence adoption is
unchanged and creates no AH14 fact or Attention.

### Immutable failure fact and event

P9 owns `legacy_adoption_attention_facts` and event
`LegacyAdoptionEvidenceEscalated(v1)`. Under the current unexpired Execution
lease, P9 first validates the legacy success/action evidence, then one P1
`TransactionScope` rechecks the fence and inserts event and fact atomically.
The fact binds exact project, `executions.workspace_id`, Execution,
ProviderTurn, `(logical_step_no, repair_attempt)`, failure code,
canonical evidence SHA-256, event id, and first-detected time. It is immutable;
identity is unique on `(execution_id, evidence_sha256)` and event id is unique.
`first_detected_at` is the first P1 transaction-scoped clock value and remains
immutable on exact retry.
Exact retry returns the original pair; a conflicting tuple is typed invariant
failure.

The evidence fingerprint is lowercase SHA-256 over canonical UTF-8 JSON v1
with exactly these top-level keys: `version`, `executionId`, `projectId`,
`workspaceId`, `episode`, `step`, `providerSuccess`, `actions`, and
`failureCode`. `episode` binds `kind`, `ref` and `revision`; `step` binds
`logicalStepNo`, `repairAttempt`, `providerTurnId`, `manifestId` and
`decoderVersion`; `providerSuccess` binds `attemptNo`, `evidenceVersion`,
`finishReason`, `settledAt` and `canonicalEventsSha256`. Each action records
zero-based `actionIndex`, `logicalActionId`, `callRef`, `toolName`,
`toolSchemaVersion`, canonical `inputHash`, `stableActionId`, `actionVersion`,
`argumentsSha256` and `disposition`. Required binding identities are validated
before fact creation. Optional source fields use the exact
`{"_tag":"Missing"}` value; null, omission and empty string are not
equivalent. Actions sort by `(actionIndex, logicalActionId, callRef)`;
object keys recursively sort by Unicode code point, strings are NFC, arrays
retain defined order, numbers are base-10 integers, and canonical bytes are
UTF-8 without insignificant whitespace. Provider text, raw arguments, host
paths and database error text are excluded.

`attention_fact_id` is `att_` plus lowercase SHA-256 of canonical UTF-8 JSON
`{"version":1,"executionId":…,"evidenceSha256":…}` in that key order.
The v1 event envelope uses exact Execution aggregate, project, fact ID
correlation, `system:recovery` actor, null command/event causes and
`first_detected_at` occurrence time. Exact payload keys are `factId`,
`attentionFactId`, `projectId`, `executionId`, `targetWorkspaceId`,
`providerTurnId`, `logicalStepNo`, `repairAttempt`, `failureCode`,
`evidenceSha256`, and `firstDetectedAt`; both fact IDs equal
`attention_fact_id`.

Before-commit crash leaves neither fact nor event and retry recomputes the
same tuple without Provider/action/output work. After-commit restart reads the
same immutable pair and remains blocked without duplicate work. Storage
failure claims no durable Attention. A stale or expired generation cannot use
this path after lease fencing. After successful commit, return the typed
blocked disposition and release the lease through the ordinary path.

### Evidence-only resolution

There is no human dismissal or timeout. P9 may resume ordinary legacy
adoption only when new authoritative evidence proves every decoded action's
exact disposition for the original failure fingerprint. The original failure
fact and `evidence_sha256` never change. The canonical resolution tuple binds
that fingerprint, full original action identity set and a one-for-one
disposition/evidence row for every action, with exact P4 same-action
Action/ToolInvocation evidence. Applied requires exact terminal settlement,
canonical result and same-invocation Observation. The immutable P4 Action and
ToolInvocation must bind the same project, Execution, ProviderTurn/Step,
repair attempt, LogicalActionId, callRef, tool name, tool schema/executor
version and input hash as that decoded action. Its terminal settlement binds
the same invocation and includes terminal disposition (`Success` or
`ExpectedFailure`), effect class, settlement version/hash/time and canonical
result reference/hash. The exact P4 Observation binds the same
invocation/action and includes its reference, format/evidence version and
digest. Cross-invocation, cross-step, similar-name, OutcomeUnknown,
RuntimeFailure, missing settlement/result/Observation, or any mismatched
binding/hash is not proof.

NotAdmitted requires an exact immutable P4 Action and ToolInvocation with
`effectAdmissionState=NotAdmitted`, `settlementKind=Denied`,
`terminalDisposition=Denied`, and a reason in the closed P4
`TerminalNoEffectDenialCode` set: `InvocationAuthorityDenied`,
`ApprovalRejected`, `ApprovalNotFound`, `ApprovalMismatch`,
`ApprovalExpired`, `ApprovalConsumedByOtherInvocation`,
`ResourceResolutionDenied`, `ResourceAdmissionDenied`, or
`ApprovalNoLongerAuthorized`. Historical `ApprovalRequired` is not terminal.
The exact denial settlement hash/version/time binds that action; result and
Observation use explicit Missing markers. An absent P4 row, missing
settlement, human assertion, restart without observed effect, or absence of a
result is not no-effect proof. A may-have-started uncertainty follows existing
P4 reconciliation before this source can resolve.

The resolution tuple has exactly these top-level keys: `version`,
`attentionFactId`, `originalEvidenceSha256`, `executionId`, `providerTurnId`,
`logicalStepNo`, `repairAttempt`, `resolutionCode`,
`actionDispositionSummarySha256`, and `actions`. Each action row binds
`actionOrdinal`, `logicalActionId`, `callRef`, `toolName`,
`toolSchemaVersion`, `inputHash`, `disposition`, and the exact P4 evidence
object (or explicit Missing values for inapplicable optional fields).
Every decoded action is included once in ascending ordinal with identical
`(ordinal, logicalActionId, callRef, toolName, toolSchemaVersion, inputHash)`
identity. Partial, empty, reordered, duplicated, mismatched or insufficiently
proven sets reject the entire resolution. `DispositionProvenNotAdmitted`
means every non-empty action is NotAdmitted. `DispositionProvenSettled` means
at least one action is Applied and every action is Applied or NotAdmitted;
every other disposition set has no valid resolution. The bounded canonical
action-disposition summary contains only ordinal, stable identity and
disposition; P9 recomputes its digest and the code before commit. The persisted
resolution fact carries the canonical summary JSON and digest, derived
resolution code, original failure/evidence binding, resolution evidence
digest, and resolved time. P9 rejects an empty set or a caller-supplied code
that differs from the code derived from the complete action list before
writing any resolution fact/event or advancing the Step.

The complete resolution tuple uses canonical JSON v1 rules above and includes
`resolutionCode` and `actionDispositionSummarySha256`. Its digest is
`resolution_evidence_sha256 = lowercaseHex(SHA256(canonicalUtf8Bytes(tuple)))`.
The deterministic resolution ID is `alr_` plus lowercase SHA-256 of canonical
JSON `{version:1, attentionFactId, originalEvidenceSha256,
resolutionEvidenceSha256, resolutionCode}`. A single P1 transaction writes
the normal Step adoption/progression and one immutable
`LegacyAdoptionEvidenceResolved(v1)` event plus
`legacy_adoption_attention_resolution_facts` row bound to the original
failure, original evidence hash, resolution evidence hash, derived code,
canonical summary and resolved time. One resolution per failure is allowed;
exact retry returns its original fact/event, while a conflicting tuple is
typed corruption. Resolution event causally references the failure event and
uses `system:recovery`; `resolved_at` is fixed by the successful resolution
transaction and is excluded from the evidence fingerprint. Its exact payload
keys are `factId`,
`attentionFactId`, `projectId`, `executionId`, `targetWorkspaceId`,
`providerTurnId`, `originalEvidenceSha256`, `resolutionEvidenceSha256`,
`resolutionCode`, and `resolvedAt`. Resolution only clears the matching P10
marker; both immutable P9 facts remain permanently retained.

## Accepted AH19 checkpoint recovery boundaries (DID v1.50)

Accepted tokens and proposal raw hashes: Work
`ACCEPT_AH19_WORK_PRECHECKPOINT_BOUNDED_FRONTIER_V1` /
`4692895A2C9CF92DB1308507F29ED288FD3149F944AAC4F3D8BAE23635F5D663`;
Conversation `ACCEPT_AH19_CONVERSATION_CHECKPOINT_OWNER_V1` /
`9B562095B653B84C0518050BC7E6374D1C3710BF464A7BAB556D4F399D604E89`.
Both were accepted 2026-10-17.

For Work, distinguish the considered pre-checkpoint latest-64 `inputFrontier`
from durable Timeline content and actual checkpoint coverage. A committed
checkpoint's `retainedFrontier` is authoritative only for content represented
under the existing P3 projector; skipped and older rows remain durable but
uncovered. Restart before a checkpoint reconstructs the same latest-64
projection. Restart after checkpoint commit reuses that exact checkpoint and
post-checkpoint typed frontier; it does not replay a settled ProviderTurn or
action. More than 64 entries after a checkpoint are not truncated by the
pre-checkpoint bound.

For Conversation, checkpoint recovery is keyed by exact RootWorkspaceId and
the contiguous Answered HumanMessage prefix. A commit before Job.Answered
resumes the same ResponseJob/Attempt/episode and leaves the current Claimed
message uncovered and pinned once. It does not admit another response, append
the message twice, or replay settled Provider/action work. Binding mismatch
prevents old Native opaque reuse and invokes portable owner-prefix rebuild.
Recovery validates the exact covered frontier, source HumanMessage, Job
revision/Attempt, ProviderTurn Manifest and checkpoint evidence under the
current lease. It never infers owner or coverage from Session text or
ProviderTurn ID spelling.
An earlier non-Answered HumanMessage (including Pending or Claimed), or a
ResponseJob that has not settled Answered (including RetryScheduled), blocks
coverage of later Answered messages and remains a fail-closed frontier after
restart. Work Session checkpoints are not Conversation recovery evidence.
This amendment adds no physical owner-state or migration decision.

## Accepted Native OS Sandbox RecoveryBinding projection (V21)

When a process-capable invocation remains NotAdmitted/Pending and its
immutable P4 RecoveryBindingV1 proof is absent, non-Bound, corrupt or fails
the exact immutable-intent/source-identity checks, P9 classifies it internally
as RecoveryBlocked by read-only inspection of the existing
`tool_invocations` and `tool_invocation_recovery_bindings` rows. P9 writes no
ToolObservationReplay fact, event, marker, attention record, or P40 state; it
does not acquire/renew a lease, invoke P4, dispatch a Provider, admit an
effect, settle Action, write ToolResult/Observation, or advance the cursor.
The Action remains Pending and the AgentLoopStep remains ActionsInProgress.
Repeated bounded scans over unchanged invalid evidence are read-only and
produce zero dispatch/lease/P4/Provider calls. No binding is synthesized,
repaired, or rebound in v1.

P9 continues to distinguish invalid immutable proof from current-source
resource/authority/control drift: the latter follows the existing P4 current
Denied, ApprovalNoLongerAuthorized, ResourceAdmissionDenied, or
SandboxPolicyRequiredInterruption path and is not binding corruption. The
durable `SandboxProviderUnavailableFactV1` path for actual provider failures
is unchanged. P10's `SandboxRecoveryBindingFailure` is derived from the same
existing P4 rows and is not a P9 fact/event.


## Full-chain durable provider-unavailable recovery (V1–V21)

P4 SandboxProbeResultV1.Unavailable is a typed no-spawn value, never an
exception that retries or falls back. For a live action, P4 persists one
complete terminal ExpectedFailure before returning: exact ToolInvocation and
policy/provider/version/capability/evidence binding, effectDisposition=NoEffect,
canonical observedAt from trusted GatewayNow, bounded sanitized failure code,
optional immutable probeEvidenceRef and fixed safe summary. If intent is
committed but observation is missing after crash, normal RecoveryController /
AgentLoop resume under a valid current lease/fence calls the P4-owned
observation persistence service to commit sandbox/probe-interrupted with
bindings copied from the exact intent. It does not probe or spawn again; an
existing exact observation is reused, mismatch/corruption fails closed.

P9 consumes only the exact persisted P4 observation. Under valid current
lease/generation fence it atomically persists the existing terminal no-effect
SandboxUnavailableV1 disposition for that exact action, one immutable
SandboxProviderUnavailableFactV1, one retained P10 queue row and one
SandboxProviderUnavailable(v1) wake event. The disposition binds exact
Step/ProviderTurn/action ordinal/callRef, Execution/Episode, policy revision/
digest, provider version/capability revision and bounded failure code. It
advances the action cursor past the exact failed action and ends only that
action/Step; no later action in the ProviderTurn is admitted,
and no Execution/Work completion/cancellation/PASS occurs. A strictly higher
human policy revision may admit a successor Step; old observation/fact is
immutable and never replayed as a new provider call. Stale fence writes none.

firstDetectedAt is one trusted P9 Clock reading captured for the transaction,
serialized as canonical UTC milliseconds; provider/caller/event timestamps are
ignored. Queue enqueuedAt and event occurredAt equal firstDetectedAt. Exact
retry returns the original fact/event/Step. Closed P9 errors include
LeaseFenceLost, UnavailableIdentityConflict, PolicySnapshotMissingOrCorrupt,
ProviderBindingMismatch, ProbeEvidenceInvalid, PersistenceUnavailable and
PersistenceCorruption. Failure transaction errors do not create an
unavailable fact. This P9 provider-failure fact is distinct from V21
RecoveryBinding proof failure, which stays read-only and has no fact/event.


## V21 P1 decision-result recovery binding

P9 obtains exact committed policy only by following
SandboxPolicyDecision.decision_command_id to its existing Command receipt and
strictly decoding commands.result_json as SandboxPolicyDecisionCommittedInternalV1.
The outer result must match commandId, project/workspace/execution/full
Episode/policyRevision; decode exactly one closed OsEnforced or
TrustedLocalUnconfined snapshot, compute canonical UTF-8 SHA-256, and compare
to both outer policyDigest and decision-row policy_digest. Missing result/
receipt, wrong variant, unknown field, noncanonical bytes, identity mismatch
or digest mismatch is persistence corruption/fail-closed. Never reconstruct
from current bundle/provider/defaults or event payload. No BlobStore or
migration is used.
