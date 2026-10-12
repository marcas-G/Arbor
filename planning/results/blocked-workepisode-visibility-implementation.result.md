# Blocked WorkEpisode Visibility Implementation Result

Status: implementation landed in an isolated managed worktree; migration 0043 remains unregistered and unexecuted.

## Changes

- Added durable WorkBlocker/WorkWait domain and port contracts, codec, SQLite migration descriptor 0043, and adapter tests. The descriptor is not added to the current migration registry or production schema.
- Bound Blocked settlement to exact pinned executable evidence: TerminalRejected action, paired Denied result, typed disposition, step identity, and pinned action manifest. Plan state is not consulted.
- Added P9 `resolve_work_blocker` evidence validation and atomic blocker resolution, event, Action/Step and Session result effects. Successful recovery must match the denied action kind and input identity; free text and `MayHaveStarted` cannot resolve a blocker.
- Added P6 WorkBlocked Inbox/Attention and Work detail projections, exact stale-event revalidation, Steer supersession, sequenced InboxAdvanced wake release, and atomic signal-consumption/offset handling for WorkBlocked.
- Added safe Work detail explanation. No automatic retry, Work completion, Verification, or Acceptance was added.

## Verification

- `pnpm typecheck` — PASS.
- Targeted Blocked settlement, P3/P9 controls, atomic P6 consumer/wake, resolver, P43 adapter, and restart suite — 27 tests PASS across 8 files.
- `apps/single-workspace/test/blocked-workepisode-restart-wake.test.ts` — real SQLite stores + `runDaemonOnce`/scheduler dispatcher prove global restart readmission after the signal offset is already at 1, child-scoped processing of its own Open Work without touching Parent Inbox, and later Parent-scoped readmission of that durable Inbox entry.
- Web `views-render.test.tsx` — 27 tests PASS.
- `pnpm lint` — PASS, one pre-existing `noNonNullAssertion` warning at `packages/agent-runtime/src/model-decision.ts:4070`.
- `git diff --check` — PASS.
- Web build — PASS (reported existing large-chunk advisory).

No full functional suite, standalone daemon process, live instance, or external database was started or modified. Targeted `runDaemonOnce` cycles used isolated temporary SQLite fixtures.

## Boundary / follow-up

Blocked settlement and resolution remain fail-closed/dormant in default production composition until the separately authorized migration 0043 is registered and activated. No current DB is upgraded here. Scheduler reevaluation after the atomic P6 commit is best-effort; durable WorkWait clearing and Parent Inbox admission are part of the same commit as offset advancement. The default/global daemon re-scans all Open Work workspaces and project roots each tick/startup, so a lost post-commit wake is re-discovered. Explicit `workspaceId` scope intentionally does not schedule other workspaces: a child-scoped daemon leaves its Parent Inbox durable and requires the owning Parent-scoped or a later global daemon to process it; it never impersonates or schedules the Parent. Configured workspaces now use the same Inbox-aware `consumeWorkspaceWake` path as global mode, preserving ordinary Work selection while enabling a Parent's own Inbox readmission.
