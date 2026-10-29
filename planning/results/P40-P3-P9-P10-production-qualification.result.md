# P40 P3/P9/P10 SQLite Production-Store Qualification

Date: 2026-10-12
Base: `ce58e0ceac7c0b0e0f48a586c0bcd70c01ce1cd4`
Accepted owner package: `5B61E0FF922A10D225FD5DAEA00176BD16C5C0B39484D626B7FEF6340516373A`
State: **TARGETED SQLITE AND MODULE QUALIFICATION PASS; P40/AH7 PHASE CLOSURE NOT CLAIMED**

## Scope and runtime boundary

The P40 code was semantically ported onto the `ce58e0ce` integration base in an
independent worktree. `CURRENT_MIGRATIONS` remains `P38_MIGRATIONS` with
baseline 38; `P40_TOOL_OBSERVATION_REPLAY_MIGRATION` remains an exported,
standalone descriptor absent from every current/production migration list.
Only test-owned temporary SQLite databases apply the already-owned P37–P39
prefix and invoke the standalone P40 descriptor. No preserved or production
database, daemon, release, or deployment was touched.

P40 consumes only the authenticated typed `P39RecoveryEvidenceStore.findSelected`
result. It does not parse persisted RecoveryBinding JSON or construct a
fallback selection. Missing P39 selected evidence fails closed before P40
evidence is written; P40’s SQLite store also rejects a
`ReconciledNoEffect` candidate that lacks the authenticated typed tuple.

## Qualification

- The P3 source regression test first failed on the real consumer seam: P3
  dropped the exact reconciliation fact/disposition and translated
  `RecoveryBlocked` into a generic interruption. The consumer now carries the
  exact `reconciliationFactRef`, status, disposition, Artifact ref, and
  invocation identity into the existing atomic Session/Action/cursor write.
- `tests/p40-p3-production-recovery.test.ts`: **2/2 PASS** against the actual
  SQLite `AgentLoopStepStore`, `SessionRepository`, and transaction adapter.
  Injected interruption before P3 commit leaves the sourced result, Action
  transition, and cursor advance absent while preserving the earlier Pending
  Action intent. Interruption after commit leaves one ToolResult, one Applied
  Action, one source identity, and one cursor advance. Re-entry makes no
  second executor call and converges from the same ProviderTurn/ActionCall.
- `tests/p40-p9-p10-production-recovery.test.ts`: **1/1 PASS** against actual
  P9 facts, DomainEventJournal, P10 attention rows, and P1 consumer offsets.
  P9 fact/event rollback and committed replay are checked on opposite sides
  of COMMIT. P10 marker/offset rollback and committed replay are checked on
  opposite sides of COMMIT. The production P10 reader returns the fixed,
  path-free `ActionRequired` row. A crash after P10 reset/offset rewind commit
  restarts from the valid `floor - 1` cursor and rebuilds one row.
- The P10 rebuild qualification exposed an implementation boundary error:
  `rebuildProjection` rejected its own committed `floor - 1` rewind as below
  the retention horizon on restart. The refusal threshold now admits the
  documented `floor - 1` catch-up cursor and continues to refuse offsets below
  it; the accepted retention boundary and P40 event-only rebuild source are
  unchanged.
- Missing P39 selected evidence is exercised through ToolRuntime with a real
  call to `findSelected`; one read returning `None` yields a typed operational
  failure and no ReconciledNoEffect result. A separate contract test prevents
  executor-authored attempt/fact selection.
- P40 codec, adapter, migration-splitter, and P3/P9/P10 module tests: combined
  targeted batch **12 files / 71 tests PASS**, including P40 store-gate **8/8**.
  The P40 text boundary follows the frozen 2,000 UTF-16 code-unit contract;
  the prior exact-16-KiB valid-payload assertion was removed because no valid
  envelope can reach that size under the accepted text bound. 2,001-unit and
  surrogate-pair boundaries remain covered.
- `pnpm build`: **PASS**. Targeted Biome check across the 12 changed source/test
  files: **PASS**. `git diff --check`: **PASS**.

`pnpm typecheck` reaches the root test TypeScript pass but exits nonzero on
existing errors in untouched P39, app transport, retry-verification, and P10
test files. None of the reported errors is in the new P40 qualification files
or the changed P40/P3/P10 implementation paths. The full functional suite,
daemon, and OS-process kill/restart qualification were not run. Therefore
these results do not close P40/AH7, do not qualify the complete 0036→0039
release prefix, and do not authorize registering migration 0040.
