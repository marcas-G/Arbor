# P44 ApprovalRejected no-effect migration — preparatory evidence

Date: 2026-10-16  
Candidate: `b1e75f78`  
Status: descriptor and isolated evidence complete; **schema activation not authorized or performed**.

## Descriptor

- Added exported, unregistered `P44_APPROVAL_REJECTED_NO_EFFECT_DENIAL_MIGRATION` (`id: 44`, requires `user_version = 43`). It drops and recreates only the two P40 `tool_invocations` observation guards.
- The SQL is derived from the exact P40 guard section and changes only the two Denied reason allowlists by adding the frozen `ApprovalRejected` code. The P40 descriptor, P39/P42 SQL, current registry, `CURRENT_SCHEMA_VERSION = 42`, runtime boundary, readiness, offline CLI, and production fixtures remain unchanged.
- Descriptor SQL SHA-256: `2378c0170aae7beb0592c69bfffef9e611da6d5323caaa0de5b7d5360b7ff33f`.

## Isolated qualification

`adapters/persistence-sqlite/test/p44-approval-rejected-no-effect-migration.test.ts` starts from the real schema-42/P39 disposable fixture, explicitly applies the dormant P43 Blocked WorkEpisode descriptor for that isolated fixture, then applies P44. It verifies version 44, the fixture-owned `work_blockers` table, unchanged `tool_invocations` foreign keys and indexes, clean `foreign_key_check`, and byte-for-byte P40 guard predicates apart from the one allowlist entry (accounting only for SQLite's removal of the final semicolon).

The second case exercises P38's P4 terminal-denial mapping for `Rejected → ApprovalRejected` and expired `Pending → ApprovalExpired`, records both Denied outcomes through the SQLite ToolInvocationStore on insert/update, and confirms unknown denial reasons and malformed canonical Success evidence are still rejected. The test is isolated persistence/P4 evidence, not a claim that the current daemon accepts schema 44 or that public P38 Reject/Expire journeys have passed on a registered schema.

## Verification

- `pnpm --filter @arbor/persistence-sqlite build` — PASS.
- `pnpm exec vitest run adapters/persistence-sqlite/test/p44-approval-rejected-no-effect-migration.test.ts` — PASS, 1 file / 2 tests.
- `pnpm typecheck` — PASS.
- Targeted Biome check for the descriptor/test and `git diff --check` — PASS.
- No full functional suite, P39–P43 offline CLI, current-runtime fixture migration, or online/preserved database upgrade was run. The current runtime remains at schema 42.

## Activation remains gated

The required activation package is recorded in
`planning/proposals/P44-approval-rejected-no-effect-schema-activation-package.md`.
An explicit governance/token decision must settle the schema-43 predecessor;
the dormant P43 Blocked WorkEpisode test descriptor is not authorization to
register that feature. Only an authorized follow-up may alter the registry,
runtime/readiness target, CLI, or current fixtures, and it must remain offline
for fresh databases or disposable copies.
