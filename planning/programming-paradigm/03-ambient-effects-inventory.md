# Ambient Effects Inventory

Date: 2026-11-04

This inventory is the result of a source scan over `packages/`, `apps/`, and
`adapters/`. It distinguishes adapter/composition usage from application or
runtime usage that should be migrated behind an existing port.

## Adapter-owned / currently acceptable

- `adapters/secret-env/src/index.ts` — reads `process.env` as the secret-env
  adapter's documented ambient input.
- `adapters/persistence-sqlite/src/runtime.ts` — native time/randomness at the
  SQLite runtime composition boundary.
- `adapters/provider-openai/src/client.ts` — native `fetch` and deadline clock
  at the provider transport adapter boundary.
- `apps/web/src/commands/envelope.ts` and `apps/web/src/commands/uuid7.ts` —
  browser transport/request identity generation, outside Domain/Application.

## Requires follow-up under PP-W102/103

- `packages/provider-runtime/src/runtime.ts:836` — reconstructs a deadline
  with `new Date(...)` and accesses global fetch plumbing. Provider Runtime
  should consume an injected clock/transport boundary rather than own ambient
  time.
- `apps/web/src/data/invalidation.ts:107-124` — uses `Date.now()` for debounce
  scheduling. This is browser-local UI timing, but should be isolated in a
  named scheduler utility if it becomes part of correctness rather than UX.
- `adapters/persistence-sqlite/src/verification-store.ts:87,189,195,225` and
  related SQLite stores — native timestamps are spread through repository
  methods instead of consistently using the runtime clock seam.

## No semantic migration performed

This inventory does not change clock semantics. PP-W102/103 must first confirm
which existing ports own these effects and add deterministic tests before
rewriting production calls.
