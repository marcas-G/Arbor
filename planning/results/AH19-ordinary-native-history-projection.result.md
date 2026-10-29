# AH19 ordinary Native Work history projection — scoped qualification

Date: 2026-10-09

Status: **Work history reaches budget planning and same-process Native
checkpoint/reprepare converges. AH19 remains open.** This does not qualify
ordinary Native checkpoint crash recovery, manifest source-step identity,
repairAttempt, or process restart.

## Projection boundary

- Work history is read only from the `sessionId` already bound to the current
  Execution. A Workspace Primary Session intentionally carries continuity
  across that Workspace's Work/Execution episodes; another Workspace's Session
  is never queried or projected.
- Conversation history remains on its existing path. ConversationResponse
  does not project its HumanMessage transcript into compressible history while
  the cross-response checkpoint owner is unresolved; see the unaccepted draft
  `planning/proposals/AH19-conversation-history-checkpoint-ownership-draft.md`.
- The latest Work Session user input remains fixed budget. Earlier items in the
  selected Session frontier become `Compressible / DataOnly` fragments:
  conversation/reasoning/action continuity uses C3; typed observations,
  context updates, and attachments use C4. The latest user or attachment input
  remains fixed. Canonical instructions retain their existing fixed budgets
  and authority.
- Each projected fragment's token estimate is removed from fixed-input
  accounting and owned by `planContext` once; the portable input remains
  available to the explicit compaction request. No input is silently dropped.
- `listRecentEntries` uses the latest typed checkpoint's sequence as the exact
  lower boundary. It returns that checkpoint plus **all unsummarized rows after
  it**; the previous row-limit behavior could evict the checkpoint or silently
  omit unsummarized post-checkpoint history. ModelContext's token budget causes
  an explicit new compaction when that frontier no longer fits. Before the
  first checkpoint, the existing bounded recent Session window remains in
  effect.

## Evidence

- RED `p3-prepare-turn`: two tests reproduced historical inputs as
  `ContextUnsatisfiable` (required 1019/1036 tokens against 600 available).
- `pnpm test p3-prepare-turn`: **11/11 PASS**. The projection is data-only,
  maps exact Session source refs, puts observations in C4, retains latest user
  or attachment input in fixed accounting, charges history exactly once, and
  converts optional historical pressure to `NeedsCompaction(BudgetPressure)`.
- RED `p2-session-append`: a typed checkpoint at sequence 4 and 66 later
  unsummarized items with `limit=4` returned `[67,68,69,70]`, omitting both the
  checkpoint and intermediate active frontier. After the repository change,
  **6/6 PASS** and the exact returned sequence is `[4,5,…,70]`; the checkpoint
  summary and all post-checkpoint rows are present, with pre-checkpoint history
  excluded.
- `pnpm test p12-security-performance`: **10/10 PASS**, including the single
  ContextFragment construction boundary.
- AH19 Work public-process focused case: **1/1 PASS**. Public AssignWork and
  repeated SteerWork create the Session history. The normal `CompactionNative`
  request (`_native_compact_0`, no `_overflow_`) contains both older action
  history and the latest public Steer. After checkpoint commit, the re-prepared
  Inference sees the exact Native checkpoint and no old action history; the
  next logical turn is requested and only one Native compaction occurs. The
  process snapshot has no `OverflowCompaction` link. Test-only fixture changes
  are isolated to the AH19 child Provider adapter; stock Provider capabilities
  are unchanged.

## Scope and limits

The ordinary Native checkpoint/reprepare qualification is same-process only.
It does not claim that the resulting checkpoint can be recovered after a
crash. The AH19 overflow-linked source-step binding/recovery evidence remains
separate. Conversation compaction ownership is an unaccepted design gap; no
design document was changed. No Native manifest/recovery identity or
repairAttempt code was changed. No SQL was used to create public process-test
history; storage tests use their isolated typed-timeline fixture.

The independent review covered the Work-only projection and reported
**Blocking = 0**. This does not accept or resolve the ConversationResponse
checkpoint-ownership gap. Before the first typed checkpoint, the existing
bounded 64-entry recent Session window remains the behavior; this work does not
qualify history older than that window. Ordinary Native checkpoint
crash/restart recovery remains **OPEN**.

## Full gate

Full `pnpm check`: **PASS**. Biome checked 964 files (one pre-existing
`noNonNullAssertion` warning in `model-decision.ts`); typecheck passed;
architecture passed 158/158; core Vitest passed 319 files / 1745 tests with 3
skipped; Web typecheck/build passed (Vite reported its existing >500 kB chunk
warning); Web Vitest passed 31 files / 223 tests. The command rewrote the
generated timestamp/hash in `planning/results/P12.restore-drill.json`; those
two unrelated values were restored to their pre-run contents.

Full `pnpm test:functional`: **PASS**. Vitest passed 31 files / 104 tests;
Playwright passed 3/3 tests. This included the public AH19 Work ordinary
Native compaction case, which passed. The functional run completed without
failure markers.
