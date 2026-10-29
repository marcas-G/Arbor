# RAI-DG-01 — Work-revision readmission hold

**Version:** v2; supersedes the v1 proposal content SHA-256
`B5441C27A4DC6152641808A2CCD710C3F885C13ECFBDEF81B22074F498F6D826`.
**Status:** Fixed governance proposal draft; awaiting independent review and
manual acceptance. No
`docs/design/**` change or production implementation is authorized by this
draft.

**Proposal owner:** Cross-phase contract landing coordinated by the DID owner.
System Design owns the user-visible Work/Attention semantics; DID owns the
invariant and integration boundary; P2/P7 own the persistent admission gate;
P9 owns the source facts; P10 owns active Attention presentation.

**Evidence base:** frozen implementation SHA
`2ea26f0e604d220b11e357c851346b7cec357b71`; real dual-daemon failure
qualification recorded at test-only commit
`b1863a437f2163b8751009b18f5999ca63b9be46` in
`planning/results/P37-v5-layered-qualification.result.md`.

## Decision requested

Adopt a durable, exact-Work-revision readmission hold driven by canonical
Execution settlement and P9 recovery-failure facts. An Attention projection
row is never the authority for the hold. The same hold rule applies to every
Work-bound `Interrupted(RuntimeSafetyStop)` settlement and every P9
recovery-blocking fact or `OutcomeUnknown(ReconciliationRequired(refs))`
settlement bound to that exact Work revision.

An authorized `SteerWork` that advances the Work revision releases the old
revision's hold. The source failure facts remain immutable audit evidence;
P10 omits their Attention rows from the active Attention set once the owning
Work has advanced beyond the source revision. There is no same-revision
Attention dismissal in this proposal. The existing P10 queue ACK only marks
that the projector wrote its marker; it does not resolve the source fact or
release the hold.

## Why a governance change is required

The P37 counterexample starts with a Committed Deliver receipt, Pending Action,
missing Observation and durable `DeliverReplayEscalated` fact with
`PriorReceiptResultMismatch`. The original Work-bound Execution then settles
normally through `ExecutionOrigin` as
`Interrupted(RuntimeSafetyStop)` (`stop_requested_at = NULL`). With no
WorkSteered/HumanMessage and Work still Open at revision 1, the scheduler
admits a new Execution 85 ms later; it has a new LogicalAction/ProviderTurn
and commits a second Deliver receipt.

`AgentActionRecoveryBlocked` itself has no retry ordinal and is not a P9
transient retry. AgentLoop returns `RecoveryBlocked`; ExecutionRuntime releases
the lease and returns without settling that still-Active Execution. Re-entry
can therefore produce another ProviderTurn. Since recovery blocking made no
durable action progress, P2's separate per-Execution D4 consecutive
no-progress counter can eventually stop that Execution as
`Interrupted(RuntimeSafetyStop)`. D1 `retryCount` applies to provider-operation
retries, not RecoveryBlocked re-entry. The Safety Gate is in-process and resets
on daemon restart under P9 `03` §4, so no exact P9 retry count is a durable
readmission rule.

The existing contracts do not decide the cross-Execution transition:

- P2 `05` admits an Open current Work with no active WorkWait.
- P7 `03` freezes `RunnableWorkSource.classify` as the sole runnability
  authority and excludes P9 facts and Attention from its input set.
- P2 / System Design G8 require a safety stop to interrupt the current
  Execution, leave Work Open and emit Attention; they do not say whether a
  new Execution for the same revision is admitted.
- P9's fact prevents unsafe progression of the original Execution and exact
  Action. It does not define admission of a different Execution/LogicalAction
  bound to the same Work revision.
- P10 Attention is a read model and never canonical admission authority.
- EGP binds a Work Episode to `(WorkId, WorkRevision)` but does not define
  re-admission disposition after a safety stop or P9 recovery block.

These scopes permit the demonstrated second attempt while leaving unresolved
whether it is acceptable. The proposal supplies that missing cross-phase
rule; it does not reinterpret an existing rule as if it already prohibited
readmission.

## Alternatives

| Option | Shape | Advantages | Costs / conflicts |
|---|---|---|---|
| A — dedicated Work-revision readmission gate (**recommended**) | P2/P7 exposes one durable, read-only gate derived from source settlement/fact records and exact Work Episode binding. `classify` and authoritative Work admission consult it. | Keeps recovery/safety provenance separate from cognitive waits; exact revision scope; survives restart; no new Work lifecycle state or mutable Attention source. | Adds a frozen runnability predicate, port and query dependencies to P2/P7; requires atomic source snapshot and admission guard; P10 needs stale-source presentation rule. |
| B — reuse/extend WorkWait | Represent RuntimeSafetyStop/P9 recovery Attention as an active WorkWait and clear it through a wake after Steer/resolution. | Reuses durable wake/timer machinery; existing scheduler already treats active waits as non-runnable. | WorkWait is the model/runtime's explicit cognitive wait registration; turns a recovery/safety fact into a synthetic wait, changes P2 wait registration/clear semantics, and risks conflating dependency/progress waits with safety disposition. The WorkWait contract does not define source-fact identity or governed resolution. |

Option A is recommended. Do not use the P10 Attention table or its consumer ACK
as gate state. Do not add a global Deliverable uniqueness/deduplication rule.

## Proposed frozen semantics

### Hold predicate and scope

For a current Work `w` at revision `r`, `held(w, r)` is true when at least one
durable source is attached to a Work Execution Episode whose binding is
exactly `(w, r)`:

1. the Execution has durably settled as
   `Interrupted(ControlledInterruption(RuntimeSafetyStop))`; or
2. P9 has committed one of the recovery-blocking sources in the closed list
   below for that Execution; or
3. the Execution has settled `OutcomeUnknown(ReconciliationRequired(refs))`
   with nonempty `refs`, the durable P4/P9 unresolved-side-effect disposition.

The closed P9 source set is:

| Source | Durable carrier and exact source identity | Included failure values |
|---|---|---|
| Deliver receipt replay proof failure | `deliver_replay_attention_facts` row plus `DeliverReplayEscalated` event; row/event `executionId`, exact `logicalActionId` and `attentionFactId` | `LegacyMessageMissingEvent`, `LegacyEventMissingMessage`, `LegacyMessageBindingMismatch`, `LegacyInboxConflict`, `PriorReceiptDecodeMismatch`, `PriorReceiptResultMismatch`, `RejectedReceiptEffectConflict`, `PriorReceiptEffectConflict` |
| AssignWork committed-receipt target proof failure | `assign_work_binding_attention_facts` row plus `AssignWorkTargetBindingEscalated` event; row/event `executionId`, exact `logicalActionId`, `committedCommandId` and `attentionFactId`; only the direct-child receipt-binding proof owned by P9 `07` | `LegacyUnbound`, `MissingBinding`, `DuplicateBinding`, `MalformedBinding`, `RefMismatch`, `AuthorityMismatch`, `ForeignTarget`, `PlacementMismatch`, `SourceActionMismatch`, `ReceiptMismatch`, `WorkMismatch`, `ProvenanceMismatch`, `EventMismatch`, `CommitLifecycleMismatch` |
| External reality cannot be reconciled | `ReconciliationEscalated` event; `aggregate_ref = executionId`, payload `executionId`, dedup identity `(executionId, invocationRefsFingerprint)` | no failure-code union; every committed event of this type is included |

The settlement source in item 3 is included even where P10 has no separate
Attention row. It is validated as `settlement_kind = OutcomeUnknown` with
`settlement_json = OutcomeUnknown(ReconciliationRequired(invocationRefs))` and
`invocationRefs.length > 0` (P2 SettleExecution validation).

The following are expressly **not independent hold sources**:

- Ephemeral `AgentActionRecoveryBlocked` / `ExecutionDriveOutcome.RecoveryBlocked`
  values have no retry ordinal and may have no committed P9 fact. That path
  leaves the same Execution Active and releases its lease; P2's one-active-main
  rule already prevents a second Work Execution. A later committed source in
  the closed list above, or a RuntimeSafetyStop settlement, starts the durable
  hold. Do not infer a P9 fact from the in-memory outcome.
- `ReconciliationSourceError` leaves the Execution Active and unsettled. It is
  not a durable source fact; the existing Active Main gate prevents new Work
  admission while recovery retries.
- An acknowledged P10 ingestion-queue row is only projector housekeeping. The
  `deliver_replay_attention_facts` row, event and P10 marker remain durable, so
  queue ACK never clears a hold.
- Ordinary `Yielded`, `Completed`, `Failed`, `Interrupted(StopRequested)`,
  `ApprovalRequired` and non-`ReconciliationRequired` settlements are not
  hold sources unless one of the listed P9 facts is also committed.
- P10 Attention rows, their subtree counts and provider/session text are never
  hold sources or fallback identity sources.

A P9 source fact on its own starts the hold even if its Execution has not yet
settled; while it remains Active, the one-active-main gate independently
prevents another admission.

The gate applies only to the Work Episode named by the source Execution. A
child Work failure does not hold its Parent Work, and a Parent Work failure
does not hold a child Work. It does not block a different Work or a later
revision of the same Work. Non-Work Execution Episodes are outside this
readmission rule.

### Decision table

| Current Work / durable state | Scheduler/admission result |
|---|---|
| Work not Open, or ordinary P7 WorkWait/dependency block | Existing P7/P2 disposition unchanged |
| Open Work, no ordinary wait, no exact-revision hold | Existing decision table; eligible to select/admit |
| Open Work, no ordinary wait, exact-revision P9 recovery fact exists | `Noop(WorkReadmissionHeld)`; no new Execution, Provider request, Action or Command |
| Open Work, no ordinary wait, exact-revision RuntimeSafetyStop settlement exists, with or without a P9 fact | `Noop(WorkReadmissionHeld)`; no new Execution, Provider request, Action or Command |
| Open Work, no ordinary wait, exact-revision `OutcomeUnknown(ReconciliationRequired(refs))` settlement exists | `Noop(WorkReadmissionHeld)` even if no separate P9 Attention row exists |
| Held revision `r`; authorized `SteerWork` commits revision `r+1` | Old hold remains durable audit evidence but does not match; new revision may follow the existing P7/P2 decision table |
| Same revision; P10 consumer ingests/ACKs the P9 Attention queue | Still held; projection ACK is not governance resolution |
| Same revision; P9 fact is durable but its P10 queue/projector is behind or rebuilding | Still held from the fact source; Attention freshness cannot weaken admission safety |
| Same revision; no existing explicit source-resolution command | Still held; no implicit dismiss, reset, retry timer or Work cancellation |

Applying the hold does not mutate `Work.status`, `Workspace.currentWorkId`,
Dependency state, Deliverable state or any approval. Work remains Open. A user
or authorized parent must issue a semantic Steer that advances the Work
revision to resume. Merely polling, restarting, acknowledging the projection
queue, or retrying the scheduler cannot clear the hold. A separate
same-revision resolution action would require its own governance decision and
is outside this proposal.

This proposal chooses to hold after an ordinary RuntimeSafetyStop even when no
P9 fact exists. The Safety Envelope is execution-scoped; immediate same-revision
re-admission would otherwise reset the execution's in-process counters and
could defeat the very stop that emitted Attention. Normal `Yielded`,
`Completed`, `Failed`, and `Interrupted(StopRequested)` settlements do not
create this hold unless accompanied by a listed P9 fact.
`OutcomeUnknown(ReconciliationRequired)` is the explicit exception above: it
represents a potentially occurred external effect and is held regardless of
whether a separate `ReconciliationEscalated` event was committed.

### Persistence and port boundary

Use the existing durable source records as the hold ledger; do not introduce
a second mutable authority table. The query is scoped by the full tuple
`(projectId, workspaceId, workId, currentWorkRevision)` and considers only
candidate source Executions whose `executions.project_id` and
`executions.workspace_id` match that same Project and owning Workspace.

- Safety / OutcomeUnknown sources: `executions` settlement plus the matching
  `agent_execution_state.episode_json` Work binding.
- P9 sources: the two fact tables and exact event witnesses enumerated above,
  plus `ReconciliationEscalated` journal events, joined through the source
  `executionId` to `agent_execution_state.episode_json`.
- Work source: current canonical `Work.status` and `Work.revision`.

Add a narrow P2/P7-owned `WorkReadmissionGateStore`/query port to answer
`hasBlockingSource({projectId, workspaceId, workId, workRevision})`
(returning bounded source identity for diagnostics, never raw
receipts/provider payload). Its SQLite
implementation reads the Work, all candidate source rows/events, and Work
binding in one `TransactionScope`. Add an index on P9 fact `execution_id` only
if the query plan requires it; no Attention projection table is read. The
current fact tables already carry execution identities and have
execution/action uniqueness indexes; the Work binding is joined through
`executions.execution_id` to `agent_execution_state.execution_id`. Work
Episode `episode_json` is durable in `agent_execution_state` under EGP; join
only by shared `execution_id` and validate the closed `ExecutionEpisodeBinding`
schema.

The identity and scope validation is exact:

1. Validate the requested Work exists and its canonical `projectId`,
   `workspaceId`, `workId` and `revision` equal the query tuple. A mismatch
   produces typed `ReadmissionTargetMismatch`.
2. For each P9 source or settlement candidate in the requested Project and
   owning Workspace, require exactly one matching `executions` row and exactly
   one `agent_execution_state` row. Verify fact/event `projectId`,
   `executionId`, and where present `targetWorkspaceId` agree with that
   Execution; verify `ReconciliationEscalated.aggregate_ref` and payload
   execution ids both equal it.
3. Decode `episode_json` with the frozen EGP decoder. A valid non-Work Episode
   is outside this Work gate. A Work Episode must resolve to a canonical Work
   in the same project and owning workspace. It matches only when its exact
   `(workId, workRevision)` equals the requested Work tuple. A higher current
   Work revision makes the old source stale; a source revision greater than
   canonical current revision is an integrity failure.
4. Missing, duplicate, malformed, unknown-version or scope-conflicting source
   rows/bindings must not be silently treated as `held=false`, `held=true`, or
   attached to a guessed Work. Return typed `ReadmissionGateIntegrityFailure`
   with `{projectId, workspaceId, workId, requestedWorkRevision,
   executionId, sourceKind, reasonCode}`. `sourceKind` is the closed union
   `RuntimeSafetyStopSettlement | OutcomeUnknownSettlement |
   DeliverReplayFact | AssignWorkBindingFact | ReconciliationEscalationEvent`;
   `reasonCode` is the closed union `ReadmissionTargetMissing`,
   `ReadmissionTargetScopeMismatch`, `ReadmissionTargetRevisionMismatch`,
   `SourceExecutionMissing`, `SourceExecutionNonUnique`,
   `SourceEpisodeStateMissing`, `SourceEpisodeStateNonUnique`,
   `EpisodeMalformed`, `EpisodeVersionUnsupported`, `SourceFactEventMismatch`,
   `SourceEventExecutionMismatch`, `SourceProjectMismatch`,
   `SourceWorkspaceMismatch`, `WorkMissing`, `WorkScopeMismatch`,
   `FutureWorkRevision`, `SettlementMalformed`. Do not return raw
   `episode_json`, receipt JSON, invocation refs or parser/SQLite text.

`RunnableWorkSource.classify` propagates that typed query failure through its
existing `RunnableWorkSourceError`; it does not classify the Work as runnable
or ordinary-waiting. The authoritative Work-bound `AdmitExecution` path
rechecks in its commit transaction. A valid hold returns typed
`WorkReadmissionHeld`; malformed/ambiguous source returns the same typed
`ReadmissionGateIntegrityFailure` and commits no Execution. Project/Workspace
identity is revalidated inside that transaction. Never infer Work identity
from Session text, `currentWorkId`, a Message, fact target alone or a Parent
workspace.

Extend P7 `RunnableWorkSource.classify` so an exact-revision hold excludes the
Work from both `current` and `runnable`. The authoritative Work-bound
`AdmitExecution` path must re-check the same predicate in its commit
transaction and reject with a typed `WorkReadmissionHeld` result if a hold
appeared after classification. This is a Runtime admission result, not a new
Work lifecycle or Domain Event. Keep the existing one-active-main constraint
and `BEGIN IMMEDIATE` transaction discipline.

P10's active Attention set for Work-bound `RuntimeSafetyEnvelope`,
`ReconciliationEscalated`, `AssignWorkTargetBindingFailure` and
`DeliverReplayFailure` sources joins source Execution → exact Work Episode
revision → canonical current Work revision. The P10 read contract carries an
internal `sourceExecutionId` binding for these four sources (not a new wire
field); the loader resolves it through `executions` plus
`agent_execution_state.episode_json`, then verifies the source Work and
current Work belong to the same project/owning workspace. The Attention
materialization/query must retain enough source identity to perform that join:
source event id for journal facts, source fact id for P9 fact tables, and the
existing SafetyStop execution id. It must not infer Work from the Attention
target workspace.

Include a row in Attention detail and subtree bubbling only while
`sourceWorkRevision === canonicalWorkRevision`; when `WorkSteered` advances the
Work, the old-revision row leaves the active set. Keep the immutable P9
fact/event and settlement in the audit timeline. An `OutcomeUnknown` settlement
is a readmission source but does not synthesize a P10 Attention row absent an
existing P10 source fact.

The current-revision filter is evaluated from canonical Work state in the
same read snapshot as the Attention source rows. It is not driven only by
consuming the `WorkSteered` event. Therefore a delayed consumer, projection
rebuild, process restart or WorkSteered/query race cannot make an old-revision
row active after the canonical revision advances. For event/fact-derived rows,
`loadAttentionFacts` resolves the source Execution binding and applies the
filter before derivation. For materialized AssignWork/Deliver rows,
`listProjectedAssignWorkBindingFailures` and
`listDeliverReplayFailures` apply the same source-Execution join and canonical
revision filter in their read transaction; the catch-up consumer also removes
stale active rows. Rebuilds reconstruct only active rows. Active queries filter
against the same-snapshot current Work revision even before catch-up.

Extend `ExecutionSettlementFact`/the Attention read port with the source
Execution's validated episode binding and current Work revision snapshot.
Malformed/absent/unknown-version binding on a source Execution, missing
Work/source row, future source revision, or cross-project/workspace mismatch
returns typed `ProjectionIntegrityFailure` with a closed `reasonCode`:
`SourceExecutionMissing`, `SourceExecutionNonUnique`,
`SourceEpisodeStateMissing`, `SourceEpisodeStateNonUnique`,
`EpisodeMalformed`, `EpisodeVersionUnsupported`, `SourceFactEventMismatch`,
`SourceEventExecutionMismatch`, `SourceProjectMismatch`,
`SourceWorkspaceMismatch`, `SourceTargetMismatch`, `WorkMissing`,
`WorkScopeMismatch`, `FutureWorkRevision`, or `SettlementMalformed`.
The error carries bounded `{projectId, workspaceId, workId?, executionId,
sourceKind, reasonCode}` only. It does not infer a Work, silently drop a
candidate source or bubble a stale row. The P10 projector remains read-only
with respect to canonical state. P9 facts/events/settlements are never
deleted; queue ACK remains ingestion housekeeping, not resolution.

### Restart and concurrency rules

- Gate state is reconstructed from durable execution settlement, P9 fact/event,
  exact Episode binding and current Work revision; no in-process counter,
  timer, provider transcript or Attention row is authoritative.
- A same-Work-revision `OutcomeUnknown(ReconciliationRequired(refs))` is a
  durable hold even with no `ReconciliationEscalated` event. P9 facts and
  unresolved settlements survive P10 queue consumption and rebuild.
- Classification and gate reads use one SQLite snapshot. `AdmitExecution`
  revalidates inside its `BEGIN IMMEDIATE` transaction, so concurrent fact,
  settlement or Steer commits cannot race a held revision into admission.
- On daemon restart, startup recovery first converges existing P9 fact and
  Execution settlement records. Scheduler then sees the same hold and creates
  no new Work Execution for the held revision.
- A crash before the source P9 fact or RuntimeSafetyStop settlement commits
  leaves no corresponding hold; recovery retries/converges according to P9.
  A crash after commit leaves the hold derivable exactly once from the durable
  source. P10 lag or queue ACK position cannot weaken it.
- `SteerWork`/revision advance is itself a canonical transaction. Before it
  commits the old revision remains held; after it commits, only the new
  revision is eligible. Restart on either side preserves that result.

## Proposed owner landing package

This is the fixed landing package if the governor accepts the proposal:

1. **System Design** — state that a Work revision with RuntimeSafetyStop or
   P9 recovery-blocking evidence is open but not automatically runnable;
   exact Work revision is the gate scope; authorized revision-advancing Steer
   releases that revision's hold; no Work cancellation or global Deliverable
   deduplication.
2. **DID** — add the invariant, closed trigger set, Work-bound episode join,
   admission transaction boundary, typed rejection and crash/restart rule.
3. **P2** — add the gate to the scheduler decision table and
   `AdmitExecution` authoritative recheck; define the `WorkReadmissionGateStore`
   port and typed result.
4. **P7** — extend the sole classifier input set with the durable exact-revision
   gate; preserve WorkWait/dependency meanings and normal decision table when
   unheld.
5. **P4/P9** — P4 preserves the existing exact `OutcomeUnknown` invocation
   truth and no-blind-replay rule; P9 freezes the closed recovery source set
   and failure-code lists above, and defines
   non-source RecoveryBlocked/ReconciliationSourceError outcomes as active-
   Execution cases already protected by the one-active-main invariant;
   preserve exact fact identity, immutability and atomic source-fact commit.
6. **P10** — define same-snapshot canonical revision filtering for all four
   Work-bound Attention sources, exact project/workspace/episode validation,
   lag/rebuild/restart behavior and typed projection integrity failure;
   retain source facts/events as audit and state expressly that projection
   state/ACK is not the Runtime gate.
7. **Execution Episode (EGP)** — clarify that WorkId + WorkRevision is also the
   durable scope used to attribute and release a hold; other Episode variants
   are unaffected.

No new migration is part of this package: every gate source, event/fact ID,
Execution identity and EGP Work Episode binding is already durably stored. P10
source identity is recovered through existing source event/fact IDs and the
Execution join; no new Attention DTO field or durable gate table is added. Any
missing episode/fact link discovered while implementing is a follow-up Design
Gap, not permission to add inferred bindings. If this inventory is wrong for a
source already named here, stop and return for governance rather than silently
adding a schema/link migration.

## Required qualification after acceptance

All tests use real SQLite and fresh isolated databases. Process scenarios use
two independent daemon processes and real kill/restart boundaries; no test
uses an in-memory gate or retries the test.

1. **P9 fact before P10 ACK:** commit the exact Deliver replay mismatch fact,
   allow the Attention consumer to write its marker and remove the pending
   queue row, settle the first Execution, and reevaluate. Assert same Work/rev
   remains Open, zero new Execution/LogicalAction/Provider request/Deliver
   receipt, and one P9 fact/Attention marker.
2. **Closed source inventory:** independently exercise all eight
   `DeliverReplayFailureCode` values, all fourteen
   `AssignWorkBindingFailureCode` values, `ReconciliationEscalated`, and
   `OutcomeUnknown(ReconciliationRequired)`. Assert exact Work/revision hold.
   Also assert each excluded ephemeral/ordinary outcome creates no independent
   hold while an Active Main Execution still prevents new admission.
3. **RuntimeSafetyStop without P9 fact:** settle an otherwise ordinary Work
   Execution with `Interrupted(RuntimeSafetyStop)`. Assert same-revision hold
   and no admission; this fixes the proposal's explicit normal-stop decision.
4. **Restart persistence:** after the fact and settlement commit, kill both
   daemons before next scheduler admission, restart against the same SQLite
   file, and assert one held Work revision and no second Deliver/provider
   request.
5. **Crash before/after hold sources:** kill before and after each P9 fact/event
   transaction and before/after SafetyStop settlement. Before-commit recovery
   may finish the source transaction; after-commit recovery reads the same
   source; every settled result must leave the derived gate consistent.
6. **Typed binding failure and scope:** inject missing/duplicate/malformed
   `agent_execution_state`, malformed/unknown-version `episode_json`, missing
   source Execution, and project/workspace/Work/revision mismatch. Assert typed
   query/admission failure, zero new Execution/provider/action/Command,
   bounded identifiers only, and no inferred Work. Include Parent/Child,
   sibling Work and cross-project negative cases.
7. **Steer clears exact revision:** while rev1 is held, commit an authorized
   `SteerWork` rev1→rev2. Assert active P10 Attention for the old revision is
   removed from the active set, P9 audit facts remain, and rev2 can be admitted
   by ordinary rules. Repeat with kill/restart immediately before and after
   Steer commit.
8. **P10 WorkSteered lag/rebuild/restart:** leave the Attention consumer offset
   before WorkSteered, advance canonical Work rev1→rev2, and query before
   catch-up; assert no rev1 active row/bubbling. Repeat during rebuild/reset
   and after process restart; retained source facts/events remain auditable and
   rebuild never revives the row.
9. **Work and Parent/Child scope:** a child Work hold blocks only that exact
   child Work revision. It does not block a Parent's distinct Work, another
   sibling Work or a different revision. A Parent-originated fact has the
   symmetric exact scope.
10. **No global dedup / lifecycle mutation:** allow a later revision or another
   Work to produce/deliver the same Deliverable; assert existing command,
   delivery and dependency semantics still apply. Assert no CancelWork,
   Work status mutation, current Work pointer mutation, or duplicate suppression
   was introduced by the gate.
11. **Existing regressions:** P2 scheduler/admission, P7 runnability/wake,
   P9 recovery fact/replay and P10 Attention projection/rebuild/restart suites
   pass; P37 L6 original P9 recovery assertions remain intact.

## Acceptance decision

This proposal requests acceptance of the fixed package above. It is not an
accepted governance decision. Do not modify `docs/design/**` or implement the
gate until the manual governor records an explicit decision against this exact
proposal revision/hash.
