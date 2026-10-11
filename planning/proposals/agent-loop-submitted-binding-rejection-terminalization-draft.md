# Submitted DecisionEpisode binding failure — fixed governance proposal

Date: 2026-10-11<br>
Status: **FIXED PROPOSAL / awaiting manual governance decision**<br>
Implementation: **not authorized**<br>
Baseline: `f80ee9132774c0c1fb570744d81398fad17da188`<br>
Evidence: `planning/results/AH10-submitted-decision-binding-integrity.result.md`

## Decision requested

Accept or reject the following single disposition for an exact, non-legacy
DecisionEpisode whose settled Provider result or Submitted DecisionRequest no
longer matches its authoritative Execution / AgentLoopStep binding:

> **P9 durable recovery block with public Action Required.** Preserve the
> Execution as Active and the exact AgentLoopStep as `ActionsInProgress`; leave
> the exact action `Pending`, with no Observation and no new Command. Record one
> immutable P9 binding-failure fact and event, and project that fact through P10
> as `ActionRequired` at the Execution's owning Workspace. The fact is the
> durable reason that makes the Step non-resumable. Every later generation
> reads the fact and returns `RecoveryBlocked` before Provider/action replay.
> Do not submit `SettleExecution(Failed)`, do not mark the Action Applied or
> `TerminalRejected`, and do not repair or rewrite the mismatched source rows.

This is an intentionally unresolved recovery state, not a fabricated action
failure. A Committed `SelectCurrentWork` receipt and its already committed
canonical effect remain immutable. The receipt does not prove the corrupted
DecisionRequest/Manifest binding, and it is never replayed through a handler.
The existing AgentLoopStep and Pending Action are not an orphan once the exact
P9 fact keys them and P9 recovery refuses all normal progression.

The fact's event is owned by P9 as `SubmittedDecisionBindingEscalated`.
P3 owns the pre-effect exact-binding guard and typed `RecoveryBlocked` result;
P2 owns returning the current lease without settlement and ordering the durable
fact check before redispatch; P10 owns the source mapping and public projection.
DID owns the Event/port/DDL registration. P5/EGP DecisionEpisode creation and
settlement semantics do not change.

## Evidence and boundary

The pending public-process test
`tests/functional/pending/ah10-submitted-decision-binding-integrity.functional.test.ts`
forms the DecisionEpisode through the Scheduler, pauses at
`AH9BeforeTerminalActionCommit`, and confirms the original Committed
`SelectCurrentWork` receipt, Submitted request, selected Work, exact pinned
Step, and Pending action. It then changes exactly one field to another valid
same-database value: the DecisionRequest Workspace or the Step Manifest. After
the actual gen0 lease expiry, gen1 acquires the same Execution. The pinned
Provider Attempt is not repeated, and there is no second selection Command,
`CurrentWorkChanged`, or target Observation. Current behavior nevertheless
settles the Execution Failed while leaving its Step `ActionsInProgress` and
Action Pending. Both cases fail the same terminal-orphan assertion.

The acceptance and landing already in force provide close but incomplete
precedents:

- DID v1.28 / EGP mechanically rejects episode binding/result mismatches, but
  does not assign this active-Step recovery disposition or an Attention fact.
- P3 `08` §2 fixes Manifest once; §7 makes `TerminalRejected` a possible Action
  state; §8 requires durable Attention for a successor identity mismatch.
  None defines this exact submitted DecisionEpisode mismatch, its Recovery
  block, or a P10 source.
- P2 `06` §4A requires resumable Steps to remain Active for redispatch and
  settled Executions to run no new actions; it does not classify this binding
  failure.
- P9 `07` §2 says `ActionsInProgress` normally converges the same action, and
  §3 sends contradictory legacy evidence to durable Attention without replay
  or direct settlement. Those clauses do not define a non-legacy submitted
  DecisionEpisode source fact or its public target.
- The accepted AH10 direct-child AssignWork contract (DID v1.33 §6A.16; P9
  `07` §2; P10 `02` §1–2 and `07` Story I) already uses the right disposition
  pattern for a different proof failure: immutable P9 fact/event, Action stays
  Pending, recovery blocks, P10 exposes Action Required, and no automatic
  repair/dismissal. Its source, fact identity, and trigger are deliberately
  specific to AssignWork, so that event/fact cannot be reused for Decision.
- P9 `07` §1 assigns P9 the recovery order/fact path; P10 `02` owns
  source→severity→target→dedup and P10 `07` owns its qualification. Therefore
  existing contracts support the selected *pattern*, but are insufficient for
  direct implementation of this DecisionEpisode source. An owner amendment is
  required; this proposal does not silently claim the mismatch is already
  covered.

## Fixed contract package for owner review

### P3 `08` — guard and blocked AgentLoopStep

Before invoking a decoded control, reading a prior result as proof of action
success, issuing a Gateway Command, advancing the action cursor, or appending an
Observation, verify all of the following from the exact durable identities:

1. Execution is the exact `DecisionEpisode` bound to the same DecisionRequest.
2. The request's Workspace is the Execution's Workspace.
3. The settled Provider result's Manifest is exactly the Step's immutable
   Manifest.
4. Step identity `(executionId, logicalStepNo, repairAttempt, providerTurnId)`
   and its next Pending Action identity/callRef match the pinned decoded result.

For the failure-code branches in this proposal, classify the two mismatches
separately and only when the request is `Submitted`: (a)
`request.workspaceId !== execution.workspaceId`, or (b) the settled success
Manifest differs from the exact Step's pinned Manifest. Other missing/settled
requests or replay-predicate failures are outside this proposal; do not turn
every `false` replay predicate into this Attention source.

Any mismatch in the submitted DecisionRequest Workspace or pinned Manifest
uses this proposal. P3 returns typed `RecoveryBlocked` to P2 and performs no
new ProviderTurn intent, Manifest, provider request, Session append, action
handler, Command, Observation, or Step/Action/Execution settlement transition.
If a matching immutable fact already exists, recovery returns `RecoveryBlocked`
before building new model context or entering `prepareTurn`. It must not
convert this integrity failure into `Failed`, `OutcomeUnknown`, `SkippedEarlySettlement`,
`TerminalRejected`, or a model-visible Observation. Existing committed
canonical Commands/events and Work selection are preserved as evidence; no
replacement identity, Command, ProviderTurn, or action is synthesized.

### P9 `07` — durable source fact/event and repeatable recovery gate

P9 owns one new immutable `submitted_decision_binding_attention_facts` source
and EventVersion 1 event `SubmittedDecisionBindingEscalated`. The fact is
written before recovery returns `RecoveryBlocked`, atomically with the event in
one `TransactionScope`. In that same transaction P9 re-reads the Execution,
exact Step, exact Action, DecisionRequest, and ProviderTurn/Manifest binding;
it verifies the same mismatch and the current full lease-holder fence when the
Execution is Active. If the evidence changed or the fence fails, the whole
write rolls back and recovery remains fail-closed.

The source identity is the exact action, not the observed corrupt value:
`(executionId, logicalStepNo, repairAttempt, logicalActionId)`. Derive
`attentionFactId` exactly as
`att_${sha256Hex(JSON.stringify({version: 1, executionId, logicalStepNo,
repairAttempt, logicalActionId}))}`; store the EventJournal-assigned `eventId`
on the fact row. Store
the first typed `failureCode` (`DecisionRequestWorkspaceMismatch` or
`StepManifestMismatch`), owning `projectId`/`workspaceId`, ProviderTurn and
action identities, first-detected timestamp, and event identity. Do not store
the candidate Work list, model text, opaque corrupt value, raw SQL/parser
details, or secrets. Exact retry returns the original immutable row and emits
no second event; a conflicting payload for the same identity is an invariant
failure and stays fail-closed.

The event payload is exactly
`{attentionFactId, executionId, workspaceId, logicalStepNo, repairAttempt,
providerTurnId, logicalActionId, failureCode}`. Its `aggregate_ref` is the
authoritative `executions.workspace_id`, its `correlation_ref` is the
LogicalActionId, its actor is `system:recovery`, and `caused_by_command_id` is
the uniquely identified original Committed SelectCurrentWork CommandId when
present (otherwise null). Do not use the corrupt DecisionRequest Workspace as
target or aggregate. No new event is emitted for every retry.

P9 checks this fact before ordinary `ActionsInProgress` replay. If present,
return `RecoveryBlocked` without Provider request, action handler, Gateway
Command, Observation, Step transition, or `SettleExecution`. The Action remains
Pending and the Step remains `ActionsInProgress`; the fact is the durable
terminal recovery disposition. The Execution remains Active and its lease is
released through the existing P2 path. v1 provides no automatic clear,
retry, repair, or dismiss action; subsequent generations remain blocked by
the same source fact.

If reading the fact or atomically recording the first fact/event fails, recovery
must still return without proposing any Execution settlement or proceeding to
Provider/action work. It releases the current lease through the existing P2
path; a later owner retries the same identity. No public Attention is claimed
until the source fact/event transaction commits.

The old `SelectCurrentWork` Committed receipt is preserved byte-for-byte and
is neither re-authorized nor re-executed. A late gen0 write after takeover is
rejected by the existing full holder/generation/expiry fence. A pre-commit
crash rolls back the fact and event together; the next current owner detects
the same exact tuple and retries. A post-commit crash leaves the same immutable
fact/event; the next owner observes it and blocks without re-running the
Provider or action. This remains true if the committed Command receipt is
generation 0 and the recovery owner is generation 1 or later.

### Migration and already-present rows

Use one additive, forward-only migration `0036` for
`submitted_decision_binding_attention_facts`, the P10 source table
`submitted_decision_binding_attention_rows`, and their identity/FK/index
constraints. The fact is unique by
`(execution_id, logical_step_no, repair_attempt, logical_action_id)`, references
its exact Execution, Step, and Action, and stores only the first typed failure
code. The P10 row is keyed by the immutable P9 `attentionFactId` and is written
only by P10's event consumer/reconciler. P10 rebuild repopulates that row from
the P9 fact snapshot, not only retained journal rows. The migration
does not update or backfill
Execution, Step, Action, DecisionRequest, Command, Event, Work, or receipt rows.
No migration inference uses Session text. The first P9 recovery pass after
migration classifies exact active rows under a current lease and records the
fact before normal replay. A pre-existing row already settled Failed while its
exact DecisionEpisode Step is still `ActionsInProgress` with the same Pending
selection Action is audit-only: P9 records the same Action Required fact from
the persisted mismatch, but never resurrects the Execution, retries the
action, rewrites the Step/Action, or changes the old settlement/receipt. Rows
whose exact identities cannot be proved follow the existing P9 insufficient
legacy-evidence Attention/ReconciliationRequired rule; they are not guessed
into this source.

### P10 `02` / `07` — public Attention

Add source literal `SubmittedDecisionBindingFailure`, severity `ActionRequired`,
target `executions.workspace_id`, and `dedupKey = attentionFactId`. Project
exactly one safe fixed summary per fact:

> A submitted Scheduler decision could not be bound to its execution; recovery is paused.

The event consumer verifies the event against the P9 source row and upserts one
P10 source-specific row in the same apply-then-advance transaction. P10's
read-only view consumes that row; its full rebuild repopulates from the durable
P9 fact table, so pruning the wakeup event cannot erase the Attention. The
The public row uses the existing Attention response shape and fixed safe
summary/time only; it does not add a wire field for `failureCode`. P9 retains
that code in its internal source fact. The public row never exposes Work
candidates, Manifest IDs, Provider content, raw database values, or parser
text. Existing subtree aggregation bubbles the count once and copies no
context. P10 rebuild and restart reconstruct the same row from the durable P9
source fact even if the source event is below the retained journal floor. P10
writes only its projection and offset. v1 adds no dismiss, repair, or canonical
mutation path.

## Required qualification before implementation authorization

The existing pending RED is expanded to assert the fixed disposition. Keep it
excluded from default functional gates until an implementation is separately
authorized and qualified.

| Layer | Required cases and assertions |
|---|---|
| P3 module | Workspace and Manifest mismatch each classify as `RecoveryBlocked` before provider/action/command/observation; exact successful matching binding still follows the current receipt-first path. |
| P9 store/recovery | Fact+event share a transaction and exact stable identity; same-tuple retry emits one event; conflicting code fails closed; rollback-before-commit yields no partial fact/event; restart-after-commit reads one fact and blocks. Existing Action/Step/Execution, Command receipt and Work rows are unchanged. |
| P10 | Public Attention query returns one `ActionRequired` row for the owning Workspace, safe summary, stable dedup; subtree count is one; restart and projection rebuild retain one row; no canonical writes. |
| Upgrade fixture | Apply migration 0036 to a baseline-equivalent `user_version=35` DB with each active mismatch and with the already-`Failed`/AIP/Pending orphan. Active cases become blocked with one fact; old settled rows receive attention only; no canonical row/receipt is repaired or resurrected. An unprovable identity follows the pre-existing P9 ambiguous-evidence path. |
| Two-daemon process | For each mismatch, gen0 reaches the existing AH9 gate with the original Committed SelectCurrentWork receipt, then crashes; after actual lease expiry gen1 acquires the same Execution and commits one fact/event. Kill gen1 immediately before and immediately after the fact/event commit; gen2 either performs the first atomic write or reads the committed pair. Across runs: ProviderAttempt count and successful provider request count stay one; no second SelectCurrentWork Command/receipt, `CurrentWorkChanged`, ActionIntent, or Observation; same DecisionRequest/Execution/Step/Action identities remain; one public Attention row; no `SettleExecution`. Attempted late gen0 writes after takeover are FencingRejected. |

The process matrix must separately report the Workspace and Manifest variants,
receipt identity/generation, lease generation/expiry, pre/post fact commit
state, and public Attention result. A focused qualification may use only the
test-local crash gates. Do not run the full functional suite or daemon-wide
qualification as part of this proposal review.

## Decision boundary

Accepting this exact proposal would authorize only the named P2/P3/P9/P10
owner amendments, DID §5.3/§7.2/§9.3 registrations, migration 0036, the
pending RED expansion, and the focused module/store/projection/two-daemon
cases above. It would not authorize changes
to `docs/design/**` by the implementation agent, Work lifecycle, Scheduler
selection semantics, Command receipt semantics, new Provider retry rules, or
other AH10 controls. The manual governor must explicitly accept this fixed
package before owner-document landing; implementation authorization remains a
separate decision after landing review.
