# S1–S4 black-box safe daemon startup

Date: 2026-10-15

Base: `4daf3bc8c9824b2363fdf4a1685b3259b9a4d85f`.
Review follow-up based on `10e65aec3ebe1d1d9afc5ea9e5b13da12d8c8f35`.

## Change

The public S1–S4 process suite now starts the existing test-only nonce daemon
reporter with `ARBOR_HTTP_PORT=0`. It accepts the port only after the spawned
child reports matching PID/nonce `STARTED` and `LISTENING` markers and a valid
actual port. The free-port reserve/close/rebind helper is removed.

The PID/nonce/listening parser and bounded process stop are shared with the
production test fixture. The parser rejects duplicate STARTED/LISTENING
markers, identity conflicts, and a restart port mismatch. S4 waits for the old
child to exit before starting a new child on the first child's reported port.
Startup and readiness failures retain the last readiness probe, child PID/exit
code/signal, recent stderr and lifecycle markers. S1–S4 registers idempotent
SIGINT/SIGTERM cleanup; daemon and provider shutdown have bounded waits and
record exit diagnostics. Runtime production code and design documents are
unchanged.

## Verification

- `pnpm build` — PASS.
- `pnpm --filter @arbor/web build` — PASS (required by the existing R2
  production-fixture HTTP readiness probe).
- Focused S4 case after shared-helper refactor — PASS, 1/1.
- Full `tests/capability/black-box/s1-s4-public-api.test.ts` after
  shared-helper refactor — PASS, 4/4.
- Existing `production-fixture-port-handshake.functional.test.ts` — PASS,
  8/8, including duplicate STARTED/LISTENING, wrong PID, wrong nonce, wrong
  restart port, and early exit.
- `pnpm typecheck` — PASS.
- Biome on all five changed TypeScript/JavaScript files — PASS.
- `git diff --check` — PASS.

The first R2 test attempt preceded the required Web build and failed three
HTTP-readiness cases; after building Web, the expanded eight-case suite passed.

## Cleanup review follow-up

Date: 2026-10-15.

The shared bounded server close is now also used by the production fixture on
startup failure and normal stop. Fixture stop memoizes its in-flight promise,
aggregates daemon/provider/directory cleanup failures, and records signal
interruption plus cleanup errors. The S1–S4 signal path uses the same bounded
daemon/provider shutdown and preserves setup/test errors alongside cleanup
failures.

Focused verification after this follow-up:

- `production-fixture-port-handshake.functional.test.ts` — PASS, 11/11,
  including provider close timeout/throw and repeated fixture/child stop.
- `pnpm typecheck` with `GOMAXPROCS=2` — PASS. The default parallel attempt
  exhausted Windows virtual memory; the bounded-parallel retry passed.
- Biome on the five changed TypeScript/JavaScript files — PASS.

The full S1–S4 suite was not rerun for this cleanup-only increment, per scope.

## Shared signal-safe cleanup follow-up

Date: 2026-10-15.

S1–S4 and the production fixture now both use the shared
`createSignalSafeCleanup` controller for SIGINT/SIGTERM registration,
interruption diagnostics, one memoized cleanup promise, and visible cleanup
errors. The conflicting duplicate STARTED fault now sends a second nonce and a
LISTENING marker with that nonce; the shared parser rejects the duplicate
instead of accepting the changed identity.

Focused verification after this follow-up:

- `production-fixture-port-handshake.functional.test.ts` — PASS, 11/11.
- `pnpm typecheck` with `GOMAXPROCS=2` — PASS.
- Biome on the five changed TypeScript/JavaScript files — PASS.
- `git diff --check` — PASS.

The complete S1–S4 suite was not rerun for this focused B1 change.
