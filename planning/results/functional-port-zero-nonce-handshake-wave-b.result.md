# Functional port-zero nonce handshake — Wave B

Date: 2026-10-10

Base: `17697aa4756b5023b7001f99ab29bf6f048343fe`.

## Scope and audit boundary

Migrated the ordinary single-daemon fixture call in exactly these files:

- `tests/functional/process/organization.functional.test.ts`
- `tests/functional/process/human-steer.functional.test.ts`
- `tests/functional/process/cross-work-delivery.functional.test.ts`

Each candidate has one `startProductionFixture` call, no `fixture.restart`, no
`startAdditionalDaemon`, no `firstDaemonEntry`, and no direct child `spawn`.
Each gets one stable `fixture.baseUrl` after the normal production daemon has
reported its port-zero bind; no later client or second-daemon URL needs to be
rewritten. Their command/provider/resource assertions are unchanged. The
shared fixture and production observer implementation are unchanged in this
wave.

The audit intentionally excluded any file with restart/additional-daemon or
custom-entry behavior. Wave A's opt-in restart path preserves the original URL
by rebinding the initial ephemeral port, but custom children must themselves
report the new process identity before that path is safe to migrate.

## Verification

- `pnpm typecheck`: PASS.
- Biome on the three changed functional test files: PASS.
- Single-test stage: F19 `cross-work-delivery` case PASS, 1/1.
- File stage: the three complete files PASS, 3/3.
- Parallel stage: three separate Vitest processes ran those three files
  concurrently; each process passed 1/1 (3/3 total).
- No full functional suite or `pnpm check` was run.

## Migration accounting

The Wave A inventory counted 36 files using `startProductionFixture`.
Wave B fully migrates 3 more files. At this HEAD:

- 3 files are fully on nonce-bound startup (this wave).
- `command-input-validation.functional.test.ts` remains partially migrated:
  its malformed-MessageId case is opted in, while its `acp_` and historical
  receipt cases still use legacy startup.
- 32 other fixture files remain untouched and legacy.

Thus 33 files still contain at least one legacy fixture invocation. This is
not a suite-wide safe-parallelism claim. The full remaining file/child-entry
inventory and custom AH migration order remain in
`planning/results/functional-port-zero-nonce-handshake-wave-a.result.md`.

F20 clean-checkout and Playwright/browser journeys remain serial. Custom AH
children were not edited or run by this wave.
