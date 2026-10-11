# P10 — 02 Attention Read-Model (GQ3)

**Authority:** DID v1.13 G3/G8; SD v1.3 §12.3 (three severities, bubbling), §14 No.42/55; DID §6.2 L6 rows; P7 `05` (DeadlockAttentionRequested), P9 `01`/`04` (ReconciliationEscalated); `planning/gaps/P7-GAP-01.md`.
**Status:** DRAFT.

## 1. Fact sources → severity → target (frozen mapping)

| Source | Fact carrier | Severity (SD §12.3) | Target |
|---|---|---|---|
| Dependency Unfulfillable | DependencyMarkedUnfulfillable event | Attention | consumer workspace |
| Deadlock | DeadlockAttentionRequested event | Attention — emitted only under the No.42 project-idle gate (P7 `05` §2), so by frozen semantics every emitted deadlock fact is already Action Required; the read-model renders it as such (no conditional branch exists) | each cycle-member workspace |
| Runtime Safety Envelope | safety-stop record / Interrupted(RuntimeSafetyStop) settlement fact | Attention | execution workspace |
| Recovery escalation | ReconciliationEscalated event | Action Required (unreconcilable side effect — SD §12.3 explicit) | execution workspace |
| AssignWork binding failure | `AssignWorkTargetBindingEscalated` + P9 `assign_work_binding_attention_facts` row | Action Required | affected Execution's owning/Parent Workspace (`executions.workspace_id`) |
| Workspace resource activation pending | P1 `WorkspaceResourceActivationIntent(Pending)` + `WorkspaceResourceActivationChanged` v1 | Action Required | the exact root Workspace in the intent |
| Verifier orphan | Open verification × settled executions (derived condition, P8 `02` §3) | Attention | owner workspace |
| Vacant producer (P7-GAP-01) | derived: dependencies(Unsatisfied ∧ WorkspaceBound) × works(无 Open Work ∧ ¬Retired) | Attention | consumer workspace (view label `WaitingOnVacantProducer`) |

### 1.1 RAI-DG-01 Work-revision freshness for active Attention

For Work-bound source rows only, Runtime Safety Envelope,
`ReconciliationEscalated`, AssignWork binding failure and Deliver replay
failure are active when and only when the source Execution's validated EGP Work
Episode `(workId, workRevision)` equals the canonical Work's current
`(workId, revision)` in the same read snapshot. The internal read contract
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
to canonical state.

`OutcomeUnknown(ReconciliationRequired(nonempty refs))` is a P2/P7
readmission source even without a P10 row. It does not synthesize Attention
unless an existing P10 source fact exists. Attention rows, subtree counts,
queue position and consumer ACK never create or release a Runtime hold.

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
