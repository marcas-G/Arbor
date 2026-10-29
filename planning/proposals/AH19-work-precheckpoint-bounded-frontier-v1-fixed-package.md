# AH19 Work Pre-Checkpoint Bounded Frontier — Fixed Governance Package

**Status:** Proposed for manual governance; not accepted. This package makes a
design decision only. It does not authorize production implementation,
migration, or qualification work.

**Recommended token:** `ACCEPT_AH19_WORK_PRECHECKPOINT_BOUNDED_FRONTIER_V1`

**Alternative token, mutually exclusive:**
`ACCEPT_AH19_WORK_PRECHECKPOINT_COMPLETE_COVERAGE_V1`. Do not accept both.

## Decision requested

Accept an explicit bounded-context policy for Work history before the first
typed `CompactionCheckpoint`. The durable Session Timeline remains complete and
append-only. The active provider context is a projection and is not required to
contain the entire Timeline.

For v1, the pre-checkpoint row window is the latest 64 persisted Session
Timeline rows by Session-local sequence, plus the current pinned input and
canonical Work facts. The current pinned input and canonical facts are
independent of the 64-row window and are not charged to its slots. Do not scan
older rows to replace a row that the existing P3 projector filters or skips.
Entries older than the row window remain durable, but are outside automatic
model context and outside any checkpoint coverage claim.

Within the selected row window, eligibility and projection are exactly the
existing P2/P3 contracts: the P2 `SessionItem` union is `UserMessage`,
`AssistantMessage`, `ToolCall`, `ToolResult`, `ControlResult`, `ContextUpdate`,
`CompactionCheckpoint`, and `AttachmentRef` (DID §1.7 and P2 `02` §10). The
existing P3 `projectSessionTimeline` behavior is retained without adding types
or filters: `UserMessage` excludes `source.kind = HumanConversation` and needs
string `text`; `ToolCall` needs string `callRef`, `toolRef`, and
`argumentsJson`; `ToolResult` and `ControlResult` need string `callRef`;
`ContextUpdate` uses its existing normalized projection; only the latest
`CompactionCheckpoint` is eligible, with Summary requiring string `summaryText`
and ProviderNative requiring its current exact source/epoch/opaque-ref/binding
checks; the existing Observation fallback projects string
`payload.observation.text` only for `entryKind = Observation`. Other SessionItem
types without an existing `projectSessionTimeline` branch remain unprojected by
that Session projector; this package does not invent a fallback representation.

A selected row skipped by P3 produces no context item and is not represented
by a `contextRef`. The row-window `inputFrontier` bounds which persisted rows
were considered; it is not evidence that every row in that range was represented
or summarized. A checkpoint/`retainedFrontier` may claim coverage only for rows
whose content was actually represented under the existing projector. Older or
skipped row content remains durable and is not silently treated as checkpoint
coverage.

Every sampling turn independently reconstructs the current hard pinned
fragments from canonical sources. The row window cannot replace or evict
`WorkObjective`, `WorkConstraints`, `CompletionExpectation`,
`VerificationMissionSummary`, `ResponsibilityDefinition`, `ResourceBoundary`,
effective Authority/Permission, or other existing C0/C1 pinned control facts.
The runtime must not imply that a checkpoint summarizes rows it did not read.

After a checkpoint exists, the active frontier is the exact checkpoint
sequence followed by every unsummarized typed Session entry after that
sequence. The numeric recent-entry bound does not truncate this post-checkpoint
frontier. If it exceeds the model budget, the Agent Loop performs explicit
compaction and atomically advances the checkpoint/epoch under the existing
P2/P3/P9 contract.

Canonical Work objective, constraints, verification mission, responsibility,
resource boundary, and other pinned control facts remain independently
projected from canonical state. This bounded history policy cannot evict or
weaken them. The latest user input remains pinned as specified by the existing
P3 context contract.

## Basis and limits

System Design §3.6 separates the durable Session Timeline from the active
Provider Context and allows the latter to be a lossy projection. System Design
§5.5–5.6 and DID §8.8 define Cognitive Continuity as Checkpoint plus Recent
Frontier rather than complete Session History. DID §8.9 and §8.13 allow
history compression and a separately bounded recent frontier while forbidding
silent loss of hard control facts. P2 owns durable append/checkpoint persistence;
P3 owns context selection and compaction; P9 owns recovery of committed
compaction evidence.

The 64-entry pre-checkpoint limit is present in implementation and in the
AH19 history qualification record, but its exact pre-checkpoint semantics are
not frozen in the owning contracts. This package freezes the existing bound as
context policy. It does not authorize deleting older Session entries, claim
that the active context has complete Work history, or introduce a new retrieval
surface for older entries.

## Owning documents to amend after acceptance

| Owner | Required reconciliation |
|---|---|
| `docs/design/02-system-design.md` §3.6, §5.5–5.6 | State that durable Work Session history remains append-only while the pre-first-checkpoint active projection is bounded and may omit older entries. Preserve the existing rule that compaction does not delete Timeline facts. |
| `docs/design/03-detailed-implementation-design.md` §8.8, §8.9, §8.13, §8.19 | Freeze the pre-checkpoint 64-entry frontier, the exact post-checkpoint sequence rule, and the distinction between selected frontier and checkpoint coverage in the manifest. |
| `docs/design/implementation/P3/02-model-context-contracts.md` §5 and §9 | Assign the bound to Context selection; define the eligible entry set and the `inputFrontier` recorded for the selected window. |
| `docs/design/implementation/P2/02-port-contracts.md` and `04-sqlite-schema.md` | Reconcile only if a port/schema statement implies a different pre-checkpoint query or suggests omitted rows are deleted. No P2 schema change is proposed by this package. |
| `docs/design/implementation/P9/02-fault-injection-matrix.md` and `07-agent-loop-step-recovery.md` | Reconcile recovery wording only if required to distinguish a real committed checkpoint from uncheckpointed older durable rows. No new P9 recovery semantics are proposed here. |

Problem & Goals and Scenarios need no change unless manual governance finds
that the bounded-context behavior changes a user-visible success criterion or
observable workflow. This package does not make that inference.

## Implementation and migration boundary

The accepted decision can be documented without changing the current 64-entry
implementation. No database migration is required for the bounded policy:
older rows remain in the existing append-only Session Timeline, and existing
P2 `commitCompaction` continues to atomically append the checkpoint and advance
the Session epoch.

Any implementation change that alters the bound, eligible entry types,
frontier calculation, or checkpoint coverage requires a separately reviewed
implementation package and its own authorization. If the alternative
complete-coverage token is chosen instead, this package is not the landing
basis: P3 would need an explicit incremental coverage/compaction strategy before
history ages out of the provider frontier, and P9 would need crash/restart
qualification for those additional checkpoint boundaries. Existing P2 atomic
checkpoint persistence may be reusable; the implementation package must decide
whether a new paging/store contract is needed. No migration ID is reserved by
this fixed package.

## Minimum qualification matrix after acceptance

1. **Public pre-checkpoint row window:** create more than 64 short, uniquely
   identifiable Work Session rows through the public Work/Steer path while
   keeping the test model window large enough to avoid an earlier budget
   compaction. Assert that P2 selects exactly the latest 64 persisted rows by
   sequence and does not refill the window from older rows after P3 filters a
   selected row. Assert P3 emits only the existing typed projector items and
   source refs, with no item/ref for skipped rows. Assert the current pinned
   input occurs exactly once and is independent of the row cap; older and
   skipped rows remain durable and are not claimed checkpoint-covered.
2. **Pinned fragments on every projection:** assert separately on every
   Provider request that the current `WorkObjective`, `WorkConstraints`,
   `CompletionExpectation`, `VerificationMissionSummary`,
   `ResponsibilityDefinition`, `ResourceBoundary`, effective
   Authority/Permission and other existing C0/C1 hard fragments are present
   with their existing source/revision bindings, even when their corresponding
   Session history is outside or skipped by the 64-row window. No assertion may
   pass solely because some combined objective text happens to contain them.
3. **Post-checkpoint frontier:** with a typed checkpoint followed by more than
   64 unsummarized entries, assert that the checkpoint and every later entry
   remain in the active frontier. The existing P2 storage qualification is
   relevant evidence but does not replace the model-context/process boundary.
4. **Filtered row through compaction and restart:** create a valid P3-filtered
   `UserMessage` row with `source.kind = HumanConversation` at the lower edge
   of the selected 64-row window, using the current typed SessionItem format;
   do not create a new type or filter. Public Work/Steer rows provide the
   surrounding eligible history. Force a real production CompactionCheckpoint
   and kill/restart after its commit. Assert the filtered row has no
   `contextRef` or PortableInput item, is absent from the compaction content and
   `retainedFrontier` coverage claim, and remains durable in the Session table.
   Assert `inputFrontier` identifies the row window considered, not the set of
   content covered by the checkpoint. After restart, the checkpoint and normal
   post-checkpoint frontier are reused without replaying a settled ProviderTurn
   or action, and the filtered row is still not projected.
5. **Restart consistency:** restart after the over-64 pre-checkpoint history is
   durable and before a new checkpoint is committed. Assert the same bounded
   projection is reconstructed and no history row is deleted, duplicated, or
   falsely covered by a checkpoint.

Qualification must preserve the frozen Work acceptance, source identity,
binding, no-replay, and settlement assertions. A green bounded-window test does
not close other AH19 recovery branches.

## Acceptance and authorization

Manual acceptance of token
`ACCEPT_AH19_WORK_PRECHECKPOINT_BOUNDED_FRONTIER_V1` accepts only the semantic
decision above and authorizes the exact owning-document landing package after
its hash and consistency review. It does not authorize changing production
behavior, creating a migration, or claiming AH19 closure. Those actions require
their own phase authorization and evidence.

The complete-coverage alternative is mutually exclusive and requires its own
proposal, owning-document revisions, and implementation plan. Selection of one
Work history policy does not accept or authorize the independent
ConversationResponse checkpoint-owner decision.
