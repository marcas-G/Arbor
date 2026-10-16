# P38 concurrency qualification

Date: 2026-10-16

Scope: accepted P38/P39 concurrency matrix additions only. No design or frozen
contract changes.

## Evidence

- Independent SQLite Resolve-vs-TTL race: 8 barrier-synchronized iterations;
  exactly one terminal winner/revision increment, with one resolution event.
  The losing store operation returns no transition; the single Inbox entry is
  consumed exactly once. The test uses two independent SQLite clients/connections.
- Independent SQLite Stop-vs-TTL race: 8 barrier-synchronized iterations;
  exact approval/action cancellation or expiry is unique, Execution Stop cause
  remains `StopRequested`, and effect count remains zero.
- Public Stop-vs-TTL process race: 2 iterations, each with an old daemon and a
  separate TTL worker. Both wait before `BEGIN IMMEDIATE`; Stop and TTL
  transactions are released together for SQLite arbitration. Both iterations
  ended with one terminal approval event, consumed Inbox, durable Stop cause,
  and zero effect.
- Same-Step P38/P4/P39 dual-daemon overlap: 1 real process qualification. Both
  daemons reach an explicitly injected, test-only pre-`BEGIN IMMEDIATE` gate
  while no SQLite write lock is held; simultaneous release lets SQLite
  serialize the exact claim attempts. The public approval is consumed once,
  one P4 intent/RecoveryBinding/attempt-0 is persisted, the competing daemon
  loses the live Execution lease, and the original owner produces exactly one
  effect and settles. This is an overlap/arbitration test, not a kill/replay
  substitute. The ordinary production composition leaves the probe absent.
- Transaction-port qualification seam: default composition remains covered by
  existing transaction-port tests; an injected probe is observed before the
  transaction body and a throwing observer is fail-silent, with the write
  still committed.

## Commands

- `pnpm exec vitest run --maxWorkers=1 --no-file-parallelism --retry=0 adapters/persistence-sqlite/test/transaction.test.ts adapters/persistence-sqlite/test/p38-executable-approval-expiry.test.ts -t "qualification probe is pre-BEGIN|barrier-synchronized SQLite connections|transaction port"` — PASS, 5 passed / 6 skipped.
- `pnpm exec vitest run --config vitest.functional.config.ts --maxWorkers=1 --no-file-parallelism --retry=0 tests/functional/process/p38-executable-approval-public.functional.test.ts -t "public Stop and TTL expiry race on exact approval revision|overlaps same-Step P38/P4/P39 claim attempts from two daemons without duplicate claim facts"` — PASS, 3 passed / 11 skipped (Stop-vs-TTL iterations 0/1 and same-Step overlap).
- `pnpm typecheck` — PASS.
- `pnpm exec vitest run --config vitest.architecture.config.ts --maxWorkers=1 --no-file-parallelism --retry=0` — PASS, 32 files / 163 tests.
- `pnpm exec biome check --write` on the eight changed implementation/test files — PASS.
- `git diff --check` — PASS.

Full core, full architecture, and full functional suites were not run.
