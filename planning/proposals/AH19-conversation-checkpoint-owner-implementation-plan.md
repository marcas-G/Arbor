# AH19 Conversation Checkpoint Owner — Fixed Implementation Plan

**Status:** Fixed planning package; implementation is not authorized by this
document. No production, test, migration, or design file is changed by preparing
this plan.

**Requested implementation token:**
`AUTHORIZE_AH19_CONVERSATION_CHECKPOINT_OWNER_IMPLEMENTATION`

## Authority and frozen basis

The governing semantics are landed in System Design v1.18 and DID v1.50. The
accepted Conversation decision is recorded in
`planning/results/AH19-conversation-checkpoint-owner-acceptance-and-landing.record.md`
under `ACCEPT_AH19_CONVERSATION_CHECKPOINT_OWNER_V1`; its accepted proposal
SHA-256 is
`9B562095B653B84C0518050BC7E6374D1C3710BF464A7BAB556D4F399D604E89`.
The independent post-landing review has Blocking = 0. This plan requests a
separate implementation authorization and does not claim it has been granted.

The owner is the exact Root `WorkspaceId`, stable across HumanMessage,
ResponseJob, Attempt, Execution, and response episode. Coverage is the
contiguous FIFO prefix of authoritatively Answered messages ordered by
`(created_at ASC, message_id ASC)`. A current Claimed message is pinned once and
remains uncovered until Answered. Any earlier non-Answered message/job blocks
later coverage. Work Session history/checkpoints are separate. ProviderNative
reuse requires exact complete `ResolvedModelBinding` equality; mismatch uses a
portable Summary rebuilt from the retained HumanMessage prefix. Existing
unowned Session checkpoints are never adopted as Conversation checkpoints.

## Fixed physical design

Use a dedicated P14 owner-state table, not a Conversation-bound standard
Session. Keep the frozen existing ordering key and do not add a sequence to
`human_messages`:

```sql
CREATE TABLE conversation_checkpoint_owners (
  root_workspace_id TEXT PRIMARY KEY REFERENCES workspaces(workspace_id),
  context_epoch INTEGER NOT NULL CHECK (context_epoch >= 0),
  covered_through_created_at TEXT,
  covered_through_message_id TEXT,
  checkpoint_kind TEXT CHECK (checkpoint_kind IS NULL OR checkpoint_kind IN ('Summary','ProviderNative')),
  checkpoint_ref TEXT,
  binding_fingerprint TEXT,
  source_manifest_json TEXT,
  producer_execution_id TEXT,
  producer_provider_turn_id TEXT,
  updated_at TEXT NOT NULL,
  CHECK ((covered_through_created_at IS NULL) = (covered_through_message_id IS NULL)),
  CHECK ((checkpoint_kind IS NULL) = (checkpoint_ref IS NULL)),
  CHECK (checkpoint_kind <> 'ProviderNative' OR binding_fingerprint IS NOT NULL)
);
CREATE INDEX idx_human_messages_conversation_order
  ON human_messages(root_workspace_id, created_at, message_id);
```

Migration 0048 is additive and declares `requiresUserVersion: 47`. Fresh-database
and disposable schema-47-copy paths apply the global ordered suffix
`45 F23/P6 → 46 VCS → 47 AH14 → 48 AH19 Conversation`. Do not renumber or
reorder prior migrations. Migration 0048 creates the empty owner table and
ordering index only. It inserts no owner rows, does not backfill checkpoint
state or coverage, and does not rewrite/delete HumanMessages or old Session
checkpoints. First owner use initializes `(epoch=0, null frontier, null
checkpoint)` under the normal transaction/fence; initialization is idempotent.

The owner row binds one checkpoint ref to its exact owner, epoch, covered
frontier, complete manifest/source identity, and producer execution/provider
turn. Summary `checkpoint_ref` is an existing immutable content-addressed Blob
ref; ProviderNative `checkpoint_ref` is the opaque provider item ref and must
carry the complete binding fingerprint. The source manifest records the exact
ordered message identities and body refs/hashes represented, frontier tuple,
owner, epoch transition, checkpoint kind, and producer identity. The current
claimed message is excluded from the covered source prefix. Existing immutable
HumanMessage bodies are the Summary rebuild source; do not duplicate transcript
body data in the owner table.

Introduce a dedicated P14 `ConversationCheckpointStore` port and SQLite
adapter. Reads and writes participate in the caller's `TransactionScope`.
Commit is one lease-fenced transaction and a compare-and-swap on owner,
expected epoch, and expected covered frontier; it atomically installs the
checkpoint metadata/ref and advances epoch/frontier. A stale fence, epoch, or
frontier fails closed and cannot overwrite a newer owner state. Write the
immutable Blob before the metadata transaction; an orphaned content-addressed
Blob on transaction failure is harmless and retained. No v1 garbage collector
is added; live owner/recovery references keep their evidence available.

## Current implementation delta

- `HumanMessageStore.listForWorkspace` currently returns all workspace messages
  in the frozen `(created_at, message_id)` order, and
  `human_messages` has no Conversation checkpoint owner state.
- `packages/agent-runtime/src/model-decision.ts` currently builds Conversation
  input from HumanMessages and the exact claimed message, while separately
  filtering the shared Session timeline by current Conversation execution.
  It has no cross-episode owner checkpoint read/write path.
- `adapters/persistence-sqlite/src/human-messages.ts` is the existing source
  reader. `packages/ports/src/human-messages.ts` owns its port. Blob storage is
  available through `BlobStorePort`; provider/model checkpoint and compaction
  plumbing currently assumes Session ownership and must not be reused as a
  Conversation owner by inference.
- The current checkout's ordinary migration target is schema 44. This plan's
  0048 requires schema 47 and is gated on the separately ordered 45–47 chain;
  implementation must verify the exact migration registry/prefix at execution
  time before editing it.

## Authorized scope if the token is granted

1. Add the Conversation checkpoint state domain/port, transactional SQLite
   adapter, SQL codecs/guards, and migration 0048 exactly as fixed above.
2. Add an owner history read that returns the current owner checkpoint plus
   durable HumanMessages strictly after its frontier in exact FIFO order. It
   also returns/validates the authoritative ResponseJob state needed to compute
   the greatest contiguous prefix where both HumanMessage and related job are
   `Answered`. Missing, malformed, Pending, Claimed, Declined, RetryScheduled,
   NeedsAttention, or otherwise non-Answered earlier evidence stops coverage;
   never skip a gap.
3. Integrate P3 Conversation preparation so it uses only the RootWorkspaceId
   owner checkpoint, the ordered uncovered durable messages, and the exact
   current Claimed message once. It must not read Work Session history or
   checkpoint entries. Advance coverage only after authoritative Answered
   settlement; compaction itself does not create an attempt or change P17 retry
   policy.
4. Persist source/producer manifest and owner CAS under the active lease fence.
   Preserve the same ResponseJob/Attempt/Execution across checkpoint commit,
   response settlement, and restart. Do not replay settled ProviderTurn/action
   effects, duplicate the current message, or emit a second Assistant turn.
5. Reuse ProviderNative evidence only on exact full binding-fingerprint match.
   On mismatch rebuild portable Summary from the retained owner prefix and do
   not send the prior opaque ref. Keep all HumanMessage rows and live Blob/native
   evidence durable.
6. Add migration fresh and schema-47 disposable-copy tests, owner-store/CAS
   tests, context projection tests, and the process matrix below. The tests do
   not modify live or preserved databases.

## Fixed qualification matrix

1. **Migration and empty owner:** fresh database reaches schema 48 through
   45/46/47/48 in order; a disposable schema-47 copy upgrades to 48. Both have
   the exact table/index and empty owner state. Existing HumanMessages and
   Session checkpoints are byte/logically unchanged; no owner/frontier is
   synthesized.
2. **Owner/FIFO prefix:** public SubmitHumanMessage produces at least two
   Answered responses. A later episode compacts and records the exact Root
   Workspace owner and contiguous `(created_at,message_id)` Answered prefix,
   ordered source identities, monotone epoch/frontier, and retained source
   rows. Provider request contains no Work Session items.
3. **Current Claimed message and same-episode restart:** force compaction while
   the exact response is Claimed; assert its body/ref appears once and is not
   covered. Kill after owner checkpoint commit but before Answered writeback,
   restart the same job/attempt/episode, and prove idempotent convergence with
   no repeated Provider/action work or duplicate message projection.
4. **Binding:** across episodes, exact matching complete binding may reuse
   Native state. A changed binding must rebuild portable Summary from the exact
   covered owner prefix and must not put the old opaque ref on the request.
5. **Isolation and retention:** interleave Work Session entries/checkpoints and
   Conversation messages under one Root Workspace. Neither owner can satisfy
   or advance the other. After restart, every HumanMessage and live referenced
   Summary Blob/native evidence remains available.
6. **Parameterized non-contiguous negative:** use one isolated contradictory
   owner-state fixture per blocker below, with an Answered prefix followed by
   the blocker and then a later Answered message:

   | Blocking evidence | Fixture shape |
   |---|---|
   | Pending | Earlier HumanMessage is Pending. |
   | Claimed | Earlier HumanMessage is Claimed and remains bound to its existing ResponseJob/episode. |
   | RetryScheduled | Earlier HumanMessage/job is not Answered and its ResponseJob is RetryScheduled. |
   | Declined | Earlier HumanMessage is Declined. |
   | NeedsAttention | Earlier ResponseJob is NeedsAttention and its HumanMessage is not Answered. |
   | Missing ResponseJob | Earlier HumanMessage has no related ResponseJob row. |
   | Malformed ResponseJob | Earlier ResponseJob has an invalid/unsupported durable state or malformed owner/message binding. |

   For **each** fixture, assert the frontier stops at the last contiguous
   authoritatively Answered message and never covers the later Answered item;
   the exact current Claimed message for the existing active response episode
   appears once as raw pinned input and remains uncovered; restart preserves
   the same blocker, owner epoch/frontier and current episode without duplicate
   message projection or replay of settled Provider/action work; and refusal
   produces no additional Provider response or second Assistant turn from the
   later Answered message. For the Claimed blocker, that blocker is the current
   pinned message; the other adversarial fixtures provide a separate exact
   current Claimed message bound to the fixture's existing response episode.
   Missing/malformed jobs are injected only as isolated legacy/contradictory
   state, never as a new admission path. No fixture may repair, skip, or infer
   the invalid gap during restart.
7. **CAS/fence/crash boundaries:** race two updates for one owner; only one
   expected epoch/frontier CAS commits. Exercise process death before owner
   transaction, after blob creation but before metadata commit, and after
   metadata commit but before Answered settlement. Restart converges or safely
   leaves only an unreferenced immutable Blob; it never infers ownership from
   Session text or ProviderTurn spelling.

Qualification uses real production composition and process boundaries, with
test-only fault probes absent from production composition. Run migration tests
only on fresh/disposable copies/offline CLI; record exact gates and results.
Passing this matrix closes only the Conversation owner implementation scope,
not all AH19 work.

## Explicit exclusions and stop conditions

- No `docs/design/**` edits, owner semantic changes, multi-thread ConversationId,
  backfill, inferred ordering, message deletion, or v1 garbage collection.
- No live/preserved database upgrade, deployment, release, or migration run
  against a durable user database. No schema version 49 or migration reordering.
- No changes to P17 retry policy, Work Session ownership, F23/P6, VCS, AH14, or
  unrelated AH19 recovery behavior.
- Do not proceed until the exact requested implementation token is accepted
  and migrations 45–47 are present in the agreed global order. If frozen
  constraints cannot be met, stop for manual governance.

## Implementation order

1. Verify the accepted design hashes/reviews and exact globally ordered
   migration 45–47 prefix; reserve 0048 with `requiresUserVersion: 47`.
2. Add migration 0048 and fresh/disposable schema-47 migration coverage.
3. Add the P14 checkpoint owner model/port/store with transaction, lease-fence,
   epoch/frontier CAS, and source-manifest validation.
4. Add contiguous Answered-prefix reads and owner-scoped context projection;
   integrate compaction and same-episode recovery.
5. Add deterministic store/context tests and the process/crash qualification
   matrix, then run authorized repository gates and record commit/outcomes.

No implementation step starts under this planning package alone.
