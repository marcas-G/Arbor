# Schema 42 stable integration

Date: 2026-10-13
Base: `4e093afb9be038576f1d0e8a8628c32e502b2f57`
Plan: `b3322b735996664d19cd2bf9643909bef6704bfb`
Accepted plan SHA-256: `7509948A83D2D6AD2B1A3C090EE6548628EB46397ABFB9718EB48535BBC0CE59`

## Integrated scope

Kept the existing schema-42 runtime and migration-registry activation from the
base. Added the stable offline P39–P42 schema-upgrade CLI through `e9aa8c1c`,
including the hash-chained manifest, resumable copy/upgrade reconciliation,
serialized provenance/report handling, bounded Windows security queries, and
post-migration target reopen behavior.

Added the invocation-wide protected P39 test root and isolated Vitest setup
from `cafa95e9` / `fa04f315`, the cached Windows SID cleanup, and the 30-second
security-process bounds. Added schema-42 template cloning, adapter fixture
callsite migrations and timeout/result updates through `18948e0f`, then the
stable single-workspace MAC fixture, per-case clone, timeout and result changes
through `78d06a43`.

The result now includes the CLI, runtime/registry activation, schema-42 factory
and clones, P39 global test root/SID/security bounds, and adapter plus MAC
fixtures. No P5/P12 diagnostic branch or pending red reproduction was
cherry-picked. No `docs/design/**`, live database, or deployment was changed.

## Cherry-picks

- CLI: `9056b3ca`, `cafa95e9`, `fa04f315`, `a5dcb8bf`, `e80f189b`,
  `2253e0f3`, `251ef294`, `b7a32b58`, `e9aa8c1c`.
- Adapter: `54fd6815`, `c5d788ad`, `eaa710b1`, `0105706f`, `1c7afad8`,
  `18948e0f`.
- MAC: `3ed3b218`, `f73b25a2`, `efc3d6c1`, `78d06a43`.

All cherry-picks applied without conflicts. Git performed automatic merges in
the cumulative migration qualification and adapter callsite files; no manual
semantic conflict resolution was needed. One inherited Markdown hard-break
space was removed so `git diff --check` passes.

## Verification

- `pnpm typecheck` — PASS.
- Biome on 44 changed TypeScript/JavaScript/JSON files — PASS.
- `git diff --check` — PASS after the whitespace cleanup.
- Static search confirmed the shared global P39 setup is registered in all
  five configured Vitest entrypoints, schema-42 factory cloning is used by the
  adapter readmission suite and all 12 migrated single-workspace suites, and
  P39 security subprocess limits are 30 seconds.
- Vitest and repository-wide gates were not run, as scoped for this integration.
