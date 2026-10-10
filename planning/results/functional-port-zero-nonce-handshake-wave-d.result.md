# Functional port-zero nonce handshake — Wave D

Date: 2026-10-10

Base: `a64ee0f3c38d7509f247300a36cb0a2ed4c137e9`.

## Audited restart candidates migrated

Migrated the two ordinary no-argument restart candidates identified in Wave C:

- `tests/functional/process/recovery-verdicts.functional.test.ts`
- `tests/functional/pending/f21-create-project-profile-process.functional.test.ts`

Both call `fixture.restart()` without a custom entry, do not start an
additional daemon, and reuse a client/URL created before restart. The
port-zero fixture keeps the initial OS-selected port when restarting, so that
URL remains stable. The fixture waits for the old `ChildProcess` to exit, then
requires a fresh start/listening nonce+PID report from the restarted process
and probes the same actual port. If another process takes the port during the
gap, the new daemon cannot bind/report and readiness fails closed.

Both restart cases now collect the child reports and explicitly assert:

- the base URL/actual port is unchanged across restart;
- exactly two STARTED and two LISTENING reports exist;
- the second child has a new nonce and PID;
- each LISTENING report matches its STARTED nonce/PID and both report the
  fixture's same actual port.

In `recovery-verdicts`, `fixture.crash()` awaits the old process exit before
restart. In the pending F21 case, `fixture.restart()` performs that same
stop-and-wait transition.

## Verification

- F16 crash/recovery case alone: PASS, 1/1.
- `recovery-verdicts.functional.test.ts`: PASS, 6/6.
- Pending F21 Profile receipt/restart case, under
  `vitest.pending-functional.config.ts`: PASS, 1/1; remains pending and does
  not count toward default/release qualification.
- `pnpm typecheck`: PASS.
- Biome on the two changed tests: PASS.
- No full functional suite or `pnpm check` was run.

## Remaining boundary

This completes the two ordinary standard-entry restart candidates. Restart and
additional-daemon tests with custom `ah-crash-child.mjs`,
`ah10-process-child.mjs`, AH17/AH18/AH19 entries remain on legacy startup and
were not modified. In nonce mode, fixture still rejects these overrides until
the custom child reports its own start nonce and actual listening port through
the existing process-local observer. No custom runner or additional-daemon
case is qualified by this wave.

Across the original 36 fixture files, seven default-gate files are now fully
opted in; three pending files use the handshake but remain outside the default
gate; 26 other fixture files remain on legacy startup. This is not a
whole-suite safe-parallelism claim. F20 clean-checkout and Playwright/browser
journeys remain serial.
