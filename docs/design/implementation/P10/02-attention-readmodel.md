# P10 — 02 Attention Read-Model (GQ3)

**Authority:** DID v1.13 G3/G8; SD v1.3 §12.3 (three severities, bubbling), §14 No.42/55; DID §6.2 L6 rows; P7 `05` (DeadlockAttentionRequested), P9 `01`/`04` (ReconciliationEscalated); `planning/gaps/P7-GAP-01.md`.
**Status:** DRAFT.

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
| Vacant producer (P7-GAP-01) | derived: dependencies(Unsatisfied ∧ WorkspaceBound) × works(无 Open Work ∧ ¬Retired) | Attention | consumer workspace (view label `WaitingOnVacantProducer`) |

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
