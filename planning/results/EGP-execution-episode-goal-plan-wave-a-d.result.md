# EGP Execution Episode / Goal / Plan — Waves A–D Result

**Date:** 2026-10-03
**Governance:** `ACCEPT_EXECUTION_EPISODE_GOAL_PLAN_CONVERGENCE`
**Status:** WAVES A–E COMPLETE (Wave E evidence is recorded separately)

## Outcome

The active runtime no longer uses “no WorkId ⇒ Coordination” as the identity of
new Conversation, Work-selection, or Work executions.

Implemented exact bindings:

```text
ConversationResponseEpisode(messageId, responseJobRevision)
WorkEpisode(workId, targetWorkRevision)
DecisionEpisode(decisionId, requestRevision)
InboxEpisode(entryKey, inputKind)        [domain/persistence contract ready]
```

Work remains the durable Goal. `update_plan` now writes Work-scoped,
revisioned, restart-safe progress state. Plan data is re-injected as a DataOnly
ContextUpdate and has no lifecycle, Verification, Acceptance or completion
authority.

For multiple runnable Works the Scheduler now emits `RequestWorkSelection`.
The wake consumer persists a deterministic WorkSelectionDecisionRequest,
admits an exact DecisionEpisode, and exposes only `select_current_work`; the
handler validates the frozen candidate set before submitting the canonical
SelectCurrentWork command and settling `DecisionSubmitted(decisionId)`.

## Persistence

Migration 0024 adds:

```text
executions.episode_kind / episode_ref / episode_revision
work_plans
work_selection_decision_requests
```

The real local database migrated to `PRAGMA user_version = 24`. Historical Work
and Conversation attempts were backfilled where exact identity existed.

## Live evidence

Real DeepSeek Flash conversation after migration:

```text
messageId  = msg_01a0fef4-5dc2-7452-8b8d-0bfc54d7bb1d
episode    = ConversationResponseEpisode(messageId, revision=0)
settlement = ConversationResponseProduced(messageId)
response   = 你好，你好！又见面啦～有什么想聊的，或者需要我帮忙的吗？
```

No Work Session frontier or Work-only tools entered the request.

## Mechanical verification

```text
pnpm lint          PASS — 851 files
pnpm typecheck     PASS
pnpm architecture  PASS — 24 files / 135 tests
pnpm test          PASS — 282 files / 1621 passed / 1 skipped
web typecheck      PASS
web build          PASS (existing >500 kB chunk warning only)
web test           PASS — 31 files / 212 tests
```

Focused additions:

- exact EpisodeBinding/result compatibility tests;
- migration 0024 re-entrancy and schema tests;
- Work Plan revision/invalid-item tests;
- `update_plan` / `select_current_work` decoder tests;
- P14 exact conversation episode/provider request test;
- EGP architecture gate forbidding new Coordination admission paths.

## Wave E disposition

Completed by `planning/results/EGP-wave-e-legacy-removal.result.md`.
Migrations 0025 and 0026 physically remove focus storage from the current
Execution and AgentExecutionState schemas. Agent Runtime, Model Context and
settlement production no longer contain Coordination/QueryCompleted branches;
historical ambiguity is explicitly tagged and fails closed.
