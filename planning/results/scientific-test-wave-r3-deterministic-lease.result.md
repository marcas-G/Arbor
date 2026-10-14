# Scientific Test Wave R3: Deterministic Lease Qualification

Date: 2026-10-14  
Base: `1ce7ffc7f22a5e641ef45e0ef5fda2b2c08e9db9`

## Scope

Test-only changes. Production TTL, lease semantics, and `docs/design/**` are
unchanged.

The 22 repeated real-time `expires_at` waits are now split as follows:

- 21 process-qualification paths use `expireExecutionLeaseForQualification`.
  The helper confirms the exact old daemon has exited, starts an immediate
  SQLite write transaction, captures the old lease tuple, and CAS-updates only
  `expires_at` against execution ID, owner, incarnation, generation, and prior
  expiry. It reads the row back and requires owner and generation to remain
  unchanged.
- One AH10 generation-takeover path remains a real natural-expiry sentinel:
  gen0 stays alive with renewal paused, its lease expires by wall time, and an
  independent gen1 daemon takes over.
- The P9 dense SSE qualification remains unchanged and still waits for a real
  TTL/3 renewal during an active stream.

The migration covers AH10 generation, SendMessage, SelectCurrentWork,
AssignWork, and direct-child receipt paths; AH17 checkpoint recovery; AH18
overflow recovery; AH19 native-binding recovery; the pending submitted-decision
binding case; and P37 DeliverMessage recovery. Existing generation, receipt,
observation, and effect uniqueness assertions remain in those paths.

## L2 additions

`tests/p9-lease-renewal.test.ts` now uses the existing `ClockTest` adapter and
Effect `TestClock` to qualify exact acquisition expiry, the TTL/3 renewal tick,
loop interruption, post-cancel expiry, generation increment on takeover, stale
renewal rejection, and stale fenced-write rejection.

`tests/lease-qualification.test.ts` checks daemon-exit gating, exact tuple
capture, owner/generation preservation, the expiry-only CAS, and fail-closed
behavior when the expected generation has drifted.

## Verification

- `pnpm build` — PASS.
- `pnpm exec tsc -p tsconfig.test.json --noEmit` — PASS.
- Biome on the 17 changed files — PASS.
- `pnpm exec vitest run tests/p9-lease-renewal.test.ts tests/lease-qualification.test.ts` — PASS, 8/8.
- Focused real-process AH10 Deliverable receipt recovery — PASS, 1/1. Gen0
  exited before the qualification CAS; gen1 acquired generation 1 and resumed
  the same action identity with existing uniqueness checks passing.
- Focused P37 DeliverMessage startup/restart case — BLOCKED before the
  qualification helper ran: the restarted test daemon exited with code 1 during
  its startup handshake and emitted no stderr. This does not provide evidence
  for or against the CAS path. The focused AH10 takeover above exercises the
  helper with real independent daemons and SQLite.

The full functional suite and P9 dense SSE sentinel were not rerun in this
focused wave.
