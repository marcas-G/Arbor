# S1–S4 black-box safe daemon startup

Date: 2026-10-14

Base: `4daf3bc8c9824b2363fdf4a1685b3259b9a4d85f`.

## Change

The public S1–S4 process suite now starts the existing test-only nonce daemon
reporter with `ARBOR_HTTP_PORT=0`. It accepts the port only after the spawned
child reports matching PID/nonce `STARTED` and `LISTENING` markers and a valid
actual port. The free-port reserve/close/rebind helper is removed.

S4 waits for the old child to exit before starting a new child on the first
child's reported port. The restart handshake rejects a different reported
port. Startup and readiness failures now retain the last readiness probe,
child PID/exit code/signal, recent stderr and lifecycle markers. Production
code and design documents are unchanged.

## Verification

- `pnpm build` — PASS.
- `pnpm --filter @arbor/web build` — PASS (required by the existing R2
  production-fixture HTTP readiness probe).
- Focused S4 case — PASS, 1/1.
- Full `tests/capability/black-box/s1-s4-public-api.test.ts` — PASS, 4/4.
- Existing `production-fixture-port-handshake.functional.test.ts` — PASS,
  6/6, including wrong PID, wrong nonce, wrong restart port, and early exit.
- `pnpm typecheck` — PASS.
- Biome on the changed black-box test — PASS.
- `git diff --check` — PASS.

The first R2 test attempt preceded the required Web build and failed three
HTTP-readiness cases; after building Web, the complete six-case suite passed.
