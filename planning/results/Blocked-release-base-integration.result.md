# Blocked implementation release-base integration result

## Scope and boundary

Ported the accepted Blocked WorkEpisode final net implementation onto release
base `9db9a6c`, retaining the P15/P8/P39 integration already on the branch and
resolving shared registry, transport, adapter-barrel, and Agent Loop imports as
unions of the accepted contracts. `SelectCurrentWork` kept its release
dependency signature; Inbox sequencing remains at the accepted Deliver,
consumer, and wake paths.

The P43 descriptor and adapter are exported but remain dormant:
`CURRENT_MIGRATIONS = P38_MIGRATIONS`, P43 is absent from the current registry,
and no production or preserved database was migrated. The P43 store tests use
isolated in-memory databases and an explicit disposable test-only P43 prefix.
The runDaemonOnce restart tests use disposable temporary SQLite files. No
daemon service, deployment, or live instance was started.

The Windows restart fixture creates each temporary test directory with an ACL
limited to the current user, SYSTEM, and Administrators. This isolates the
fixture from the shared Codex temp-root ACL while preserving the production
P39 fail-closed deployment checks unchanged.

## Verification

- Blocked settlement, projection, Inbox episode, P43 store, resolver, restart,
  Agent Runtime, and atomic consumer/wake target: 10 files, 27 tests passed.
- Real SQLite `runDaemonOnce`/scheduler restart qualification: 2/2 passed as
  part of the target above.
- Web `views-render.test.tsx`: 1 file, 27 tests passed.
- Minimal TypeScript project build: `pnpm exec tsc -b
  apps/single-workspace/tsconfig.json packages/api-contracts/tsconfig.json` —
  passed.
- Biome on the 63 changed TypeScript/TSX files — passed.

No full functional suite, full workspace build, migration against an existing
database, deployment, or live-instance test was run.
