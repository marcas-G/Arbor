# EGP Wave E — Legacy Focus Physical Removal Result

**Date:** 2026-10-03
**Governance:** `ACCEPT_EXECUTION_EPISODE_GOAL_PLAN_CONVERGENCE`
**Status:** COMPLETE

## Outcome

The current runtime and database no longer use `Work | Coordination` as the
identity of a Workspace execution.

- migration 0025 rebuilds `executions` without `focus_kind` or
  `focus_work_id`;
- migration 0026 rebuilds `agent_execution_state` without `focus_json` and
  persists exact `episode_json`;
- new Agent state uses `AgentEpisodeIdentity` (the exact Workspace episode,
  `ExecutionBoundEpisode`, or explicit `LegacyAmbiguousEpisode`);
- Agent Runtime fails closed before model inference when a historical
  Workspace execution has no exact episode;
- TurnProfile resolution has no `WorkspaceCoordination` purpose;
- conversation settlement requires `ConversationResponseEpisode` and produces
  `ConversationResponseProduced(messageId)`; no generic `QueryCompleted`
  production path remains;
- scheduler admission uses `AdmitWork(workId)` and exact `WorkEpisode`.

Historical focus types and columns remain only inside forward migration and
pre-migration adapter compatibility needed to replay old phase fixtures. The
current P26 schema cannot store them, and architecture tests prohibit their
return to Agent Runtime or Model Context.

## Real database migration

`C:/Arbor/arbor-slice.db` was migrated forward from 25 to 26.

```text
PRAGMA user_version             = 26
executions.focus_kind           = absent
executions.focus_work_id        = absent
agent_execution_state.focus_json = absent
agent_execution_state.episode_json = present
PRAGMA foreign_key_check        = []
```

Two already-settled historical executions that had no mechanically provable
purpose remain auditable as `LegacyAmbiguousEpisode`; they are not inferred
from Session text and cannot be driven again. The pre-0025 recoverable backup
is `C:/Arbor/arbor-slice.pre-egp25.backup.db`.

## Mechanical evidence

- `adapters/persistence-sqlite/test/p25-execution-episode-only-migration.test.ts`
- `adapters/persistence-sqlite/test/p26-agent-state-episode-migration.test.ts`
- `tests/architecture/egp-architecture.test.ts`
- exact conversation, Work, Decision and Plan tests recorded in the Waves A–D
  result

Final repository-wide command evidence is recorded after the closure run in
the section below.

## Final closure run

```text
pnpm lint          PASS — 853 files
pnpm typecheck     PASS
pnpm architecture  PASS — 24 files / 137 tests
pnpm test          PASS — 284 files / 1625 passed / 1 skipped
web typecheck      PASS
web build          PASS (existing >500 kB chunk warning only)
web test           PASS — 31 files / 212 tests
```

`pnpm check` completed successfully on 2026-10-03.
