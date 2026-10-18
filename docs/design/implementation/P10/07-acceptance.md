# P10 — 07 Acceptance Stories

**Authority:** `01`–`06`; S2.4.1–S2.4.3/§12.5, S1 (tree overview), S4 (wait observability); P5–P9 acceptance style.
**Status:** DRAFT for unrelated baseline clauses; Native OS Sandbox addenda accepted under parent token `ACCEPT_NATIVE_OS_SANDBOX_CONVERGENCE_V1` and V5 token `ACCEPT_NATIVE_OS_SANDBOX_PROVIDER_UNAVAILABLE_FACT_STORAGE_V5`.

**Accepted AH10 DeliverReplayFailure qualification story (DID v1.37):** Story M
is the design acceptance contract for the P9 failure source's consumer
atomicity, deduplication, rebuild and restart. Runtime qualification remains
pending; this addition does not close P10 phase acceptance or AH10.

**Accepted storage correction (DID v1.38):** Story M also qualifies the
source-specific P10 marker and append-only migration ordering under addendum
SHA-256 `040789D32BE1D92F1BAD28C5E3346439C1E902236452E778CD104AF6AA71EC8B`.
P36 integration remains a prerequisite; this does not authorize P37 in
isolation or close runtime qualification.

**Accepted EA-DG-01 owner amendment (DID v1.39):** Story N qualifies the
read-only Executable approval Inbox target and workspace-scoped projection
contract under proposal SHA-256
`E4F1B2935E0397292049BB3FDB1AB5847B02443CCE1B55A9827F823C63F145EB`.
This does not authorize implementation or claim browser/process qualification.

Deterministic; read-only assertions over canonical fixtures + driven commands.

- **Story A — Tree & Status**: seeded multi-level project (executing/waiting-blocked/idle/attention workspaces) → Tree query returns responsibility chain + per-node status per the frozen label map + subtree attention summaries without per-node drill-in (S2.4.1); no view write occurs (write-count snapshot).
- **Story B — Attention read-model**: fixtures for every current fact-backed and derived Attention source, including SubmittedDecisionBindingFailure and GAP-01 vacant producer with a retired-workspace negative case → severities/targets/bubbling/dedup exactly per `02`; attention rows never mutate canonical state (snapshot).
- **Story C — EffectiveFacts & freshness**: watermark/lag exposed on reads; explicit barrier blocks/refuses per `03`; no implicit RYW (write then immediate read may lag; barrier forces catch-up).
- **Story D — Detail/Verification/Dependency/Transcript/Usage/Inbox views**: per-view derive assertions incl. usage aggregates (observe-only) and transcript paging over session_entries (first production read path).
- **Story E — Rebuild at scale**: materialized projections (Attention/EffectiveFacts/Tree/Usage) — force drift → orchestrated rebuild → query correctness (same state as incremental); checkpoint resume; retention touches projection rows only (journal horizon untouched — negative assertion).
- **Story F — Human intervention facts**: steer/critical-steer/formation-approval/accept/withdraw/mark-unfulfillable (human principal) → paired facts emitted same-transaction (payload per `06`); the human-stop emission branch is asserted **wire-only** (dormant until the P12 resolver — declaration + payload shape checked, no mutation invoked); Intervention Summary bubbles; WorkSteered payload back-filled (P6 shape).
- **Story G — Action surfaces**: Query (**message-mediated**: query Message → workspace-side P14 execution, read-only, result Message/Inbox back-flow rendered), Steer, Stop-request (P2 validates as frozen; no resolver invoked; external AdmitExecution likewise never called directly), Governance Change entry — all via CommandGateway only.
- **Story H — Work Detail and F22**: query an exact `{projectId, workspaceId, workId}` through the read-only Work Detail view and assert Open/Completed/Cancelled from canonical Work; accepted-but-open remains Open; acceptedResult is bound to the same Work revision's canonical Acceptance and exact concluded PASS Verification; missing/mismatched Completed binding is a typed projection-integrity failure. After restart, the same Work remains inspectable. Absent and cross-project/workspace targets return identical `projection/work-not-found` / `not-found` with no target facts. No view writes occur.
- **Story I — AssignWork binding failure Attention**: emit one P9 `AssignWorkTargetBindingEscalated` with its immutable fact; after the P10 consumer catches up, one `Action Required` row targets the Execution's owning Parent Workspace, uses `attentionFactId` deduplication, and increments the normal subtree summary once. A repeated event/fact tuple does not duplicate the row. Projection rebuild and restart reproduce the same single row, and no Work, Permission, or other canonical state changes.
- **Story J — F21 post-commit resource activation Attention**: a real Profile CreateProject commits exactly one Pending intent/status event with Project/Workspace/Session/receipt; ConversationOnly commits none. The P12 post-commit reconciler exposes one fixed path-free ActionRequired row targeted at the root Workspace and keyed by `(projectId, workspaceId, boundaryRevision)` after claim activation fails. A daemon crash after Gateway commit but before this call is repaired by startup reconciliation. A second daemon/replay cannot duplicate claims or rows. Same-boundary recovery commits claims + Active CAS + Active event once and reconciliation clears only that exact row. Permanent path failure remains Pending/visible; no path/ref leakage, auto-rebind, ProjectCreated v2, or canonical mutation by P10.
- **Story K — F21 level-triggered Attention with refused consumer**: set the shared Attention consumer offset below the retained event floor and remove the activation source row. P12 reconciliation from the current intent restores exactly one Pending row without calling generic rebuild, returning `ConsumerRebuildRefused`, or changing/advancing that offset. The generic consumer refusal remains observable and is not claimed repaired.
- **Story L — F21 Attention rebuild/reset race and stale-event convergence**: pause rebuild and activation at the P10 source-reset boundary; prove Attention source reset, Pending-intent snapshot, and P1 Attention offset rewind commit/rollback in the same `TransactionScope`, then replay retained events. An Active transition racing after the snapshot is reconciled afterward. Replaying the old Pending event after Active must reconcile to no row. Separately, put the shared consumer offset below floor with the Activation row absent and prove P12's source-only reconcile restores exactly one row while generic `ConsumerRebuildRefused` remains unchanged; then prune the Pending event and prove an authorized P10 full rebuild's current-intent snapshot still reconstructs exactly one row. Neither path changes/advances the shared offset outside the atomic full-rebuild rewind contract. No unrelated Attention row or P1 intent, claim, Workspace, or receipt changes occur.
- **Story M — AH10 Deliver replay failure Attention**: P9 records exactly one `DeliverReplayEscalated` fact/event for a stable `(executionId, logicalActionId, messageId)` when legacy Message/Event/Inbox proof or a prior receipt/effect binding conflicts. The fact and event share one transaction: before-commit crash leaves neither; after-commit restart returns the same immutable fact without a duplicate event. P10 inserts one `deliver_replay_attention_rows` marker FK-bound to that P9 fact and advances its project/event offset in the same transaction; a pre-commit crash leaves neither marker nor offset advance, and a post-commit crash leaves both, while replay or duplicate marker insertion cannot duplicate the visible row. The query union with the unchanged AssignWork-specific source, F21 source and derived sources produces one `ActionRequired` `DeliverReplayFailure` row on the owning Execution Workspace with exact source, target, `attentionFactId` dedup, typed failure code and fixed safe summary; subtree counts include it once. An authorized full rebuild resets source markers, snapshots retained P9 facts, seeds markers and rewinds the P1 offset to `floor - 1` in one transaction. Prune `DeliverReplayEscalated` while retaining the P9 fact and prove rebuild still returns one row; replay retained events without duplication. The marker FK rejects a missing P9 fact; existing AssignWork projection schema, rows and dedup remain unchanged. Qualify v33→34→35→36→37, v35→36→37 and v36→37 only after P36 integration; prove no standalone v35→37 upgrade or edits to migrations 0034–0036. A retained/consumed Inbox row must match the exact P7 fields; an absent row after consumption is allowed. No Message, MessageSent, Command receipt, Action Observation, Applied transition, Provider request, or canonical Work/Dependency change occurs on the blocked path; P10 does not clear the fact or mutate canonical state. Ordinary SendMessage and MessageSent(v1), F21 rebuild-refusal behavior and AH7/P36 contracts are unchanged.
- **Story N — Executable approval Inbox target**: query the exact P10 Inbox view for a Workspace with one P6 `eap:<approvalId>:<revision>` entry and one Control `cap:` entry; the Executable target is loaded only from a proven P4 `route_kind='Executable'` row in that same Workspace and returns exact tool/version, validated bounded/redacted argument preview, canonical resource targets, capabilities, side-effect semantics, expiry and action digest. A `cap:` entry never produces an Executable target; a foreign/absent target returns the same safe not-found projection; a consumed, expired or cancelled entry is absent from `unconsumed`. View count and ordering are deterministic; querying performs zero writes, decisions, inbox consumption or wake. Malformed/unreviewable argument projections fail closed. Browser and HTTP rendering remain P12/P13 transport responsibilities; this story freezes only P10 DTO/derive behavior.
- **Story O — AH7-DG-01/P39-P40 RNO replay-evidence Attention**: a valid new P39 `ReconciledNoEffect` row with same-invocation/attempt selected `NotOccurred` fact and exact P40 envelope does not create replay-evidence Attention; P4/P3 replay exact stored text/truncated/source once. A P39 settled RNO row with NULL P40 evidence remains byte/field unchanged, is not reconciled/executed again, and on a valid current-generation Pending P3 action produces exactly one P9 `ToolObservationReplayEvidenceEscalated(Missing)` fact/event and one P10 source-specific `ToolObservationReplayEvidenceFailure` `ActionRequired` row on the Execution Workspace. P9 fact+event atomicity and P10 marker+shared P1 offset atomicity are asserted on both sides of COMMIT; P3 writes no ToolResult/Observation/Action/cursor for the blocked legacy case. Duplicate event/fact/marker delivery cannot duplicate attention; a full P10 rebuild reconstructs one row only from retained P9 event within the accepted retention horizon, while below-floor rebuild preserves current rows and returns `ConsumerRebuildRefused`. Stale generation is `LeaseFencingRejected` before P4/P3 evidence reads and produces no P9/P10 attention. P39 selected fact, proof refs, P4 Artifact and all P3 source hashes remain distinct and unchanged.
- **Story P — AH10 Submitted DecisionEpisode binding failure and P41 Attention**: independently reproduce Submitted DecisionRequest Workspace mismatch and settled Provider-result/Step Manifest mismatch against the same authoritative Execution/Step/Action. For each, preserve the original Committed `SelectCurrentWork` Command receipt and canonical selection; write one P9 `SubmittedDecisionBindingEscalated` fact/event keyed by exact execution/step/repair/action tuple; keep Action Pending and Step `ActionsInProgress` while blocked; issue no new SelectCurrentWork, Provider request/Turn, action Command, Observation or ordinary settlement; expose exactly one path-safe `SubmittedDecisionBindingFailure` ActionRequired row at `executions.workspace_id`. Verify exact same-command receipt replay does not authorize the corrupted binding, old generation/expired lease is fenced before read/write, and gen1 takeover observes a committed fact or atomically retries a pre-commit rollback. Exercise authorized Stop after fact and Stop-before-fact: only with complete current lease and no unresolved P4 side effect, use the P3 early-settlement plan and P2 RecoveryController to settle `Interrupted(StopRequested)` and free the active slot; preserve the P9 fact/public Attention and all original receipt/Work/selection facts; do not replay old Provider/action. Inject crashes before/after fact commit, Stop/fact+Step close commit, and RecoveryController settlement. Audit an already-settled Failed DecisionEpisode whose exact Step is `ActionsInProgress` with Pending select action: report the specific still-provable mismatch or `SettledExecutionWithPendingDecisionAction` as audit-only Attention, with no resurrection/repair. Race two independent connections/processes writing the same fact tuple and prove one immutable fact/event. For P10, prove exact union/dedup/subtree count and duplicate event consumption; full rebuild atomically resets this marker, snapshots P9 facts, seeds markers, and rewinds P1 offset to `floor-1`, including after source-event pruning. Crash before/after rebuild commit and race a new fact immediately before/after rebuild; no missed/duplicate row and no P9 fact/P1 floor mutation. Qualify 0041 only after integrated/qualified 0036→0037→0038→0039→0040; prove no migration renumber/checksum edits, v35 skip, or standalone release. Module and two-daemon tests are separate gates; do not infer either from the other. This design landing is not implementation/qualification evidence.

For the two-daemon layer, use separate OS processes and independent SQLite
connections. Start gen0 with the exact committed receipt, then block recovery on
each mismatch; request Stop/fact in both commit orders. Kill gen0 at both sides
of the fact write and stop-close transaction, wait for the persisted lease to
actually expire, and acquire gen1 by the normal lease path. Assert its exact
generation/expiry tuple before recovery; separately inject late gen0 writes and
require `FencingRejected`. Kill gen1 before/after RecoveryController
SettleExecution and restart to convergence. Record the persisted Execution,
Step, Action, receipt, fact/event, offset and public Attention snapshot at each
boundary. These real-process assertions are not satisfied by the P3 module
matrix, and neither gate substitutes for the separate migration-runner gate.
- **Mechanical**: view list = `01` must-set; label map exhaustive switch; P12 boundary negative (no HTTP/WS/CLI in P10 tree); P14 consume-only; P5–P9 regression guard green.

## Accepted AH10 DeliverReplay outbox, claim and transaction qualification (DID v1.43)

The accepted v5+v6 proposal hashes and B0 review are recorded in
`planning/results/AH10-deliver-event-pruning-v6-governance-acceptance-and-landing.md`.
This extends Story M; it does not close runtime implementation or phase
qualification. In addition to its source-fact, public-row, rebuild and
migration assertions, qualification must prove:

- P9 event/fact/pending-row create and exact retry are atomic; event ID stays
  unique/audit-only after journal prune; reuse of a pruned ID for another fact
  rolls back. Marker exists before queue ACK; marker, ACK and offset are
  atomic. Exact retry after prior ACK inserts one new queue row; exact retry
  while already pending inserts no duplicate. Queue FIFO read does not imply
  FIFO ACK across event and queue paths.
- Raw P1 event ID is looked up in P9 before type/version/payload decode. A
  matching fact with corrupt/mismatched event or exact Deliver type without a
  fact is typed fail-closed: no DLQ, no offset, no marker/ACK/projection
  survives rollback. Ordinary non-Deliver poison preserves P1's existing
  dead-letter-and-advance behavior.
- Current P1 offset, raw event batch, P9 fact witness, classification,
  projection, queue batch, marker/ACK and offset change share one
  `BEGIN IMMEDIATE`. Independent-connection/process tests prove both
  serialization orders against journal prune, P9 fact/queue commit and P10
  rebuild/reset. The rebuild atomically resets, snapshots facts, seeds
  markers, ACKs only after markers, and rewinds the offset.
- Two real daemon processes prove a valid global lease returns nonmutating
  `NoClaim`, an expired/empty claim has one CAS winner, and stale generations
  cannot write. Repeated crash of Project A must leave its queue pending while
  healthy due B/C complete multiple rounds; persisted attempt order and
  capped backoff survive restart. Do not claim completion for repeated-crash
  A.
- P12 artifact/schema tests recompute same-window committed queue INSERT/ACK
  counts/rates/net growth (including post-ACK exact requeue), enforce both
  minimum ACK rate and ACK rate strictly greater than sustained INSERT rate,
  and measure raw-preflight duration, full poll lock hold, writer wait,
  backoff and due-healthy fairness at declared maximum workloads. Queue batch
  64 and P1 event batch remain separate.

These are design acceptance gates only. Migration 0037 and implementation
remain ordered after P36 and separately authorized; this section does not
claim tests have run or P37/AH10 has closed.

**Story Q — RAI-DG-01 Work-revision freshness:** for each Work-bound Runtime
Safety Envelope, ReconciliationEscalated, AssignWork binding failure and
Deliver replay failure source, bind its source Execution to exact
`(WorkId, WorkRevision)`. Same-revision rows appear in detail and subtree
bubbling. Advance canonical revision by Steer while the WorkSteered consumer
lags; same-snapshot active queries omit the old row immediately. Repeat after
restart and during projection reset/rebuild; no stale row returns, while source
settlement/fact/event remains auditable. A malformed/absent/unknown-version
binding or cross-scope/future-revision conflict yields only the typed bounded
`ProjectionIntegrityFailure`; no guessed Work or silent drop.
`OutcomeUnknown` without an existing P10 source fact creates no Attention row.
P10 remains read-only and neither projection state nor queue ACK controls
P2/P7 admission. P41 DecisionEpisode marker remains governed by its exact P9
fact and P41 rebuild contract.

**Story R — Blocked WorkEpisode visibility and recovery:** form two distinct
typed terminal denied-action failures in one WorkEpisode; reject a Blocked
settlement if any same-Episode Denied action lacks either an exact later
successful recovery disposition or inclusion in its failure refs. Commit
`Completed(Blocked)`, `ExecutionSettled`, WorkBlocker ledger rows and exact
Manual+InboxAdvanced Wait atomically. Assert one ActionRequired row per
failure fingerprint at the owning Workspace, bubbled once, safe Work Detail
with both categories/requests/refs, one typed direct-Parent Inbox entry for
child Work and none for Root Work. An active resumed WorkEpisode lowers the
row to Attention; ordinary Manual wait does not resolve it. Exact later
success or authorized Work revision advance resolves it once; terminal Work
supersedes it. Same-key repeated failure updates/reopens by state; event
pruning plus P10 rebuild does not revive resolved rows. Views and Attention
never mutate Work, call Provider, or retry an action.

## Accepted Native OS Sandbox acceptance story

**Story — durable sandbox policy and unavailable projection.** A human submits
the exact policy through the existing authenticated command route; the
Workspace Detail projection shows only the current P1 decision's profile,
provider, network mode, revision, expiry and Configured/Unavailable state.
When a required provider capability is unavailable before spawn, P9 persists
one exact `SandboxProviderUnavailableFactV1`; P10
shows one `SandboxProviderUnavailable` ActionRequired row at the canonical
Execution Workspace, with fixed safe summary and `attentionFactId` dedup. No
process starts and no host path, secret, provider diagnostic or destination
is exposed. Duplicate wakeups do not duplicate Attention; event pruning and
full rebuild preserve the projection from the P9 durable fact. A higher
policy revision supersedes the old current-status projection without deleting
the immutable fact. Rejection writes no decision/event; a Committed decision
and event/receipt are atomic. No P10 row mutates policy or retries execution.

**V5 qualification cases (design acceptance only; no tests are claimed):**

- 0050 applies only after exact `user_version=49`, complete 001–0049 prefix
  and the final accepted 0049 signature; it rejects the dormant P43 Blocked
  schema and commits all fact/queue/marker tables, indexes/triggers and
  `user_version=50` atomically. Migration 0049's schema-48 preflight and
  decision/provenance rows are also qualified before any implementation.
- Schema assertions cover every fact/queue/projection field, key, FK, index
  and trigger, no event FK, no cascade, and no backfill. P9 facts and P10
  queue identities are immutable; queue rows cannot be deleted.
- SQL CHECK and P9 decoder reject NULL, empty/all-space, leading/trailing
  U+0020 and values over 128 UTF-8 bytes; accepted opaque reason strings
  round-trip byte-for-byte.
- Same exact identity/payload retry returns one fact, one queue row and the
  same event. Conflicts in tenant/workspace/episode, policy, profile,
  provider/version, probe evidence, reason, queue binding or event identity
  fail closed without partial writes; fact UPDATE/DELETE and queue identity
  UPDATE/DELETE are rejected by SQLite triggers.
- Two-sided real-process crash qualification proves pre-commit leaves no
  fact/queue/event and post-commit retains all three; restart does not mint a
  second event/provider attempt; stale P9 lease/generation writes nothing.
- Queue claim/consume crash before commit leaves/reclaims an expired Claimed
  row; crash after commit leaves one projection row plus Consumed queue state.
  Old claim id, duplicate wake or duplicate consume cannot write a second row;
  changed bindings/conflicting marker fail closed.
- Event pruning followed by P10 queue scan/full rebuild restores one active
  Attention row per eligible fact under accepted source/freshness rules.
  Provider/profile/version/evidence bindings are checked at snapshot/consume;
  stale facts are not revived.
- Independent SQLite processes race P9 fact→queue→event commit against P10
  reset/snapshot/queue re-arm/offset rewind in both serialization orders,
  including pruning a post-snapshot wake before P10 catches up. The durable
  queue yields one marker; crashes before/after rebuild commit converge.
- Reset racing queue claim/consume either re-arms the consumed row or
  invalidates the stale claim and allows a fresh claim; stale claimant cannot
  consume after rebuild.
- A `user_version=49` target with any 0049 signature/schema mismatch, or the
  dormant P43 draft, is rejected. 0049/0050 are not registered/run by this
  design landing. The accepted P2 Blocked WorkEpisode owner remains intact;
  its unregistered draft descriptor must be sequenced after schema 50 before
  any future implementation/registration.

**Accepted AH14 legacy adoption evidence Attention design gate (DID v1.49):**
for the single `LegacyActionDispositionUnproven` scope, prove the ambiguous
legacy success is not adopted and leaves Step/action/Session/settlement and
Provider count unchanged. Qualify canonical failure evidence/fact ID, first
writer time, exact event envelope, and P9 fact/event atomicity before and after
COMMIT. P10 must expose exactly one safe
`LegacyAdoptionEvidenceInsufficient` `ActionRequired` row on the exact
Execution Workspace, with `attentionFactId` dedup, fixed summary and no
Provider/action evidence leakage; subtree summary counts it exactly once, and
unauthorized Workspace reads reveal nothing. Verify event/fact field equality,
marker/offset atomicity and idempotent replay, including independently
corrupted envelope and payload fields failing closed without marker mutation
or offset advancement. Full
rebuild after pruning the source event reconstructs exactly unresolved rows
from permanent P9 failure/resolution facts and does not revive resolved rows.
Only the complete original decoded action set with exact same-action P4
Applied terminal/result/Observation evidence or terminal no-effect NotAdmitted
evidence may resolve; prove deterministic evidence hashes/codes/IDs, partial
set rejection and one-resolution idempotency. No human dismissal, timeout, or
uncertain P4 effect clears the row. Preserve the existing positive AH14
equivalent-fixture adoption behavior without creating Attention. These are
design qualification requirements only; migration and implementation remain
separately authorized.

After that separate authorization, migration qualification uses only a fresh
or explicitly disposable copy of the pinned activated prefix, exercises
offline upgrade/interruption/resume, foreign keys/indexes and runtime
readiness, and converts only the named fixture baseline. Never open or upgrade
the preserved database; do not renumber or modify prior migrations.
