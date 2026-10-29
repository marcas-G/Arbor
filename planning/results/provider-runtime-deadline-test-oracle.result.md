# Provider Runtime deadline test-oracle result

Status: TEST-ONLY ORACLE HARDENING COMPLETE; no production timeout or retry
policy changed.

At baseline `4f568c1`, the first full `pnpm check` was reported with two
failures in the whole-turn deadline and retry-backoff deadline cases. The
original focused run nevertheless passed both cases (2/2, 4.29s), and a later
full-check rerun was reported green. This is the load-sensitive history that
motivated deterministic orchestration; it is not evidence of a production
deadline defect.

The tests now provide Effect `TestClock` and Arbor `RuntimeClock` from the same
clock for these two cases. Whole-turn deadline waits for the real Adapter
start barrier, verifies durable Attempt 0 is `InProgress`, advances the
existing 180ms deadline by 1ms, and asserts Adapter abort, one call, durable
`TimedOut`/`Stop`, no Attempt 1, and `TurnDeadline`. It no longer awaits an
Adapter-only `connected` promise without a bound.

The retry-backoff case waits for Attempt 0 start, Adapter invocation, the
persisted `RetryableFailure`/`Retry` plus its `AttemptFailed` progress event,
and the post-failure clock-sleep registration before advancing the existing
120ms turn deadline by 1ms. It asserts one Adapter call, no Attempt 1, the
same durable Attempt 0 retry decision, and `TurnDeadline`. A 5-second live
watchdog is used only to fail setup if a barrier is never reached; it does not
advance the test clock or determine the tested timeout.

Verification:

- Targeted pair, 3 consecutive runs: 2/2 each.
- `pnpm exec vitest run tests/provider-runtime-phase1.integration.test.ts --reporter=dot`: 25/25.
- `pnpm typecheck`: PASS.
- `pnpm exec biome check tests/provider-runtime-phase1.integration.test.ts`: PASS.
- `git diff --check`: PASS.

## Independent integration qualification (2026-10-08)

- The full `tests/provider-runtime-phase1.integration.test.ts` passed 25/25 in
  11.35s before core-suite pressure.
- The final full `pnpm check` passed with the deadline cases included in the
  318-file core suite (1733 passed, 3 skipped) and no deadline failure.
- Earlier integration attempts exposed only validation defects: a Biome export
  ordering issue in the new Work Detail index export, then two stale Web view
  matrix assertions after adding the tenth view. Each was fixed at its source;
  no timeout assertion or product duration was weakened.

Files changed: `tests/provider-runtime-phase1.integration.test.ts` and this
result note. No commit or push was made.
