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
- Same-Step P38/P4/P39 dual-daemon overlap: 1 real process qualification.
  The owner pauses at the exact same-Step claim immediately before
  `BEGIN IMMEDIATE`, while no SQLite write lock is held. The second daemon
  simultaneously attempts `runExecution` for that Execution and is rejected by
  the live exclusive P2 lease before any claim transaction; it writes no P38,
  P4, or P39 claim fact. Releasing the owner yields one consumed approval,
  intent/RecoveryBinding/attempt-0 and exactly one effect/settlement. This does
  not claim that two daemons enter the P39 transaction: P2 lease ownership
  correctly arbitrates first. The independent-connection adapter races above
  separately prove transaction-level approval/TTL CAS behavior. The ordinary
  production composition leaves the probe absent.
- Transaction-port qualification seam: default composition remains covered by
  existing transaction-port tests; an injected probe is observed before the
  transaction body and a throwing observer is fail-silent, with the write
  still committed.

## Commands

- `pnpm exec vitest run --maxWorkers=1 --no-file-parallelism --retry=0 adapters/persistence-sqlite/test/transaction.test.ts adapters/persistence-sqlite/test/p38-executable-approval-expiry.test.ts -t "qualification probe is pre-BEGIN|barrier-synchronized SQLite connections|transaction port"` — PASS, 5 passed / 6 skipped.
- `pnpm exec vitest run --config vitest.functional.config.ts --maxWorkers=1 --no-file-parallelism --retry=0 tests/functional/process/p38-executable-approval-public.functional.test.ts -t "public Stop and TTL expiry race on exact approval revision"` — PASS, 2 passed / 12 skipped.
- `pnpm exec vitest run --config vitest.functional.config.ts --maxWorkers=1 --no-file-parallelism --retry=0 tests/functional/process/p38-executable-approval-public.functional.test.ts -t "overlaps same-Step P38/P4/P39 claim attempts from two daemons without duplicate claim facts"` — PASS, 1 passed / 13 skipped. The daemon loser is rejected at P2 lease acquisition before entering the P39 claim transaction; independent adapter races are the SQLite transaction-level arbitration evidence.
- `pnpm typecheck` — PASS.
- `pnpm exec vitest run --config vitest.architecture.config.ts --maxWorkers=1 --no-file-parallelism --retry=0` — PASS, 32 files / 164 tests.
- `pnpm exec biome check --write` on the eight changed implementation/test files — PASS.
- `git diff --check` — PASS.

Full core, full architecture, and full functional suites were not run.
