# P41 Submitted Decision Binding Runtime Behavior Port

## Scope and base

- Integration base: `5f78ffcf277f14e6ee554ec83767e5d05b9f7686`.
- Authorized behavior source: `f15c14324bf2d55de459af9a631233c4d35227b9` is an ancestor of `241ebd1180b2f6c041e6641bf78e38a70fe7dd3d`.
- The integration base is a separate descendant of merge base `9d45463b0c2b2296628fa80d33aa2a79a570da89`.
- Behavior implementation: `ec900065b7cc6b3e216438b86e7b097e0c7b23b7`.
- Storage dependency: `0a850d0fa8cb2efa9a789eefdbc0417efbb29b93` is the cherry-pick of storage port commit `83fea00c9908b04a680d0e94a145562b9601c767`.

## Implementation

Runtime now owns deterministic Submitted Decision failure identity and appends the exact `SubmittedDecisionBindingEscalated` event before storing its complete immutable P9 fact in the caller's transaction. Repeated observations find and validate the existing fact, preserving its original event and timestamp. Recovery closes only the exact matching pending `select_current_work` action; source-table absence remains fail-closed. Ordinary Work Stop and exact matching Decision Stop keep their generic settlement behavior.

P10 Attention now validates the event against the stored P9 fact and derives one `ActionRequired` row keyed by the immutable fact ID. The P9 fact store port remains optional so implementations without 0041 fail closed. Migration 0041 is represented by the separately committed storage descriptor only; `CURRENT_MIGRATIONS` remains P38 and the migration is not registered.

## Qualification

- `pnpm typecheck`: PASS.
- `pnpm build`: PASS.
- Full-repository Biome: PASS (1120 files); `git diff --check`: PASS.
- Focused Vitest: 8 files, 36 tests PASS. Coverage includes P41 fact codec/store behavior, unavailable-source and Stop negatives, submitted event retry identity, P10 Attention derivation, P10 SQLite close/reopen rebuild, and pinned replay.
- `tests/p41-p10-attention-rebuild-restart.test.ts` uses a temporary SQLite database, applies P38 through the existing migration runner, applies the standalone 0041 DDL directly without changing `user_version`, writes the P9 fact and journal event through production adapters, closes and reopens the SQLite scope, and rebuilds the same single P10 Attention row from the production fact/event read paths.

## Process qualification limitation

The imported AH10 real-daemon scenario was attempted but did not complete. The environment first required an explicit Windows PowerShell module path and private ACLs for P39's writer-lock probe. After those test-only setup issues were identified, the scenario reached its existing public setup route and was rejected with `UnsupportedOrigin:AssignWork` (the foreign Workspace route was likewise rejected with `UnsupportedOrigin:CreateChildWorkspace`). No production origin policy or migration registry was changed to work around those rejections. Real daemon/process restart qualification remains open for the final supported public journey; this result does not claim that qualification.

## Review

Independent exact-SHA review: pending.
