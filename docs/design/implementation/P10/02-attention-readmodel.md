# P10 — 02 Attention Read-Model (GQ3)

**Authority:** DID v1.13 G3/G8; SD v1.3 §12.3 (three severities, bubbling), §14 No.42/55; DID §6.2 L6 rows; P7 `05` (DeadlockAttentionRequested), P9 `01`/`04` (ReconciliationEscalated); `planning/gaps/P7-GAP-01.md`.
**Status:** DRAFT for unrelated baseline clauses; Native OS Sandbox addenda accepted under parent token `ACCEPT_NATIVE_OS_SANDBOX_CONVERGENCE_V1` and V5 token `ACCEPT_NATIVE_OS_SANDBOX_PROVIDER_UNAVAILABLE_FACT_STORAGE_V5`.

**Accepted AH10 DeliverReplayFailure amendment (DID v1.37):** the specific P9
fact source, ActionRequired target, `attentionFactId` deduplication and
rebuildable read-model row below are accepted under proposal SHA-256
`75EAF29FC8FC90C5E098DA3758EFAD8C69074F478C82F2399619F522AE596565`.
Existing Attention sources and transport/repair boundaries are unchanged.

**Accepted storage correction (DID v1.38):** Deliver uses the separate P10
`deliver_replay_attention_rows` marker relation FK-bound to the immutable P9
fact. The AssignWork-specific projection table, its source/failure/FK contract
and existing rows are unchanged. This storage correction is accepted under
SHA-256 `040789D32BE1D92F1BAD28C5E3346439C1E902236452E778CD104AF6AA71EC8B`;
runtime implementation remains separately gated, and migration 0037 depends
on P36 integration.

**Accepted S3 AnyProducer settled-wait amendment (DID v1.59):** P10 APW-3
derives a read-only Attention row for legacy AnyProducer waits under the exact
idle/no-producer predicate below. It reuses the existing `WaitingOnVacantProducer`
view label, target, and dedup family. No schema, marker, event, public source
literal, or dismiss/repair action is added. Accepted under package SHA-256
`5b558d26b4140631f5c7a14bb743b1e42a9d8992d50feee1a3d2c3c98353b7c8` and
token `ACCEPT_S3_ANY_PRODUCER_WAIT_ELIGIBILITY_V1`; the acceptance authorizes
design landing only, not implementation.

## 1. Fact sources → severity → target (frozen mapping)

| Source | Fact carrier | Severity (SD §12.3) | Target |
|---|---|---|---|
| Dependency Unfulfillable | DependencyMarkedUnfulfillable event | Attention | consumer workspace |
| Deadlock | DeadlockAttentionRequested event | Attention — emitted only under the No.42 project-idle gate (P7 `05` §2), so by frozen semantics every emitted deadlock fact is already Action Required; the read-model renders it as such (no conditional branch exists) | each cycle-member workspace |
| Runtime Safety Envelope | safety-stop record / Interrupted(RuntimeSafetyStop) settlement fact | Attention | execution workspace |
| Recovery escalation | ReconciliationEscalated event | Action Required (unreconcilable side effect — SD §12.3 explicit) | execution workspace |
| AssignWork binding failure | `AssignWorkTargetBindingEscalated` + P9 `assign_work_binding_attention_facts` row | Action Required | affected Execution's owning/Parent Workspace (`executions.workspace_id`) |
| Deliver replay failure | P10 `deliver_replay_attention_rows` marker joined to P9 `deliver_replay_attention_facts`; P9 emits `DeliverReplayEscalated` | Action Required | Deliver Execution Workspace (`targetWorkspaceId=executions.workspace_id`) |
| Tool Observation replay-evidence failure | P10 `tool_observation_replay_attention_rows` marker joined to P9 `tool_observation_replay_attention_facts`; P9 emits `ToolObservationReplayEvidenceEscalated` | Action Required | exact Execution Workspace (`targetWorkspaceId=executions.workspace_id`) |
| Workspace resource activation pending | P1 `WorkspaceResourceActivationIntent(Pending)` + `WorkspaceResourceActivationChanged` v1 | Action Required | the exact root Workspace in the intent |
| Verifier orphan | Open verification × settled executions (derived condition, P8 `02` §3) | Attention | owner workspace |
| WorkEpisodeBlocked | current Open `work_blockers` row at exact Open Work revision, with no bound active WorkEpisode | ActionRequired; Attention while a bound WorkEpisode is active | Work's owning Workspace; blockerId dedup |
| Legacy adoption evidence insufficient | `legacy_adoption_attention_rows` marker joined to P9 `legacy_adoption_attention_facts`; P9 emits `LegacyAdoptionEvidenceEscalated` | ActionRequired | exact `executions.workspace_id` captured by the failure fact; internal binding retains `executionId` |

The existing `VerifierOrphan` row remains derived and read-only. Its explicit
`RetryVerification` affordance is a P8 `/commands` action shown only when the
authenticated session resolves the exact Root-local human or direct Parent
Workspace human authority. It is not an Attention dismissal/repair command.
The canonical retry makes the old Open predicate false; a projection may show
the row until the existing P10 freshness barrier catches up. Only after that
barrier may the UI confirm the old row is absent, and the immutable
`Unknown(Orphaned)` conclusion remains inspectable.
| Vacant producer (P7-GAP-01) | derived: dependencies(Unsatisfied ∧ WorkspaceBound) × works(无 Open Work ∧ ¬Retired) | Attention | consumer workspace (view label `WaitingOnVacantProducer`) |
| Settled AnyProducer wait (APW-3) | derived canonical-state predicate: current-revision `DependencyChanged` WorkWait on an Unsatisfied AnyProducer Dependency; Open consumer Work with no active WorkEpisode; project idle; no Pending formation decision or Approved-but-unapplied producer; and no APW-3 producer evidence | Attention | consumer workspace (same existing `WaitingOnVacantProducer` label) |

### Accepted APW-3 — settled AnyProducer wait (2026-10-24)

This is a live, read-only derivation; it does not add a P7 wait-for edge or
deadlock. In one canonical read snapshot, emit the existing Attention row only
when all of these hold:

1. The Dependency is `Unsatisfied`, its binding is `AnyProducer`, and the
   consumer Work has an active `DependencyChanged` WorkWait for that exact
   Dependency whose `observedRevision` equals the current Dependency revision.
   Revision-mismatched/stale waits are suppressed.
2. The consumer Work is `Open` and has no active WorkEpisode Execution.
3. The legacy producer-evidence predicate is empty. It includes the APW-1
   evidence categories for another same-Project Open Work or an exact
   Approved-but-materializing FormationFulfillment, plus any matching
   persisted Deliverable whose deterministic P7 satisfaction CommandId has
   neither a `Committed` nor `TerminalRejected` exact receipt. A matching
   Deliverable with a missing or retryable/nonterminal receipt may still
   converge and suppress this row. A Committed receipt is terminal; a
   TerminalRejected receipt is not a convergence candidate and is not retried
   by this amendment.
4. No Project Execution is active, there is no current Pending
   FormationProposal, and there is no Approved-but-unapplied producer
   fulfillment. These facts mean the Project is idle with no authorized
   producer transition; a Pending proposal is not producer evidence and its
   existing Governance Inbox decision remains the action surface.

The row uses source/view label `WaitingOnVacantProducer`, severity `Attention`,
target = consumer Workspace, and existing dedup key
`vacant-producer:<dependencyId>`. Its fixed summary is non-content-bearing and
must not name a producer Workspace that does not exist. No Work objective,
Message/Inbox text, Provider output, or other untrusted text is consulted.

The row is not authority: it does not mutate the Dependency, clear the
WorkWait, mark the Dependency `Unfulfillable`, satisfy/wake the consumer, or
gate readmission. A brief row between a valid current-revision wait and the
existing P7/P2 wake consumer clearing it is permitted; the row disappears when
the wait clears, the Dependency becomes terminal, producer evidence appears,
or the Project ceases to satisfy the idle predicate. Existing WorkspaceBound
P7-GAP-01 semantics and P7 coordinator/wake semantics are unchanged.

### RAI-DG-01 Work-revision freshness for active Attention

For Work-bound source rows only, Runtime Safety Envelope,
`ReconciliationEscalated`, AssignWork binding failure, Deliver replay failure
and `LegacyAdoptionEvidenceInsufficient` are active when and only when the
source Execution's validated EGP Work Episode `(workId, workRevision)` equals
the canonical Work's current `(workId, revision)` in the same read snapshot.
The internal read contract
carries `sourceExecutionId`; this is not a wire/DTO field. Resolve it through
`executions` and `agent_execution_state.episode_json`, then validate exact
Project, owning Workspace and Work identity. Do not infer Work identity from
the Attention target Workspace.

Source materialization retains its existing source identity: journal event id
for event-derived facts, P9 fact id for fact-table sources, and the SafetyStop
Execution id. `loadAttentionFacts` applies the Work revision filter before
deriving event/fact rows. `listProjectedAssignWorkBindingFailures` and
`listDeliverReplayFailures` apply the same source-Execution join and canonical
revision filter in their read transaction; catch-up removes stale active rows.
Detail queries and subtree bubbling omit stale rows immediately after the
canonical revision advances, even if WorkSteered ingestion lags. Rebuilds
reconstruct active rows only; active queries continue to filter against the
same-snapshot Work revision before catch-up. Immutable settlement/fact/event
sources remain in the audit timeline.

Malformed or absent/unknown-version episode binding on a source Execution,
missing/duplicate source rows or Execution, fact/event mismatch, future source
revision, or cross-project/workspace mismatch returns typed
`ProjectionIntegrityFailure` with only bounded identity fields. Its source and
reason fields are closed:

```ts
type ProjectionIntegrityFailure = {
  readonly _tag: "ProjectionIntegrityFailure";
  readonly projectId: ProjectId;
  readonly workspaceId: WorkspaceId;
  readonly workId?: WorkId;
  readonly executionId: ExecutionId;
  readonly sourceKind: "RuntimeSafetyEnvelope" | "ReconciliationEscalated"
    | "AssignWorkTargetBindingFailure" | "DeliverReplayFailure";
  readonly reasonCode: "SourceExecutionMissing" | "SourceExecutionNonUnique"
    | "SourceEpisodeStateMissing" | "SourceEpisodeStateNonUnique"
    | "EpisodeMalformed" | "EpisodeVersionUnsupported"
    | "SourceFactEventMismatch" | "SourceEventExecutionMismatch"
    | "SourceProjectMismatch" | "SourceWorkspaceMismatch"
    | "SourceTargetMismatch" | "WorkMissing" | "WorkScopeMismatch"
    | "FutureWorkRevision" | "SettlementMalformed";
};
```

No parser, SQLite, receipt or provider text is returned; no candidate is
guessed or silently dropped. The P10 projector remains read-only with respect
to canonical state. This gate is limited to validated Work Episodes; the
P41 Submitted DecisionEpisode binding source retains its separate exact-fact
projection contract.

`OutcomeUnknown(ReconciliationRequired(nonempty refs))` is a P2/P7
readmission source even without a P10 row. It does not synthesize Attention
unless an existing P10 source fact exists. Attention rows, subtree counts,
queue position and consumer ACK never create or release a Runtime hold.

### RAI-DG-02 query-derived terminal Provider presentation

P10 calls the P2-owned exact terminal-chain proof query inside the same read
transaction/freshness barrier and adds no event, outbox, queue, marker, offset
or table. `TerminalProviderFailure` is `ActionRequired`, targets the exact
owning Workspace, exposes only the closed terminal code, exact Work revision,
validated final-Attempt `settledAt`, exact fixed summary
“The model provider rejected this Work execution. Review the provider
configuration or request compatibility, then explicitly steer the Work to
retry.” and dedup
`terminal-provider-failure:<workId>:<revision>:<failureFingerprint>`.
Equivalent historical Executions select the earliest validated witness by
`(execution.admittedAt, executionId, logicalStepNo, repairAttempt,
providerTurnId, attemptNo)` while all remain audit evidence.

`TerminalProviderFailureIntegrity` exposes only the closed
`ReadmissionGateIntegrityFailure` code and bounded identities. If the
Execution's Project/Workspace/Work/revision is uniquely provable it targets
that Workspace; if only the Execution Project is uniquely provable it targets
the Project root; otherwise the view fails with bounded
`ProjectionIntegrityFailure` and guesses nothing. Its fixed summary is
“Arbor cannot safely verify a terminal provider-failure recovery record.
Execution remains blocked; inspect the bounded integrity code before
retrying.” Its dedup key is
`terminal-provider-failure-integrity:<executionId>:<logicalStepNo>:<repairAttempt>:<failureCode>`.
Missing or invalid Attempt time is integrity failure, never query time; because
the frozen row requires `occurredAt`, `FailureOccurrenceTimeInvalid` returns
bounded `ProjectionIntegrityFailure` and no guessed row.

Both rows are active only while canonical Work is Open at the exact revision.
Steer revision advance or authorized Work terminalization makes retry-oriented
presentation inactive without deleting source evidence. P10 ACK, restart,
polling and rebuild have no effect on the P2/P7 admission hold. Work Detail
uses the same proof and offers only the existing exact-revision Steer action;
there is no blind retry control.

### Accepted AH7-DG-02 ReconciliationEscalated projection (DID v1.40)

The existing P9 `ReconciliationEscalated{executionId,
invocationRefsFingerprint,refs}` remains the sole source event. P10 projects it
as `source=ReconciliationEscalated`, `severity=ActionRequired`,
`targetWorkspaceId=executions.workspace_id`, and
`dedupKey=reconciliation-escalated:<executionId>:<invocationRefsFingerprint>`.
The fixed path-free summary is “An external tool effect could not be verified;
recovery is paused.” The event contains no command, argument, resource path,
authority snapshot or raw proof. Repeated source identity produces one row;
P10 does not inspect an empty external-source lookup or establish reality.

The consumer applies this projection and advances its existing project/event
offset atomically. Full rebuild replays the existing P9 event only while it is
retained; this amendment adds no P9 fact-store or marker relation and promises
no durable Attention beyond the P1 journal-retention horizon. Source/fact
creation is owned by P9/P4; P10 writes only its read model and offset.

- Normal is the absence of facts (default state, not a row).
- Human-required approval maps to Action Required when a governance gate awaits human decision (formation approval pending — P6 `01` §4).

## 2. Bubbling (subtree aggregation)

- A workspace's subtree-attention summary = aggregated counts by severity over descendants; **context is never copied upward** (SD §12.3). The Tree view renders the summary; drilling in resolves detail.
- Dedup on read: keyed by the fact source's frozen dedup identity (ReconciliationEscalated: executionId+invocationRefsFingerprint; Deadlock: cycle fingerprint; derived views: their natural join key). Bubbling aggregates deduplicated facts, not raw events.
- AssignWork binding failure deduplication uses P9's immutable
  `attentionFactId`, derived from `(executionId, logicalActionId,
  committedCommandId)`. The row targets the Execution's owning Parent
  Workspace; existing subtree-summary aggregation counts it once and copies
  no context upward. Detail uses the fixed summary “A committed AssignWork
  could not be proven to match its exact target; recovery is paused.” plus the
  typed `failure_code`; opaque refs and raw authority material are not
  projected. The view does not repair or mutate canonical state, and v1 adds
  no dismiss or repair action. The source semantics are owned by SD §4.11;
  P9 owns the source fact/event.

For this projection, the DTO uses `source =
AssignWorkTargetBindingFailure`, `targetWorkspaceId = executions.workspace_id`,
and `dedupKey = attentionFactId`. The existing apply-then-advance consumer
loads the P9-owned fact and projects the Attention row in one transaction;
P10 writes only its read-model row and consumer offset, never the source fact.

The AH10 Deliver projection uses `source=DeliverReplayFailure`,
`severity=ActionRequired`, `targetWorkspaceId=fact.targetWorkspaceId`, and
`dedupKey=attentionFactId`. Its fixed summary is “A Deliver handover could
not be reconciled with its exact Message and MessageSent facts; execution
recovery is paused.” The typed `failureCode` is included; MessageId, bodyRef,
summary, raw receipt JSON, parser/database errors and authority material are
not projected. Subtree aggregation deduplicates on `attentionFactId` and
never copies context upward. v1 has no dismiss, repair, or automatic-clear
command for this source.

The P10 DTO query unions this source with the existing AssignWork-specific
source, F21 activation source and derived sources before project/workspace
filtering, severity counts and subtree aggregation. Its Deliver branch is:

```sql
SELECT
  'DeliverReplayFailure' AS source,
  'ActionRequired' AS severity,
  fact.target_workspace_id AS target_workspace_id,
  fact.attention_fact_id AS dedup_key,
  fact.failure_code AS failure_code,
  fact.first_detected_at AS occurred_at
FROM deliver_replay_attention_rows AS projected
JOIN deliver_replay_attention_facts AS fact
  ON fact.attention_fact_id = projected.attention_fact_id
WHERE fact.project_id = ?;
```

The marker's primary key is `attentionFactId`, so one P9 fact yields at most
one Deliver row; the foreign key forbids a marker without its source fact.
Target, failure code and time are read from the P9 fact and are not copied
into the P10 marker. The event consumer inserts the marker and advances its
own project/event offset in one transaction. P10 writes only its projection
and offset; it never mutates the P9 fact, canonical Message, Command receipt,
Execution or Action. An authorized full rebuild seeds markers from the P9 fact
snapshot and rewinds the P1 Attention offset atomically as specified in `04`;
retained-event replay is idempotent. Restart/replay preserves one Attention
row for the immutable `attentionFactId`.

### FT-DG-01 OPEN-3 Workspace resource activation

The source is the P1 intent row, not the Profile catalog or an inferred
non-empty-boundary/no-claim predicate. P10's source-specific
`reconcileProjectActivationAttention(projectId)` reads the current P1
`listAll` snapshot and replaces only this source's rows in one transaction:
upsert one row for each `Pending` intent and remove rows for `Active` or absent
intents. The P1 status event and P12 post-commit/startup hooks are wakeups for
this reconciliation; neither supplies row state. For `Pending`, P10 upserts
exactly one row with
`source=WorkspaceResourceActivationPending`, `severity=ActionRequired`,
`targetWorkspaceId=workspaceId`, and
`dedupKey=(projectId,workspaceId,resourceBoundaryRevision)`. Its fixed summary
is “Project resource activation is pending; file actions are unavailable.”
and its timestamp is the intent's `createdAt`. No path, Profile ref/version,
failure text, or OS error is returned. The same key is deleted only when that
same intent is `Active`; a changed Workspace boundary revision does not clear
an older pending intent.

`WorkspaceResourceActivationChanged(Pending|Active)` is applied by P10 in the
generic `(projectId, sequence)` apply-then-advance transaction only as a
reconciliation trigger. The handler re-reads current intent state and never
upserts/deletes from the event's status payload; delayed Pending cannot revive
an Active row. P12 invokes the same reconciler after the post-commit activation
attempt and at startup for all projects with intents, so this source remains
current even if the generic Attention consumer returns
`ConsumerRebuildRefused` because its offset is below the journal floor. That
reconciliation never reads, resets, or advances the shared P1 offset. P10 only
changes its own Attention projection, never the P1 intent, Workspace, claims,
or receipt. Normal event-derived Attention sources retain the existing
freshness watermark/barrier behavior.

## Accepted F18 verification reconciliation Attention (DID v1.58)

Accepted under `ACCEPT_F18_VERIFICATION_V2_CONSUMER_AND_READMODEL_CONVERGENCE_OPTION_A`,
proposal SHA-256
`C6C41E96C5A59B46810DB9FA7A998DDBC5887B93D75ADF3606E0CA25E351EC73`.
P10 joins `verification_signal_reconciliation_attention_rows` to the immutable
P9 fact and exposes one row with source
`F18VerificationSignalReconciliation`, exact Root Workspace target,
`ActionRequired`, `attentionFactId` dedup key, closed `failureCode`, and
`firstDetectedAt` occurrence time. Every code uses the fixed public summary:
“A verified result delivery could not be reconciled; recovery is paused.”
Internal diagnostic summary is limited to source kind, ProjectId, event
sequence and failure code; no payload, criterion/user text, paths, receipt
bytes or secrets are exposed. Subtree bubbling counts one row and copies no
context. The row never auto-clears and has no repair or model-wake authority.

The P9 retained queue is scanned each bounded poll and startup cycle
independently of journal offsets. A worker claims Pending or expired work by
lease/generation CAS, validates the exact fact/reconciliation/root binding,
then atomically inserts or validates the marker and marks the queue Projected
under that generation. Rebuild enumerates immutable facts and atomically
recreates/validates markers and converges matching queue rows. Marker/fact
conflict is persistence corruption and produces no public row.

## 3. Read-model contract

- Pure function of canonical state + journal; materialized incrementally via the generic consumer (P1 `05`); rebuildable (`04`).
- **Never performs canonical mutation** (GQ3/G8): disposition of any attention row is a human/parent governance command (S3 step 12: Withdraw / MarkUnfulfillable / steer / stop).
- GAP-01 closure: the vacant-producer view is implemented here and may not be silently descoped (gap file's non-blocking declaration).

## 4. Must Not Decide

- No new attention severities beyond SD's three; no automatic escalation actions; no notification transport (P12).

## Accepted AH7-DG-01 / P39-P40 replay-evidence source (DID v1.41)

Accepted hashes: DG01 logical `19EFED54E037D3E2EC6F4D273D917F5249195650E5E41B3DCFF8DEB9784F29CD`;
P40 physical `5B61E0FF922A10D225FD5DAEA00176BD16C5C0B39484D626B7FEF6340516373A`;
RNO compatibility addendum `8B8E5D3C5729CF5619605DA8D8DF34BA00E1F817E80A743555029F331690E830`;
matrix `AD9AB72D0AA51AB84F4194EC2BF4BB90EC957BD062788C480BCBDD39B8E8DD35`.

The P9 source is `ToolObservationReplayEvidenceEscalated(v1)`;
P10 projects it as `source=ToolObservationReplayEvidenceFailure`,
`severity=ActionRequired`, `targetWorkspaceId=executions.workspace_id`, and
`dedupKey=attentionFactId`. The fixed path-free summary is:
“A terminal tool outcome could not be replayed from durable observation
evidence; recovery is paused.” The closed P9 failure code is stored only in the
internal projection row and is not added to the public Attention DTO. No raw
tool output, Observation, Artifact, cause, path, parser/OS text or secret is
projected. This is separate from `ReconciliationEscalated`: valid P39 RNO is
not an Attention source; only missing/conflicting P40 evidence escalates.

P10 owns this dedicated marker table, not a widening of the AssignWork-specific
FK/table:

```sql
CREATE TABLE tool_observation_replay_attention_rows (
  project_id          TEXT NOT NULL,
  dedup_key           TEXT NOT NULL,
  source              TEXT NOT NULL DEFAULT 'ToolObservationReplayEvidenceFailure'
                      CHECK (source = 'ToolObservationReplayEvidenceFailure'),
  severity            TEXT NOT NULL DEFAULT 'ActionRequired'
                      CHECK (severity = 'ActionRequired'),
  target_workspace_id TEXT NOT NULL,
  summary             TEXT NOT NULL DEFAULT 'A terminal tool outcome could not be replayed from durable observation evidence; recovery is paused.'
                      CHECK (summary = 'A terminal tool outcome could not be replayed from durable observation evidence; recovery is paused.'),
  failure_code        TEXT NOT NULL CHECK (failure_code IN (
    'Missing','UnsupportedVersion','Malformed','HashMismatch',
    'SettlementMismatch','IntentMismatch','ResultRefMismatch','UnexpectedResultRef'
  )),
  occurred_at         TEXT NOT NULL,
  source_event_id     TEXT NOT NULL UNIQUE REFERENCES domain_events(event_id),
  source_fact_id      TEXT NOT NULL,
  PRIMARY KEY (project_id, dedup_key),
  CHECK (dedup_key = source_fact_id),
  FOREIGN KEY (source_fact_id, project_id, target_workspace_id, source_event_id)
    REFERENCES tool_observation_replay_attention_facts
      (attention_fact_id, project_id, target_workspace_id, event_id),
  FOREIGN KEY (target_workspace_id, project_id)
    REFERENCES workspaces(workspace_id, project_id)
);
CREATE INDEX tool_observation_replay_row_target
  ON tool_observation_replay_attention_rows
    (project_id, target_workspace_id, occurred_at);
```

The query unions the marker into the existing Attention result before severity
counting/bubbling, with no additional wire field:

```sql
SELECT
  projected.source AS source,
  projected.severity AS severity,
  projected.target_workspace_id AS target_workspace_id,
  projected.dedup_key AS dedup_key,
  projected.summary AS summary_ref,
  projected.occurred_at AS occurred_at
FROM tool_observation_replay_attention_rows AS projected
WHERE projected.project_id = ?;
```

`failure_code` is deliberately omitted from the DTO projection.

The query unions this source with existing Attention sources without adding a
DTO detail field; it maps fixed source/severity/summary, owning Workspace,
`attentionFactId` dedup and occurrence time. Subtree counts derive from
deduplicated rows. P9 immutable fact/event and P10 row plus the existing
per-project `P10_ATTENTION_CONSUMER_ID` advance in one transaction. Duplicate
event/fact is one row; conflicting identity is projection corruption. Full P10
rebuild clears this marker with other Attention source rows and rewinds the
same shared offset to `floor-1` in the accepted atomic reset; replay is
event-backed only within P1's retained horizon. Do not seed P40 rows directly
from the P9 fact snapshot after the event is pruned, and do not alter
`ConsumerRebuildRefused` below the retained floor. No dismissal/repair action,
canonical mutation or notification transport is added.

## Accepted AH10 Submitted DecisionEpisode binding Attention (DID v1.42)

Accepted fixed proposal SHA-256:
`10D5A2532810B65DFBD3E397B141F6C0765AD32F4992BDDD0FE17F468975339A`;
acceptance/landing audit:
`planning/results/AH10-submitted-decision-binding-P41-governance-acceptance-and-landing.md`.

Add one source to the closed mapping:

| Source | Fact carrier | Severity | Target |
|---|---|---|---|
| Submitted DecisionEpisode binding failure | P10 `submitted_decision_binding_attention_rows` marker joined to the P9 `submitted_decision_binding_attention_facts`; P9 emits `SubmittedDecisionBindingEscalated(v1)` | Action Required | exact Execution Workspace (`executions.workspace_id`) |

The public row is exactly source `SubmittedDecisionBindingFailure`, severity
`ActionRequired`, target `executions.workspace_id`, and dedup key
`attentionFactId`. Its fixed safe summary is “A Scheduler decision action
could not be safely recovered; review is required.” Use the P9
`first_detected_at` as occurrence time. The public DTO exposes no failure code,
Work candidates, Manifest ids, provider text, corrupt value or parser/database
detail. Subtree aggregation counts the immutable fact once. P10 adds no
dismissal, repair or canonical mutation.

P10 owns the marker table, FK-bound to the P9 fact and owning Workspace but not
to the prunable `domain_events` row. Event application validates the exact P9
fact/event pair and atomically upserts one marker with the existing P1
per-project Attention offset. Exact duplicate delivery is an idempotent
no-op; conflicting fact/event binding is projection corruption. The P9 event
id on the fact is audit-only, so pruning does not remove the durable rebuild
source. P10 `04` owns the full-rebuild contract; this row participates in the
same reset/snapshot/seed/offset transaction without changing F21 refusal
semantics or P1 retention ownership.

## Accepted AH10 DeliverReplay outbox amendment (DID v1.43)

Accepted fixed package: v5 base SHA-256
`5AAA2CD1FC00DFA729730E36FF13BAD7038496985D57500FD841B210E76F8B2F` plus
v6 addendum SHA-256
`8E6F47EF5933B6241B5E02E43821B6B816F705A9840AAA62FDFD318283004AF4`;
decision and review audit:
`planning/results/AH10-deliver-event-pruning-v6-governance-acceptance-and-landing.md`.

The P10 Deliver read-model source/query, public DTO, severity, target,
deduplication and fixed summary remain unchanged. The source-specific marker
is still keyed/FK-bound to the immutable P9 fact; the P9 `event_id` is only an
audit identity and is not FK-bound to prunable `domain_events`.

P9 atomically places each new Deliver fact in a durable pending queue. P10
consumes no more than the configured queue batch (64 is the default queue
batch only; P1 event batch is independent). In the same poll transaction P10
inserts or verifies the exact marker before ACKing that queue row. Marker,
queue ACK, ordinary event projections/dead letters allowed by P1, lease/schedule
success state and current P1 offset commit together. Queue-list reads are
ordered by queue sequence, but event projection can ACK a newer fact before a
pending-list consumer reaches an older one; FIFO ACK order is not promised
across those paths. Exact duplicate marker/event/outbox delivery is
idempotent; no marker can exist without its exact P9 fact.

Deliver event classification follows P1 `05`: use the raw stored EventId to
look up P9 before type/version/payload decoding. P9 fact found plus malformed
or mismatched event, or exact DeliverReplayEscalated type with no P9 fact,
is a typed source-integrity failure, not ordinary poison. It rolls back all
poll projections, marker/queue ACK and offset writes; it is not dead-lettered
and does not advance the offset. Ordinary non-Deliver poison and pure
event-local projection defects keep the existing P1 behavior. Full rebuild's
fact-first marker seed and pending-queue acknowledgements are owned by `04`.

### Accepted P41 / 0041 Submitted DecisionEpisode binding marker

Migration 0041 adds one P10 rebuildable marker per project/fact. Its complete
physical relation is:

```sql
CREATE TABLE submitted_decision_binding_attention_rows (
  project_id TEXT NOT NULL,
  attention_fact_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  PRIMARY KEY (project_id, attention_fact_id),
  FOREIGN KEY (attention_fact_id, project_id, workspace_id)
    REFERENCES submitted_decision_binding_attention_facts
      (attention_fact_id, project_id, workspace_id)
);
```

The composite FK binds the marker to the exact immutable P9 fact and its
Workspace; the fact's composite Execution FK establishes that Workspace
against the authoritative Execution. P10 validates the target during event
application. The marker stores no copied failure code, timestamp, event ID or
summary; the safe public row is derived from the fact. Project reset may
delete this marker, never its P9 source fact. P10's exact event application
validates the event against its exact fact and authoritative Execution
Workspace, then inserts the idempotent marker and advances the existing
per-project Attention offset in one transaction. Conflicting bindings are
projection corruption. Its full-rebuild transaction is specified in `04`.

## Accepted Native OS Sandbox unavailable Attention

Add one P9-fact-backed source to the existing Attention mapping:

| Source | Fact carrier | Severity | Target |
|---|---|---|---|
| Sandbox provider unavailable | immutable P9 `SandboxProviderUnavailableFactV1`; `SandboxProviderUnavailable(v1)` is a wakeup | ActionRequired | exact Execution Workspace (`executions.workspace_id`) |

The closed public `AttentionSource` literal is `SandboxProviderUnavailable`.
The existing Attention DTO is unchanged: source `SandboxProviderUnavailable`,
severity `ActionRequired`, target from the canonical Execution relation,
dedup key `attentionFactId`, and fixed safe summary “Required sandbox
capabilities are unavailable; execution did not start.” No provider output,
failure detail, host path, environment value or destination is exposed.

The durable P9 fact is the only source of truth; P10 adds a retained admission
queue and disposable source-specific Attention marker via migration 0050.
Duplicate wake delivery does not duplicate queue/Attention state, and event
pruning cannot erase source facts or admission work. Startup/periodic queue
scan recovers missed wakeups. Only facts current under the accepted exact
Execution/Episode/policyRevision freshness predicate contribute an Attention
row; a higher policy revision supersedes the old live projection without
deleting its immutable P9 fact. No dismissal action, repair command, new
ViewId or canonical mutation is added. The row participates once in the
existing subtree Attention counts.

The retained queue transitions `Pending`→`Claimed`→`Consumed` and has exact
project/fact/workspace identity. Claim uses one `BEGIN IMMEDIATE` to select a
bounded batch of due Pending or expired Claimed rows ordered by
`(enqueuedAt, projectId, attentionFactId)`, assign fresh `claimId` and trusted
canonical-UTC `claimExpiresAt`, and increment `attemptCount`. Consume uses a
new `BEGIN IMMEDIATE`, validates the
current claim/expiry and exact P9 fact, durable decision, Execution/Episode,
profile/provider/version/reason/evidence binding and accepted Attention
freshness. If eligible, insert/verify one marker keyed by
`(projectId, attentionFactId)`; then mark the queue row Consumed and clear
claim fields atomically. A stale fact may be Consumed without an active
marker. Stale/expired claims, changed bindings or marker conflicts cannot
consume. The queue row is not deleted. A wake for Pending/Claimed only wakes
the dispatcher; Consumed is a no-op. Full rebuild/re-arm is P10 `04`.

## Accepted AH14 LegacyAdoptionEvidenceInsufficient source (DID v1.49)

Accepted token `ACCEPT_AH14_LEGACY_ADOPTION_EVIDENCE_ATTENTION_GOVERNANCE`,
proposal raw SHA-256
`71F81F8B61375B9828FAB208D517FBF2CE0092C0B71ECCD124353262E23FCFB1`,
accepted 2026-10-17. P10 registers exactly source
`LegacyAdoptionEvidenceInsufficient`, severity `ActionRequired`, target
`workspace_id` stored on the immutable P9 failure fact (the exact
`executions.workspace_id` at detection), and internal `sourceExecutionId` for
authorization and Work-episode freshness checks. Public rows have
`targetWorkspaceId`, `dedupKey=attentionFactId`,
`failureCode=LegacyActionDispositionUnproven`,
`occurredAt=firstDetectedAt`, and the fixed safe summary:
`Legacy action outcome cannot be proven; operator review is required.`
No Provider payload, action arguments, evidence tuple/digest, paths, or error
text is exposed. Query authorization requires the reader's project/Workspace
scope to cover this exact target.

The `legacy_adoption_attention_rows` marker is keyed by
`(project_id, attention_fact_id)`, records the exact `workspace_id`, and is
composite-bound to that P9 fact. Applying either event validates the complete
event envelope and exact payload key set against immutable P9 rows before
mutation. For failure, require
`event_id=failure.event_id`, `event_type=LegacyAdoptionEvidenceEscalated`,
`event_version=1`, project, exact Execution aggregate,
`correlation_ref=attention_fact_id`, null command/event causes,
`system:recovery` actor, occurrence time equal to
`first_detected_at`, and exact payload fields/values from the failure fact;
`factId=attentionFactId=attention_fact_id` and evidence digest equals
`evidence_sha256`.

For resolution, validate both immutable facts and require
`event_id=resolution.event_id`, `event_type=LegacyAdoptionEvidenceResolved`,
`event_version=1`, exact Execution aggregate/project,
`correlation_ref=attention_fact_id`, null command cause,
`caused_by_event_id=originalFailureEventId`, `system:recovery` actor, and
occurrence time equal to `resolved_at`. Exact payload keys are `factId`,
`attentionFactId`, `projectId`, `executionId`, `targetWorkspaceId`,
`providerTurnId`, `originalEvidenceSha256`, `resolutionEvidenceSha256`,
`resolutionCode`, and `resolvedAt`. Bind them field-for-field to the
resolution/failure facts, including the original and resolution hashes. Also
recompute the canonical disposition-summary hash and the non-empty action-set
resolution-code mapping; stored summary hash, tuple hash, row code and event
code must agree.

Missing facts, wrong envelope/field, extra or missing payload keys, tuple
conflict, or hash/code mismatch is typed corruption: make no marker insertion
or deletion and do not advance the Attention offset. Validation, marker
insert/delete and offset acknowledgement occur in one transaction. Failure
marker insertion is idempotent. Resolution deletes only the matching active
marker; it never deletes or rewrites either P9 fact. There is no human dismiss
command and no timeout clearing path.

## Accepted V21 derived RecoveryBinding Attention

Add the non-persisted API `AttentionSource` literal
`SandboxRecoveryBindingFailure`. P10 derives this row on each authorized
Attention/Workspace Detail query by strict read-only evaluation of the exact
P4 `tool_invocations` and `tool_invocation_recovery_bindings` rows. Emit only
while the exact Execution is active and its exact invocation remains
NotAdmitted, unsettled and Action Pending, with missing/corrupt/mismatched
immutable RecoveryBindingV1 proof. No marker, event, fact, queue, or rebuild
state is written; this source is not P40 `ToolObservationReplay` and event
pruning is irrelevant. Duplicate reads produce the same identity and summary.

The public target is the canonical Execution Workspace, severity is
`ActionRequired`, and the exact safe summary is “Sandbox recovery binding
evidence is missing or invalid; execution is paused.” `occurredAt` is the
immutable `tool_invocations.intent_at`, strict-decoded as canonical UTC;
missing or invalid value is a projection-integrity failure with no fallback
timestamp and no derived Attention. The dedup `attentionFactId` is lowercase
SHA-256 of exact canonical UTF-8 JSON with fixed key order
`version,executionId,invocationId,bindingShaOr`. NULL hash is JSON null; a
syntactically valid stored lowercase 64-hex hash is used exactly even when
content hash mismatches. A non-NULL malformed hash is a
Persistence/ProjectionIntegrityFailure: fail closed, do not emit a derived
row, and use the existing corruption Problem/operational path. Never expose
binding hashes/bytes, arguments, regions, host paths, or parser details.

The canonical preimage forms are
{"version":1,"executionId":"<exact-id>","invocationId":"<exact-id>","bindingShaOr":null}
when the stored SQL value is NULL, and
{"version":1,"executionId":"<exact-id>","invocationId":"<exact-id>","bindingShaOr":"<exact stored lowercase 64-hex>"}
when the stored value has exact valid format. Hash the exact UTF-8 JSON bytes
with no whitespace or trailing newline; never include malformed bytes.

The derived row disappears only when that invocation is terminal or its
Execution is stopped. RecoveryBinding is immutable and v1 has no automatic or
manual repair/rebind path; a verified backup or new Execution is outside this
contract. Current resource/authority/control drift with a valid binding is
handled by existing P4 denial or policy-required behavior and is not this
Attention source. Existing `SandboxProviderUnavailable` P9 fact/queue/marker
semantics are unchanged.


## Full-chain P9 fact freshness and sandbox queue constants (V21)

A SandboxProviderUnavailableFactV1 contributes a live row only when strict
fact identity/codec validation passes; the exact committed P1 decision matches
Project/Workspace/Execution and full EpisodeBinding; its policyRevision equals
the fact and no higher committed revision exists for that Execution; canonical
Execution still has the same tenant/workspace/episode and is active; the active
AgentLoopStep is the exact SandboxUnavailableV1 disposition naming this
attentionFactId; and the joined command result, row policy_digest, provider/
version/capability/OS build/profile/network/evidence bindings all match. The
fact remains immutable when its decision expires; expiry removes Committed
status but not historical fact. Higher revision, terminal/Stop or changed
Episode makes it stale for live Attention without deleting it.

The retained sandbox-provider queue specifically uses max claim batch 100,
periodic scan every 5 seconds, and claim TTL 30 seconds; this is separate from
other P10 source/event batch defaults. A wake may trigger an earlier scan but
never bypasses the queue. Trusted P10 Clock supplies canonical UTC milliseconds.
Due Pending or Claimed rows with claimExpiresAt<=now are ordered by
(enqueuedAt,projectId,attentionFactId). Claim is one BEGIN IMMEDIATE with fresh
claimId, expiry=now+30s, attemptCount incremented only on commit. Consume is a
new BEGIN IMMEDIATE, requires exact unexpired current claim, rechecks P9 fact,
decision/result, Execution/Episode and freshness, then marker and queue
Consumed transition commit atomically. Reclaim replaces claim and increments
once; no retry cap, dead-letter or row deletion. Duplicate events, expired
claims, changed identity, marker conflict or stale lease never consume or
advance offsets. Authorized full rebuild uses one transaction to reset only
this source marker, snapshot retained facts/queue, re-arm unresolved current
items and rewind the existing offset atomically; below-floor safety refuses
rebuild without destroying current rows.

SandboxPolicyDecisionRequired is a separate derived NeedsDecision/ActionRequired
projection for an active Execution with verified durable NotAdmitted/Pending
invocation and no matching current policy decision. It is not provider
Unavailable and writes no fact/queue/event. The V21 RecoveryBinding failure
source remains pure-derived and follows its own exact identity/integrity rules.

## Accepted Native durable process-mode no-effect Attention V2

Accepted under `ACCEPT_NATIVE_PROCESS_MODE_DURABLE_NO_EFFECT_V2`, supplement
SHA-256
`B9909E31C005FE3546EBA1EA72395BDE3231F68ECFD2ADA14045B0C50E018DEB`.
P10 derives one read-only `ProcessExecutionUnavailable` ActionRequired row
only from the exact terminal P4 Denied above and an exact one-to-one join to
its Execution and P3 action identity. Require the closed reason code,
`settlement_kind=Denied`, `effect_admission_state=NotAdmitted`, canonical
`settled_at`, and the exact RecoveryBinding/action binding. Missing or
conflicting joins produce no Attention and use the existing typed projection
integrity path. The row is scoped to the exact Execution Workspace and active
Execution; it disappears when that Execution settles or is Stopped.

Its `attentionFactId` is lowercase SHA-256 over canonical UTF-8 JSON with
exact ordered keys `version,executionId,workspaceId,invocationId,
providerTurnId,logicalStepNo,repairAttempt,logicalActionId,actionIndex,
callRef,reasonCode`; `version=1`. The Attention row uses that exact identity
as its `dedupKey`. `occurredAt` is the immutable P4 `settled_at`, never
current time. Fixed summaries are:

- `Process execution is disabled for this daemon; the action was not started.`
- `No qualified Native OS process tuple is available; the action was not started.`

Expose only the safe status, exact closed reason code, and existing public
Execution/action references. Omit command text, paths, environment, raw
provider/policy errors, helper locations, evidence digests, and capability
details. This is a read-only projection: it adds no P9 fact, provider
unavailable fact, attempt, queue, marker, event, or P40 Observation.
Implementation is conditionally authorized under
`AUTHORIZE_NATIVE_PROCESS_MODE_DURABLE_NO_EFFECT_V2_IMPLEMENTATION` after the
required independent post-landing review; migration execution, database
upgrade, deployment, Native support claims, and release remain separately
gated.
