# Application / Persistence Decomposition — Result

## Status

**COMPLETE / VERIFIED — 2026-09-30.**

## Delivered

- Split the Application command gateway into contracts, handler registry,
  project admission, fence/stop, receipt policy and orchestration modules.
- Preserved `gateway.ts` and `@arbor/application` as compatible public export
  surfaces.
- Expanded `CommandHandlerError` with the P7/P8 Dependency, Deliverable,
  Verification, Acceptance, Evidence and environment-revision Port failures.
- Removed command-handler `Effect.orDie` conversions for those declared Port
  failures; they now roll back and propagate as typed failures without writing
  an authoritative Receipt.
- Kept unique-constraint races as their existing semantic rejections while
  returning non-unique repository failures through the typed channel.
- Made retry-attempt tracing best effort: trace failure can no longer mask the
  original `TransactionOperationalFailure`.
- Split SQLite Project, Workspace, Work and Session repositories into one
  adapter module per aggregate; `repositories.ts` is now a compatibility
  barrel.

## Behavioral invariants preserved

- One semantic command still runs in one `TransactionScope`.
- Existing Receipt replay still precedes fence, authority and handler work.
- Terminal semantic rejection still writes one TerminalRejected Receipt and no
  Domain Event.
- Handler/repository failure and transaction failure still write no
  authoritative Receipt.
- Repository SQL, CAS predicates, fencing checks and session idempotency are
  unchanged.
- No Domain, Port, migration, DDL, transport or wire contract changed.

## Evidence

- focused gateway/P7/P8/repository suite: PASS (93/93)
- final gateway regression suite: PASS (15/15)
- typed handler failure regression: PASS
- retry-trace masking regression: PASS
- lint: PASS
- typecheck: PASS
- architecture: PASS (115/115)
- core tests: PASS (1477 passed, 1 skipped)
- web typecheck/build: PASS
- web tests: PASS (211/211)
- git diff check: PASS

## Next backend boundary

The next review target is ProviderTurn SQLite persistence (`provider-turns.ts`)
and the single-workspace composition root. Both are large, but should only be
split where ownership or lifecycle boundaries are real; migrations remain a
chronological source of truth and should not be divided by file size alone.
