# Scientific Test Wave R3: Deterministic Lease Qualification

Date: 2026-10-14
Base: `1ce7ffc7f22a5e641ef45e0ef5fda2b2c08e9db9`

## Scope

Test-only changes. Production TTL, lease semantics, and `docs/design/**` are
unchanged.

The 22 repeated real-time `expires_at` waits are now split as follows:

- 20 paths use `expireExecutionLeaseForQualification`. The helper captures the
  exact old lease tuple and CAS-updates only `expires_at` inside an immediate
  SQLite write transaction. It requires the exact execution, owner,
  incarnation, generation, and old expiry; it reads the row back and requires
  owner and generation to remain unchanged.
- Two paths preserve real natural expiry. The AH10 generation-takeover case
  keeps gen0 alive with renewal paused while an independent gen1 daemon takes
  over. The P37 gen0 FencingRejected case keeps its live old owner through the
  real expiry so the old process can submit its stale command after takeover.
- The P9 dense SSE qualification remains unchanged and still waits for a real
  TTL/3 renewal during an active stream.

P37 process probes now record the acquiring PID and exact durable owner,
incarnation, and generation. Each P37 CAS callsite explicitly supplies the
controller for that process (primary or additional recovery daemon); the helper
fails before kill/write if the controller PID or owner tuple does not match.
Additional-daemon snapshots support the recovery-owner path. A focused wrong
controller test verifies no kill or database mutation occurs on mismatch.
Restart handshake diagnostics now report child PID, exit code, signal, stdout
line count, and lifecycle markers; the fixture wrapper also reports captured
stderr.

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
behavior when the expected generation has drifted or the selected controller
does not match the observed owner process.

## Verification

- `pnpm build` — PASS.
- `pnpm exec tsc -p tsconfig.test.json --noEmit` — PASS.
- Biome on the changed TypeScript files — PASS.
- `pnpm exec vitest run tests/p9-lease-renewal.test.ts tests/lease-qualification.test.ts` — PASS, 9/9 including the B1 wrong-controller negative.
- Focused real-process AH10 Deliverable receipt recovery — PASS, 1/1. Gen0
  exited before the qualification CAS; gen1 acquired generation 1 and resumed
  the same action identity with existing uniqueness checks passing.
- Focused P37 `blocks a Committed receipt when a still-present Inbox row no
  longer matches` — PASS, 1/1. The gen0 primary and gen1 additional recovery
  daemon each supplied their own process-bound owner evidence before CAS.
- P37 natural live-owner expiry / FencingRejected sentinel — PASS, 1/1.
- RAI-DG-01 focused journeys remain RED and prevent a release-readiness claim.
  The Inbox-mismatch journey failed twice at the P9 replay probe: the target
  Execution remained `Interrupted`, the target Deliver action remained
  `Pending`, there were no P9 facts or P9 probes, the target lease was at
  generation 1, provider requests were 9 (baseline 5), and the recovery daemon
  had zero reported errors. The safety-only journey, which does not use the CAS
  helper, timed out waiting for revision `initial + 2` after its RuntimeSafetyStop
  and subsequent public SteerWork. These failures are recorded as existing
  RAI-DG-01 evidence; no production semantics were changed to force a green.

The full functional suite and P9 dense SSE sentinel were not rerun in this
focused wave.
