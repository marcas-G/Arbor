# Schema-42 test database fixture

Date: 2026-10-13  
Base: `b3322b735996664d19cd2bf9643909bef6704bfb`  
Plan SHA-256: `7509948A83D2D6AD2B1A3C090EE6548628EB46397ABFB9718EB48535BBC0CE59`

## Outcome

Added `tests/support/schema42-database.ts` as the reusable real-file fixture for
tests that require the post-activation schema. It creates a private disposable
database under the worktree (P39 intentionally rejects system temporary
directories), applies ordinary P38, invokes the dedicated P39 maintenance
runner with its own report database, then applies standalone P40, P41, and P42
one descriptor at a time. It returns the database/report paths and isolated
cleanup. Unsupported P39 deployment is reported with its typed code and
observed version; the helper does not fabricate schema 42.

The fixture qualification seeds a P38 Project/Execution and proves version 42,
clean foreign keys, P41 NULL-fact rejection and marker behavior, P42
`LegacyUnknown` attribution, and reopen/no-op at version 42. The API exposes a
database filename before daemon start for runtime/functional prestart tests;
this change does not itself qualify a daemon startup.

Moved general P40 store and P9/P10 recovery consumers to the central fixture.
Their version-39 rejection test remains an explicit historical boundary case.
P43 store tests now apply their isolated 0043 descriptor on a real schema-42
fixture instead of assigning `user_version = 42`. P39/P41/P42 migration-owned
tests retain their version-specific setup.

Review follow-up: private directory creation now retains ownership before ACL
setup and removes that exact path if setup fails. The injected-failure test
proves the directory is removed even when ACL preparation throws. Follow-up
`pnpm typecheck` also passes.

## Verification

- `pnpm build`: PASS.
- `pnpm exec vitest run adapters/persistence-sqlite/test/schema42-database-fixture.test.ts adapters/persistence-sqlite/test/p43-work-blocker-store.test.ts`: PASS, 2 files / 5 tests.
- `pnpm exec vitest run adapters/persistence-sqlite/test/p40-observation-store-gates.test.ts tests/p40-p9-p10-production-recovery.test.ts`: PASS, 2 files / 9 tests.
- `pnpm typecheck`: PASS, including test TypeScript.
- Biome formatting and `git diff --check`: PASS.
- Private-directory ACL fault test: PASS, 1/1.

No production registry/runtime/CLI, migration SQL, `docs/design/**`, live or
preserved database, deployment, or release was changed or operated.
