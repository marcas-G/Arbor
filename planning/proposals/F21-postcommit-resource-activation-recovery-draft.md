# F21 OPEN-3 — Post-Commit Resource Activation Recovery (Governance Draft)

Status: **DRAFT / proposed disposition for independent governance review**

This revision supersedes the OPEN-3 source-projection portion of landing
`ff949eb`: status events are wakeup hints, while P10's Activation source is
reconciled from current P1 intent state. The previous event-payload-driven
projection cannot recover through P1 `ConsumerRebuildRefused` and must not be
implemented as the current contract. This amendment does not alter the
accepted recovery intent, event, ownership, receipt, or compatibility rules.

Related accepted baseline: FT-DG-01 v3 proposal Git-blob SHA-256
`274885C110E3B277753B49F6BAD023619ADFCF52D866CC86F01F27F7FDA85DD0`.
This draft addresses only OPEN-3. It does not close OPEN-1 Profile-source audit
or OPEN-2 historical CreateProject v1 same-ID replay, authorize implementation,
change `docs/design/**`, or change any F23 receipt rule.

## 1. Observable gap

CreateProject commits Project, root Workspace, Primary Session, ProjectCreated
v1, WorkspaceCreated v1, and its CommandReceipt in the existing P1 transaction.
The P12 external composition then reads the persisted Workspace boundary and
performs ownership activation in a separate transaction. If the process stops
between those stages, or the post-commit resolver/claim transaction fails, the
canonical command remains Committed while no ownership claim exists.

Today the HTTP path returns a safe post-commit-convergence failure when it sees
an activation error. Retrying the exact same current request can re-enter
`afterCommitted` and retry from the persisted Workspace boundary. However:

- restart does not have a durable activation-work item that it scans;
- P10 Attention has no source for a committed non-empty boundary without its
  ownership claim;
- after a process crash the client may not retain the exact request needed to
  trigger the current retry path; and
- no current public repair operation may silently select a replacement Profile
  or rewrite the committed boundary.

The existing F21 normal Profile journey and successful-receipt restart replay
are not evidence for this failed post-commit interval. This is an OPEN-3
production-recovery/visibility gap, not a failure of the admitted-boundary
success path.

## 2. Recommended minimal candidate

Add a durable P1-owned `WorkspaceResourceActivation` intent keyed by
`(workspaceId, resourceBoundaryRevision)`. It is an operational convergence
fact, not a Project resource selector, authority grant, or new ownership
boundary.

For a newly created root Workspace with a non-empty trusted canonical boundary,
the same existing CreateProject transaction writes one `Pending` intent with
the Project/Workspace/Session/events/Committed receipt. ConversationOnly has
an empty boundary and creates no activation intent. Existing v1 Projects and
receipts are not reconstructed into intents by guessing from historical paths.

The intent stores only workspace/project identity, boundary revision, status,
and timestamps plus a closed safe failure class if needed. It stores neither
canonical path, Profile ref/version, raw OS error, nor user/model text. The
source of activation input is always
`WorkspaceRepository.findById(workspaceId).resourceBoundary` at the pinned
revision; the startup Profile catalog is never consulted during activation
recovery.

### Intent state, transaction, and level-triggered Attention contract

The intent has exactly two persisted states: `Pending` and `Active`. `Pending`
means the committed non-empty root boundary has not yet been proven active in
`resource_ownership`; `Active` means the matching boundary revision's complete
claim set committed. There is no durable `Processing` or terminal-failure
state. Every failed resolution/write leaves `Pending`; a closed safe failure
class may be updated without carrying path, Profile, or OS-error detail.

P10 `02` currently materializes attention incrementally through the P1 generic
event consumer, while P1 `05` refuses a generic rebuild when its offset is
below the retained journal floor. The Activation Attention source therefore
uses a dedicated level-triggered reconciliation path from the P1 intent table;
it does not depend on the shared P1 consumer offset or a successful generic
rebuild.

One new P1 domain event type, `WorkspaceResourceActivationChanged`, remains at
EventVersion 1 as a journal/wakeup hint. Its closed tagged v1 payload is exactly
`{ _tag: "WorkspaceResourceActivationChanged", workspaceId,
resourceBoundaryRevision, status }`, where status is `Pending | Active`; the
event envelope supplies project identity and workspace aggregate reference.
It contains no path, Profile ref/version, filesystem error, or user/model text.
The P1 event catalog/schema and P10 consumer register this type. Crucially,
the P10 handler does **not** apply the payload status as projection truth: every
event delivery, including an old/replayed Pending event, invokes a same-project
reconciliation that reads the current P1 intent table and replaces only that
source's P10 rows from current Pending/Active states. A stale Pending event can
therefore never recreate a row for an already-Active intent.

- New Profile CreateProject: append
  `WorkspaceResourceActivationChanged(Pending)` after the existing
  `ProjectCreated(v1)` → `WorkspaceCreated(v1)` events, in the same Gateway
  transaction that writes the intent, canonical state, and Committed receipt.
  ConversationOnly has an empty boundary, so it writes no intent or activation
  event.
- Successful activation: in the same `BEGIN IMMEDIATE` transaction that
  inserts the complete ownership claim set and CASes this exact intent from
  `Pending` to `Active`, append `WorkspaceResourceActivationChanged(Active)`.
  If any step fails or the transaction rolls back, neither Active nor its
  event commits.
- P10's `reconcileProjectActivationAttention(projectId)` reads all activation
  intents for that project and, in one `BEGIN IMMEDIATE` transaction, replaces
  only `WorkspaceResourceActivationPending` rows with exactly the current
  Pending set. Its idempotency/dedup key is
  `(projectId, workspaceId, resourceBoundaryRevision)`, never event id. P10
  reads no Profile/path/error material and writes only its projection table.
  P12 calls this reconciliation after the post-commit activation attempt
  regardless of success/failure, and at startup for every project with an
  activation intent (including Active intents, to remove stale rows). The P10
  event handler calls the same in-scope reconciliation from inside the
  consumer's existing transaction. Re-delivery is a replacement from current
  source truth, not an operation driven by event payload state.
- P12's reconciliation is deliberately independent of `ConsumerRebuildRefused`:
  it does not call generic rebuild, reset, read, or advance the shared P1
  Attention consumer offset. If that offset is below the journal floor, this
  Activation Attention source still becomes current; the generic consumer
  remains refused under P1 `05` until its owning rebuild path is repaired.
- A full P10 Attention rebuild MUST include activation-source reset, a
  consistent Pending-intent snapshot, and rollback of the P1 Attention offset
  to `floor - 1` in the same `TransactionScope`. It commits/rolls back these
  together, then replays retained journal events. P11's writer transaction
  serializes against this snapshot; status events replayed after the snapshot
  invoke current-source reconciliation and cannot override newer intent truth.
  The snapshot handles a Pending intent whose event has been pruned; the P12
  source path independently handles a refused generic rebuild. Neither path
  changes the P1 intent or ownership claims.

The new type begins at its own EventVersion 1 under existing P1 `05` rules.
`ProjectCreated` and `WorkspaceCreated` remain EventVersion 1 with their
current payloads and order; no reader-ceiling bump, upcast, or event-schema
reinterpretation is proposed. F23 authentication/codec/Actor/Resolver/Gateway
tuple order is unchanged.

P11 activation resolves the persisted boundary outside a write transaction as
today. Claim insertion and `Pending → Active` intent transition then commit in
one transaction. A transaction-local compare-and-set on the intent identity
ensures one winner: concurrent/replayed workers that observe `Active` return
the existing result and do not append duplicate claims. Failures leave the
intent `Pending`; no partial ownership claims or false `Active` status commit.
Do not add a long-lived `Processing` lease in this candidate: a crash while
processing must leave a recoverable Pending intent, not strand a lease.

P12 post-commit composition invokes P11 activation and then calls P10's
source-specific reconciliation from the current intent table whether P11
succeeded or failed. On startup, P12 first lists all activation intents and
reconciles each affected project's P10 source rows (including Active intents,
to remove a stale Pending row after a crash); it then scans Pending intents,
reads their persisted Workspace boundaries, and invokes the same idempotent
P11 activation path. A bounded periodic retry may be considered separately;
it must not mutate or retarget the Project. Replayed exact CreateProject
receipts may also converge the existing intent, but are not the only recovery
trigger.

P10 stores one derived/materialized Action Required row for each Pending
intent, targeted at the root Workspace and deduplicated by
`(projectId, workspaceId, resourceBoundaryRevision)`. Use a fixed path-free
summary such as “Project resource activation is pending; file actions are
unavailable.” P10 clears the row only when reconciliation sees that the same
pinned intent is Active or absent. P10 does not retry, repair, or mutate
canonical state. Persistent failure stays visible; the failure class may
distinguish only a closed safe category and must not carry filesystem text or
Profile identity.

This proposal does not provide a way to choose a new directory. Restoring the
same canonical path and retrying the same boundary is convergence. Changing a
boundary requires a separately authorized governance command and its exact
resource/ownership semantics; there is no Profile-catalog fallback, automatic
rebind, or browser free-path repair.

## 3. Owner placement and compatibility

| Owner | Proposed responsibility |
|---|---|
| P1 `01` | Add the intent and `WorkspaceResourceActivationChanged(Pending)` to the CreateProject v2 committed transaction contract; specify empty ConversationOnly behavior, terminal receipt separation, and no rollback after commit. |
| P1 `02` / `04` | Define intent store/Port and additive SQLite migration, unique key, status transition CAS, source-table retention/rebuild contract, and how the P11 activation transaction shares one `TransactionScope` across claim insertion, Pending→Active, and the Active event. Do not call the current self-transactional ownership service in a second transaction. No receipt tuple or CommandStore schema changes. |
| P1 `05` + domain event catalog | Define the new `WorkspaceResourceActivationChanged` payload/type at its first EventVersion 1 and preserve the existing reader policy. Existing ProjectCreated/WorkspaceCreated payloads and EventVersion 1 remain unchanged. |
| P11 `10` (or the exact owning P11 contract) | Define activation attempt, failure class, the single atomic claim+Pending→Active+event transaction, dedup/concurrency, and same-boundary retry. The existing ownership resolver and CAS rules remain authoritative. |
| P12 `10` / startup recovery owner | Own post-commit reconciliation after every activation attempt and startup reconciliation for every project with any intent (including Active), followed by the Pending-intent activation scan; pass no path and read no receipt outside the Gateway. Reconciliation never reads the Profile registry or changes the shared P1 consumer offset. Until separately authorized periodic retry exists, an online-restored path requires exact current-v2 replay or restart. |
| P10 `02` / `03` / `04` / `05` / `07` | Own the typed path-free source row/API, dedicated P1-intent-to-P10 reconciliation transaction, event-as-wakeup handler that re-reads current table truth, exact tuple dedup, full-rebuild/reset/offset-snapshot atomicity, retention/ConsumerRebuildRefused behavior, and acceptance. P10 never changes canonical intents or claims. |

This candidate selects the additive intent table as the recovery source. It
gives P12 a precise restart worklist and gives P10 a stable level-triggered
rebuild source without changing ProjectCreated. Deriving “pending” only from a
non-empty Workspace boundary and missing claims is not an alternate
implementation in this package: it cannot distinguish intentional
empty/no-claim states and would need its own accepted predicate and
single-consumption contract.

Compatibility constraints:

1. Keep ProjectCreated and WorkspaceCreated EventVersion 1 and existing
   payloads. If a future choice instead adds a v2 event, raise the reader
   ceiling and update every consumer explicitly; P1 v1 readers currently
   quarantine higher versions.
2. Do not change CommandId, semantic fingerprint, Handler schema, receipt
   result/error shape, or the exact tuple.
3. External order remains authentication → strict wire-v1 decode → ID/Actor
   binding → Resolver → Gateway `BEGIN IMMEDIATE` tuple comparison/decode.
   No Composition/transport pre-read is added.
4. Historical CreateProject v1 rows remain preserve-only. Do not create
   intents, source tags, successful replay, or new ownership claims by
   interpreting old receipt JSON or inferring Profile identity from a path.
5. OPEN-1 and OPEN-2 stay open. This candidate adds no Profile path or Profile
   selector to the public Attention/UI surface. GitWorktree lifecycle remains
   out of scope.
6. The additive intent migration does not synthesize intents for projects or
   receipts created before it. In particular, a pre-migration CreateProject
   v2 receipt that committed before ownership activation is not backfilled by
   guessing from a non-empty Workspace path or a missing claim. Existing
   canonical rows/events/receipts remain unchanged; only an exact current-v2
   receipt replay may use the already-authorized post-commit convergence path
   against that persisted Workspace boundary. If that legacy replay still
   fails, it remains outside the new automatic intent/Attention guarantee and
   requires a separately reviewed v2 adoption/migration disposition.
   Historical v1 receipts remain preserve-only: no intent backfill, v1 decode,
   or successful same-ID replay is introduced.

## 4. Qualification matrix required before OPEN-3 can close

| Boundary | Injected condition | Required public/durable assertions |
|---|---|---|
| Before CreateProject commit | Kill/fail command transaction | No Committed receipt, Project, Workspace, Session, events, intent, claim, or Attention. |
| After commit / before ownership activation | Kill old daemon at a test-only boundary | One Committed receipt, Project, Workspace, Session, v1 events and Pending intent; no claims yet; restart discovers the intent without client resend. |
| Activation resolver or claim transaction fails | Keep failure active across restart | Command stays Committed and row unchanged; Pending intent survives; no partial claim; P12's post-commit reconciliation or startup reconciliation produces exactly one path-free Action Required row even if the generic P1 consumer refuses because its offset is below the pruned floor. |
| Recovery succeeds after same path is restored | Restart/retry worker | Claim, `Active` transition, and Active event commit atomically once; Attention clears after P10 consumes/reconciles Active; no second Project/Workspace/Session/ProjectCreated/WorkspaceCreated event/receipt; no Profile re-resolution. |
| Same intent is processed twice/concurrently | Two daemon workers or startup + exact receipt replay | One active intent and one canonical claim set; loser observes the winner; no duplicate attention or claim. |
| Profile registry changes to another path/version | Restart with changed catalog while intent is Pending | Recovery still uses the stored Workspace boundary, does not switch path; old v1 collision remains F23 `IdempotencyConflict`/preserve-only. |
| Path remains unavailable | Repeated restart/retry | Intent and one safe Attention remain; no success/claim, path/ref/OS error disclosure, auto-rebind, or false rollback. Restoring the path while the daemon remains up requires exact current-v2 replay or restart until a separately designed periodic retry exists. A different boundary requires a separately governed operation not supplied by this proposal. |
| ConversationOnly | Empty persisted boundary | No activation intent/Attention and no file ownership claim; conversation behavior remains unchanged. |
| Attention rebuild after journal pruning | Keep an intent Pending beyond the event retention horizon, then rebuild P10 | Rebuild reads current intent state and reproduces exactly one Pending row even when its original Pending event is no longer retained; Active/ConversationOnly intents produce no row. |
| Consumer offset below pruned floor | Seed `ConsumerRebuildRefused` with a Pending intent and absent Activation Attention row | P12 source reconciliation reads the current intent table and restores exactly one row without calling generic rebuild or changing the shared P1 offset; it does not claim the generic consumer recovered. |
| Old status event after Active | Retain a Pending event, commit Active, then replay/reconcile the old event | The P10 event handler reads current P1 intent state and leaves no row; event payload status cannot override current Active source truth. |
| Pending→Active races source reconciliation | Interleave a P12 source reconciliation with P11's atomic claim+Active CAS+event transaction | SQLite transaction serialization yields either one Pending row before Active commits or no row after Active commits; a reconciliation that runs after Active cannot restore Pending from an earlier snapshot/event. No duplicate row or claim. |
| Pre-intent v2 receipt | Seed a committed v2 Project/Workspace without an activation intent | Migration/startup does not synthesize an intent or change receipt/events/ownership. Exact current-v2 replay may retry only the persisted boundary; continuing failure remains outside automatic OPEN-3 coverage. v1 remains preserve-only. |

The integration test must use a fresh real daemon/database and public
CreateProject/view routes. The fault seam is test-only, process-local, and
fires after Gateway commit but before activation; it must not be controllable
by environment variables in production. SQLite inspection is an independent
postcondition, not the oracle for public Attention or replay response.

## 5. Decision still required

The original durable-intent recovery recommendation and the source-only
reconciliation correction have been authorized for owner-document landing
under the user's standing design-landing authorization; the updated LF
proposal digest and owner digests are recorded in the follow-up landing
record. This is not implementation authorization. OPEN-3 remains open until
the listed crash, rebuild, and fresh-daemon qualification passes; do not call
F21 production recovery closed.
