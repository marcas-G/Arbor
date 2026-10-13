# Current P39 Windows test-root fix

Date: 2026-10-13  
Base: `80ba7d1208b03164aa24c6e5eec87e64b6b73f92`

## Root cause

Commit `e76f46a8` created and removed a protected TEMP root from `setupFiles`.
Vitest runs that setup in each isolated test worker, so the full root suite
created hundreds of ACL roots and launched concurrent `whoami.exe` / `icacls.exe`
processes. The recorded run spawned 392 workers, with roughly 406 ms startup per
worker. Under that load, test-owned roots could fail teardown with `EPERM`, and
timed-out suites left additional cleanup work behind. The earlier run also
showed broad P39 unsupported-deployment failures when child processes used
ordinary `%TEMP%` paths.

## Change

- Moved creation and cleanup of the protected TEMP root to Vitest `globalSetup`
  for both the root and functional test configurations. The root is established
  once before workers start and removed after they finish.
- Kept the worker setup for explicitly supplying the inbox PowerShell module
  path. It no longer creates/removes temp roots per test file.
- Added bounded Windows filesystem retries to disposable-root cleanup for
  transient `EPERM` / sharing violations.
- Added a regression test proving that a worker-created `mkdtemp` directory
  inherits an ACL accepted by the existing P39 protected-directory validator.

No production writer-lock validation, migration behavior, security policy, or
`docs/design/**` file changed.

## Verification

- `pnpm build` — PASS.
- P39 reality-proof migration + blocked WorkEpisode restart + P38 startup:
  3 files, 23 tests PASS after the global-root change.
- New inherited-TEMP ACL regression — 1/1 PASS.
- P39 cross-process writer exclusion under `vitest.functional.config.ts`:
  1 file, 3/3 PASS.
- F21 resource-admission file: 1/5 PASS, 4 failures remain. The responses were
  persistence 503 / replay 409; the recorded underlying SQLite error is
  `table projects has no column named resource_source_json`. This is a separate
  schema/fixture integration failure and was not changed here.
- Biome check on the changed TypeScript/config files and `git diff --check` —
  PASS.
- Per scope, no full `pnpm check` was run.

The results qualify the test-root and writer-lock representative paths. They do
not claim that the full release check is green.
