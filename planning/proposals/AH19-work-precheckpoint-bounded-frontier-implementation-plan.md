# AH19 Work Pre-Checkpoint Bounded Frontier — Fixed Implementation Plan

**Status:** Fixed planning package; implementation is not authorized by this
document. No production, test, migration, or design file is changed by preparing
this plan.

**Requested implementation token:**
`AUTHORIZE_AH19_WORK_PRECHECKPOINT_BOUNDED_FRONTIER_IMPLEMENTATION`

## Authority and frozen basis

The governing semantics are landed in System Design v1.18 and DID v1.50. The
accepted Work decision is recorded in
`planning/results/AH19-work-precheckpoint-bounded-frontier-acceptance-and-landing.record.md`
under `ACCEPT_AH19_WORK_PRECHECKPOINT_BOUNDED_FRONTIER_V1`; its accepted
proposal SHA-256 is
`4692895A2C9CF92DB1308507F29ED288FD3149F944AAC4F3D8BAE23635F5D663`.
The independent post-landing review has Blocking = 0. This plan requests a
separate implementation authorization and does not claim it has been granted.

The fixed behavior is: before the first typed Work `CompactionCheckpoint`, P2
selects exactly the latest 64 persisted Session Timeline rows by local sequence;
P3 applies only existing projector branches and does not refill filtered or
skipped rows from older history. Current input and canonical C0/C1 facts are
independent of the row cap. `inputFrontier` describes the selected rows;
context refs and `retainedFrontier` describe only represented content. After a
typed checkpoint, the active frontier is that checkpoint plus every later
unsummarized typed entry, without a 64-row cap. The Timeline remains append-only.

## Current implementation delta

- `packages/model-context/src/projector.ts` already defines
  `SESSION_TIMELINE_ENTRY_LIMIT = 64` and the existing P3 typed projector.
- `packages/agent-runtime/src/model-decision.ts` reads Work history through
  `SessionRepository.listRecentEntries` for startup/checkpoint recovery and
  context assembly.
- `adapters/persistence-sqlite/src/session-repository.ts` already finds the
  latest typed checkpoint, returns it with all later rows, and uses a bounded
  descending query before the first checkpoint. Its pre-checkpoint path then
  expands the returned window backward to close ToolCall/ToolResult causality.
  That expansion can exceed the frozen latest-64 row window. The existing P3
  unresolved-invocation gate already has a fail-closed result and remains the
  authority when an invocation cannot be closed inside the selected window.
- Work input projection and checkpoint recovery must use the same selected
  frontier. The current C0/C1 construction and canonical source bindings stay
  independent of Session selection.
- No P2 schema or migration change is required or authorized by the accepted
  Work contract. Migration 0048 belongs only to the separately fixed
  Conversation implementation plan.

## Authorized scope if the token is granted

1. Add a narrowly named SessionRepository operation for the Work active
   frontier, or equivalent typed query contract, so its behavior cannot
   accidentally change Work, Conversation, or diagnostic timeline reads.
2. Before the first typed checkpoint, return exactly the latest 64 persisted
   typed Timeline rows by sequence. Do not perform causal backfill from rows
   older than the selected 64. If P3 finds an unresolved or contradictory
   invocation in that selected range, preserve its existing `Blocked` behavior;
   do not silently widen the selected input.
3. After a typed checkpoint exists, return the exact latest checkpoint and all
   unsummarized typed rows after it, without an entry-count cap. Preserve
   current checkpoint sequence and epoch validation and explicit compaction.
4. Route Work context preparation, startup checkpoint discovery, and any
   recovery path that reconstructs the same Work context through this one
   selection rule. Keep the current user input exactly once and keep each
   canonical C0/C1 source/revision-bound fragment independently present on
   every Provider request.
5. Preserve `inputFrontier` as the persisted row window considered. Preserve
   context refs as actual projections and make each checkpoint's
   `retainedFrontier` cover only content actually represented by the existing
   projector. Do not add a SessionItem type, fallback projector, filter, older
   history retrieval surface, or deletion behavior.

## Fixed qualification matrix

All cases use the real production P2/P3 assembly and public Work/Steer journey
where practical. Test-only row seeding is limited to a valid existing typed
`UserMessage` with `source.kind = HumanConversation` for the frozen P3 filter
case.

1. **Exact pre-checkpoint row window:** create over 64 persisted rows, including
   a filtered row near the lower edge. Assert the selected sequence interval is
   exactly the latest 64 rows, no older row is backfilled, the filtered row has
   no context item/ref, and older/filtered rows remain durable and uncovered.
2. **Pinned facts and current input:** inspect every Provider request in the
   journey. Assert current input appears once, and WorkObjective,
   WorkConstraints, CompletionExpectation, VerificationMissionSummary,
   ResponsibilityDefinition, ResourceBoundary, effective Authority/Permission
   and every existing C0/C1 hard fragment each retain their own source/revision
   binding independently of the row window.
3. **Post-checkpoint frontier:** seed a typed checkpoint followed by more than
   64 unsummarized typed rows. Assert the exact checkpoint and all following
   rows are selected; budget pressure takes the existing explicit compaction
   path rather than truncating the frontier.
4. **Compaction and restart:** force a real checkpoint with the filtered row in
   the selected window, kill after checkpoint commit, then restart. Assert the
   filtered row is absent from PortableInput, context refs, compaction content,
   and retained coverage; `inputFrontier` still names the considered window;
   the row remains durable; and no settled ProviderTurn/action is replayed.
5. **Pre-checkpoint restart:** restart after over-64 history is durable and
   before a checkpoint. Assert the identical 64-row projection is reconstructed
   with no deletion, duplication, or false coverage.
6. **Causal boundary:** exercise a ToolResult whose matching ToolCall is just
   outside the selected window. Assert no older row is fetched and
   `decideSessionProjection` returns its exact existing blocked decision:
   `_tag: "Blocked"`, `reason: "ContradictoryTimeline"`,
   `callRefs: [<the orphaned result callRef>]`, and
   `closedFrontier: { firstSequence, lastSequence }`, where those two values
   are the first and last selected entry sequences strictly before the
   contradictory ToolResult (each is `null` when that prefix is empty). Assert
   it does not return `Ready`, substitute a different projection, or widen the
   selected rows during recovery.

The focused P2/P3/runtime tests are followed by the applicable functional
process qualification and repository gates. A green result closes only this
bounded-frontier implementation scope, not AH19 as a whole.

## Explicit exclusions and stop conditions

- No `docs/design/**` edits, semantic changes, migration, Session deletion,
  projector fallback, or new retrieval control.
- No changes to checkpoint epochs, ProviderNative binding acceptance, P9 replay
  rules, Work acceptance, C0/C1 source semantics, or unrelated AH19 branches.
- No Conversation checkpoint state or use of a Work Session as Conversation
  ownership.
- Do not proceed until the exact requested implementation token is accepted.
  If qualification exposes a semantic gap, stop and report evidence for manual
  governance rather than modifying frozen design.

## Implementation order

1. Introduce the narrow Work selection contract and adapter query while
   retaining all generic Session history readers.
2. Update Work context and recovery call sites to share the selection result.
3. Add focused store/projector/runtime tests for the exact row window,
   post-checkpoint unbounded frontier, C0/C1 pinning, and causal fail-closed
   boundary.
4. Add the public process compaction/restart cases, then run the authorized
   repository gates and record exact commands, commit, and outcomes.

No implementation step starts under this planning package alone.
