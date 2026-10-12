# P41 / 0041 Physical Storage Amendment Port

Date: 2026-10-12
Base: `5f78ffcf277f14e6ee554ec83767e5d05b9f7686`

## Result

Implemented the accepted 0041 physical storage amendment in an isolated
worktree. The P9 fact primary key is now declared `TEXT NOT NULL PRIMARY KEY`.
The standalone descriptor retains migration ID 41 and name
`p41_submitted_decision_binding_attention`; its corrected DDL body hash is
`8b5908a58cbc9f75b8188df4fa6d22481f60b028581a603b022f1d883373846a` and the
descriptor fingerprint is
`1c4b30b9fc08569c8b50a9333ea115562a2ac93ee81cc869cda97d5fe75149a1`.

The persistence adapter accepts a complete caller-bound fact, persists it,
reads by fact ID, and lists by project. Exact replay of an existing identity
tuple is idempotent; changed content for that tuple fails closed. The adapter
does not append the business event, create Attention, or decide recovery or
Stop eligibility. Its methods remain optional, report readiness false when
0041 is absent, and return typed `PersistenceUnavailable` on absent-table
read/write attempts.

The 0041 descriptor remains absent from `P36_MIGRATIONS`,
`CURRENT_MIGRATIONS`, and all runnable migration lists. No migration was run;
the equivalent schema tests use a fresh in-memory or temporary SQLite database
and leave `user_version` unchanged. No preserved database, daemon, release
functional suite, or `docs/design/**` file was touched.

## Evidence

- P41 storage and codec tests: 7/7 passed. Coverage includes the NULL-key
  rejection with SQLite `SQLITE_CONSTRAINT_NOTNULL` (`errcode` 1299), positive
  insertion, closed failure-code set, exact tuple/event uniqueness, execution
  and marker composite FKs, immutability, idempotent storage, conflict
  rejection, read/list after file-backed database reopen, and fail-closed
  behavior when the standalone table is absent.
- `pnpm build`: passed.
- `pnpm typecheck`: passed.
- Targeted Biome check: passed, 7 files checked.

## Boundary

This result establishes the physical storage amendment and its equivalent
SQLite evidence only. It does not register or execute migration 0041, prove the
0036→0040 qualification gate, activate P41 runtime behavior, or claim P41
qualification or release readiness. Independent post-implementation review is
pending.
