# Functional port-zero nonce handshake — Wave E

Date: 2026-10-10

Base: `a50b4d58c4e8434fd87e29e5507c0943f9bf71d3`.

## Shared AH crash-child migration

Added `tests/functional/support/functional-daemon-lifecycle.mjs` as a
test-only helper that creates one process-local nonce/PID, emits the STARTED
report, and supplies the callback used to emit LISTENING with the actual bound
port. Both the ordinary `nonce-daemon-child.mjs` and shared
`ah-crash-child.mjs` now use this helper. Production continues to expose only
the existing generic `onWebTransportListening(port)` observer; no nonce,
protocol field, endpoint, or production route was added.

The fixture's opt-in mode now allows a custom `firstDaemonEntry`; its stdout
must satisfy the same child PID + same nonce + actual port handshake before
the parent probes readiness. Custom restart overrides and custom additional
daemons remain rejected until their own migration. The representative AH15
test starts its first incarnation with `ah-crash-child.mjs`, kills it at the
qualified boundary, then restarts the ordinary nonce child on the same
fixture URL. The crash helper's AH probe output continues through the same
stdout callback and existing probe assertions.

## Qualification

- AH15 `AfterInboxPromotionCommit` case alone: PASS, 1/1.
- Complete `tests/functional/process/ah15-inbox-input-promotion-crash.functional.test.ts`:
  PASS, 2/2, covering before/after commit boundaries.
- Both cases explicitly assert same fixture URL/actual port, two distinct
  child nonces and PIDs, and each listen report's nonce/PID matches its start
  report. `fixture.crash()` waits for the old child process to exit before
  restart.
- `pnpm typecheck`: PASS.
- Biome on the six touched source/test files: PASS.
- No complete functional suite or `pnpm check` was run.

Only the AH15 consumer file opts into the custom-child handshake in this wave.
The other `ah-crash-child.mjs` consumers, AH10/17/18/19 runners, and
additional-daemon tests remain on their legacy startup path. This does not
qualify the shared runner's other restart-entry permutations or authorize
parallel sharding of those files. F20 clean-checkout and Playwright remain
serial.
