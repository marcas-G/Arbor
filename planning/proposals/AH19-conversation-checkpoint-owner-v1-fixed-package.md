# AH19 Conversation Checkpoint Owner — Fixed Governance Package

**Status:** Proposed for manual governance; not accepted. This package fixes
conversation history semantics only. It does not authorize production
implementation, migration, or qualification work.

**Recommended token:** `ACCEPT_AH19_CONVERSATION_CHECKPOINT_OWNER_V1`

## Decision requested

Define one durable, cross-episode Conversation continuity owner for the Root
Workspace conversation. For v1, the stable owner key is the exact
`RootWorkspaceId` (`WorkspaceId`) that owns the HumanMessages. The owner key is
stable across `HumanMessageId`, `ConversationResponseJob` revision, Attempt,
ExecutionId, and ConversationResponseEpisode. It is not the current response
Execution, message, job revision, or Workspace Work Session checkpoint.

The v1 product contract has one Root Workspace conversation stream. If a later
product surface permits multiple conversation threads within one Workspace,
that change must introduce an exact `ConversationId` and a separate accepted
contract; WorkspaceId must not silently be reinterpreted to mean several
streams.

The checkpoint owner advances over a contiguous FIFO prefix of authoritative
`Answered` HumanMessages only. Its retained frontier names the exact inclusive
`coveredThroughMessageId` in the stable conversation order. If the existing
durable order uses `created_at`, ties are resolved by `messageId`; an
implementation package may add an explicit owner-local sequence instead, but
must preserve the same total order and identify the migration.

An active `Claimed` HumanMessage remains an exact, pinned input for its own
ConversationResponseEpisode. It is included once as the raw current message and
is not considered covered by the summary frontier until that response is
authoritatively answered. A checkpoint must not leap over a Pending, Claimed,
RetryScheduled, or otherwise non-Answered earlier message. The next episode's
context is the owner checkpoint, every durable message after its frontier in
order, and the exact current claimed message once. It excludes Workspace Work
Session history and checkpoints.

## Binding, restart, and retention

- A ProviderNative checkpoint may cross response episodes only when its
  complete `ResolvedModelBinding` fingerprint matches exactly. A mismatch must
  rebuild through portable Summary using the owned HumanMessage prefix; it must
  never send the old opaque provider reference to the new binding.
- Recovery validates the owner key, exact retained frontier, source message,
  response job/attempt binding, ProviderTurn manifest, and checkpoint evidence.
  It does not infer an owner or covered prefix from Session text or ProviderTurn
  ID spelling.
- If a checkpoint commit succeeds before the current ResponseJob becomes
  Answered, restart resumes that same episode and owner state idempotently. The
  same message is not summarized and appended as new context twice, and no
  already settled ProviderTurn or action is replayed.
- HumanMessage rows remain immutable durable facts after checkpointing; a
  checkpoint is a context projection, not permission to delete transcript
  evidence. The referenced portable summary/blob and any binding-bound Native
  evidence remain durable while the active owner state or recovery record
  references them. Physical garbage collection is outside v1 unless a separate
  policy is accepted.
- The owner state is physically separate from the Workspace Work Primary
  Session checkpoint state. Work and Conversation cannot observe, advance, or
  satisfy one another's checkpoint frontier.

## Recommended storage boundary

Persist one owner-scoped Conversation checkpoint state keyed by Root
WorkspaceId, separate from the shared Workspace Work Primary Session. It must
atomically bind owner key, monotonic context epoch, exact covered message
frontier, checkpoint kind/reference, complete binding fingerprint when Native,
and source manifest/producer identity under the current lease fence. Use the
existing immutable HumanMessage store as the source for portable rebuild.

The owning design must decide whether this state is a dedicated P14
Conversation-history checkpoint record or a separately bound standard Session
owned by that Conversation stream. Either physical choice must have a unique
owner and epoch independent of the Workspace Work Session. The implementation
package must select and pin the exact table/port/transaction shape. Existing
unowned Workspace Session checkpoints cannot be backfilled as Conversation
checkpoints because they do not prove which HumanMessage prefix they cover.

No migration number is reserved in this fixed package. After acceptance, the
implementation package must identify the next available migration ID, add its
forward-only descriptor, and qualify fresh and upgraded database behavior.
Existing HumanMessages remain available as the source history; migration must
not synthesize checkpoint ownership or message coverage from Session text.

## Owning documents to amend after acceptance

| Owner | Required reconciliation |
|---|---|
| `docs/design/02-system-design.md` §3.6, §4.6, §5.5–5.6 | Define Conversation continuity as a separate owner/frontier from the Workspace Work Session; specify what the checkpoint represents and preserve the durable HumanMessage timeline. |
| `docs/design/03-detailed-implementation-design.md` §8.8, §8.13, §8.19, P14 section | Freeze the stable owner key, covered frontier, current-message rule, binding compatibility, and manifest/source identity. |
| `docs/design/implementation/P14/02-conversation-execution.md` §1, §4, §5 | Own Root Workspace conversation ordering, Answered-prefix coverage, one current claimed message, cross-episode reuse, and recovery semantics. Update `01-human-message.md` only if the accepted ordering/owner key adds a HumanMessage field or index. |
| `docs/design/implementation/P3/02-model-context-contracts.md` and `03-agent-loop-driver.md` | Define how the owner checkpoint plus post-frontier messages become portable input and how explicit compaction resumes the same current response step. |
| `docs/design/implementation/P3/04-sqlite-schema.md` and P2 `02-port-contracts.md` / `04-sqlite-schema.md` | Define the exact owner-state persistence port, atomic checkpoint/frontier/epoch commit, fencing, and migration after the implementation package selects the physical design. |
| `docs/design/implementation/P9/02-fault-injection-matrix.md` and `07-agent-loop-step-recovery.md` | Add the required checkpoint-commit, response-settlement, binding-change, and restart recovery cases; preserve same-episode P9 guarantees. |
| P17 Conversation Delivery contracts | Reconcile only the interaction between ResponseJob eligibility/Answered state and frontier advancement. Do not widen retry semantics or create a new attempt as a consequence of compaction. |

P14 is the business owner for the HumanMessage-to-response continuity rule;
System Design owns the system semantics; P3 owns context projection; P2 owns
transactional storage primitives; P9 owns recovery evidence. P17 is amended only
where its already-frozen job state transitions intersect this owner.

## Implementation and migration boundary

Acceptance does not authorize the implementation. A separate fixed
implementation package must specify the selected owner-state port/table,
message ordering key, transaction participation, exact migration ID, upgrade
and rollback constraints, manifest fields, and ProviderNative-versus-Summary
recovery behavior. The migration is additive and forward-only; no old Session
checkpoint is assigned to the new owner by inference.

Changing message ordering, allowing coverage to pass a non-Answered message,
reusing a Workspace Work checkpoint, deleting covered HumanMessages, or
retrying a response because of compaction are outside this decision and require
new manual governance.

## Minimum process qualification matrix after separate implementation authorization

1. **Owner and frontier creation:** public SubmitHumanMessage produces at least
   two Answered episodes; a later episode creates a checkpoint covering exactly
   the contiguous answered prefix. Assert Root WorkspaceId owner, monotonically
   advancing frontier, exact source MessageIds, immutable source rows retained,
   and no Work Session history in the Conversation provider request.
2. **Current message pinning:** during the active claimed response, force
   compaction and assert the current HumanMessage body/reference occurs exactly
   once as pinned input and is not included in the covered prefix. Advance the
   frontier only after authoritative Answered settlement.
3. **Cross-episode reuse and restart:** commit the first checkpoint, kill the
   daemon before response settlement or transcript writeback, restart the same
   ResponseJob/Attempt, then submit the next message. Assert one answer per
   message, no Provider/action replay, exact checkpoint-plus-frontier input,
   and no regression or skip in owner coverage.
4. **Binding change:** change the complete model binding between episodes.
   Assert the old Native opaque reference is not sent, portable Summary rebuild
   uses the exact owner frontier, and the current HumanMessage remains pinned.
5. **Work/Conversation isolation and retention:** interleave or seed exact Work
   Session entries and Conversation messages under one Root Workspace. Assert
   neither stream reads, advances, or satisfies the other's checkpoint; all
   HumanMessage rows and every live checkpoint Blob reference remain readable
   after restart.
6. **Non-contiguous Answered-history negative and restart:** use an
   isolated owner-state fixture with an Answered prefix, then an earlier
   message in each of `Pending`, `Claimed`, and `RetryScheduled`, followed by a
   later Answered message. These rows represent an adversarial legacy or
   contradictory owner-state shape, not a new admission path. Assert the
   checkpoint/frontier stops at the last message of the continuous Answered
   prefix and never covers the later Answered message across the gap. For the
   Claimed case, the exact Claimed body remains pinned once for its existing
   ResponseJob and is not summarized. Kill and restart after the frontier
   refusal; assert the same earlier gap remains, no frontier advancement occurs,
   and no additional Provider request or second response is produced from the
   later message.

The accepted implementation package may combine cases 1–3 into one public
process scenario if each crash boundary and persisted owner/frontier assertion
remains independently observable. Binding change and Work/Conversation
isolation remain required assertions. Case 6 remains a separate fail-closed
negative because it validates an impossible/out-of-order state rather than the
normal FIFO path.

## Acceptance and authorization

Manual acceptance of `ACCEPT_AH19_CONVERSATION_CHECKPOINT_OWNER_V1` accepts only
the owner/frontier/binding/retention semantics above and authorizes the exact
owning-document landing package after proposal-hash and consistency review. It
does not authorize storage, migration, runtime, or test implementation.

Production implementation requires a separate token after design landing,
independent review, and next-migration-ID verification. Acceptance of the Work
pre-checkpoint bounded-frontier package neither accepts nor authorizes this
Conversation decision.
