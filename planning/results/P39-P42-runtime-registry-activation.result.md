# P39–P42 schema 42 runtime and registry activation

Date: 2026-10-13  
Base: `b3322b735996664d19cd2bf9643909bef6704bfb`

## Authorization and scope

- Authorization token recorded verbatim: `AUTHORIZE_P39_P42_SCHEMA_ACTIVATION_AND_FRESH_COPY_QUALIFICATION`.
- Implementation plan: `planning/proposals/P39-P42-schema-activation-implementation-plan.md`.
- Accepted plan SHA-256: `7509948A83D2D6AD2B1A3C090EE6548628EB46397ABFB9718EB48535BBC0CE59`.
- This result covers the runtime/registry slice only. The offline upgrade CLI, existing-database upgrade, deployment, and release are not claimed.
- No files under `docs/design/**` and no existing or live database were changed or operated.

## Changes

- Registered the ordinary current suffix as P38 + P40 + P41 + P42; P39 remains exclusively in `P39_MAINTENANCE_MIGRATIONS`.
- Added `CURRENT_SCHEMA_VERSION = 42`; the readiness high-water derives from this explicit target.
- Added exact predecessor requirements: P40 requires 39, P41 requires 40, and P42 requires 41.
- Made the generic migration runner reject any supplied ID 39 before acquiring `SqlClient`; it checks every pending descriptor's actual `PRAGMA user_version` against its explicit requirement or immediate predecessor before the transaction.
- Composition admits exactly schema 42 and reports that versions below it require an offline upgrade; newer versions remain unsupported. Persistence readiness uses the same schema-42 constant. The production migration hook is a no-op at version 42.
- Added runtime, readiness, migration-runner, registry, and architecture assertions; adjusted migration qualification assertions to the activated registry.

## Verification

- `pnpm build` — PASS (initialized workspace package outputs in the isolated worktree; this preceded the final stricter predecessor check, which is covered by the targeted runner tests).
- `pnpm exec vitest run adapters/persistence-sqlite/test/p39-claim-atomicity.test.ts adapters/persistence-sqlite/test/p39-42-cumulative-prefix-qualification.test.ts` — PASS, 2 files / 3 tests (132.01s). The P39 claim test uses `runP39SqliteMaintenance`; P39 is no longer applied through the generic runner.
- `pnpm exec vitest run adapters/persistence-sqlite/test/migrate.test.ts apps/single-workspace/test/p38-runtime-schema-boundary.test.ts tests/architecture/mac-p4-convergence.test.ts adapters/persistence-sqlite/test/p42-project-resource-source-migration.test.ts` — PASS, 4 files / 27 tests (111.06s).
- `pnpm exec vitest run apps/single-workspace/test/p38-runtime-schema-boundary.test.ts` after integrating fixture commit `0ca0a972a83cec32dd249f977364728a75523c47` and ACL cleanup fix `da289d3875ccd699ff84e627d5cb41c92c419e84` — PASS, 1 file / 13 tests (153.55s). The successful `--once` case creates the real P38→P39-maintenance→P40→P41→P42 fixture, starts the daemon, observes a Web bind, and confirms `user_version` remains 42.
- Biome check for the 11 changed TypeScript files — PASS; `git diff --check` — PASS.
- Earlier first collection attempt failed because this fresh worktree had not built `@arbor/ports`; after `pnpm build`, the final targeted runs above passed. Intermediate runtime-harness assertion/timeout failures were corrected by using structured error assertions, private ACL fixtures, and separate version cases.

The runtime batch proves schema-42 admission, old-version refusal before migration/runtime/Web startup, exact readiness, the version-42 migration-hook no-op, and a complete disposable schema-42 `runDaemonOnce` plus Web-bind success. No full functional suite, existing-database upgrade, deployment, or release qualification is claimed.

