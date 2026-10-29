# P37 L2 attention-poll integration checkpoint

Status: **L2 implementation checkpoint; not a phase-closure claim.**

Worktree: `C:\Users\ThinkPad\.codex\worktrees\p37-storage-l2\Arbor`

Base: P36 candidate checkpoint `9d45463b0c2b2296628fa80d33aa2a79a570da89`

Pre-result source checkpoint: `dc9cc6f1cb336ae7107307feda87188872ae7a07`

## Scope implemented

- Adds migration 0037 storage for immutable P9 deliver-replay fact/event provenance, durable outbox/ACK ordering, and P10 projection markers, with pruning/FK protections.
- Adds P9 fact/outbox, P10 marker/projection, and P1 global attention-poll claim/fencing ports and SQLite adapters.
- Adds the application `runAttentionPollOnce` coordinator. A valid poll claim is fenced and rechecked in one data transaction that reads raw journal rows, checks the raw event identity against the exact P9 fact before decoding Deliver, applies ordinary projection effects, inserts/verifies P10 markers before outbox ACK, advances the offset, and settles the lease. Source-integrity failure rolls that data transaction back before a separate bounded failure-accounting transaction.
- Keeps the generic event-only `runConsumerBatch` path and its empty-batch no-op behavior. Historical registered event payloads continue to use the existing decoder compatibility behavior; Deliver witness validation remains strict and raw-ID-first.
- Failure settlement now checks both owner/generation and an unexpired lease, including the not-yet-taken-over expired-claim case.

No `docs/design/**` files or migrations 0034–0036 were changed. L3 gateway/application handler work remains outside this worktree.

## Targeted verification

All commands ran in this worktree after the P36 heavy gate had finished. No full `pnpm check` or full functional suite was run.

- `pnpm --filter @arbor/single-workspace... build` — PASS; targeted workspace dependency DAG TypeScript build, including ports, SQLite persistence, application, and single-workspace composition.
- `pnpm exec vitest run adapters/persistence-sqlite/test/p37-ah10-deliver-replay-migration.test.ts adapters/persistence-sqlite/test/p37-attention-poll-store.test.ts adapters/persistence-sqlite/test/p37-deliver-replay-outbox-store.test.ts packages/application/test/p37-attention-poll-loop.test.ts tests/architecture/mac-p4-convergence.test.ts` — PASS, **5 files / 16 tests**.
  - Migration prefix upgrades v33→37, v34→37, v35→37, and v36→37: 4 cases; separate latest `user_version`/DDL and pruning/FK contract assertion: 1 case.
  - Attention poll lease fencing: 3; durable fact/outbox/marker/raw-decoder behavior: 3; integrated coordinator: 2; scoped architecture check: 3.
- `pnpm exec biome check` on the 16 changed source/test files — PASS, no diagnostics.
- `git diff --check` — PASS.

Test setup/diagnosis: the first isolated Vitest attempt could not import workspace packages because this clean worktree had no generated `dist`; the minimal dependency build resolved that fixture/setup condition. The next migration failures were test expectations inconsistent with `runMigrations`' existing “number of applied migrations” return contract; assertions were corrected to 4/3/2/1 while retaining independent `PRAGMA user_version=37` and schema assertions. An initial application test implementation used an unavailable Effect API, corrected to the repository's Effect v4 `Result` API. Raw EventId decoding was adjusted to preserve existing unprefixed stored IDs and historical payload compatibility; strict Deliver/P9 witness checks remain in the coordinator. Final targeted results above are green.

## Not covered / remaining

- L4–L6 integration and qualification are not included in this L2 worktree/checkpoint.
- P12 capacity/lease/backpressure qualification is not included; current coordinator settings are implementation defaults, not capacity evidence.
- No full functional suite, broad package/repository check, or real-process crash/restart matrix was run for this checkpoint.
- This evidence does not establish AH10 closure or formal P37/L2 phase closure.
