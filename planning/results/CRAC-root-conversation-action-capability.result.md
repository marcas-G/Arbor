# CRAC Root Conversation Action Capability Result

**Date:** 2026-10-03
**Governance:** `ACCEPT_ROOT_CONVERSATION_ACTION_CAPABILITY`
**Accepted proposal SHA-256:** `DEBD13AAB34B7556B221F12B647360E945F95F5D89BD0B03287963DB22B917A8`
**Status:** COMPLETE / LIVE QUALIFIED

## Implemented boundary

- `RootConversation` supersedes `RootConversationRespond`.
- Executable tools remain empty.
- The only visible control is `propose_workspace`.
- The existing handler persists a Pending FormationProposal; human
  RecordDecision remains mandatory before child creation.
- Proposal persistence and `gov:<proposalId>:<revision>` Queue admission are
  one transaction. Agent input promotion excludes Governance entries.
- migrations 0027/0028 repair Pending proposals created before atomic Queue
  admission and remove stale actionable rows for already-settled proposals.
- A versioned canonical instruction tells the model it is operating in Arbor,
  forbids external-platform questions, and limits clarification to missing
  name/responsibility/resource scope.
- ProviderTurn ToolCall and AgentLoopAction ControlResult entries are rebound
  to the exact conversation execution and re-enter only that execution's next
  turn. Unrelated Work timeline entries remain excluded.

## Focused evidence

- TurnProfile test: zero executable + exactly `propose_workspace`.
- Agent Loop test: proposal observation survives into the second provider turn
  and the same ConversationResponseEpisode settles with final text.
- P14 production request test: ordinary conversation advertises only
  `propose_workspace` and excludes prior Work tool history.

## Final verification

Live DeepSeek Flash qualification:

```text
普通问候             -> plain text answer; no tool action
创建子工作区（缺参） -> asks only for explicit child name/responsibility/resource
完整名称/责任/资源    -> propose_workspace
durable proposal      -> Pending
human Queue entry      -> visible and exact-revision bound
conversation result   -> ConversationResponseProduced(messageId)
creation              -> not performed; human RecordDecision still required
```

The first live pass exposed two real defects and both were corrected before
closure: assistant-history-derived child naming (prompt asset advanced to v3)
and a Pending proposal without a Queue entry (atomic Inbox admission plus
migration 0027). Live Queue rejection then exposed a stale actionable row;
RecordDecision now consumes the exact `gov:` entry and migration 0028 repairs
historical settled rows. `Modify` consumes the old revision and creates a new
exact-revision human approval entry.

Final post-fix closure:

```text
pnpm lint          PASS — 856 files
pnpm typecheck     PASS
pnpm architecture  PASS — 25 files / 141 tests
pnpm test          PASS — 287 files / 1633 passed / 1 skipped
web typecheck      PASS
web build          PASS (existing >500 kB chunk warning only)
web test           PASS — 31 files / 214 tests
```
