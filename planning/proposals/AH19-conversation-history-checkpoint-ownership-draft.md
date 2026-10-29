# AH19-DG — Conversation history checkpoint ownership (draft)

Status: **Draft for manual governance. Not accepted.** No design document was
modified and no Conversation history truncation/compression policy is proposed
as implementation behavior here.

## Observed failure boundary

The ordinary context projection has a durable checkpoint/recent-frontier source
for Work: `SessionRepository.listRecentEntries` uses the latest typed
`CompactionCheckpoint` sequence as a floor before selecting the bounded recent
timeline. Conversation history has a different source and no equivalent
checkpoint owner:

- Each `ConversationResponseEpisode` belongs to one HumanMessage and response
  job (`docs/design/implementation/P14/02-conversation-execution.md` §1–§4).
- `model-decision.ts` obtains answered history from
  `HumanMessageStore.listForWorkspace(workspaceId)`, then builds the current
  Conversation input from those HumanMessages plus the exact claimed message.
- Conversation excludes the Workspace Work Session frontier. Its execution
  timeline is also filtered to rows belonging to the current Execution, so a
  checkpoint written during one response is not the continuity source for a
  later response.
- `CompactionCheckpoint` is stored in a Session and advances that Session's
  ContextEpoch. The HumanMessage transcript remains a separate append history;
  the current frozen contracts do not say how a Session checkpoint represents
  or replaces a prefix of that transcript across response Episodes.

The earlier AH19 public-process experiment used repeated public
`SubmitHumanMessage` inputs and reached an ordinary `CompactionNative` request.
It only established the trigger. It did not prove checkpoint reuse by a later
ConversationResponse or bounded transcript projection. The attempted per-turn
compressible fragment mapping also lacked old HumanMessage refs in the
Compaction manifest and has been withdrawn.

## Frozen sources and unresolved decision

- DID §8.8 says C3 Cognitive Continuity uses **Checkpoint + Recent Frontier**,
  not the complete Session history.
- SD §3.6 and §5.6 separate durable append history from the active model
  projection and allow old conversation history to be compacted.
- P14 freezes one exact HumanMessage → one ConversationResponse Episode and
  keeps chat separate from Workspace Work Session input. It does not assign
  ownership of a compaction checkpoint that spans multiple ConversationResponse
  Episodes.

Manual governance needs to define the owner and identity of a durable
Conversation checkpoint, the exact retained HumanMessage frontier, how a later
response selects/replays it, and how the current claimed HumanMessage remains
available. It must also define interaction with response ordering/recovery and
model/deployment changes. Until those semantics are accepted, the Agent Runtime
must preserve the existing complete HumanMessage input behavior; it must not
silently cap, slice, or infer a summary from workspace history.

## Requested governance outcome

Please decide whether Conversation gains a durable checkpoint/recent-frontier
contract and which owning document carries it. This draft intentionally does
not choose storage ownership, lifecycle, retention boundary, or migration. No
implementation authorization is requested by this draft.
