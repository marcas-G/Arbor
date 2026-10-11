# AH10 Submitted DecisionEpisode binding failure — P41 governance proposal

Date: 2026-10-11<br>
Status: **DRAFT / revised for Blocking = 2 / awaiting independent review**<br>
Implementation: **not authorized**<br>
Evidence baseline: `f80ee9132774c0c1fb570744d81398fad17da188`<br>
Governance tree: P39 integration `5e5b1296f17cfa10ab90815f24d2d0f1afebcd9d`<br>
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
> durable reason that blocks ordinary recovery. Every later generation reads
> the fact before Provider/action replay. Do not submit
> `SettleExecution(Failed)`, mark the action `Applied`, repair source rows, or
> dismiss the fact. A human with existing authority may issue `StopExecution`;
> after safe P3 quiescence, P2 RecoveryController may settle this exact
> Execution as `Interrupted(StopRequested)` and release the active slot. Stop
> preserves the P9 fact and public `ActionRequired` row, does not replay the
> old Provider result or `SelectCurrentWork`, and does not assert the old
> Committed Command failed or undo its canonical effect.

Without a human Stop, this is a durable blocked recovery state, not a fabricated
action failure. A Committed `SelectCurrentWork` receipt and its already
committed canonical effect remain immutable. The receipt does not prove the
corrupted DecisionRequest/Manifest binding, and it is never replayed through a
handler. The P9 fact keys the exact Step and Pending Action; Stop is the
existing authorized path to quiesce that blocked Execution. Stop closes the
runtime action ledger without changing canonical Work/selection or clearing
the Attention fact.

The fact's event is owned by P9 as `SubmittedDecisionBindingEscalated`.
P3 owns the pre-effect exact-binding guard and typed `RecoveryBlocked` result;
P2 owns returning the current lease without settlement and ordering the durable
fact check before redispatch and gates RecoveryController settlement on P3
quiescence; P10 owns the source mapping and public projection. DID owns the
Event/port/DDL registration. P5/EGP DecisionEpisode creation and settlement
semantics do not change.

## Baseline and migration-prefix audit

- The original RED is from `f80ee9132774c0c1fb570744d81398fad17da188`:
  DID v1.36, SQLite `user_version=35` (P35). That tree has no integrated
  migrations 0036–0040.
- The external combined P36–P39 governance tree is
  `codex/governance-p36-p38-integration@5e5b1296f17cfa10ab90815f24d2d0f1afebcd9d`.
  It carries P36 AH7-DG-03, P37 AH10 Deliver, P38 EA-DG-01 and P39 AH7-DG-02
  accepted owner contracts; DID is v1.40. Its integration result says the
  contracts are design-only: migration implementations/registration for
  0036–0039 and their qualification are not integrated.
- P40 AH7-DG-01 is separately accepted at
  `planning/results/AH7-DG-01-physical-schema-supplement-acceptance.record.md`
  in external commit `ce1cea5`. Its accepted LF SHA is
  `5B61E0FF922A10D225FD5DAEA00176BD16C5C0B39484D626B7FEF6340516373A`; the
  acceptance record says P40 owner landing and cumulative-runner qualification
  are still blocked. P40 reserves cumulative migration 0040 after P36–P39.
- These branch states are not presumed integrated into the original f80
  evidence database. The P41 target is DID v1.42, after the unified DID v1.41
  landing for P36–P40. P41/migration 0041 is strictly conditional on P36–P40
  being integrated into that one design/migration prefix and separately
  qualified.

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
convert this integrity failure into `Failed`, `OutcomeUnknown`, or
`SkippedEarlySettlement` during ordinary recovery. Existing committed
canonical Commands/events and Work selection are preserved as evidence; no
replacement identity, Command, ProviderTurn, or action is synthesized.

#### Stop-only quiescence for a fact-blocked DecisionEpisode

The existing authorized `StopExecution` command is the sole v1 resolution of
the active Execution lock. After Stop is durable, P3 may run a stop-only
quiescence path for this exact mismatch and `select_current_work` Action. If
the P9 fact already exists, P3 reuses it. If Stop wins the race and the fact
does not yet exist, P3 records it through the P9 fact store in the same
transaction as the P3 close. This is not ordinary action replay:

1. Require `stopRequestedAt != null`, the same exact binding mismatch and
   active DecisionEpisode/Step/Action identities, plus the complete current
   lease-holder tuple with unexpired `expires_at`. Reuse the exact existing
   P9 fact or insert it atomically with the Step/Action close.
2. Confirm the settled ProviderTurn and its own Manifest/event chain are
   internally complete. In the Manifest-mismatch case, this is a narrow P3
   Stop-only exception to the normal Step/Manifest replay gate: the Step's bad
   `manifestId` remains a failure fact, while P3 may read the ProviderTurn's
   own immutable Manifest (whose `providerTurnId`, Execution, Session, epoch,
   and model binding must still match) and the exact pinned decoder only to
   enumerate action order for closure. This never accepts/rewrites the Step
   Manifest. It must not call Provider, execute a control, submit a Command, or
   emit an Observation from that decode.
3. In one `TransactionScope`, close the exact current Pending control Action as
   `TerminalRejected` with disposition
   `StopRequestedAfterSubmittedBindingFailure`; mark any later Pending actions
   `SkippedEarlySettlement`; advance the cursor through the complete pinned
   action list; and transition the Step to
   `SettlementProposed(Interrupted(StopRequested))`. Recheck Stop, fact,
   identity, and full lease fence in that transaction. If this is the first
   binding-failure detection, append the P9 fact/event in this same transaction.
   Append no Observation.

This applies the frozen P3 early-settlement states to the current control
Action. `TerminalRejected` means this AgentLoop action was closed without
certifying an Observation/Applied result; it does **not** claim that the old
Committed SelectCurrentWork Command failed or that its canonical effect was
rolled back. If any unresolved P4 side-effect reference exists, do not take
this path; the existing reconcile/quiescence/OutcomeUnknown gate remains
authoritative. No new Action state, settlement variant, or P3 event is
required; the P9 event above remains the durable source fact.

The local read/decode in step 2 is permitted only because the fact-backed Stop
path performs no model or control action; it reconstructs action indices for
the existing P3 early-settlement transition. The Step's mismatched Manifest is
not accepted as valid. P3 validates and decodes from the settled ProviderTurn's
own internally matching Manifest/event chain, then verifies decoded action
identity/callRef/hash against every already persisted row before closing the
ledger. This decode only enumerates actions; it cannot authorize execution. If
that internal ProviderTurn evidence or row match fails, do not fabricate the
Stop proposal. The two qualified corruptions leave the ProviderTurn's own
Manifest/event binding and exact persisted Action identity intact.

### P2 `06` — Stop and RecoveryController order

P2 must not use its ordinary `stopRequestedAt && no P4 pending` shortcut to
settle this exact fact-blocked Execution while its Step is still
`ActionsInProgress` and the Action is Pending. For the exact mismatch plus an
authorized Stop, whether or not its P9 fact has already committed:

1. acquire/validate a current full lease and invoke only the P3/P9 stop-only
   quiescence above; this creates the P9 fact if Stop committed first;
2. reread the persisted `SettlementProposed(Interrupted(StopRequested))` and
   require the existing reconciliation source to return no unresolved
   side-effect references;
3. submit the existing deterministic `SettleExecution` through
   `RecoveryController` authority and the normal Gateway; after its commit, the
   settled Execution releases the active Workspace slot.

P2 must not directly settle an AIP/Pending Step, and a Worker/old generation
cannot perform the RecoveryController settlement. Stop leaves Work lifecycle,
selected Work, the old receipt and `CurrentWorkChanged` history unchanged; it
adds only the existing Stop and ExecutionSettled facts. It does not create a new
DecisionRequest/DecisionEpisode or resume the old Provider/action. The P9 fact
and P10 Action Required projection survive settlement and remain visible;
Stop is not a fact dismissal or repair. If fact commit precedes Stop, the
execution stays blocked until the human Stop request. If Stop commits first,
the mismatch fact and P3 stop proposal commit together. Concurrent Stop/fact
writers serialize to one of those orders.

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
the first typed `failureCode` (`DecisionRequestWorkspaceMismatch`,
`StepManifestMismatch`, or `SettledExecutionWithPendingDecisionAction`), owning
`projectId`/`workspaceId`, ProviderTurn and
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

P9 checks this fact before ordinary `ActionsInProgress` replay. If present and
Stop has not been requested, return `RecoveryBlocked` without Provider request,
action handler, Gateway Command, Observation, Step transition, or
`SettleExecution`. The Action remains Pending and the Step remains
`ActionsInProgress`; the fact blocks ordinary recovery. The Execution remains
Active and its lease is released through the existing P2 path. If Stop is
requested, P9 permits only the P2/P3 stop-only quiescence path; it must not
bypass Step/Action closure and settle directly. The P9 fact is never cleared,
rewritten, repaired, or dismissed by Stop, and subsequent Attention queries
continue to expose its Action Required row.

If reading the fact or atomically recording the first fact/event fails, recovery
must still return without proposing any Execution settlement or proceeding to
Provider/action work. It releases the current lease through the existing P2
path; a later owner retries the same identity. No public Attention is claimed
until the source fact/event transaction commits. When Stop is already durable,
fact/event write, Action/Step stop closure, and
`SettlementProposed(Interrupted(StopRequested))` commit atomically under the
current lease; pre-commit crash rolls all of them back.

The old `SelectCurrentWork` Committed receipt is preserved byte-for-byte and
is neither re-authorized nor re-executed. A late gen0 write after takeover is
rejected by the existing full holder/generation/expiry fence. A pre-commit
crash rolls back the fact and event together; the next current owner detects
the same exact tuple and retries. A post-commit crash leaves the same immutable
fact/event; the next owner observes it and blocks without re-running the
Provider or action. This remains true if the committed Command receipt is
generation 0 and the recovery owner is generation 1 or later.

### Migration and already-present rows

Use one additive, forward-only P41 migration
`0041_submitted_decision_binding_attention` (`PRAGMA user_version=41`) for
`submitted_decision_binding_attention_facts`, the P10 source table
`submitted_decision_binding_attention_rows`, and their identity/FK/index
constraints. The fact is unique by
`(execution_id, logical_step_no, repair_attempt, logical_action_id)`, references
its exact Execution, Step, and Action, and stores only the first typed failure
code. The P10 row is keyed by the immutable P9 `attentionFactId` and is written
only by P10's event consumer/reconciler. P10 rebuild repopulates that row from
the P9 fact snapshot, not only retained journal rows. Migration 0041 is
registered only as the final cumulative suffix after P36/0036, P37/0037,
P38/0038, P39/0039, and P40/0040 have been integrated and qualified in order.
It is not independently implementable, runnable from `user_version=35`,
skippable, or independently releasable. It may target DID v1.42 only after the
unified DID v1.41 P36–P40 landing. It must not rewrite, renumber, checksum-edit,
or replace any migration 0036–0040. The migration
does not update or backfill
Execution, Step, Action, DecisionRequest, Command, Event, Work, or receipt rows.
No migration inference uses Session text. After the qualified 0036→0037→0038→
0039→0040→0041 prefix is applied, the P9 startup recovery pass scans exact
active DecisionEpisode/Step/Action tuples before normal replay, validates them
under the current lease, and records the fact for active mismatches. It also
enumerates already-settled `Failed` DecisionEpisodes whose exact Step remains
`ActionsInProgress` and whose cursor Action is Pending
`select_current_work`. That structural settled-step orphan is a scan trigger
even if its original mismatched field was later repaired; record
`failureCode=SettledExecutionWithPendingDecisionAction` and Attention only.
Where a Workspace or Manifest mismatch still exists, retain its more specific
failure code. This post-migration P9 audit changes no Execution, Step, Action,
DecisionRequest, Command, Event history, Work, or receipt; it never resurrects
the Execution or retries an action. An unprovable Step/Action identity follows
the existing P9 insufficient-evidence Attention/ReconciliationRequired path
and is not guessed into this fact table.

### P10 `02` / `07` — public Attention

Add source literal `SubmittedDecisionBindingFailure`, severity `ActionRequired`,
target `executions.workspace_id`, and `dedupKey = attentionFactId`. Project
exactly one safe fixed summary per fact:

> A Scheduler decision action could not be safely recovered; review is required.

The event consumer verifies the event against the P9 source row and upserts one
P10 source-specific row in the same apply-then-advance transaction. P10's
read-only view consumes that row; its full rebuild repopulates from the durable
P9 fact table, so pruning the wakeup event cannot erase the Attention. The
public row uses the existing Attention response shape and fixed safe
summary/time only; it does not add a wire field for `failureCode`. P9 retains
that code in its internal source fact. The public row never exposes Work
candidates, Manifest IDs, Provider content, raw database values, or parser
text. Existing subtree aggregation bubbles the count once and copies no
context. P10 rebuild and restart reconstruct the same row from the durable P9
source fact even if the source event is below the retained journal floor. P10
writes only its projection and offset. v1 adds no dismiss, repair, or canonical
mutation path.

## Required qualification before implementation authorization

The pending RED is expanded to exercise the public Stop resolution after the
fact-backed block. Keep it excluded from default functional gates until an
implementation is separately authorized and qualified.

| Layer | Required cases and assertions |
|---|---|
| P3 module | Workspace and Manifest mismatch each classify as `RecoveryBlocked` before provider/action/command/observation; exact successful matching binding still follows the current receipt-first path. |
| P2/P3 Stop module | Both orders are deterministic: (a) fact/event commits, then authorized `StopExecution`; (b) Stop commits first, then P2/P3 records fact/event and closes Step/Action atomically. No unresolved P4 side effect is a hard precondition. The P3 close is `TerminalRejected(StopRequestedAfterSubmittedBindingFailure)` for the current Action, `SkippedEarlySettlement` for later Pending rows, and `SettlementProposed(Interrupted(StopRequested))`; no Observation/Applied/Failed/OutcomeUnknown. P2 settles only the persisted proposal through RecoveryController, then releases the active slot. The Attention fact/row survives. |
| P9 store/recovery | Fact+event share a transaction and exact stable identity; same-tuple retry emits one event; conflicting code fails closed; rollback-before-commit yields no partial fact/event; restart-after-commit reads one fact and blocks. Two independent SQLite connections/OS processes recording the same tuple yield one immutable fact and one event; the loser reads the winner. Existing Command receipt and Work rows are unchanged. |
| P10 | Public Attention query returns one `ActionRequired` row for the owning Workspace, safe summary, stable dedup; subtree count is one; restart and projection rebuild retain one row; no canonical writes. |
| P41 migration prefix | Only after P36/0036 through P40/0040 are integrated in one cumulative runner and their required qualifications pass, register 0041 after 0040 and qualify v35→…→v41 plus supported intermediate prefixes. Assert no direct v35→v41 skip, no standalone 0041 release, and byte/checksum identity for each 0036–0040 migration. |
| Upgrade fixture | Against the qualified v40 prefix, apply 0041 with each active mismatch and with a v35-era already-`Failed`/AIP/Pending orphan carried through 0036–0040. Active mismatches become blocked with one fact; the settled orphan receives audit-only `SettledExecutionWithPendingDecisionAction` (or the still-provable specific mismatch code), public Attention only; no canonical row/receipt is repaired or resurrected. An unprovable identity follows the existing P9 insufficient-evidence path. |
| Two-daemon process | For each mismatch, gen0 reaches AH9 with the original Committed SelectCurrentWork receipt. Cover fact-before-Stop, Stop-before-fact, and serialized concurrent ordering. Crash gen0, wait for actual lease expiry, acquire gen1, and kill at both sides of the atomic fact+Step/Action stop-close commit; gen2 must redo the whole transaction or read the proposal. Then kill on both sides of RecoveryController `SettleExecution`; restart converges to `Interrupted(StopRequested)`. Across branches: no new Provider request/ProviderTurn, SelectCurrentWork Command, `CurrentWorkChanged`, Work mutation, or Observation; old receipt is unchanged; one fact/event and public ActionRequired row remain after settlement; late gen0 writes are FencingRejected; no Failed settlement or active-slot leak. |

The matrix reports Workspace/Manifest variants, fact-before-Stop/Stop-before-
fact order, original receipt identity/generation, lease generation/expiry,
pre/post fact+Step commit and RecoveryController settlement states, and public
Attention after Stop. The old-orphan audit and concurrent duplicate writer are
separate qualifications, not inferred from the two-daemon rows. A focused
qualification may use test-local crash gates. Do not run the full functional
suite or start/restart a daemon as part of this proposal review.

## Decision boundary

Accepting this exact proposal would authorize only the named P2/P3/P9/P10
owner amendments, DID §5.3/§7.2/§9.3 registrations targeting DID v1.42 after
the unified v1.41 P36–P40 landing, migration 0041 after the qualified
0036–0040 prefix, the pending RED expansion, and the focused
module/store/projection/two-daemon cases above. It does not authorize 0041
registration, implementation, migration execution, or release before P36–P40
integration and qualification. It would not authorize changes to
`docs/design/**` by the implementation agent, Work lifecycle, Scheduler
selection semantics, Command receipt semantics, new Provider retry rules, or
other AH10 controls. Manual acceptance precedes owner-document landing;
implementation authorization remains a separate decision after the landing
review and prefix qualification.
